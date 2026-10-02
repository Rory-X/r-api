import { randomUUID } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';

export const QUOTA_METRICS = ['requests', 'input_tokens', 'output_tokens', 'total_tokens', 'cost'] as const;
export type QuotaMetric = typeof QUOTA_METRICS[number];

export const QUOTA_WINDOW_TYPES = ['fixed', 'calendar_day', 'calendar_month'] as const;
export type QuotaWindowType = typeof QUOTA_WINDOW_TYPES[number];

export const QUOTA_ENFORCEMENTS = ['hard', 'soft'] as const;
export type QuotaEnforcement = typeof QUOTA_ENFORCEMENTS[number];

export type DownstreamKeyLimitPolicyInput = {
  metric: QuotaMetric;
  scopeType?: 'key' | 'model' | 'site';
  scopeValue?: string | null;
  windowType: QuotaWindowType;
  windowSeconds?: number | null;
  limitValue: number;
  burstValue?: number;
  enforcement?: QuotaEnforcement;
  warningThresholds?: number[];
  enabled?: boolean;
};

export type DownstreamKeyLimitPolicy = DownstreamKeyLimitPolicyInput & {
  id: number;
  downstreamApiKeyId: number;
  scopeType: 'key' | 'model' | 'site';
  scopeValue: string | null;
  windowSeconds: number | null;
  burstValue: number;
  enforcement: QuotaEnforcement;
  warningThresholds: number[];
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type QuotaMetricAmounts = Partial<Record<QuotaMetric, number>>;

export type QuotaWindowSnapshot = {
  policyId: number;
  metric: QuotaMetric;
  windowStart: string;
  windowEnd: string;
  limitValue: number;
  burstValue: number;
  usedValue: number;
  reservedValue: number;
  remaining: number;
  enforcement: QuotaEnforcement;
};

export type QuotaReservation = {
  token: string;
  keyId: number;
  expiresAt: string;
  windows: Array<{
    policyId: number;
    metric: QuotaMetric;
    windowStart: string;
    amount: number;
    windowId: number;
  }>;
};

export type QuotaReservationResult =
  | { ok: true; reservation: QuotaReservation | null; windows: QuotaWindowSnapshot[] }
  | {
    ok: false;
    statusCode: 429;
    error: string;
    reason: 'quota_exceeded';
    metric: QuotaMetric;
    retryAfterSeconds: number;
    resetAt: string;
    limit: number;
    remaining: number;
  };

type QuotaPolicyRow = typeof schema.downstreamKeyLimitPolicies.$inferSelect;
type QuotaWindowRow = typeof schema.downstreamKeyUsageWindows.$inferSelect;

const DEFAULT_RESERVATION_TTL_MS = 5 * 60_000;
const MAX_POLICIES_PER_KEY = 100;

function normalizeMetric(value: unknown): QuotaMetric {
  const metric = String(value || '').trim().toLowerCase();
  if ((QUOTA_METRICS as readonly string[]).includes(metric)) return metric as QuotaMetric;
  throw new Error(`不支持的配额指标: ${metric || 'empty'}`);
}

function normalizeWindowType(value: unknown): QuotaWindowType {
  const windowType = String(value || '').trim().toLowerCase();
  if ((QUOTA_WINDOW_TYPES as readonly string[]).includes(windowType)) return windowType as QuotaWindowType;
  throw new Error(`不支持的配额窗口: ${windowType || 'empty'}`);
}

function normalizeEnforcement(value: unknown): QuotaEnforcement {
  const enforcement = String(value || 'hard').trim().toLowerCase();
  if ((QUOTA_ENFORCEMENTS as readonly string[]).includes(enforcement)) return enforcement as QuotaEnforcement;
  throw new Error(`不支持的配额执行模式: ${enforcement}`);
}

function normalizeNonNegativeNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} 必须是非负数字`);
  return parsed;
}

function normalizeLimitPolicy(input: DownstreamKeyLimitPolicyInput): DownstreamKeyLimitPolicyInput {
  const metric = normalizeMetric(input.metric);
  const windowType = normalizeWindowType(input.windowType);
  const scopeType = input.scopeType === 'model' || input.scopeType === 'site' ? input.scopeType : 'key';
  const scopeValue = scopeType === 'key' ? '' : String(input.scopeValue || '').trim().slice(0, 160);
  if (scopeType !== 'key' && !scopeValue) throw new Error('模型/站点配额必须提供 scopeValue');
  const limitValue = normalizeNonNegativeNumber(input.limitValue, 'limitValue');
  if (limitValue <= 0) throw new Error('limitValue 必须大于 0');
  const burstValue = normalizeNonNegativeNumber(input.burstValue ?? 0, 'burstValue');
  let windowSeconds: number | null = null;
  if (windowType === 'fixed') {
    const parsed = Math.trunc(Number(input.windowSeconds));
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 31_536_000) {
      throw new Error('fixed 窗口的 windowSeconds 必须在 1 到 31536000 之间');
    }
    windowSeconds = parsed;
  }
  const warningThresholds = (Array.isArray(input.warningThresholds) ? input.warningThresholds : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 1)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right)
    .slice(0, 5);
  return {
    metric,
    scopeType,
    scopeValue,
    windowType,
    windowSeconds,
    limitValue,
    burstValue,
    enforcement: normalizeEnforcement(input.enforcement),
    warningThresholds,
    enabled: input.enabled !== false,
  };
}

function parseWarningThresholds(raw: unknown): number[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed)
      ? parsed.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 1)
      : [];
  } catch {
    return [];
  }
}

function toPolicy(row: QuotaPolicyRow): DownstreamKeyLimitPolicy {
  return {
    id: row.id,
    downstreamApiKeyId: row.downstreamApiKeyId,
    metric: normalizeMetric(row.metric),
    scopeType: row.scopeType === 'model' || row.scopeType === 'site' ? row.scopeType : 'key',
    scopeValue: row.scopeValue || null,
    windowType: normalizeWindowType(row.windowType),
    windowSeconds: row.windowSeconds ?? null,
    limitValue: Number(row.limitValue || 0),
    burstValue: Number(row.burstValue || 0),
    enforcement: normalizeEnforcement(row.enforcement),
    warningThresholds: parseWarningThresholds(row.warningThresholdsJson),
    enabled: row.enabled !== false,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

export async function listDownstreamKeyLimitPolicies(keyId: number): Promise<DownstreamKeyLimitPolicy[]> {
  const rows = await db.select().from(schema.downstreamKeyLimitPolicies)
    .where(eq(schema.downstreamKeyLimitPolicies.downstreamApiKeyId, keyId))
    .orderBy(asc(schema.downstreamKeyLimitPolicies.id))
    .all();
  return rows.map(toPolicy);
}

export async function replaceDownstreamKeyLimitPolicies(
  keyId: number,
  rawPolicies: DownstreamKeyLimitPolicyInput[],
): Promise<DownstreamKeyLimitPolicy[]> {
  if (!Array.isArray(rawPolicies) || rawPolicies.length > MAX_POLICIES_PER_KEY) {
    throw new Error(`每个 API key 最多配置 ${MAX_POLICIES_PER_KEY} 条配额策略`);
  }
  const policies = rawPolicies.map(normalizeLimitPolicy);
  const seen = new Set<string>();
  for (const policy of policies) {
    const key = [policy.metric, policy.scopeType, policy.scopeValue || '', policy.windowType, policy.windowSeconds || ''].join(':');
    if (seen.has(key)) throw new Error(`配额策略重复: ${key}`);
    seen.add(key);
  }
  const nowIso = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.delete(schema.downstreamKeyLimitPolicies)
      .where(eq(schema.downstreamKeyLimitPolicies.downstreamApiKeyId, keyId))
      .run();
    if (policies.length === 0) return;
    await tx.insert(schema.downstreamKeyLimitPolicies).values(policies.map((policy) => ({
      downstreamApiKeyId: keyId,
      metric: policy.metric,
      scopeType: policy.scopeType || 'key',
      scopeValue: policy.scopeValue || '',
      windowType: policy.windowType,
      windowSeconds: policy.windowSeconds,
      limitValue: policy.limitValue,
      burstValue: policy.burstValue || 0,
      enforcement: policy.enforcement || 'hard',
      warningThresholdsJson: JSON.stringify(policy.warningThresholds || []),
      enabled: policy.enabled !== false,
      createdAt: nowIso,
      updatedAt: nowIso,
    })) as any).run();
  });
  return await listDownstreamKeyLimitPolicies(keyId);
}

function resolveWindowBounds(policy: DownstreamKeyLimitPolicy, now: Date): { start: string; end: string; retryAfterSeconds: number } {
  const nowMs = now.getTime();
  let startMs: number;
  let endMs: number;
  if (policy.windowType === 'calendar_day') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    startMs = start.getTime();
    endMs = startMs + 86_400_000;
  } else if (policy.windowType === 'calendar_month') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    startMs = start.getTime();
    endMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  } else {
    const seconds = Math.max(1, Math.trunc(policy.windowSeconds || 60));
    const sizeMs = seconds * 1_000;
    startMs = Math.floor(nowMs / sizeMs) * sizeMs;
    endMs = startMs + sizeMs;
  }
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((endMs - nowMs) / 1_000)),
  };
}

async function ensureUsageWindow(executor: typeof db, policy: DownstreamKeyLimitPolicy, bounds: { start: string; end: string }, nowIso: string): Promise<QuotaWindowRow> {
  const values = {
    policyId: policy.id,
    windowStart: bounds.start,
    windowEnd: bounds.end,
    usedValue: 0,
    reservedValue: 0,
    version: 0,
    updatedAt: nowIso,
  };
  if (runtimeDbDialect === 'mysql') {
    await (executor.insert(schema.downstreamKeyUsageWindows).values(values) as any)
      .onDuplicateKeyUpdate({ set: { windowStart: sql`${schema.downstreamKeyUsageWindows.windowStart}` } })
      .run();
  } else {
    await (executor.insert(schema.downstreamKeyUsageWindows).values(values) as any)
      .onConflictDoNothing({ target: [schema.downstreamKeyUsageWindows.policyId, schema.downstreamKeyUsageWindows.windowStart] })
      .run();
  }
  const row = await executor.select().from(schema.downstreamKeyUsageWindows).where(and(
    eq(schema.downstreamKeyUsageWindows.policyId, policy.id),
    eq(schema.downstreamKeyUsageWindows.windowStart, bounds.start),
  )).get();
  if (!row) throw new Error(`无法创建配额窗口: ${policy.id}/${bounds.start}`);
  return row;
}

function quotaLimit(policy: DownstreamKeyLimitPolicy): number {
  return Math.max(0, policy.limitValue + policy.burstValue);
}

export async function readDownstreamKeyQuotaWindows(input: { keyId: number; now?: Date } ): Promise<QuotaWindowSnapshot[]> {
  const policies = (await listDownstreamKeyLimitPolicies(input.keyId)).filter((policy) => policy.enabled && policy.scopeType === 'key');
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const snapshots: QuotaWindowSnapshot[] = [];
  for (const policy of policies) {
    const bounds = resolveWindowBounds(policy, now);
    const row = await ensureUsageWindow(db, policy, bounds, nowIso);
    const usedValue = Number(row.usedValue || 0);
    const reservedValue = Number(row.reservedValue || 0);
    snapshots.push({
      policyId: policy.id,
      metric: policy.metric,
      windowStart: bounds.start,
      windowEnd: bounds.end,
      limitValue: policy.limitValue,
      burstValue: policy.burstValue,
      usedValue,
      reservedValue,
      remaining: Math.max(0, quotaLimit(policy) - usedValue - reservedValue),
      enforcement: policy.enforcement,
    });
  }
  return snapshots;
}

export async function reserveDownstreamKeyQuota(input: {
  keyId: number;
  amounts: QuotaMetricAmounts;
  now?: Date;
  ttlMs?: number;
}): Promise<QuotaReservationResult> {
  const policies = (await listDownstreamKeyLimitPolicies(input.keyId)).filter((policy) => policy.enabled && policy.scopeType === 'key');
  if (policies.length === 0) return { ok: true, reservation: null, windows: [] };
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(30_000, input.ttlMs || DEFAULT_RESERVATION_TTL_MS)).toISOString();
  try {
    return await db.transaction(async (tx) => {
      const reservedWindows: QuotaReservation['windows'] = [];
      const snapshots: QuotaWindowSnapshot[] = [];
      for (const policy of policies) {
        const amountRaw = input.amounts[policy.metric];
        const amount = Number.isFinite(Number(amountRaw)) ? Math.max(0, Number(amountRaw)) : 0;
        if (amount <= 0) continue;
        const bounds = resolveWindowBounds(policy, now);
        const row = await ensureUsageWindow(tx as typeof db, policy, bounds, nowIso);
        const limit = quotaLimit(policy);
        const updated = await tx.update(schema.downstreamKeyUsageWindows).set({
          reservedValue: sql`${schema.downstreamKeyUsageWindows.reservedValue} + ${amount}`,
          version: sql`${schema.downstreamKeyUsageWindows.version} + 1`,
          updatedAt: nowIso,
        }).where(and(
          eq(schema.downstreamKeyUsageWindows.id, row.id),
          ...(policy.enforcement === 'hard'
            ? [sql`${schema.downstreamKeyUsageWindows.usedValue} + ${schema.downstreamKeyUsageWindows.reservedValue} + ${amount} <= ${limit}`]
            : []),
        )).run();
        if (policy.enforcement === 'hard' && Number(updated?.changes || 0) === 0) {
          const current = await tx.select().from(schema.downstreamKeyUsageWindows).where(eq(schema.downstreamKeyUsageWindows.id, row.id)).get();
          const usedValue = Number(current?.usedValue || 0);
          const reservedValue = Number(current?.reservedValue || 0);
          const boundsForError = resolveWindowBounds(policy, now);
          throw new QuotaExceededError({
            metric: policy.metric,
            retryAfterSeconds: boundsForError.retryAfterSeconds,
            resetAt: boundsForError.end,
            limit,
            remaining: Math.max(0, limit - usedValue - reservedValue),
          });
        }
        const current = await tx.select().from(schema.downstreamKeyUsageWindows).where(eq(schema.downstreamKeyUsageWindows.id, row.id)).get();
        const usedValue = Number(current?.usedValue || 0);
        const reservedValue = Number(current?.reservedValue || 0);
        snapshots.push({
          policyId: policy.id,
          metric: policy.metric,
          windowStart: bounds.start,
          windowEnd: bounds.end,
          limitValue: policy.limitValue,
          burstValue: policy.burstValue,
          usedValue,
          reservedValue,
          remaining: Math.max(0, limit - usedValue - reservedValue),
          enforcement: policy.enforcement,
        });
        reservedWindows.push({ policyId: policy.id, metric: policy.metric, windowStart: bounds.start, amount, windowId: row.id });
      }
      if (reservedWindows.length === 0) return { ok: true, reservation: null, windows: snapshots } as const;
      const token = randomUUID();
      await tx.insert(schema.downstreamKeyQuotaReservations).values({
        reservationToken: token,
        downstreamApiKeyId: input.keyId,
        status: 'pending',
        amountJson: JSON.stringify(input.amounts),
        windowIdsJson: JSON.stringify(reservedWindows),
        expiresAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      return {
        ok: true,
        reservation: { token, keyId: input.keyId, expiresAt, windows: reservedWindows },
        windows: snapshots,
      } as const;
    });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return {
        ok: false,
        statusCode: 429,
        error: `API key ${error.metric} quota reached`,
        reason: 'quota_exceeded',
        metric: error.metric,
        retryAfterSeconds: error.retryAfterSeconds,
        resetAt: error.resetAt,
        limit: error.limit,
        remaining: error.remaining,
      };
    }
    throw error;
  }
}

export async function settleDownstreamKeyQuotaReservation(
  reservationToken: string,
  actualAmounts: QuotaMetricAmounts,
  now = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  return await db.transaction(async (tx) => {
    const reservation = await tx.select().from(schema.downstreamKeyQuotaReservations)
      .where(and(
        eq(schema.downstreamKeyQuotaReservations.reservationToken, reservationToken),
        eq(schema.downstreamKeyQuotaReservations.status, 'pending'),
      )).get();
    if (!reservation) return false;
    const windows = parseReservationWindows(reservation.windowIdsJson);
    for (const item of windows) {
      const actual = Number.isFinite(Number(actualAmounts[item.metric]))
        ? Math.max(0, Number(actualAmounts[item.metric]))
        : item.amount;
      await tx.update(schema.downstreamKeyUsageWindows).set({
        usedValue: sql`${schema.downstreamKeyUsageWindows.usedValue} + ${actual}`,
        reservedValue: sql`case when ${schema.downstreamKeyUsageWindows.reservedValue} - ${item.amount} < 0 then 0 else ${schema.downstreamKeyUsageWindows.reservedValue} - ${item.amount} end`,
        version: sql`${schema.downstreamKeyUsageWindows.version} + 1`,
        updatedAt: nowIso,
      }).where(eq(schema.downstreamKeyUsageWindows.id, item.windowId)).run();
    }
    await tx.update(schema.downstreamKeyQuotaReservations).set({
      status: 'settled',
      settledAt: nowIso,
      updatedAt: nowIso,
    }).where(eq(schema.downstreamKeyQuotaReservations.id, reservation.id)).run();
    return true;
  });
}

export async function releaseDownstreamKeyQuotaReservation(reservationToken: string, now = new Date()): Promise<boolean> {
  const nowIso = now.toISOString();
  return await db.transaction(async (tx) => {
    const reservation = await tx.select().from(schema.downstreamKeyQuotaReservations)
      .where(and(
        eq(schema.downstreamKeyQuotaReservations.reservationToken, reservationToken),
        eq(schema.downstreamKeyQuotaReservations.status, 'pending'),
      )).get();
    if (!reservation) return false;
    for (const item of parseReservationWindows(reservation.windowIdsJson)) {
      await tx.update(schema.downstreamKeyUsageWindows).set({
        reservedValue: sql`case when ${schema.downstreamKeyUsageWindows.reservedValue} - ${item.amount} < 0 then 0 else ${schema.downstreamKeyUsageWindows.reservedValue} - ${item.amount} end`,
        version: sql`${schema.downstreamKeyUsageWindows.version} + 1`,
        updatedAt: nowIso,
      }).where(eq(schema.downstreamKeyUsageWindows.id, item.windowId)).run();
    }
    await tx.update(schema.downstreamKeyQuotaReservations).set({
      status: 'released',
      releasedAt: nowIso,
      updatedAt: nowIso,
    }).where(eq(schema.downstreamKeyQuotaReservations.id, reservation.id)).run();
    return true;
  });
}

export async function recoverExpiredDownstreamKeyQuotaReservations(now = new Date()): Promise<number> {
  const rows = await db.select({ token: schema.downstreamKeyQuotaReservations.reservationToken })
    .from(schema.downstreamKeyQuotaReservations)
    .where(and(
      eq(schema.downstreamKeyQuotaReservations.status, 'pending'),
      lte(schema.downstreamKeyQuotaReservations.expiresAt, now.toISOString()),
    )).all();
  let recovered = 0;
  for (const row of rows) {
    if (await releaseDownstreamKeyQuotaReservation(row.token, now)) {
      await db.update(schema.downstreamKeyQuotaReservations).set({ status: 'expired', updatedAt: now.toISOString() })
        .where(eq(schema.downstreamKeyQuotaReservations.reservationToken, row.token)).run();
      recovered += 1;
    }
  }
  return recovered;
}

/** Record usage that was not pre-reserved, such as post-response cost settlement. */
export async function recordDownstreamKeyQuotaUsage(
  keyId: number,
  metric: QuotaMetric,
  amount: number,
  now = new Date(),
): Promise<void> {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return;
  const policies = (await listDownstreamKeyLimitPolicies(keyId)).filter((policy) => policy.enabled && policy.scopeType === 'key' && policy.metric === metric);
  if (policies.length === 0) return;
  const nowIso = now.toISOString();
  await db.transaction(async (tx) => {
    for (const policy of policies) {
      const bounds = resolveWindowBounds(policy, now);
      const row = await ensureUsageWindow(tx as typeof db, policy, bounds, nowIso);
      await tx.update(schema.downstreamKeyUsageWindows).set({
        usedValue: sql`${schema.downstreamKeyUsageWindows.usedValue} + ${value}`,
        version: sql`${schema.downstreamKeyUsageWindows.version} + 1`,
        updatedAt: nowIso,
      }).where(eq(schema.downstreamKeyUsageWindows.id, row.id)).run();
    }
  });
}

function parseReservationWindows(raw: string): QuotaReservation['windows'] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is QuotaReservation['windows'][number] => (
      !!item
      && typeof item === 'object'
      && Number.isFinite(Number(item.policyId))
      && Number.isFinite(Number(item.windowId))
      && typeof item.metric === 'string'
      && typeof item.windowStart === 'string'
      && Number.isFinite(Number(item.amount))
    )).map((item) => ({
      policyId: Math.trunc(Number(item.policyId)),
      metric: normalizeMetric(item.metric),
      windowStart: item.windowStart,
      amount: Math.max(0, Number(item.amount)),
      windowId: Math.trunc(Number(item.windowId)),
    }));
  } catch {
    return [];
  }
}

export class QuotaExceededError extends Error {
  readonly metric: QuotaMetric;
  readonly retryAfterSeconds: number;
  readonly resetAt: string;
  readonly limit: number;
  readonly remaining: number;

  constructor(input: { metric: QuotaMetric; retryAfterSeconds: number; resetAt: string; limit: number; remaining: number }) {
    super(`quota exceeded: ${input.metric}`);
    this.name = 'QuotaExceededError';
    this.metric = input.metric;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.resetAt = input.resetAt;
    this.limit = input.limit;
    this.remaining = input.remaining;
  }
}
