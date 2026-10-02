import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  observeWorkerRun,
  removeWorkerMetric,
  setWorkerMetric,
} from './metrics.js';
import { redactOperationalMessage } from './redactOperationalMessage.js';

export type WorkerHealthStatus = 'starting' | 'healthy' | 'degraded' | 'stopped' | 'disabled';

type WorkerRecord = {
  name: string;
  enabled: boolean;
  critical: boolean;
  intervalMs: number;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  currentRunStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export type WorkerHealthItem = Readonly<{
  name: string;
  status: WorkerHealthStatus;
  enabled: boolean;
  critical: boolean;
  intervalMs: number;
  staleAfterMs: number;
  startedAt: string | null;
  stoppedAt: string | null;
  currentRunStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
}>;

export type WorkerHealthSnapshot = Readonly<{
  status: 'healthy' | 'degraded';
  generatedAt: string;
  summary: Readonly<{
    total: number;
    healthy: number;
    starting: number;
    degraded: number;
    stopped: number;
    disabled: number;
  }>;
  blockingWorkers: readonly string[];
  workers: readonly WorkerHealthItem[];
}>;

const workers = new Map<string, WorkerRecord>();
const tracer = trace.getTracer('r-api-workers');

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').slice(0, 80) || 'unnamed-worker';
}

function normalizeIntervalMs(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 60_000;
  return Math.max(100, Math.trunc(parsed));
}

