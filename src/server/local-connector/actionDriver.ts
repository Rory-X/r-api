import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { atomicWriteFile, readOptionalFile } from './atomicFile.js';
import {
  createLocalConnectorBackup,
  restoreLocalConnectorBackup,
} from './backupStore.js';
import {
  isLocalConnectorActionManifest,
  type LocalConnectorActionManifest,
  type LocalConnectorAgent,
} from './protocol.js';

export const LOCAL_CONNECTOR_MANAGED_SOURCE = 'metapi-local-connector';
const CODEX_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
]);
const CLAUDE_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
]);

export type LocalConnectorLaunchCommand = {
  executable: string;
  argv: string[];
};

export type LocalConnectorTargetPaths = {
  codexHome: string;
  claudeConfigDir: string;
};

export type LocalConnectorActionExecutionResult = {
  changed: boolean;
  target: string;
  operation: LocalConnectorActionManifest['operation'];
  backupRef: string | null;
  details: Record<string, unknown>;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function resolveLocalConnectorTargetPaths(env: NodeJS.ProcessEnv = process.env): LocalConnectorTargetPaths {
  return {
    codexHome: resolve(env.CODEX_HOME?.trim() || join(homedir(), '.codex')),
    claudeConfigDir: resolve(env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')),
  };
}

function validateLaunchCommand(command: LocalConnectorLaunchCommand): LocalConnectorLaunchCommand {
  const executable = command.executable.trim();
  if (!executable || executable.length > 4_096 || executable.includes('\0')) {
    throw new Error('Connector executable 无效');
  }
  if (!Array.isArray(command.argv) || command.argv.length > 32) throw new Error('Connector argv 无效');
  const argv = command.argv.map((item) => {
    if (typeof item !== 'string' || item.length > 4_096 || item.includes('\0')) {
      throw new Error('Connector argv 无效');
    }
    return item;
  });
  return { executable, argv };
}

function shellQuotePosix(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function shellQuoteWindows(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function buildEmitArgv(
  launch: LocalConnectorLaunchCommand,
  configPath: string,
  kind: 'hook' | 'notify',
  agent: LocalConnectorAgent,
): string[] {
  return [
    ...launch.argv,
    'emit',
    '--kind',
    kind,
    '--agent',
    agent,
    '--config',
    resolve(configPath),
    '--source',
    LOCAL_CONNECTOR_MANAGED_SOURCE,
  ];
}

export function buildCodexNotifyArgv(
  launch: LocalConnectorLaunchCommand,
  configPath: string,
  forwardNotify?: readonly string[] | null,
): string[] {
  return [
    ...launch.argv,
    'dispatch-codex-notify',
    '--config',
    resolve(configPath),
    '--source',
    LOCAL_CONNECTOR_MANAGED_SOURCE,
    ...(forwardNotify?.length
      ? ['--forward-notify', JSON.stringify(forwardNotify)]
      : []),
  ];
}

function buildHookCommands(
  launch: LocalConnectorLaunchCommand,
  configPath: string,
  kind: 'hook' | 'notify',
  agent: LocalConnectorAgent,
): { command: string; commandWindows: string; argv: string[] } {
  const normalized = validateLaunchCommand(launch);
  const argv = buildEmitArgv(normalized, configPath, kind, agent);
  const values = [normalized.executable, ...argv];
  return {
    command: values.map(shellQuotePosix).join(' '),
    commandWindows: values.map(shellQuoteWindows).join(' '),
    argv,
  };
}

function managedCommand(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.includes(`--source ${LOCAL_CONNECTOR_MANAGED_SOURCE}`)
    || value.includes(`--source" "${LOCAL_CONNECTOR_MANAGED_SOURCE}`)
    || value.includes(`--source' '${LOCAL_CONNECTOR_MANAGED_SOURCE}`);
}

function parseJsonConfig(snapshot: Awaited<ReturnType<typeof readOptionalFile>>, label: string): JsonRecord {
  if (!snapshot.exists) return {};
  try {
    const value = JSON.parse(snapshot.data.toString('utf8'));
    if (!isRecord(value)) throw new Error('root is not object');
    return value;
  } catch {
    throw new Error(`${label} 不是有效的 JSON 对象`);
  }
}

function removeManagedHooks(document: JsonRecord): boolean {
  if (!isRecord(document.hooks)) return false;
  let changed = false;
  for (const [eventName, rawGroups] of Object.entries(document.hooks)) {
    if (!Array.isArray(rawGroups)) continue;
    const nextGroups: unknown[] = [];
    for (const rawGroup of rawGroups) {
      if (!isRecord(rawGroup) || !Array.isArray(rawGroup.hooks)) {
        nextGroups.push(rawGroup);
        continue;
      }
      const nextHandlers = rawGroup.hooks.filter((rawHandler) => {
        if (!isRecord(rawHandler)) return true;
        const remove = rawHandler.type === 'command'
          && (managedCommand(rawHandler.command) || managedCommand(rawHandler.commandWindows));
        if (remove) changed = true;
        return !remove;
      });
      if (nextHandlers.length > 0) nextGroups.push({ ...rawGroup, hooks: nextHandlers });
      else if (rawGroup.hooks.length === 0) nextGroups.push(rawGroup);
    }
    if (nextGroups.length > 0) (document.hooks as JsonRecord)[eventName] = nextGroups;
    else delete (document.hooks as JsonRecord)[eventName];
  }
  if (Object.keys(document.hooks as JsonRecord).length === 0) delete document.hooks;
  return changed;
}

function installJsonHooks(input: {
  document: JsonRecord;
  events: string[];
  commands: { command: string; commandWindows: string };
  agent: LocalConnectorAgent;
}): boolean {
  removeManagedHooks(input.document);
  const hooks = isRecord(input.document.hooks) ? input.document.hooks : {};
  input.document.hooks = hooks;
  for (const eventName of input.events) {
    const handler: JsonRecord = {
      type: 'command',
      command: input.commands.command,
      timeout: 10,
    };
    if (input.agent === 'codex') handler.commandWindows = input.commands.commandWindows;
    const groups = Array.isArray(hooks[eventName]) ? hooks[eventName] as unknown[] : [];
    groups.push({ hooks: [handler] });
    hooks[eventName] = groups;
  }
  return true;
}

function normalizeHookEvents(manifest: LocalConnectorActionManifest): string[] {
  const allowed = manifest.agent === 'codex' ? CODEX_HOOK_EVENTS : CLAUDE_HOOK_EVENTS;
  const defaults = manifest.agent === 'codex'
    ? ['SessionStart', 'SessionEnd', 'Stop']
    : ['SessionStart', 'SessionEnd', 'Stop'];
  const requested = manifest.eventNames.length > 0 ? manifest.eventNames : defaults;
  const normalized = [...new Set(requested.filter((eventName) => allowed.has(eventName)))];
  if (normalized.length === 0) throw new Error('动作没有可安装的受支持 Hook 事件');
  return normalized;
}

function targetPathForManifest(
  manifest: LocalConnectorActionManifest,
  paths: LocalConnectorTargetPaths,
): string {
  if (manifest.agent === 'codex') {
    return manifest.kind === 'hook'
      ? join(paths.codexHome, 'hooks.json')
      : join(paths.codexHome, 'config.toml');
  }
  return join(paths.claudeConfigDir, 'settings.json');
}

async function applyJsonAction(input: {
  manifest: LocalConnectorActionManifest;
  targetPath: string;
  commands: { command: string; commandWindows: string };
}): Promise<{ changed: boolean; details: Record<string, unknown> }> {
  const snapshot = await readOptionalFile(input.targetPath);
  const document = parseJsonConfig(snapshot, input.targetPath);
  if (input.manifest.operation === 'uninstall') {
    const changed = removeManagedHooks(document);
    if (changed) await atomicWriteFile(input.targetPath, `${JSON.stringify(document, null, 2)}\n`, snapshot.mode ?? 0o600);
    return { changed, details: { format: 'json' } };
  }
  const events = input.manifest.kind === 'notify'
    ? ['Notification']
    : normalizeHookEvents(input.manifest);
  installJsonHooks({
    document,
    events,
    commands: input.commands,
    agent: input.manifest.agent,
  });
  await atomicWriteFile(input.targetPath, `${JSON.stringify(document, null, 2)}\n`, snapshot.mode ?? 0o600);
  return { changed: true, details: { format: 'json', events } };
}

function sameStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

export function isManagedNotifyArgv(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(
    (item, index) => item === '--source' && value[index + 1] === LOCAL_CONNECTOR_MANAGED_SOURCE,
  );
}

export function parseArgvJson(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) return null;
    return parsed.every((item) => typeof item === 'string' && Boolean(item) && item.length <= 4_096)
      ? parsed as string[]
      : null;
  } catch {
    return null;
  }
}

function previousCodexNotifyArgv(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const argv = value.filter((item): item is string => typeof item === 'string' && Boolean(item));
  if (argv.length !== value.length || argv.length > 32) return null;
  if (isManagedNotifyArgv(argv)) {
    const forwardIndex = argv.indexOf('--forward-notify');
    return forwardIndex >= 0 ? parseArgvJson(argv[forwardIndex + 1]) : null;
  }
  const legacyForwardIndex = argv.indexOf('--previous-notify');
  if (legacyForwardIndex >= 0) {
    const legacyForward = parseArgvJson(argv[legacyForwardIndex + 1]);
    if (legacyForward && isManagedNotifyArgv(legacyForward)) {
      return argv.filter((_, index) => index !== legacyForwardIndex && index !== legacyForwardIndex + 1);
    }
  }
  return argv;
}

async function applyCodexNotifyAction(input: {
  manifest: LocalConnectorActionManifest;
  targetPath: string;
  launch: LocalConnectorLaunchCommand;
  configPath: string;
}): Promise<{ changed: boolean; details: Record<string, unknown> }> {
  const snapshot = await readOptionalFile(input.targetPath);
  let document: JsonRecord;
  try {
    const parsed = snapshot.exists ? parseToml(snapshot.data.toString('utf8')) : {};
    if (!isRecord(parsed)) throw new Error('root is not object');
    document = parsed;
  } catch {
    throw new Error(`${input.targetPath} 不是有效的 TOML`);
  }
  const launch = validateLaunchCommand(input.launch);
  const expected = [launch.executable, ...buildCodexNotifyArgv(launch, input.configPath)];
  if (input.manifest.operation === 'uninstall') {
    if (!sameStringArray(document.notify, expected) && !isManagedNotifyArgv(document.notify)) {
      return { changed: false, details: { format: 'toml' } };
    }
    delete document.notify;
  } else {
    const previousNotify = previousCodexNotifyArgv(document.notify);
    document.notify = [
      launch.executable,
      ...buildCodexNotifyArgv(launch, input.configPath, previousNotify),
    ];
  }
  const serialized = stringifyToml(document);
  await atomicWriteFile(input.targetPath, serialized.endsWith('\n') ? serialized : `${serialized}\n`, snapshot.mode ?? 0o600);
  return { changed: true, details: { format: 'toml' } };
}

export async function executeLocalConnectorAction(
  manifestInput: unknown,
  options: {
    dataDir: string;
    backupKey: string;
    configPath: string;
    launch: LocalConnectorLaunchCommand;
    paths?: LocalConnectorTargetPaths;
  },
): Promise<LocalConnectorActionExecutionResult> {
  if (!isLocalConnectorActionManifest(manifestInput)) throw new Error('Connector 动作清单无效');
  const manifest = manifestInput;
  const paths = options.paths || resolveLocalConnectorTargetPaths();
  const targetPath = targetPathForManifest(manifest, paths);

  if (manifest.operation === 'rollback') {
    if (!manifest.backupRef) throw new Error('回滚动作缺少 backupRef');
    const restored = await restoreLocalConnectorBackup({
      dataDir: options.dataDir,
      backupKey: options.backupKey,
      backupRef: manifest.backupRef,
      targetPath,
      agent: manifest.agent,
      kind: manifest.kind,
    });
    return {
      changed: restored.restored,
      target: targetPath,
      operation: manifest.operation,
      backupRef: manifest.backupRef,
      details: { restoredExistingFile: restored.existed, sha256: restored.sha256 },
    };
  }

  const backup = await createLocalConnectorBackup({
    dataDir: options.dataDir,
    backupKey: options.backupKey,
    targetPath,
    agent: manifest.agent,
    kind: manifest.kind,
  });
  if (manifest.operation === 'backup') {
    return {
      changed: false,
      target: targetPath,
      operation: manifest.operation,
      backupRef: backup.backupRef,
      details: { backedUpExistingFile: backup.existed, sha256: backup.sha256 },
    };
  }

  const commands = buildHookCommands(options.launch, options.configPath, manifest.kind, manifest.agent);
  const applied = manifest.agent === 'codex' && manifest.kind === 'notify'
    ? await applyCodexNotifyAction({
      manifest,
      targetPath,
      launch: options.launch,
      configPath: options.configPath,
    })
    : await applyJsonAction({ manifest, targetPath, commands });
  return {
    changed: applied.changed,
    target: targetPath,
    operation: manifest.operation,
    backupRef: backup.backupRef,
    details: {
      ...applied.details,
      backedUpExistingFile: backup.existed,
      previousSha256: backup.sha256,
    },
  };
}
