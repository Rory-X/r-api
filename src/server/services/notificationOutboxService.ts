import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { config, normalizeNotificationDeliveryPolicy } from '../config.js';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';
import { createNotificationSignature } from './notificationThrottle.js';
import {
  dispatchNotificationChannel,
  getConfiguredNotificationChannels,
  isNotificationChannel,
  type NotificationChannel,
  type NotificationChannelDispatchResult,
  type NotificationLevel,
} from './notificationChannelDispatcher.js';

export type NotificationDeliveryPolicy = 'prefer_delivery' | 'prefer_no_duplicate';
export type NotificationOutboxStatus = 'pending' | 'processing' | 'delivered' | 'delivery_unknown';
export type NotificationOutboxRow = typeof schema.notificationOutbox.$inferSelect;

export type EnqueueNotificationInput = {
  title: string;
  message: string;
  level?: NotificationLevel;
  occurredAt?: Date;
  bypassThrottle?: boolean;
  idempotencyKey?: string;
  channels?: NotificationChannel[];
  reserveForImmediateDispatch?: boolean;
};

export type EnqueueNotificationResult = {
  notificationId: string | null;
  throttled: boolean;
  deduplicated: boolean;
  rows: NotificationOutboxRow[];
};

export type ProcessNotificationOutboxResult = {
  claimed: boolean;
  row: NotificationOutboxRow;
  dispatch: NotificationChannelDispatchResult | null;
};

type DbExecutor = typeof db;
type DispatchNotificationChannel = typeof dispatchNotificationChannel;

const MAX_THROTTLE_CAS_ATTEMPTS = 12;
const DEFAULT_WORKER_BATCH_SIZE = 16;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const WORKER_NAME = 'notification-outbox';

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerPassPromise: Promise<void> | null = null;
let workerStopped = true;
let lastCleanupAtMs = 0;

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeLevel(value: unknown): NotificationLevel {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'warning') return 'warning';
  if (normalized === 'error') return 'error';
  return 'info';
}

function normalizeChannels(channels: NotificationChannel[]): NotificationChannel[] {
  return [...new Set(channels.filter((channel) => isNotificationChannel(channel)))];
}

