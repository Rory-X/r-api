import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import WebSocket from 'ws';
import { CODEX_DESKTOP_APP_SERVER_CLIENT_INFO } from './identity.js';

export type NormalizedAppServerEvent = {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  idempotencyKey: string;
};

export type AppServerTransport = {
  readable: Readable;
  writable: Writable;
  close: () => Promise<void>;
};

const OBSERVED_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'turn/completed',
  'turn/plan/updated',
  'turn/diff/updated',
  'item/started',
  'item/completed',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value[key]) ? value[key] as Record<string, unknown> : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeIdentifier(value: string | null): string | null {
  if (!value) return null;
  return /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;
}

function safeErrorMessage(value: unknown): string | null {
  const message = firstText(
    isRecord(value) ? value.message : null,
    isRecord(value) && isRecord(value.error) ? value.error.message : null,
  );
  if (!message) return null;
  return Buffer.from(message.replace(/[\r\n]+/g, ' '), 'utf8').subarray(0, 500).toString('utf8');
}

export function normalizeAppServerNotification(value: unknown): NormalizedAppServerEvent | null {
  if (!isRecord(value) || typeof value.method !== 'string' || !OBSERVED_METHODS.has(value.method)) return null;
  const params = isRecord(value.params) ? value.params : {};
  const thread = nestedRecord(params, 'thread');
  const turn = nestedRecord(params, 'turn');
  const item = nestedRecord(params, 'item');
  const statusRecord = nestedRecord(params, 'status');
  const threadId = safeIdentifier(firstText(params.threadId, params.thread_id, thread?.id));
  const turnId = safeIdentifier(firstText(params.turnId, params.turn_id, turn?.id));
  const itemId = safeIdentifier(firstText(params.itemId, params.item_id, item?.id));
  const status = safeIdentifier(firstText(
    typeof params.status === 'string' ? params.status : null,
    statusRecord?.type,
    statusRecord?.status,
    turn?.status,
    item?.status,
  ));
  const parts = [
    threadId ? `thread=${threadId}` : null,
    turnId ? `turn=${turnId}` : null,
    itemId ? `item=${itemId}` : null,
    status ? `status=${status}` : null,
  ].filter((part): part is string => Boolean(part));
  const errorMessage = value.method === 'error' ? safeErrorMessage(params) : null;
  if (errorMessage) parts.push(`error=${errorMessage}`);
  const message = parts.length > 0 ? parts.join(' ') : 'structured lifecycle event';
  const level = value.method === 'error' || status === 'failed'
    ? 'error'
    : status === 'interrupted' || status === 'cancelled'
      ? 'warning'
      : 'info';
  return {
    title: `Codex App Server: ${value.method}`,
    message,
    level,
    idempotencyKey: createHash('sha256')
      .update(`${value.method}\0${threadId || ''}\0${turnId || ''}\0${itemId || ''}\0${status || ''}`)
      .digest('hex'),
  };
}

export function resolveCodexAppServerEndpoint(input?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = input?.trim()
    || env.CODEX_APP_SERVER_ENDPOINT?.trim()
    || env.CODEX_COMPANION_APP_SERVER_ENDPOINT?.trim();
  if (explicit) return explicit;
  const socketPath = join(env.CODEX_HOME?.trim() || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
  return existsSync(socketPath) ? `unix:${socketPath}` : null;
}

function endpointPath(endpoint: string): string {
  const normalized = endpoint.trim();
  if (normalized.startsWith('unix:')) {
    const path = normalized.slice('unix:'.length);
    if (!isAbsolute(path)) throw new Error('App Server unix endpoint 必须是绝对路径');
    return path;
  }
  if (normalized.startsWith('npipe:')) {
    const path = normalized.slice('npipe:'.length);
    if (!path.startsWith('\\\\.\\pipe\\')) throw new Error('App Server named pipe endpoint 无效');
    return path;
  }
  if (isAbsolute(normalized)) return normalized;
  throw new Error('App Server observer 只支持本机 unix socket 或 named pipe');
}

export async function createSocketAppServerTransport(endpoint: string): Promise<AppServerTransport> {
  const path = endpointPath(endpoint);
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket('ws://localhost/', {
      // The Codex control socket uses tungstenite without extension negotiation.
      perMessageDeflate: false,
      createConnection: () => createConnection({ path }),
    });
    const onOpen = () => {
      candidate.off('error', onError);
      resolve(candidate);
    };
    const onError = (error: Error) => {
      candidate.off('open', onOpen);
      reject(error);
    };
    candidate.once('open', onOpen);
    candidate.once('error', onError);
  });

  const readable = new PassThrough();
  // A writable failure may destroy the readable on a later tick, after a
  // reconnecting client has already detached its own listeners. Keep the
  // transport boundary safe from an uncaught stream error in that window.
  readable.on('error', () => undefined);
  let bufferedOutput = '';
  let closed = false;
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      bufferedOutput += chunk.toString();
      const frames: string[] = [];
      let newline = bufferedOutput.indexOf('\n');
      while (newline >= 0) {
        const frame = bufferedOutput.slice(0, newline);
        bufferedOutput = bufferedOutput.slice(newline + 1);
        if (frame.trim()) frames.push(frame);
        newline = bufferedOutput.indexOf('\n');
      }
      let index = 0;
      const sendNext = (error?: Error) => {
        if (error) {
          callback(error);
          return;
        }
        const frame = frames[index++];
        if (frame === undefined) {
          callback();
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          callback(new Error('Codex App Server control WebSocket is not open'));
          return;
        }
        socket.send(frame, (sendError) => sendNext(sendError || undefined));
      };
      sendNext();
    },
  });

  // Writable callbacks surface transport failures as an `error` event. Keep
  // that event inside the transport boundary so a daemon restart cannot turn
  // a normal disconnect into an uncaught process-level exception.
  writable.on('error', (error) => {
    if (!closed && !readable.destroyed) readable.destroy(error);
  });

  const fail = (error: Error) => {
    if (closed) return;
    readable.destroy(error);
    writable.destroy(error);
  };
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      fail(new Error('Codex App Server control socket returned a binary frame'));
      return;
    }
    const payload = data.toString();
    readable.write(payload.endsWith('\n') ? payload : `${payload}\n`);
  });
  socket.on('error', fail);
  socket.on('close', () => {
    if (!closed) readable.end();
  });

  return {
    readable,
    writable,
    close: async () => {
      if (closed) return;
      closed = true;
      writable.end();
      if (socket.readyState === WebSocket.CLOSED) {
        readable.end();
        return;
      }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1_000);
        timeout.unref?.();
        socket.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        socket.close();
      });
      readable.end();
    },
  };
}

