import { join } from 'node:path';
import { atomicWriteFile, readOptionalFile } from './atomicFile.js';

type ThreadMetadataRecord = Readonly<{
  title: string;
  updatedAt: string;
}>;

type ThreadMetadataStore = Readonly<{
  protocol: 'metapi.local-connector.thread-metadata.v1';
  threads: Readonly<Record<string, ThreadMetadataRecord>>;
}>;

const STORE_PROTOCOL = 'metapi.local-connector.thread-metadata.v1';
const STORE_FILENAME = 'thread-metadata.json';
const MAX_STORE_BYTES = 512 * 1024;
const MAX_THREAD_COUNT = 500;
const THREAD_RETENTION_MS = 30 * 24 * 60 * 60_000;
const THREAD_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,256}$/;

function storePath(dataDir: string): string {
  return join(dataDir, STORE_FILENAME);
}

function normalizedTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const title = value.replace(/[\0\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, 120) : null;
}

async function readStore(dataDir: string): Promise<ThreadMetadataStore> {
  const snapshot = await readOptionalFile(storePath(dataDir), MAX_STORE_BYTES);
  if (!snapshot.exists) return { protocol: STORE_PROTOCOL, threads: {} };
  try {
    const parsed = JSON.parse(snapshot.data.toString('utf8')) as Record<string, unknown>;
    const rawThreads = parsed.protocol === STORE_PROTOCOL
      && parsed.threads
      && typeof parsed.threads === 'object'
      && !Array.isArray(parsed.threads)
      ? parsed.threads as Record<string, unknown>
      : {};
    const threads: Record<string, ThreadMetadataRecord> = {};
    for (const [threadId, raw] of Object.entries(rawThreads)) {
      if (!THREAD_ID_PATTERN.test(threadId) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      const title = normalizedTitle(record.title);
      const timestamp = typeof record.updatedAt === 'string' ? Date.parse(record.updatedAt) : Number.NaN;
      if (!title || !Number.isFinite(timestamp)) continue;
      threads[threadId] = { title, updatedAt: new Date(timestamp).toISOString() };
    }
    return { protocol: STORE_PROTOCOL, threads };
  } catch {
    return { protocol: STORE_PROTOCOL, threads: {} };
  }
}

export async function rememberLocalConnectorThreadMetadata(input: {
  dataDir: string;
  threads: readonly Readonly<{
    threadId: string;
    title: string;
    updatedAt?: string | null;
  }>[];
  now?: Date | number;
}): Promise<void> {
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const nowIso = now.toISOString();
  const existing = await readStore(input.dataDir);
  const entries = new Map(Object.entries(existing.threads));
  for (const thread of input.threads) {
    if (!THREAD_ID_PATTERN.test(thread.threadId)) continue;
    const title = normalizedTitle(thread.title);
    if (!title) continue;
    entries.set(thread.threadId, {
      title,
      // This is the time the Connector observed the title, not the last time
      // Codex changed the thread. Visible long-lived threads must stay cached.
      updatedAt: nowIso,
    });
  }
  const cutoff = now.getTime() - THREAD_RETENTION_MS;
  const retained = [...entries.entries()]
    .filter(([, record]) => Date.parse(record.updatedAt) >= cutoff)
    .sort((left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt))
    .slice(0, MAX_THREAD_COUNT);
  await atomicWriteFile(storePath(input.dataDir), `${JSON.stringify({
    protocol: STORE_PROTOCOL,
    threads: Object.fromEntries(retained),
  })}\n`, 0o600);
}

export async function readLocalConnectorThreadTitle(
  dataDir: string,
  threadId: string | null,
): Promise<string | null> {
  if (!threadId || !THREAD_ID_PATTERN.test(threadId)) return null;
  return (await readStore(dataDir)).threads[threadId]?.title || null;
}