function normalizePositiveMs(value: unknown, fallback: number): number {
  const normalized = Math.trunc(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeErrorMessage(value: unknown): string {
  return String(value || 'unknown error').trim().slice(0, 2_000) || 'unknown error';
}

function buildLeaseOwner(): string {
  const host = String(hostname() || process.env.HOSTNAME || 'local').trim() || 'local';
  return `${host}:${process.pid}`;
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const input = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const code = String(input.code ?? input.errno ?? '').toUpperCase();
    const message = String(input.message || '').toLowerCase();
    if (
      code === '23505'
      || code === '1062'
      || code === 'ER_DUP_ENTRY'
      || code === 'SQLITE_CONSTRAINT'
      || code === 'SQLITE_CONSTRAINT_UNIQUE'
      || message.includes('unique constraint')
      || message.includes('duplicate entry')
      || message.includes('duplicate key')
    ) {
      return true;
    }
    current = input.cause;
  }
  return false;
}

function buildThrottleSignatureHash(title: string, message: string, level: NotificationLevel): string {
  return hashValue(createNotificationSignature(title, message, level));
}

function buildIdempotencyKeyHash(value: string | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized ? hashValue(normalized) : null;
}

async function insertThrottleStateIfMissing(
  tx: DbExecutor,
  input: {
    signature: string;
    nowIso: string;
  },
): Promise<boolean> {
  const values = {
    signature: input.signature,
    lastEnqueuedAt: input.nowIso,
    suppressedCount: 0,
    version: 1,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
  let inserted: { changes?: number };
  if (runtimeDbDialect === 'mysql') {
    inserted = await (tx.insert(schema.notificationThrottleStates).values(values) as any)
      .onDuplicateKeyUpdate({
        set: { signature: sql`${schema.notificationThrottleStates.signature}` },
      })
      .run();
  } else {
    inserted = await (tx.insert(schema.notificationThrottleStates).values(values) as any)
      .onConflictDoNothing({ target: schema.notificationThrottleStates.signature })
      .run();
  }
  return Number(inserted?.changes || 0) > 0;
}

async function evaluatePersistedThrottle(
  tx: DbExecutor,
  input: {
    signature: string;
    now: Date;
    cooldownMs: number;
  },
): Promise<{ shouldSend: boolean; mergedCount: number }> {
  if (input.cooldownMs <= 0) {
    return { shouldSend: true, mergedCount: 0 };
  }

  const nowIso = input.now.toISOString();
  const cutoffIso = new Date(input.now.getTime() - input.cooldownMs).toISOString();

  for (let attempt = 0; attempt < MAX_THROTTLE_CAS_ATTEMPTS; attempt += 1) {
    const current = await tx.select().from(schema.notificationThrottleStates)
      .where(eq(schema.notificationThrottleStates.signature, input.signature))
      .get();

    if (!current) {
      if (await insertThrottleStateIfMissing(tx, { signature: input.signature, nowIso })) {
        return { shouldSend: true, mergedCount: 0 };
      }
      continue;
    }

    const currentVersion = Math.max(1, Math.trunc(Number(current.version) || 1));
    if (current.lastEnqueuedAt > cutoffIso) {
      const suppressed = await tx.update(schema.notificationThrottleStates).set({
        suppressedCount: sql`${schema.notificationThrottleStates.suppressedCount} + 1`,
        version: sql`${schema.notificationThrottleStates.version} + 1`,
        updatedAt: nowIso,
      }).where(and(
        eq(schema.notificationThrottleStates.signature, input.signature),
        eq(schema.notificationThrottleStates.version, currentVersion),
      )).run();
      if (Number(suppressed?.changes || 0) > 0) {
        return { shouldSend: false, mergedCount: 0 };
      }
      continue;
    }

    const reset = await tx.update(schema.notificationThrottleStates).set({
      lastEnqueuedAt: nowIso,
      suppressedCount: 0,
      version: sql`${schema.notificationThrottleStates.version} + 1`,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.notificationThrottleStates.signature, input.signature),
      eq(schema.notificationThrottleStates.version, currentVersion),
      lte(schema.notificationThrottleStates.lastEnqueuedAt, cutoffIso),
    )).run();
    if (Number(reset?.changes || 0) > 0) {
      return {
        shouldSend: true,
        mergedCount: Math.max(0, Math.trunc(Number(current.suppressedCount) || 0)),
      };
    }
  }

  throw new Error('notification throttle CAS retry budget exhausted');
}

async function findRowsByIdempotencyHash(
  idempotencyKeyHash: string,
  executor: DbExecutor = db,
): Promise<NotificationOutboxRow[]> {
  const coordinator = await executor.select().from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.idempotencyKeyHash, idempotencyKeyHash))
    .get();
  if (!coordinator) return [];
  return await executor.select().from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.notificationId, coordinator.notificationId))
    .orderBy(asc(schema.notificationOutbox.id))
    .all();
}

