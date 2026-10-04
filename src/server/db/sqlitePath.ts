import { config } from '../config.js';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { threadId } from 'node:worker_threads';

export function resolveSqlitePath(): string {
  const raw = ((isVitestRuntime() ? process.env.DB_URL : undefined) ?? config.dbUrl ?? '').trim();
  if (!raw) {
    const isolatedVitestPath = resolveVitestSqlitePath();
    if (isolatedVitestPath) {
      return isolatedVitestPath;
    }
    return resolve(`${config.dataDir}/hub.db`);
  }
  if (raw === ':memory:') return raw;
  if (raw.startsWith('file://')) {
    const parsed = new URL(raw);
    return decodeURIComponent(parsed.pathname);
  }
  if (raw.startsWith('sqlite://')) {
    return resolve(raw.slice('sqlite://'.length).trim());
  }
  return resolve(raw);
}

function isVitestRuntime(): boolean {
  if ((process.env.VITEST_POOL_ID || '').trim()) {
    return true;
  }
  if ((process.env.VITEST_WORKER_ID || '').trim()) {
    return true;
  }
  const runtimeArgs = [...process.argv, ...process.execArgv]
    .map((value) => String(value || '').toLowerCase());
  return runtimeArgs.some((value) => value.includes('vitest'));
}

function isDefaultRepoDataDir(value: string | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  return resolve(trimmed) === resolve('./data');
}

export function resolveVitestSqlitePath(): string | null {
  if (!isVitestRuntime()) {
    return null;
  }
  if ((process.env.DB_URL || '').trim()) {
    return null;
  }
  if ((process.env.DATA_DIR || '').trim() && !isDefaultRepoDataDir(process.env.DATA_DIR)) {
    // Tests may import config before choosing their fixture directory. Resolve
    // the live test override here instead of falling back to cached config.
    return resolve(process.env.DATA_DIR!, 'hub.db');
  }

  const workerTag = process.env.VITEST_POOL_ID
    || process.env.VITEST_WORKER_ID
    || `${process.pid}-${threadId}`;
  return resolve(tmpdir(), `metapi-vitest-${workerTag}`, 'hub.db');
}

