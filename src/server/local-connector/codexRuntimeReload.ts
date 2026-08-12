import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

type CommandExecutor = (executable: string, argv: readonly string[]) => Promise<void>;
type ProcessLookup = (socketPath: string) => Promise<number | null>;
type ProcessTerminator = (pid: number) => Promise<void>;

const UNMANAGED_APP_SERVER_ERROR = 'app server is running but is not managed by codex app-server daemon';
const CODEX_APP_SERVER_COMMAND = /(?:^|\/)codex(?:-[^/\s]+)?\s+app-server(?:\s|$)/;

export type CodexRuntimeReloadOptions = Readonly<{
  codexExecutable: string;
  connectorLaunchdLabel: string;
  appServerSocketPath: string;
  connectorHealthUrl?: string | null;
  debounceMs?: number;
  socketTimeoutMs?: number;
  connectorHealthTimeoutMs?: number;
  uid?: number;
  execute?: CommandExecutor;
  findUnmanagedAppServerPid?: ProcessLookup;
  terminateUnmanagedAppServer?: ProcessTerminator;
  socketExists?: (path: string) => Promise<boolean>;
  healthCheck?: (url: string) => Promise<boolean>;
  connectorHealthCheck?: () => Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
}>;

export type CodexRuntimeReloadResult = Readonly<{
  appServerRestarted: true;
  connectorRestarted: true;
  connectorHealthy: boolean | null;
  appServerOwnership?: 'managed' | 'reclaimed';
}>;

export type CodexRuntimeWatcherOptions = Readonly<{
  configPaths: readonly string[];
  reloadOptions: CodexRuntimeReloadOptions;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  reload?: (options: CodexRuntimeReloadOptions) => Promise<CodexRuntimeReloadResult>;
  fingerprint?: (paths: readonly string[]) => Promise<string>;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onReload?: (input: Readonly<{ changedAt: string; result: CodexRuntimeReloadResult }>) => void;
  onError?: (error: Error) => void;
}>;

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0
    ? Math.trunc(value as number)
    : fallback;
}

function validateLaunchdLabel(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(normalized)) {
    throw new Error('Connector launchd label 格式无效');
  }
  return normalized;
}

