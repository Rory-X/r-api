import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
} from 'drizzle-orm';

import { db, runtimeDbDialect, schema } from '../db/index.js';
import type { ProxyHealthDomain } from './proxyHealthDomain.js';

export type StoredSiteRuntimeRecoveryState = 'healthy' | 'open' | 'recovering';

export type SiteRuntimeHealthPersistenceRecord = {
  scopeKey: string;
  siteId: number;
  scope: 'site' | 'model';
  modelName: string | null;
  recoveryState: StoredSiteRuntimeRecoveryState;
  penaltyScore: number;
  latencyEmaMs: number | null;
  firstByteLatencyEmaMs: number | null;
  firstByteSampleCount: number;
  transientFailureStreak: number;
  lastTransientFailureAtMs: number | null;
  recentSuccessCount: number;
  recentFailureCount: number;
  recentWindowUpdatedAtMs: number;
  breakerLevel: number;
  breakerUntilMs: number | null;
  recoverySuccessCount: number;
  lastProbeAtMs: number | null;
  lastProbeSuccessAtMs: number | null;
  lastUpdatedAtMs: number;
  lastFailureAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastFailureReason: string | null;
  lastFailureDomain: ProxyHealthDomain | null;
  lastFailureEndpointId: number | null;
};

export type SiteRuntimeRecoveryProbeLease = {
  owner: string;
  token: string;
  channelId: number;
  expiresAtMs: number;
  scopeKeys: string[];
};

export type ActiveSiteRuntimeRecoveryProbeLease = {
  scopeKey: string;
  owner: string;
  token: string;
  channelId: number;
  expiresAtMs: number;
};

const STORE_INSTANCE_ID = randomUUID();