export async function enqueueNotification(
  input: EnqueueNotificationInput,
): Promise<EnqueueNotificationResult> {
  const channels = normalizeChannels(input.channels ?? getConfiguredNotificationChannels());
  if (channels.length === 0) {
    return {
      notificationId: null,
      throttled: false,
      deduplicated: false,
      rows: [],
    };
  }

  const idempotencyKeyHash = buildIdempotencyKeyHash(input.idempotencyKey);
  if (idempotencyKeyHash) {
    const existingRows = await findRowsByIdempotencyHash(idempotencyKeyHash);
    if (existingRows.length > 0) {
      return {
        notificationId: existingRows[0]?.notificationId ?? null,
        throttled: false,
        deduplicated: true,
        rows: existingRows,
      };
    }
  }

  const now = input.occurredAt ?? new Date();
  const nowIso = now.toISOString();
  const level = normalizeLevel(input.level);
  const throttleSignature = buildThrottleSignatureHash(input.title, input.message, level);
  const cooldownMs = Math.max(0, Math.trunc(config.notifyCooldownSec)) * 1_000;
  const deliveryPolicy = normalizeNotificationDeliveryPolicy(config.notifyDeliveryPolicy);
  const notificationId = randomUUID();
  const reserveForImmediateDispatch = input.reserveForImmediateDispatch === true;
  const leaseOwner = reserveForImmediateDispatch ? buildLeaseOwner() : null;
  const leaseExpiresAt = reserveForImmediateDispatch
    ? new Date(now.getTime() + normalizePositiveMs(config.notifyOutboxLeaseTtlMs, 30_000)).toISOString()
    : null;

  try {
    return await db.transaction(async (tx: DbExecutor) => {
      if (idempotencyKeyHash) {
        const existingRows = await findRowsByIdempotencyHash(idempotencyKeyHash, tx);
        if (existingRows.length > 0) {
          return {
            notificationId: existingRows[0]?.notificationId ?? null,
            throttled: false,
            deduplicated: true,
            rows: existingRows,
          };
        }
      }

      const throttle = input.bypassThrottle
        ? { shouldSend: true, mergedCount: 0 }
        : await evaluatePersistedThrottle(tx, {
          signature: throttleSignature,
          now,
          cooldownMs,
        });
      if (!throttle.shouldSend) {
        return {
          notificationId: null,
          throttled: true,
          deduplicated: false,
          rows: [],
        };
      }

      const message = throttle.mergedCount > 0
        ? `${input.message}\n\n[通知合并] 冷静期内已合并 ${throttle.mergedCount} 条重复告警`
        : input.message;

      for (const [index, channel] of channels.entries()) {
        await tx.insert(schema.notificationOutbox).values({
          notificationId,
          idempotencyKeyHash: index === 0 ? idempotencyKeyHash : null,
          throttleSignature,
          channel,
          title: input.title,
          message,
          level,
          occurredAt: nowIso,
          deliveryPolicy,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: nowIso,
          leaseOwner,
          leaseToken: reserveForImmediateDispatch ? randomUUID() : null,
          leaseExpiresAt,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).run();
      }

      const rows = await tx.select().from(schema.notificationOutbox)
        .where(eq(schema.notificationOutbox.notificationId, notificationId))
        .orderBy(asc(schema.notificationOutbox.id))
        .all();
      return {
        notificationId,
        throttled: false,
        deduplicated: false,
        rows,
      };
    });
  } catch (error) {
    if (idempotencyKeyHash && looksLikeUniqueCollision(error)) {
      const existingRows = await findRowsByIdempotencyHash(idempotencyKeyHash);
      if (existingRows.length > 0) {
        return {
          notificationId: existingRows[0]?.notificationId ?? null,
          throttled: false,
          deduplicated: true,
          rows: existingRows,
        };
      }
    }
    throw error;
  }
}

function pendingRowIsClaimable(nowIso: string) {
  return and(
    eq(schema.notificationOutbox.status, 'pending'),
    or(
      isNull(schema.notificationOutbox.nextAttemptAt),
      lte(schema.notificationOutbox.nextAttemptAt, nowIso),
    ),
    or(
      isNull(schema.notificationOutbox.leaseToken),
      isNull(schema.notificationOutbox.leaseExpiresAt),
      lte(schema.notificationOutbox.leaseExpiresAt, nowIso),
    ),
  );
}

function expiredRetryableProcessingRow(nowIso: string) {
  return and(
    eq(schema.notificationOutbox.status, 'processing'),
    eq(schema.notificationOutbox.deliveryPolicy, 'prefer_delivery'),
    lte(schema.notificationOutbox.leaseExpiresAt, nowIso),
  );
}

async function markExpiredNoDuplicateLeasesUnknown(now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const updated = await db.update(schema.notificationOutbox).set({
    status: 'delivery_unknown',
    lastOutcome: 'delivery_unknown',
    lastError: 'delivery outcome became unknown after the worker lease expired',
    nextAttemptAt: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.notificationOutbox.status, 'processing'),
    eq(schema.notificationOutbox.deliveryPolicy, 'prefer_no_duplicate'),
    lte(schema.notificationOutbox.leaseExpiresAt, nowIso),
  )).run();
  return Number(updated?.changes || 0);
}

async function loadClaimedRow(id: number, leaseToken: string): Promise<NotificationOutboxRow | null> {
  return await db.select().from(schema.notificationOutbox).where(and(
    eq(schema.notificationOutbox.id, id),
    eq(schema.notificationOutbox.status, 'processing'),
    eq(schema.notificationOutbox.leaseToken, leaseToken),
  )).get() || null;
}

async function claimReservedRow(row: NotificationOutboxRow, now = new Date()): Promise<NotificationOutboxRow | null> {
  if (!row.leaseToken) return null;
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(
    now.getTime() + normalizePositiveMs(config.notifyOutboxLeaseTtlMs, 30_000),
  ).toISOString();
  const claimed = await db.update(schema.notificationOutbox).set({
    status: 'processing',
    attemptCount: sql`${schema.notificationOutbox.attemptCount} + 1`,
    lastAttemptAt: nowIso,
    leaseExpiresAt,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.notificationOutbox.id, row.id),
    eq(schema.notificationOutbox.status, 'pending'),
    eq(schema.notificationOutbox.leaseToken, row.leaseToken),
  )).run();
  if (Number(claimed?.changes || 0) === 0) return null;
  return loadClaimedRow(row.id, row.leaseToken);
}

