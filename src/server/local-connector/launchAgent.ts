import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { atomicWriteFile, ensurePrivateDirectory, readOptionalFile } from './atomicFile.js';
import type { LocalConnectorConfig } from './config.js';

type CommandExecutor = (executable: string, argv: readonly string[]) => Promise<void>;

export type LocalConnectorServiceInstallOptions = Readonly<{
  configPath: string;
  config: LocalConnectorConfig;
  connectorLabel: string;
  reloaderLabel?: string | null;
  installConfigWatcher?: boolean;
  nodeExecutable: string;
  cliEntryPath: string;
  codexHome: string;
  codexExecutable: string;
  appServerSocketPath: string;
  dashboardHost?: string;
  dashboardPort?: number;
  launchAgentsDir?: string;
  home?: string;
  pathEnvironment?: string;
  uid?: number;
  now?: () => Date;
  execute?: CommandExecutor;
  wait?: (ms: number) => Promise<void>;
  verify?: () => Promise<void>;
  platform?: NodeJS.Platform;
}>;

export type LocalConnectorServiceInstallResult = Readonly<{
  connectorLabel: string;
  connectorPlistPath: string;
  reloaderLabel: string | null;
  reloaderPlistPath: string | null;
  backupDir: string | null;
  cliEntryPath: string;
  nodeExecutable: string;
  dashboardHealthUrl: string;
}>;

function normalizedLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(normalized)) throw new Error(`${label} 格式无效`);
  return normalized;
}

function normalizedAbsolutePath(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes('\0')) throw new Error(`${label} 无效`);
  const absolute = resolve(normalized);
  if (absolute !== normalized) throw new Error(`${label} 必须是绝对路径`);
  return absolute;
}

function xmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistString(value: string, indent: string): string {
  return `${indent}<string>${xmlText(value)}</string>`;
}

function renderStringDictionary(values: Readonly<Record<string, string>>, indent: string): string[] {
  const lines = [`${indent}<dict>`];
  for (const key of Object.keys(values).sort()) {
    lines.push(`${indent}\t<key>${xmlText(key)}</key>`);
    lines.push(plistString(values[key]!, `${indent}\t`));
  }
  lines.push(`${indent}</dict>`);
  return lines;
}

export function renderLaunchAgentPlist(input: Readonly<{
  label: string;
  programArguments: readonly string[];
  environment: Readonly<Record<string, string>>;
  stdoutPath: string;
  stderrPath: string;
  throttleInterval: number;
  processType?: 'Background';
}>): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    plistString(input.label, '\t'),
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...input.programArguments.map((argument) => plistString(argument, '\t\t')),
    '\t</array>',
    '\t<key>EnvironmentVariables</key>',
    ...renderStringDictionary(input.environment, '\t'),
    ...(input.processType ? [
      '\t<key>ProcessType</key>',
      plistString(input.processType, '\t'),
    ] : []),
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<true/>',
    '\t<key>ThrottleInterval</key>',
    `\t<integer>${input.throttleInterval}</integer>`,
    '\t<key>StandardOutPath</key>',
    plistString(input.stdoutPath, '\t'),
    '\t<key>StandardErrorPath</key>',
    plistString(input.stderrPath, '\t'),
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

function defaultExecute(executable: string, argv: readonly string[]): Promise<void> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, [...argv], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      const detail = Buffer.concat(stderr.length > 0 ? stderr : stdout)
        .toString('utf8')
        .trim()
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 2_000);
      reject(new Error(`${executable} ${argv.join(' ')} failed (${signal || code}): ${detail || 'no output'}`));
    });
  });
}

async function ensureFile(path: string, label: string, executable: boolean): Promise<void> {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw new Error(`${label} 不存在或不是普通文件: ${path}`);
  await access(path, constants.R_OK | (executable ? constants.X_OK : 0));
}

async function assertStandalonePackage(cliEntryPath: string): Promise<void> {
  const manifestPath = join(dirname(dirname(cliEntryPath)), 'package.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('install-service 必须从独立安装的 metapi-connector npm 包运行');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || (manifest as Record<string, unknown>).name !== 'metapi-connector') {
    throw new Error('install-service 必须从独立安装的 metapi-connector npm 包运行');
  }
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '-');
}