function toIso(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function leaseOwner(): string {
  return `${hostname()}:${process.pid}:${STORE_INSTANCE_ID}`;
}

function toDbValues(record: SiteRuntimeHealthPersistenceRecord) {
  return {
    scopeKey: record.scopeKey,
    siteId: record.siteId,
    scope: record.scope,
    modelName: record.modelName,
    recoveryState: record.recoveryState,
    penaltyScore: record.penaltyScore,
    latencyEmaMs: record.latencyEmaMs,
    firstByteLatencyEmaMs: record.firstByteLatencyEmaMs,
    firstByteSampleCount: record.firstByteSampleCount,
    transientFailureStreak: record.transientFailureStreak,
    lastTransientFailureAt: toIso(record.lastTransientFailureAtMs),
    recentSuccessCount: record.recentSuccessCount,
    recentFailureCount: record.recentFailureCount,
    recentWindowUpdatedAt: toIso(record.recentWindowUpdatedAtMs) || new Date().toISOString(),
    breakerLevel: record.breakerLevel,
    breakerUntil: toIso(record.breakerUntilMs),
    recoverySuccessCount: record.recoverySuccessCount,
    lastProbeAt: toIso(record.lastProbeAtMs),
    lastProbeSuccessAt: toIso(record.lastProbeSuccessAtMs),
    lastFailureAt: toIso(record.lastFailureAtMs),
    lastSuccessAt: toIso(record.lastSuccessAtMs),
    lastFailureReason: record.lastFailureReason,
    lastFailureDomain: record.lastFailureDomain,
    lastFailureEndpointId: record.lastFailureEndpointId,
    updatedAt: toIso(record.lastUpdatedAtMs) || new Date().toISOString(),
  };
}

function toPersistenceRecord(
  row: typeof schema.siteRuntimeHealthStates.$inferSelect,
): SiteRuntimeHealthPersistenceRecord {
  return {
    scopeKey: row.scopeKey,
    siteId: row.siteId,
    scope: row.scope === 'model' ? 'model' : 'site',
    modelName: row.modelName ?? null,
    recoveryState: row.recoveryState as StoredSiteRuntimeRecoveryState,
    penaltyScore: row.penaltyScore,
    latencyEmaMs: row.latencyEmaMs ?? null,
    firstByteLatencyEmaMs: row.firstByteLatencyEmaMs ?? null,
    firstByteSampleCount: row.firstByteSampleCount,
    transientFailureStreak: row.transientFailureStreak,
    lastTransientFailureAtMs: toMs(row.lastTransientFailureAt),
    recentSuccessCount: row.recentSuccessCount,
    recentFailureCount: row.recentFailureCount,
    recentWindowUpdatedAtMs: toMs(row.recentWindowUpdatedAt) ?? Date.now(),
    breakerLevel: row.breakerLevel,
    breakerUntilMs: toMs(row.breakerUntil),
    recoverySuccessCount: row.recoverySuccessCount,
    lastProbeAtMs: toMs(row.lastProbeAt),
    lastProbeSuccessAtMs: toMs(row.lastProbeSuccessAt),
    lastUpdatedAtMs: toMs(row.updatedAt) ?? Date.now(),
    lastFailureAtMs: toMs(row.lastFailureAt),
    lastSuccessAtMs: toMs(row.lastSuccessAt),
    lastFailureReason: row.lastFailureReason ?? null,
    lastFailureDomain: (row.lastFailureDomain as ProxyHealthDomain | null) ?? null,
    lastFailureEndpointId: row.lastFailureEndpointId ?? null,
  };
}

export async function loadSiteRuntimeHealthRecords(): Promise<SiteRuntimeHealthPersistenceRecord[]> {
  const rows = await db.select().from(schema.siteRuntimeHealthStates).all();
  return rows.map(toPersistenceRecord);
}

export async function upsertSiteRuntimeHealthRecords(
  records: SiteRuntimeHealthPersistenceRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const siteIds = Array.from(new Set(records.map((record) => record.siteId)));
  const existingSites = await db.select({ id: schema.sites.id })
    .from(schema.sites)
    .where(inArray(schema.sites.id, siteIds))
    .all();
  const existingSiteIds = new Set(existingSites.map((site) => site.id));
  const persistedRecords = records.filter((record) => existingSiteIds.has(record.siteId));
  if (persistedRecords.length === 0) return;
  await db.transaction(async (tx: typeof db) => {
    for (const record of persistedRecords) {
      const values = toDbValues(record);
      const updateValues = {
        siteId: values.siteId,
        scope: values.scope,
        modelName: values.modelName,
        recoveryState: values.recoveryState,
        penaltyScore: values.penaltyScore,
        latencyEmaMs: values.latencyEmaMs,
        firstByteLatencyEmaMs: values.firstByteLatencyEmaMs,
        firstByteSampleCount: values.firstByteSampleCount,
        transientFailureStreak: values.transientFailureStreak,
        lastTransientFailureAt: values.lastTransientFailureAt,
        recentSuccessCount: values.recentSuccessCount,
        recentFailureCount: values.recentFailureCount,
        recentWindowUpdatedAt: values.recentWindowUpdatedAt,
        breakerLevel: values.breakerLevel,
        breakerUntil: values.breakerUntil,
        recoverySuccessCount: values.recoverySuccessCount,
        lastProbeAt: values.lastProbeAt,
        lastProbeSuccessAt: values.lastProbeSuccessAt,
        lastFailureAt: values.lastFailureAt,
        lastSuccessAt: values.lastSuccessAt,
        lastFailureReason: values.lastFailureReason,
        lastFailureDomain: values.lastFailureDomain,
        lastFailureEndpointId: values.lastFailureEndpointId,
        updatedAt: values.updatedAt,
      };
      if (runtimeDbDialect === 'mysql') {
        await (tx.insert(schema.siteRuntimeHealthStates).values(values) as any)
          .onDuplicateKeyUpdate({ set: updateValues })
          .run();
      } else {
        await (tx.insert(schema.siteRuntimeHealthStates).values(values) as any)
          .onConflictDoUpdate({
            target: schema.siteRuntimeHealthStates.scopeKey,
            set: updateValues,
          })
          .run();
      }
    }
  });
}

export async function deleteSiteRuntimeHealthRecords(scopeKeys: string[]): Promise<void> {
  const normalized = Array.from(new Set(scopeKeys.map((key) => key.trim()).filter(Boolean)));
  if (normalized.length === 0) return;
  await db.delete(schema.siteRuntimeHealthStates)
    .where(inArray(schema.siteRuntimeHealthStates.scopeKey, normalized))
    .run();
}

export async function listActiveSiteRuntimeRecoveryProbeLeases(
  nowMs = Date.now(),
): Promise<ActiveSiteRuntimeRecoveryProbeLease[]> {
  const nowIso = new Date(nowMs).toISOString();
  const rows = await db.select({
    scopeKey: schema.siteRuntimeHealthStates.scopeKey,
    owner: schema.siteRuntimeHealthStates.probeLeaseOwner,
    token: schema.siteRuntimeHealthStates.probeLeaseToken,
    channelId: schema.siteRuntimeHealthStates.probeLeaseChannelId,
    expiresAt: schema.siteRuntimeHealthStates.probeLeaseExpiresAt,
  }).from(schema.siteRuntimeHealthStates)
    .where(and(
      gt(schema.siteRuntimeHealthStates.probeLeaseExpiresAt, nowIso),
      gt(schema.siteRuntimeHealthStates.probeLeaseChannelId, 0),
    ))
    .all();

  return rows.flatMap((row) => {
    const expiresAtMs = toMs(row.expiresAt);
    if (!row.owner || !row.token || !row.channelId || expiresAtMs == null) return [];
    return [{
      scopeKey: row.scopeKey,
      owner: row.owner,
      token: row.token,
      channelId: row.channelId,
      expiresAtMs,
    }];
  });
}

export async function claimSiteRuntimeRecoveryProbeLease(input: {
  scopeKeys: string[];
  channelId: number;
  nowMs?: number;
  leaseMs: number;
}): Promise<SiteRuntimeRecoveryProbeLease | null> {
  const scopeKeys = Array.from(new Set(input.scopeKeys.map((key) => key.trim()).filter(Boolean)));
  if (scopeKeys.length === 0 || !Number.isFinite(input.channelId) || input.channelId <= 0) return null;
  const nowMs = input.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const lease: SiteRuntimeRecoveryProbeLease = {
    owner: leaseOwner(),
    token: randomUUID(),
    channelId: Math.trunc(input.channelId),
    expiresAtMs: nowMs + Math.max(1_000, Math.trunc(input.leaseMs)),
    scopeKeys,
  };
  const expiresAt = new Date(lease.expiresAtMs).toISOString();
  const claimedScopeKeys: string[] = [];

  for (const scopeKey of scopeKeys) {
    const result = await db.update(schema.siteRuntimeHealthStates).set({
      probeLeaseOwner: lease.owner,
      probeLeaseToken: lease.token,
      probeLeaseChannelId: lease.channelId,
      probeLeaseExpiresAt: expiresAt,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.siteRuntimeHealthStates.scopeKey, scopeKey),
      or(
        isNull(schema.siteRuntimeHealthStates.probeLeaseExpiresAt),
        lte(schema.siteRuntimeHealthStates.probeLeaseExpiresAt, nowIso),
      ),
    )).run();
    if (Number(result?.changes || 0) > 0) {
      claimedScopeKeys.push(scopeKey);
      continue;
    }
    if (claimedScopeKeys.length > 0) {
      await db.update(schema.siteRuntimeHealthStates).set({
        probeLeaseOwner: null,
        probeLeaseToken: null,
        probeLeaseChannelId: null,
        probeLeaseExpiresAt: null,
        updatedAt: nowIso,
      }).where(and(
        inArray(schema.siteRuntimeHealthStates.scopeKey, claimedScopeKeys),
        eq(schema.siteRuntimeHealthStates.probeLeaseToken, lease.token),
      )).run();
    }
    return null;
  }
  return lease;
}