function normalizeError(error: unknown): string {
  return redactOperationalMessage(error);
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function staleAfterMs(record: WorkerRecord): number {
  return Math.max(30_000, record.intervalMs * 3);
}

function statusFor(record: WorkerRecord, nowMs: number): WorkerHealthStatus {
  if (!record.enabled) return 'disabled';
  if (record.startedAtMs === null) return 'stopped';
  const staleMs = staleAfterMs(record);
  if (record.currentRunStartedAtMs !== null && nowMs - record.currentRunStartedAtMs > staleMs) {
    return 'degraded';
  }
  if (record.lastFinishedAtMs === null) {
    return nowMs - record.startedAtMs > staleMs ? 'degraded' : 'starting';
  }
  if (record.consecutiveFailures > 0 || nowMs - record.lastFinishedAtMs > staleMs) {
    return 'degraded';
  }
  return 'healthy';
}

function getOrCreateWorker(name: string): WorkerRecord {
  const normalizedName = normalizeName(name);
  const existing = workers.get(normalizedName);
  if (existing) return existing;
  const created: WorkerRecord = {
    name: normalizedName,
    enabled: true,
    critical: false,
    intervalMs: 60_000,
    startedAtMs: Date.now(),
    stoppedAtMs: null,
    currentRunStartedAtMs: null,
    lastFinishedAtMs: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  workers.set(normalizedName, created);
  return created;
}

export function startObservedWorker(input: {
  name: string;
  intervalMs: number;
  enabled?: boolean;
  critical?: boolean;
}): void {
  const name = normalizeName(input.name);
  const enabled = input.enabled !== false;
  const nowMs = Date.now();
  const existing = workers.get(name);
  const record: WorkerRecord = existing ?? {
    name,
    enabled,
    critical: input.critical === true,
    intervalMs: normalizeIntervalMs(input.intervalMs),
    startedAtMs: null,
    stoppedAtMs: null,
    currentRunStartedAtMs: null,
    lastFinishedAtMs: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    consecutiveFailures: 0,
    lastError: null,
  };
  record.enabled = enabled;
  record.critical = input.critical === true;
  record.intervalMs = normalizeIntervalMs(input.intervalMs);
  record.startedAtMs = enabled ? nowMs : null;
  record.stoppedAtMs = enabled ? null : nowMs;
  record.currentRunStartedAtMs = null;
  workers.set(name, record);
  setWorkerMetric(name, enabled, record.consecutiveFailures, enabled);
}

export function stopObservedWorker(name: string): void {
  const record = getOrCreateWorker(name);
  record.startedAtMs = null;
  record.stoppedAtMs = Date.now();
  record.currentRunStartedAtMs = null;
  setWorkerMetric(record.name, false, record.consecutiveFailures, record.enabled);
}

export async function runObservedWorkerPass<T>(name: string, pass: () => Promise<T>): Promise<T> {
  const record = getOrCreateWorker(name);
  const startedAtMs = Date.now();
  record.currentRunStartedAtMs = startedAtMs;
  return await tracer.startActiveSpan(`worker.${record.name}`, async (span) => {
    span.setAttribute('worker.name', record.name);
    try {
      const result = await pass();
      const finishedAtMs = Date.now();
      record.currentRunStartedAtMs = null;
      record.lastFinishedAtMs = finishedAtMs;
      record.lastSuccessAtMs = finishedAtMs;
      record.consecutiveFailures = 0;
      record.lastError = null;
      span.setStatus({ code: SpanStatusCode.OK });
      observeWorkerRun({
        worker: record.name,
        outcome: 'success',
        durationMs: finishedAtMs - startedAtMs,
        lastSuccessAtMs: record.lastSuccessAtMs,
        consecutiveFailures: record.consecutiveFailures,
      });
      setWorkerMetric(record.name, true, 0, record.enabled);
      return result;
    } catch (error) {
      const finishedAtMs = Date.now();
      record.currentRunStartedAtMs = null;
      record.lastFinishedAtMs = finishedAtMs;
      record.lastFailureAtMs = finishedAtMs;
      record.consecutiveFailures += 1;
      record.lastError = normalizeError(error);
      span.recordException(new Error(record.lastError));
      span.setStatus({ code: SpanStatusCode.ERROR, message: record.lastError });
      observeWorkerRun({
        worker: record.name,
        outcome: 'failure',
        durationMs: finishedAtMs - startedAtMs,
        lastSuccessAtMs: record.lastSuccessAtMs,
        consecutiveFailures: record.consecutiveFailures,
      });
      setWorkerMetric(record.name, false, record.consecutiveFailures, record.enabled);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function getWorkerHealthSnapshot(nowMs = Date.now()): WorkerHealthSnapshot {
  const items = [...workers.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((record): WorkerHealthItem => {
      const status = statusFor(record, nowMs);
      setWorkerMetric(
        record.name,
        status === 'healthy' || status === 'starting',
        record.consecutiveFailures,
        record.enabled,
      );
      return Object.freeze({
        name: record.name,
        status,
        enabled: record.enabled,
        critical: record.critical,
        intervalMs: record.intervalMs,
        staleAfterMs: staleAfterMs(record),
        startedAt: toIso(record.startedAtMs),
        stoppedAt: toIso(record.stoppedAtMs),
        currentRunStartedAt: toIso(record.currentRunStartedAtMs),
        lastFinishedAt: toIso(record.lastFinishedAtMs),
        lastSuccessAt: toIso(record.lastSuccessAtMs),
        lastFailureAt: toIso(record.lastFailureAtMs),
        consecutiveFailures: record.consecutiveFailures,
        lastError: record.lastError,
      });
    });
  const summary = {
    total: items.length,
    healthy: items.filter((item) => item.status === 'healthy').length,
    starting: items.filter((item) => item.status === 'starting').length,
    degraded: items.filter((item) => item.status === 'degraded').length,
    stopped: items.filter((item) => item.status === 'stopped').length,
    disabled: items.filter((item) => item.status === 'disabled').length,
  };
  const blockingWorkers = items
    .filter((item) => item.critical && (item.status === 'degraded' || item.status === 'stopped'))
    .map((item) => item.name);
  return Object.freeze({
    status: summary.degraded > 0 || summary.stopped > 0 ? 'degraded' : 'healthy',
    generatedAt: new Date(nowMs).toISOString(),
    summary: Object.freeze(summary),
    blockingWorkers: Object.freeze(blockingWorkers),
    workers: Object.freeze(items),
  });
}

export function resetWorkerHealthForTests(): void {
  for (const worker of workers.keys()) removeWorkerMetric(worker);
  workers.clear();
}