function servicePath(nodeExecutable: string, value?: string): string {
  const candidates = [
    dirname(nodeExecutable),
    ...(value || '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const allowed = new Set([
    dirname(nodeExecutable),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);
  return [...new Set(candidates.map((item) => item.trim()).filter((item) => allowed.has(item)))].join(':');
}

type ServiceFileSnapshot = Readonly<{
  path: string;
  exists: boolean;
  data: Buffer;
  mode: number;
}>;

async function snapshotServiceFiles(paths: readonly string[]): Promise<readonly ServiceFileSnapshot[]> {
  const snapshots: ServiceFileSnapshot[] = [];
  for (const path of paths) {
    const snapshot = await readOptionalFile(path, 512 * 1024);
    snapshots.push(Object.freeze({
      path,
      exists: snapshot.exists,
      data: snapshot.data,
      mode: snapshot.mode || 0o644,
    }));
  }
  return Object.freeze(snapshots);
}

async function backupExistingFiles(
  snapshots: readonly ServiceFileSnapshot[],
  backupDir: string,
): Promise<string | null> {
  const existing = snapshots.filter((snapshot) => snapshot.exists);
  if (existing.length === 0) return null;
  await ensurePrivateDirectory(backupDir);
  await Promise.all(existing.map((snapshot) => atomicWriteFile(
    join(backupDir, basename(snapshot.path)),
    snapshot.data,
    0o600,
  )));
  return backupDir;
}

async function restoreServiceFiles(snapshots: readonly ServiceFileSnapshot[]): Promise<void> {
  await Promise.all(snapshots.map((snapshot) => snapshot.exists
    ? atomicWriteFile(snapshot.path, snapshot.data, snapshot.mode)
    : rm(snapshot.path, { force: true })));
}

async function bootstrapWithRetry(input: {
  execute: CommandExecutor;
  wait: (ms: number) => Promise<void>;
  uid: number;
  plistPath: string;
}): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await input.execute('/bin/launchctl', ['bootstrap', `gui/${input.uid}`, input.plistPath]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await input.wait((attempt + 1) * 500);
    }
  }
  throw lastError;
}

async function bootout(execute: CommandExecutor, uid: number, label: string): Promise<void> {
  await execute('/bin/launchctl', ['bootout', `gui/${uid}/${label}`]).catch(() => undefined);
}