function defaultExecute(executable: string, argv: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
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
        resolve();
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

function captureCommand(executable: string, argv: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
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
        resolve(Buffer.concat(stdout).toString('utf8'));
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

async function defaultFindUnmanagedAppServerPid(socketPath: string): Promise<number | null> {
  let output: string;
  try {
    output = await captureCommand('/usr/sbin/lsof', ['-nP', '-a', '-t', '-U', socketPath]);
  } catch {
    return null;
  }
  const pids = [...new Set(output.split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
  for (const pid of pids) {
    try {
      const command = await captureCommand('/bin/ps', ['-p', String(pid), '-o', 'command=']);
      if (CODEX_APP_SERVER_COMMAND.test(command.trim())) return pid;
    } catch {
      // The process may disappear between lsof and ps; continue looking.
    }
  }
  return null;
}

async function defaultTerminateUnmanagedAppServer(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('App Server PID 无效');
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
    return;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return;
      if ((error as NodeJS.ErrnoException)?.code !== 'EPERM') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') throw error;
  }
}

function isUnmanagedAppServerError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes(UNMANAGED_APP_SERVER_ERROR);
}

async function defaultSocketExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function configFingerprint(paths: readonly string[]): Promise<string> {
  const hash = createHash('sha256').update('metapi-codex-runtime-config\0');
  for (const path of paths) {
    hash.update(path).update('\0');
    try {
      hash.update(await readFile(path)).update('\0');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') throw error;
      hash.update('<missing>\0');
    }
  }
  return hash.digest('hex');
}

async function waitForCondition(input: {
  timeoutMs: number;
  check: () => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  do {
    if (await input.check()) return true;
    await input.wait(Math.min(250, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  return await input.check();
}

export async function reloadCodexRuntime(
  options: CodexRuntimeReloadOptions,
): Promise<CodexRuntimeReloadResult> {
  const codexExecutable = options.codexExecutable.trim();
  const socketPath = options.appServerSocketPath.trim();
  if (!codexExecutable) throw new Error('缺少 Codex executable');
  if (!socketPath) throw new Error('缺少 App Server socket path');
  const label = validateLaunchdLabel(options.connectorLaunchdLabel);
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid) || (uid as number) < 0) throw new Error('无法确定当前用户 UID');
  const execute = options.execute || defaultExecute;
  const findUnmanagedAppServerPid = options.findUnmanagedAppServerPid || defaultFindUnmanagedAppServerPid;
  const terminateUnmanagedAppServer = options.terminateUnmanagedAppServer || defaultTerminateUnmanagedAppServer;
  const socketExists = options.socketExists || defaultSocketExists;
  const healthCheck = options.healthCheck || defaultHealthCheck;
  const wait = options.wait || defaultWait;

  const debounceMs = normalizedPositiveInteger(options.debounceMs, 1_200);
  if (debounceMs > 0) await wait(debounceMs);

  let appServerOwnership: 'managed' | 'reclaimed' = 'managed';
  try {
    await execute(codexExecutable, ['app-server', 'daemon', 'restart']);
  } catch (error) {
    if (!isUnmanagedAppServerError(error)) throw error;
    const pid = await findUnmanagedAppServerPid(socketPath);
    if (!pid) {
      throw new Error(`${UNMANAGED_APP_SERVER_ERROR}；未找到可安全接管的 Codex App Server 进程`);
    }
    await terminateUnmanagedAppServer(pid);
    await execute(codexExecutable, ['app-server', 'daemon', 'start']);
    appServerOwnership = 'reclaimed';
  }
  const socketReady = await waitForCondition({
    timeoutMs: normalizedPositiveInteger(options.socketTimeoutMs, 15_000),
    check: () => socketExists(socketPath),
    wait,
  });
  if (!socketReady) throw new Error(`Codex App Server socket 未在超时前恢复: ${socketPath}`);

  await execute('/bin/launchctl', [
    'kickstart',
    '-k',
    `gui/${uid}/${label}`,
  ]);

  const healthUrl = options.connectorHealthUrl?.trim() || null;
  const connectorHealthCheck = options.connectorHealthCheck
    || (healthUrl ? () => healthCheck(healthUrl) : null);
  const connectorHealthy = connectorHealthCheck
    ? await waitForCondition({
      timeoutMs: normalizedPositiveInteger(options.connectorHealthTimeoutMs, 20_000),
      check: connectorHealthCheck,
      wait,
    })
    : null;
  if (connectorHealthCheck && !connectorHealthy) {
    throw new Error(`Connector 重启后健康检查超时${healthUrl ? `: ${healthUrl}` : ''}`);
  }
  return Object.freeze({
    appServerRestarted: true,
    connectorRestarted: true,
    connectorHealthy,
    ...(appServerOwnership === 'reclaimed' ? { appServerOwnership } : {}),
  });
}

export async function watchCodexRuntimeConfig(
  options: CodexRuntimeWatcherOptions,
): Promise<void> {
  const paths = [...new Set(options.configPaths.map((path) => path.trim()).filter(Boolean))];
  if (paths.length === 0) throw new Error('至少需要一个 Codex 配置监听路径');
  const fingerprint = options.fingerprint || configFingerprint;
  const reload = options.reload || reloadCodexRuntime;
  const wait = options.wait || waitWithSignal;
  const pollIntervalMs = Math.max(250, normalizedPositiveInteger(options.pollIntervalMs, 1_000));
  const retryDelayMs = Math.max(1_000, normalizedPositiveInteger(options.retryDelayMs, 5_000));
  let observedFingerprint = await fingerprint(paths);
  let reloadPending = false;

  while (!options.signal?.aborted) {
    await wait(reloadPending ? retryDelayMs : pollIntervalMs, options.signal);
    if (options.signal?.aborted) break;
    try {
      const nextFingerprint = await fingerprint(paths);
      if (nextFingerprint !== observedFingerprint) {
        observedFingerprint = nextFingerprint;
        reloadPending = true;
      }
      if (!reloadPending) continue;
      const result = await reload(options.reloadOptions);
      // Codex may normalize auth.json or config.toml while its App Server starts.
      // Re-baseline after a successful reload so those writes stay part of the
      // same configuration change instead of triggering another restart cycle.
      observedFingerprint = await fingerprint(paths);
      reloadPending = false;
      options.onReload?.({ changedAt: new Date().toISOString(), result });
    } catch (error) {
      reloadPending = true;
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
