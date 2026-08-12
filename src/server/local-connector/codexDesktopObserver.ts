import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export type CodexDesktopSessionSnapshot = Readonly<{
  threadId: string;
  status: 'loaded' | 'active';
  activeTurnId: string | null;
  lastTurnId: string | null;
  lastTurnStatus: 'completed' | null;
  lastTurnAt: string | null;
  updatedAt: string;
}>;

type LifecycleEvent = Readonly<{
  type: 'task_started' | 'task_complete';
  turnId: string;
  occurredAt: string;
}>;

type RolloutCursor = {
  offset: number;
  pendingLine: string;
  latest: LifecycleEvent | null;
};

const THREAD_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LIFECYCLE_PREFIX_PATTERN = /"type":"event_msg","payload":\{"type":"task_(?:started|complete)"/;
const ROLLOUT_INDEX_REFRESH_MS = 30_000;
const READ_CHUNK_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isoTimestamp(value: unknown): string | null {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseLifecycleLine(line: string): LifecycleEvent | null {
  if (!LIFECYCLE_PREFIX_PATTERN.test(line)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== 'event_msg' || !isRecord(value.payload)) return null;
  const type = value.payload.type;
  const turnId = value.payload.turn_id;
  const occurredAt = isoTimestamp(value.timestamp);
  if ((type !== 'task_started' && type !== 'task_complete')
    || typeof turnId !== 'string'
    || !THREAD_ID_PATTERN.test(turnId)
    || !occurredAt) {
    return null;
  }
  return Object.freeze({ type, turnId, occurredAt });
}

async function listRolloutFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRolloutFiles(path, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path);
    }
  }
  return files;
}

function rolloutThreadId(path: string): string | null {
  const match = /-([a-f0-9-]{36})\.jsonl$/i.exec(basename(path));
  return match && THREAD_ID_PATTERN.test(match[1]) ? match[1] : null;
}

export class CodexDesktopSessionObserver {
  private readonly codexHome: string;
  private readonly rolloutPaths = new Map<string, string>();
  private readonly cursors = new Map<string, RolloutCursor>();
  private indexedAt = 0;

  constructor(input: { codexHome?: string } = {}) {
    this.codexHome = input.codexHome || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  }

  async scan(): Promise<readonly CodexDesktopSessionSnapshot[]> {
    const locks = await this.readLocks();
    if (locks.length === 0) return Object.freeze([]);
    const missingRollout = locks.some((lock) => !this.rolloutPaths.has(lock.threadId));
    if (this.indexedAt === 0
      || (missingRollout && Date.now() - this.indexedAt >= ROLLOUT_INDEX_REFRESH_MS)) {
      await this.refreshRolloutIndex();
    }
    const sessions = await Promise.all(locks.map(async (lock) => {
      const rolloutPath = this.rolloutPaths.get(lock.threadId);
      const lifecycle = rolloutPath ? await this.readLatestLifecycle(rolloutPath) : null;
      let updatedAt = lock.updatedAt;
      if (rolloutPath) {
        try {
          const metadata = await stat(rolloutPath);
          if (metadata.mtimeMs > Date.parse(updatedAt)) updatedAt = metadata.mtime.toISOString();
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      }
      return Object.freeze({
        threadId: lock.threadId,
        status: lifecycle?.type === 'task_started' ? 'active' as const : 'loaded' as const,
        activeTurnId: lifecycle?.type === 'task_started' ? lifecycle.turnId : null,
        lastTurnId: lifecycle?.turnId || null,
        lastTurnStatus: lifecycle?.type === 'task_complete' ? 'completed' as const : null,
        lastTurnAt: lifecycle?.occurredAt || null,
        updatedAt,
      });
    }));
    return Object.freeze(sessions);
  }

  private async readLocks(): Promise<Array<{ threadId: string; updatedAt: string }>> {
    const root = join(this.codexHome, 'thread-writer-locks');
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw error;
    }
    const locks = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.lock'))
      .map(async (entry) => {
        const threadId = entry.name.slice(0, -'.lock'.length);
        if (!THREAD_ID_PATTERN.test(threadId)) return null;
        try {
          const metadata = await stat(join(root, entry.name));
          return { threadId, updatedAt: metadata.mtime.toISOString() };
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
          throw error;
        }
      }));
    return locks.filter((lock): lock is { threadId: string; updatedAt: string } => Boolean(lock));
  }

  private async refreshRolloutIndex(): Promise<void> {
    const paths = await listRolloutFiles(join(this.codexHome, 'sessions'));
    const next = new Map<string, string>();
    for (const path of paths.sort()) {
      const threadId = rolloutThreadId(path);
      if (threadId) next.set(threadId, path);
    }
    this.rolloutPaths.clear();
    for (const [threadId, path] of next) this.rolloutPaths.set(threadId, path);
    this.indexedAt = Date.now();
  }

  private async readLatestLifecycle(path: string): Promise<LifecycleEvent | null> {
    const metadata = await stat(path);
    let cursor = this.cursors.get(path);
    if (!cursor || metadata.size < cursor.offset) {
      cursor = { offset: 0, pendingLine: '', latest: null };
      this.cursors.set(path, cursor);
    }
    if (metadata.size === cursor.offset) return cursor.latest;

    const handle = await open(path, 'r');
    try {
      let position = cursor.offset;
      while (position < metadata.size) {
        const length = Math.min(READ_CHUNK_BYTES, metadata.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const lines = `${cursor.pendingLine}${buffer.subarray(0, bytesRead).toString('utf8')}`.split('\n');
        cursor.pendingLine = lines.pop() || '';
        for (const line of lines) {
          const event = parseLifecycleLine(line);
          if (event) cursor.latest = event;
        }
      }
      if (position === metadata.size && cursor.pendingLine) {
        const event = parseLifecycleLine(cursor.pendingLine);
        if (event) {
          cursor.latest = event;
          cursor.pendingLine = '';
        }
      }
      cursor.offset = position;
      return cursor.latest;
    } finally {
      await handle.close();
    }
  }
}
