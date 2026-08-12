import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  atomicRemoveFile,
  atomicWriteFile,
  ensurePrivateDirectory,
  readOptionalFile,
} from './atomicFile.js';

const RUNTIME_LOCK_FILENAME = 'connector.lock';
const LEGACY_PID_FILENAME = 'connector.pid';

export type ConnectorRuntimeLock = Readonly<{
  pid: number;
  startedAt: string;
  serviceManager: 'launchd' | null;
  serviceLabel: string | null;
}>;

export type ConnectorRuntimeState = Readonly<{
  lockPath: string;
  pidPath: string;
  lockStatus: 'active' | 'stale' | 'missing' | 'invalid';
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  serviceManager: 'launchd' | null;
  serviceLabel: string | null;
  pidFilePid: number | null;
  pidFileMatchesLock: boolean;
  launchd: Readonly<{
    available: boolean;
    state: string | null;
    pid: number | null;
    matchesLock: boolean | null;
  }> | null;
}>;

function runtimePaths(dataDir: string) {
  return {
    lockPath: join(dataDir, RUNTIME_LOCK_FILENAME),
    pidPath: join(dataDir, LEGACY_PID_FILENAME),
  };
}

function normalizedPid(value: unknown): number | null {
  const pid = Math.trunc(Number(value));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function parseRuntimeLock(value: Buffer): ConnectorRuntimeLock | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Record<string, unknown>;
    const pid = normalizedPid(parsed.pid);
    const startedAt = typeof parsed.startedAt === 'string' && Number.isFinite(Date.parse(parsed.startedAt))
      ? parsed.startedAt
      : null;
    if (!pid || !startedAt) return null;
    const serviceLabel = typeof parsed.serviceLabel === 'string' && parsed.serviceLabel.trim()
      ? parsed.serviceLabel.trim()
      : null;
    return Object.freeze({
      pid,
      startedAt,
      serviceManager: parsed.serviceManager === 'launchd' || serviceLabel ? 'launchd' : null,
      serviceLabel,
    });
  } catch {
    return null;
  }
}

async function readPidFile(path: string): Promise<number | null> {
  const snapshot = await readOptionalFile(path, 128);
  if (!snapshot.exists) return null;
  return normalizedPid(snapshot.data.toString('utf8').trim());
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
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`));
    });
  });
}

async function inspectLaunchd(
  label: string | null,
  lockPid: number | null,
): Promise<ConnectorRuntimeState['launchd']> {
  if (process.platform !== 'darwin' || !label) return null;
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || (uid as number) < 0) return null;
  try {
    const output = await captureCommand('/bin/launchctl', ['print', `gui/${uid}/${label}`]);
    const state = output.match(/^\s*state\s*=\s*([^\r\n]+)$/m)?.[1]?.trim() || null;
    const pid = normalizedPid(output.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1]);
    return Object.freeze({
      available: true,
      state,
      pid,
      matchesLock: lockPid === null || pid === null ? null : pid === lockPid,
    });
  } catch {
    return Object.freeze({
      available: false,
      state: null,
      pid: null,
      matchesLock: lockPid === null ? null : false,
    });
  }
}

export async function inspectConnectorRuntimeState(
  dataDir: string,
  options: Readonly<{ serviceLabel?: string | null }> = {},
): Promise<ConnectorRuntimeState> {
  const { lockPath, pidPath } = runtimePaths(dataDir);
  const [lockSnapshot, pidFilePid] = await Promise.all([
    readOptionalFile(lockPath, 8 * 1024),
    readPidFile(pidPath),
  ]);
  const lock = lockSnapshot.exists ? parseRuntimeLock(lockSnapshot.data) : null;
  const running = Boolean(lock && processIsAlive(lock.pid));
  const lockStatus: ConnectorRuntimeState['lockStatus'] = !lockSnapshot.exists
    ? 'missing'
    : !lock
      ? 'invalid'
      : running
        ? 'active'
        : 'stale';
  const serviceLabel = lock?.serviceLabel || options.serviceLabel?.trim() || null;
  const launchd = await inspectLaunchd(serviceLabel, lock?.pid || null);
  return Object.freeze({
    lockPath,
    pidPath,
    lockStatus,
    running,
    pid: lock?.pid || null,
    startedAt: lock?.startedAt || null,
    serviceManager: lock?.serviceManager || (serviceLabel ? 'launchd' : null),
    serviceLabel,
    pidFilePid,
    pidFileMatchesLock: Boolean(lock && pidFilePid === lock.pid),
    launchd,
  });
}

async function removeRuntimeFileOwnedBy(path: string, pid: number, kind: 'lock' | 'pid'): Promise<void> {
  const snapshot = await readOptionalFile(path, 8 * 1024);
  if (!snapshot.exists) return;
  const ownerPid = kind === 'lock'
    ? parseRuntimeLock(snapshot.data)?.pid || null
    : normalizedPid(snapshot.data.toString('utf8').trim());
  if (ownerPid === pid) await atomicRemoveFile(path).catch(() => undefined);
}

export async function acquireConnectorRuntimeState(dataDir: string): Promise<() => Promise<void>> {
  await ensurePrivateDirectory(dataDir);
  const { lockPath, pidPath } = runtimePaths(dataDir);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const serviceLabel = process.env.XPC_SERVICE_NAME?.trim() || null;
      const lock: ConnectorRuntimeLock = Object.freeze({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        serviceManager: serviceLabel ? 'launchd' : null,
        serviceLabel,
      });
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`);
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await atomicRemoveFile(lockPath).catch(() => undefined);
        throw error;
      }
      await handle.close();
      try {
        await atomicWriteFile(pidPath, `${process.pid}\n`, 0o600);
      } catch (error) {
        await removeRuntimeFileOwnedBy(lockPath, process.pid, 'lock');
        throw error;
      }
      return async () => {
        await Promise.all([
          removeRuntimeFileOwnedBy(lockPath, process.pid, 'lock'),
          removeRuntimeFileOwnedBy(pidPath, process.pid, 'pid'),
        ]);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const snapshot = await readOptionalFile(lockPath, 8 * 1024);
      const lock = parseRuntimeLock(snapshot.data);
      if (!lock) throw new Error('Connector 运行锁损坏，请确认无运行实例后删除 connector.lock');
      if (processIsAlive(lock.pid)) throw new Error(`Connector 已在运行 (pid ${lock.pid})`);
      await Promise.all([
        atomicRemoveFile(lockPath),
        removeRuntimeFileOwnedBy(pidPath, lock.pid, 'pid'),
      ]);
    }
  }
  throw new Error('无法获取 Connector 运行锁');
}