async function claimNextRow(now = new Date()): Promise<NotificationOutboxRow | null> {
  await markExpiredNoDuplicateLeasesUnknown(now);
  const nowIso = now.toISOString();
  const candidate = await db.select().from(schema.notificationOutbox)
    .where(or(
      pendingRowIsClaimable(nowIso),
      expiredRetryableProcessingRow(nowIso),
    ))
    .orderBy(asc(schema.notificationOutbox.nextAttemptAt), asc(schema.notificationOutbox.createdAt), asc(schema.notificationOutbox.id))
    .get();
  if (!candidate) return null;

  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + normalizePositiveMs(config.notifyOutboxLeaseTtlMs, 30_000),
  ).toISOString();
  const claimed = await db.update(schema.notificationOutbox).set({
    status: 'processing',
    attemptCount: sql`${schema.notificationOutbox.attemptCount} + 1`,
    lastAttemptAt: nowIso,
    leaseOwner: buildLeaseOwner(),
    leaseToken,
    leaseExpiresAt,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.notificationOutbox.id, candidate.id),
    or(
      pendingRowIsClaimable(nowIso),
      expiredRetryableProcessingRow(nowIso),
    ),
  )).run();
  if (Number(claimed?.changes || 0) === 0) return null;
  return loadClaimedRow(candidate.id, leaseToken);
}

function computeRetryDelayMs(attemptCount: number, retryAfterMs: number | null): number {
  const base = normalizePositiveMs(config.notifyOutboxRetryBaseMs, 5_000);
  const max = Math.max(base, normalizePositiveMs(config.notifyOutboxRetryMaxMs, 15 * 60 * 1_000));
  const exponent = Math.min(20, Math.max(0, Math.trunc(attemptCount) - 1));
  const exponential = Math.min(max, base * (2 ** exponent));
  return Math.min(max, Math.max(exponential, Math.max(0, Math.trunc(retryAfterMs || 0))));
}

function startLeaseHeartbeat(row: NotificationOutboxRow): () => void {
  if (!row.leaseToken) return () => undefined;
  const ttlMs = normalizePositiveMs(config.notifyOutboxLeaseTtlMs, 30_000);
  const heartbeatMs = Math.max(1_000, Math.min(Math.trunc(ttlMs / 3), Math.max(1_000, ttlMs - 1_000)));
  const timer = setInterval(() => {
    const nowIso = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    void db.update(schema.notificationOutbox).set({
      leaseExpiresAt,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.notificationOutbox.id, row.id),
      eq(schema.notificationOutbox.status, 'processing'),
      eq(schema.notificationOutbox.leaseToken, row.leaseToken!),
    )).run().catch((error: unknown) => {
      console.warn(`[notification-outbox] lease heartbeat failed: ${normalizeErrorMessage(error)}`);
    });
  }, heartbeatMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function persistDispatchResult(
  row: NotificationOutboxRow,
  result: NotificationChannelDispatchResult,
  now = new Date(),
): Promise<boolean> {
  if (!row.leaseToken) return false;
  const nowIso = now.toISOString();
  let values: Record<string, unknown>;

  if (result.outcome === 'delivered') {
    values = {
      status: 'delivered',
      lastOutcome: 'delivered',
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: nowIso,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    };
  } else if (result.outcome === 'delivery_unknown' && row.deliveryPolicy === 'prefer_no_duplicate') {
    values = {
      status: 'delivery_unknown',
      lastOutcome: 'delivery_unknown',
      lastError: normalizeErrorMessage(result.error),
      nextAttemptAt: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    };
  } else {
    const retryDelayMs = computeRetryDelayMs(row.attemptCount, result.retryAfterMs);
    values = {
      status: 'pending',
      lastOutcome: result.outcome,
      lastError: normalizeErrorMessage(result.error),
      nextAttemptAt: new Date(now.getTime() + retryDelayMs).toISOString(),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    };
  }

  const updated = await db.update(schema.notificationOutbox).set(values).where(and(
    eq(schema.notificationOutbox.id, row.id),
    eq(schema.notificationOutbox.status, 'processing'),
    eq(schema.notificationOutbox.leaseToken, row.leaseToken),
  )).run();
  return Number(updated?.changes || 0) > 0;
}

async function dispatchClaimedRow(
  row: NotificationOutboxRow,
  dispatch: DispatchNotificationChannel = dispatchNotificationChannel,
  now = new Date(),
): Promise<ProcessNotificationOutboxResult> {
  const stopHeartbeat = startLeaseHeartbeat(row);
  let result: NotificationChannelDispatchResult;
  try {
    result = await dispatch({
      channel: row.channel as NotificationChannel,
      title: row.title,
      message: row.message,
      level: normalizeLevel(row.level),
      occurredAt: row.occurredAt,
    });
  } catch (error) {
    result = {
      channel: row.channel as NotificationChannel,
      outcome: 'delivery_unknown',
      error: normalizeErrorMessage(error),
      retryAfterMs: null,
    };
  } finally {
    stopHeartbeat();
  }

  const persisted = await persistDispatchResult(row, result, now);
  if (!persisted) {
    console.warn(`[notification-outbox] lost lease before persisting row ${row.id} outcome ${result.outcome}`);
  }
  return { claimed: true, row, dispatch: result };
}

export async function dispatchReservedNotificationOutboxRow(
  row: NotificationOutboxRow,
  dispatch: DispatchNotificationChannel = dispatchNotificationChannel,
  now = new Date(),
): Promise<ProcessNotificationOutboxResult> {
  const claimed = await claimReservedRow(row, now);
  if (!claimed) {
    return { claimed: false, row, dispatch: null };
  }
  return dispatchClaimedRow(claimed, dispatch, now);
}

export async function runNotificationOutboxPass(input: {
  limit?: number;
  dispatch?: DispatchNotificationChannel;
  now?: Date;
} = {}): Promise<{ claimed: number; delivered: number; failed: number; deliveryUnknown: number }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? DEFAULT_WORKER_BATCH_SIZE)));
  const rows: NotificationOutboxRow[] = [];
  for (let index = 0; index < limit; index += 1) {
    const row = await claimNextRow(input.now ?? new Date());
    if (!row) break;
    rows.push(row);
  }

  const results = await Promise.all(rows.map((row) => dispatchClaimedRow(row, input.dispatch, input.now ?? new Date())));
  return {
    claimed: results.length,
    delivered: results.filter((item) => item.dispatch?.outcome === 'delivered').length,
    failed: results.filter((item) => item.dispatch?.outcome === 'failed').length,
    deliveryUnknown: results.filter((item) => item.dispatch?.outcome === 'delivery_unknown').length,
  };
}