export async function createCodexAppServerTransport(input: {
  endpoint?: string | null;
  ownedExecutable?: string | null;
  cwd?: string;
}): Promise<AppServerTransport> {
  if (input.ownedExecutable) {
    return createOwnedAppServerTransport({ executable: input.ownedExecutable, cwd: input.cwd });
  }
  if (!input.endpoint) throw new Error('Codex App Server endpoint 缺失');
  return createSocketAppServerTransport(input.endpoint);
}

export async function createOwnedAppServerTransport(input: {
  executable: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
}): Promise<AppServerTransport> {
  const executable = input.executable.trim();
  if (!executable || executable.length > 4_096 || executable.includes('\0')) {
    throw new Error('Codex executable 无效');
  }
  const spawnProcess = input.spawnImpl || spawn;
  const spec = buildOwnedAppServerSpawnSpec(executable, input.cwd, input.env);
  const child = spawnProcess(spec.executable, spec.argv, spec.options) as ChildProcessWithoutNullStreams;
  child.stderr.setEncoding('utf8');
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return {
    readable: child.stdout,
    writable: child.stdin,
    close: async () => {
      child.stdin.end();
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

export function buildOwnedAppServerSpawnSpec(
  executable: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): {
  executable: string;
  argv: ['app-server'];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ['pipe', 'pipe', 'pipe'];
  };
} {
  const normalized = executable.trim();
  if (!normalized || normalized.length > 4_096 || normalized.includes('\0')) {
    throw new Error('Codex executable 无效');
  }
  return {
    executable: normalized,
    argv: ['app-server'],
    options: {
      cwd: cwd || process.cwd(),
      env: env || process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  };
}

export async function startCodexAppServerObserver(input: {
  endpoint?: string | null;
  ownedExecutable?: string | null;
  cwd?: string;
  signal?: AbortSignal;
  onEvent: (event: NormalizedAppServerEvent) => void | Promise<void>;
  onError?: (error: Error) => void;
  transportFactory?: () => Promise<AppServerTransport>;
}): Promise<{ close: () => Promise<void> }> {
  const transport = input.transportFactory
    ? await input.transportFactory()
    : input.ownedExecutable
      ? await createOwnedAppServerTransport({ executable: input.ownedExecutable, cwd: input.cwd })
      : await createSocketAppServerTransport(input.endpoint || '');
  transport.readable.setEncoding('utf8');
  let buffer = '';
  let closed = false;
  let initializeResolve: (() => void) | null = null;
  let initializeReject: ((error: Error) => void) | null = null;
  const initialized = new Promise<void>((resolve, reject) => {
    initializeResolve = resolve;
    initializeReject = reject;
  });
  const write = (message: Record<string, unknown>) => {
    if (!closed) transport.writable.write(`${JSON.stringify(message)}\n`);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    input.signal?.removeEventListener('abort', onAbort);
    await transport.close();
  };
  const onAbort = () => { void close(); };
  const fail = (error: Error) => {
    if (closed) return;
    initializeReject?.(error);
    initializeReject = null;
    input.onError?.(error);
  };
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error('Codex App Server 返回了无效 JSON'));
      return;
    }
    if (!isRecord(message)) return;
    if (message.id === 1 && !message.method) {
      if (message.error) fail(new Error(safeErrorMessage(message.error) || 'Codex App Server initialize 失败'));
      else {
        initializeResolve?.();
        initializeResolve = null;
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'r-api observer does not own interactive requests' },
      });
      return;
    }
    const event = normalizeAppServerNotification(message);
    if (event) void Promise.resolve(input.onEvent(event)).catch((error) => fail(error as Error));
  };
  transport.readable.on('data', (chunk: string | Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }
  });
  transport.readable.on('error', (error) => fail(error as Error));
  transport.readable.on('close', () => fail(new Error('Codex App Server observer connection closed')));
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });

  write({
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: CODEX_DESKTOP_APP_SERVER_CLIENT_INFO,
      capabilities: { experimentalApi: true },
    },
  });
  const timeout = setTimeout(() => initializeReject?.(new Error('Codex App Server initialize 超时')), 5_000);
  timeout.unref?.();
  try {
    await initialized;
    write({ method: 'initialized', params: {} });
    return { close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