export async function installLocalConnectorServices(
  options: LocalConnectorServiceInstallOptions,
): Promise<LocalConnectorServiceInstallResult> {
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('install-service 当前仅支持 macOS LaunchAgent');
  }
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || (uid as number) < 0) throw new Error('无法确定当前用户 UID');
  const connectorLabel = normalizedLabel(options.connectorLabel, 'Connector launchd label');
  const installConfigWatcher = options.installConfigWatcher !== false;
  const reloaderLabel = installConfigWatcher
    ? normalizedLabel(options.reloaderLabel || `${connectorLabel}.codex-runtime`, 'Reloader launchd label')
    : null;
  if (reloaderLabel === connectorLabel) throw new Error('Connector 与 Reloader launchd label 不能相同');

  const home = normalizedAbsolutePath(options.home || homedir(), 'HOME');
  const configPath = normalizedAbsolutePath(options.configPath, 'Connector config path');
  const nodeExecutable = normalizedAbsolutePath(options.nodeExecutable, 'Node executable');
  const cliEntryPath = normalizedAbsolutePath(options.cliEntryPath, 'Connector CLI entry');
  const codexHome = normalizedAbsolutePath(options.codexHome, 'CODEX_HOME');
  const codexExecutable = normalizedAbsolutePath(options.codexExecutable, 'Codex executable');
  const appServerSocketPath = normalizedAbsolutePath(options.appServerSocketPath, 'App Server socket');
  const dashboardHost = options.dashboardHost?.trim() || '127.0.0.1';
  if (dashboardHost !== '127.0.0.1') {
    throw new Error('install-service 的 Dashboard 必须监听 127.0.0.1');
  }
  const dashboardPort = Math.trunc(options.dashboardPort ?? 4_765);
  if (!Number.isInteger(dashboardPort) || dashboardPort < 1 || dashboardPort > 65_535) {
    throw new Error('Dashboard 端口必须在 1 到 65535 之间');
  }
  await Promise.all([
    ensureFile(configPath, 'Connector config', false),
    ensureFile(nodeExecutable, 'Node executable', true),
    ensureFile(cliEntryPath, 'Connector CLI entry', false),
    ...(installConfigWatcher ? [ensureFile(codexExecutable, 'Codex executable', true)] : []),
  ]);
  await assertStandalonePackage(cliEntryPath);

  const launchAgentsDir = normalizedAbsolutePath(
    options.launchAgentsDir || join(home, 'Library', 'LaunchAgents'),
    'LaunchAgents directory',
  );
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(options.config.dataDir);
  const connectorPlistPath = join(launchAgentsDir, `${connectorLabel}.plist`);
  const reloaderPlistPath = reloaderLabel ? join(launchAgentsDir, `${reloaderLabel}.plist`) : null;
  const serviceSnapshots = await snapshotServiceFiles([
    connectorPlistPath,
    ...(reloaderPlistPath ? [reloaderPlistPath] : []),
  ]);
  const backupDir = await backupExistingFiles(
    serviceSnapshots,
    join(options.config.dataDir, 'service-backups', timestamp((options.now || (() => new Date()))())),
  );
  const pathEnvironment = servicePath(nodeExecutable, options.pathEnvironment);
  const connectorPlist = renderLaunchAgentPlist({
    label: connectorLabel,
    programArguments: [
      nodeExecutable,
      cliEntryPath,
      'run',
      '--config',
      configPath,
      '--direct',
      '--dashboard-host',
      dashboardHost,
      '--dashboard-port',
      String(dashboardPort),
    ],
    environment: {
      CODEX_APP_SERVER_USE_LOCAL_DAEMON: '1',
      HOME: home,
      PATH: pathEnvironment,
    },
    stdoutPath: join(options.config.dataDir, 'launchd.stdout.log'),
    stderrPath: join(options.config.dataDir, 'launchd.stderr.log'),
    throttleInterval: 10,
  });
  const reloaderPlist = reloaderLabel && reloaderPlistPath
    ? renderLaunchAgentPlist({
      label: reloaderLabel,
      programArguments: [
        nodeExecutable,
        cliEntryPath,
        'watch-codex-runtime',
        '--codex-home',
        codexHome,
        '--codex-executable',
        codexExecutable,
        '--connector-launchd-label',
        connectorLabel,
        '--config',
        configPath,
        '--app-server-socket',
        appServerSocketPath,
        '--debounce-ms',
        '1200',
        '--watch-interval-ms',
        '1000',
      ],
      environment: { CODEX_HOME: codexHome, HOME: home, PATH: pathEnvironment },
      stdoutPath: join(options.config.dataDir, 'codex-runtime-watcher.stdout.log'),
      stderrPath: join(options.config.dataDir, 'codex-runtime-watcher.stderr.log'),
      throttleInterval: 5,
      processType: 'Background',
    })
    : null;

  const execute = options.execute || defaultExecute;
  const wait = options.wait || ((ms: number) => new Promise<void>((resolveWait) => setTimeout(resolveWait, ms)));
  const stagedConnectorPlist = join(options.config.dataDir, '.connector-launch-agent.next.plist');
  const stagedReloaderPlist = reloaderPlist ? join(options.config.dataDir, '.codex-runtime-launch-agent.next.plist') : null;
  await atomicWriteFile(stagedConnectorPlist, connectorPlist, 0o600);
  if (stagedReloaderPlist && reloaderPlist) await atomicWriteFile(stagedReloaderPlist, reloaderPlist, 0o600);
  try {
    await execute('/usr/bin/plutil', ['-lint', stagedConnectorPlist]);
    if (stagedReloaderPlist) await execute('/usr/bin/plutil', ['-lint', stagedReloaderPlist]);
  } catch (error) {
    await Promise.all([
      rm(stagedConnectorPlist, { force: true }),
      ...(stagedReloaderPlist ? [rm(stagedReloaderPlist, { force: true })] : []),
    ]);
    throw error;
  }
  await atomicWriteFile(connectorPlistPath, connectorPlist, 0o644);
  if (reloaderPlistPath && reloaderPlist) await atomicWriteFile(reloaderPlistPath, reloaderPlist, 0o644);
  await Promise.all([
    rm(stagedConnectorPlist, { force: true }),
    ...(stagedReloaderPlist ? [rm(stagedReloaderPlist, { force: true })] : []),
  ]);
  try {
    if (reloaderLabel) await bootout(execute, uid as number, reloaderLabel);
    await bootout(execute, uid as number, connectorLabel);
    await execute('/bin/launchctl', ['setenv', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', '1']);
    await bootstrapWithRetry({ execute, wait, uid: uid as number, plistPath: connectorPlistPath });
    if (reloaderPlistPath) {
      await bootstrapWithRetry({ execute, wait, uid: uid as number, plistPath: reloaderPlistPath });
    }
    await options.verify?.();
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (reloaderLabel) await bootout(execute, uid as number, reloaderLabel);
    await bootout(execute, uid as number, connectorLabel);
    try {
      await restoreServiceFiles(serviceSnapshots);
      const connectorSnapshot = serviceSnapshots.find((snapshot) => snapshot.path === connectorPlistPath);
      const reloaderSnapshot = reloaderPlistPath
        ? serviceSnapshots.find((snapshot) => snapshot.path === reloaderPlistPath)
        : null;
      if (connectorSnapshot?.exists) {
        await bootstrapWithRetry({ execute, wait, uid: uid as number, plistPath: connectorPlistPath });
      }
      if (reloaderSnapshot?.exists && reloaderPlistPath) {
        await bootstrapWithRetry({ execute, wait, uid: uid as number, plistPath: reloaderPlistPath });
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length > 0
      ? `${message}；恢复旧 LaunchAgent 失败: ${rollbackErrors.join('；')}`
      : `${message}；已恢复安装前 LaunchAgent 状态`);
  }
  return Object.freeze({
    connectorLabel,
    connectorPlistPath,
    reloaderLabel,
    reloaderPlistPath,
    backupDir,
    cliEntryPath,
    nodeExecutable,
    dashboardHealthUrl: `http://127.0.0.1:${dashboardPort}/healthz`,
  });
}

export async function uninstallLocalConnectorServices(input: Readonly<{
  connectorLabel: string;
  reloaderLabel?: string | null;
  launchAgentsDir?: string;
  home?: string;
  uid?: number;
  execute?: CommandExecutor;
  platform?: NodeJS.Platform;
}>): Promise<Readonly<{
  connectorLabel: string;
  connectorPlistPath: string;
  reloaderLabel: string | null;
  reloaderPlistPath: string | null;
}>> {
  if ((input.platform || process.platform) !== 'darwin') {
    throw new Error('uninstall-service 当前仅支持 macOS LaunchAgent');
  }
  const uid = input.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || (uid as number) < 0) throw new Error('无法确定当前用户 UID');
  const connectorLabel = normalizedLabel(input.connectorLabel, 'Connector launchd label');
  const reloaderLabel = input.reloaderLabel === null
    ? null
    : normalizedLabel(input.reloaderLabel || `${connectorLabel}.codex-runtime`, 'Reloader launchd label');
  const home = normalizedAbsolutePath(input.home || homedir(), 'HOME');
  const launchAgentsDir = normalizedAbsolutePath(
    input.launchAgentsDir || join(home, 'Library', 'LaunchAgents'),
    'LaunchAgents directory',
  );
  const connectorPlistPath = join(launchAgentsDir, `${connectorLabel}.plist`);
  const reloaderPlistPath = reloaderLabel ? join(launchAgentsDir, `${reloaderLabel}.plist`) : null;
  const execute = input.execute || defaultExecute;
  if (reloaderLabel) await bootout(execute, uid as number, reloaderLabel);
  await bootout(execute, uid as number, connectorLabel);
  await Promise.all([
    rm(connectorPlistPath, { force: true }),
    ...(reloaderPlistPath ? [rm(reloaderPlistPath, { force: true })] : []),
  ]);
  return Object.freeze({ connectorLabel, connectorPlistPath, reloaderLabel, reloaderPlistPath });
}