export async function listOwnedSiteRuntimeRecoveryProbeScopes(input: {
  scopeKeys: string[];
  token: string;
  nowMs?: number;
}): Promise<Set<string>> {
  const scopeKeys = Array.from(new Set(input.scopeKeys.map((key) => key.trim()).filter(Boolean)));
  if (scopeKeys.length === 0 || !input.token.trim()) return new Set();
  const rows = await db.select({ scopeKey: schema.siteRuntimeHealthStates.scopeKey })
    .from(schema.siteRuntimeHealthStates)
    .where(and(
      inArray(schema.siteRuntimeHealthStates.scopeKey, scopeKeys),
      eq(schema.siteRuntimeHealthStates.probeLeaseToken, input.token),
      gt(
        schema.siteRuntimeHealthStates.probeLeaseExpiresAt,
        new Date(input.nowMs ?? Date.now()).toISOString(),
      ),
    ))
    .all();
  return new Set(rows.map((row) => row.scopeKey));
}

export async function releaseSiteRuntimeRecoveryProbeLease(token: string): Promise<void> {
  const normalized = token.trim();
  if (!normalized) return;
  await db.update(schema.siteRuntimeHealthStates).set({
    probeLeaseOwner: null,
    probeLeaseToken: null,
    probeLeaseChannelId: null,
    probeLeaseExpiresAt: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.siteRuntimeHealthStates.probeLeaseToken, normalized)).run();
}
