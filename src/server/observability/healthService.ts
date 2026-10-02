import { db, schema } from '../db/index.js';
import { setDependencyMetric, setReadinessMetric } from './metrics.js';
import { getWorkerHealthSnapshot } from './workerHealth.js';
import { redactOperationalMessage } from './redactOperationalMessage.js';

let acceptingTraffic = false;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeError(error: unknown): string {
  return redactOperationalMessage(error, 300);
}

async function checkRuntimeDatabase(): Promise<void> {
  await db.select({ key: schema.settings.key }).from(schema.settings).limit(1);
}

export function setApplicationReadiness(ready: boolean): void {
  acceptingTraffic = ready;
  setReadinessMetric(ready);
}

export function getLivenessReport(now = new Date()) {
  return Object.freeze({
    status: 'alive' as const,
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
  });
}

export async function getReadinessReport(options: {
  databaseCheck?: () => Promise<void>;
  timeoutMs?: number;
  now?: Date;
} = {}) {
  const now = options.now ?? new Date();
  const databaseCheck = options.databaseCheck ?? checkRuntimeDatabase;
  const timeoutMs = Math.max(100, Math.trunc(options.timeoutMs ?? 2_000));
  let databaseAvailable = false;
  let databaseError: string | null = null;
  const startedAtMs = Date.now();
  try {
    await withTimeout(databaseCheck(), timeoutMs);
    databaseAvailable = true;
  } catch (error) {
    databaseError = normalizeError(error);
  }
  setDependencyMetric('database', databaseAvailable);

  const workerHealth = getWorkerHealthSnapshot(now.getTime());
  const ready = acceptingTraffic && databaseAvailable && workerHealth.blockingWorkers.length === 0;
  setReadinessMetric(ready);
  return Object.freeze({
    status: ready ? 'ready' as const : 'not_ready' as const,
    generatedAt: now.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor(process.uptime())),
    checks: Object.freeze({
      startup: Object.freeze({ ok: acceptingTraffic }),
      database: Object.freeze({
        ok: databaseAvailable,
        latencyMs: Math.max(0, Date.now() - startedAtMs),
        error: databaseError,
      }),
      workers: Object.freeze({
        ok: workerHealth.blockingWorkers.length === 0,
        blockingWorkers: workerHealth.blockingWorkers,
        summary: workerHealth.summary,
      }),
    }),
  });
}

export function resetApplicationReadinessForTests(): void {
  setApplicationReadiness(false);
}