export async function cleanupNotificationOutbox(now = new Date()): Promise<{
  outboxRowsDeleted: number;
  throttleRowsDeleted: number;
}> {
  const retentionDays = Math.max(1, Math.trunc(config.notifyOutboxRetentionDays || 30));
  const cutoffIso = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const outbox = await db.delete(schema.notificationOutbox).where(and(
    inArray(schema.notificationOutbox.status, ['delivered', 'delivery_unknown']),
    lte(schema.notificationOutbox.updatedAt, cutoffIso),
  )).run();
  const throttle = await db.delete(schema.notificationThrottleStates)
    .where(lte(schema.notificationThrottleStates.updatedAt, cutoffIso))
    .run();
  return {
    outboxRowsDeleted: Number(outbox?.changes || 0),
    throttleRowsDeleted: Number(throttle?.changes || 0),
  };
}

async function runWorkerPass(): Promise<void> {
  try {
    await runObservedWorkerPass(WORKER_NAME, async () => {
      await runNotificationOutboxPass();
      const nowMs = Date.now();
      if (nowMs - lastCleanupAtMs >= CLEANUP_INTERVAL_MS) {
        lastCleanupAtMs = nowMs;
        await cleanupNotificationOutbox(new Date(nowMs));
      }
    });
  } catch (error) {
    console.warn(`[notification-outbox] worker pass failed: ${normalizeErrorMessage(error)}`);
  }
}

function scheduleWorkerPass(): void {
  if (workerStopped || workerPassPromise) return;
  workerPassPromise = runWorkerPass().finally(() => {
    workerPassPromise = null;
  });
}

export function startNotificationOutboxWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerStopped = false;
  const pollIntervalMs = normalizePositiveMs(config.notifyOutboxPollIntervalMs, 1_000);
  startObservedWorker({ name: WORKER_NAME, intervalMs: pollIntervalMs });
  scheduleWorkerPass();
  workerTimer = setInterval(scheduleWorkerPass, pollIntervalMs);
  workerTimer.unref?.();
}

export async function stopNotificationOutboxWorker(): Promise<void> {
  workerStopped = true;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  await workerPassPromise;
  stopObservedWorker(WORKER_NAME);
}

export async function __resetNotificationOutboxWorkerForTests(): Promise<void> {
  await stopNotificationOutboxWorker();
  workerPassPromise = null;
  lastCleanupAtMs = 0;
}
