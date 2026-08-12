import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export type ModelSyncReconcileResult = {
  accountId: number;
  discovered: string[];
  retained: string[];
  retired: string[];
  missingCounts: Record<string, number>;
};

export type ModelSyncStatePublic = {
  accountId: number;
  modelName: string;
  consecutiveMissing: number;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  status: 'active' | 'candidate_retired';
  lastError: string | null;
  updatedAt: string | null;
};

export type ModelCapabilityMatrixPublic = {
  accountId: number;
  siteId: number;
  siteName: string;
  username: string | null;
  modelName: string;
  available: boolean | null;
  source: 'manual' | 'discovered' | 'sync_state';
  effectiveStatus: 'manual_override' | 'active' | 'candidate_retired';
  consecutiveMissing: number;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  checkedAt: string | null;
};

function normalizeModelName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeThreshold(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(32, parsed) : 3;
}

function modelKey(value: string): string {
  return value.trim().toLowerCase();
}

async function upsertSeenState(input: {
  accountId: number;
  modelName: string;
  syncAt: string;
}): Promise<void> {
  const current = await db.select().from(schema.modelSyncStates).where(and(
    eq(schema.modelSyncStates.accountId, input.accountId),
    eq(schema.modelSyncStates.modelName, input.modelName),
  )).get();
  if (current) {
    await db.update(schema.modelSyncStates).set({
      consecutiveMissing: 0,
      lastSeenAt: input.syncAt,
      lastSyncAt: input.syncAt,
      status: 'active',
      lastError: null,
      updatedAt: input.syncAt,
    }).where(eq(schema.modelSyncStates.id, current.id)).run();
    return;
  }
  await db.insert(schema.modelSyncStates).values({
    accountId: input.accountId,
    modelName: input.modelName,
    consecutiveMissing: 0,
    lastSeenAt: input.syncAt,
    lastSyncAt: input.syncAt,
    status: 'active',
    createdAt: input.syncAt,
    updatedAt: input.syncAt,
  }).run();
}

async function upsertMissingState(input: {
  accountId: number;
  modelName: string;
  syncAt: string;
  threshold: number;
}): Promise<number> {
  const current = await db.select().from(schema.modelSyncStates).where(and(
    eq(schema.modelSyncStates.accountId, input.accountId),
    eq(schema.modelSyncStates.modelName, input.modelName),
  )).get();
  const consecutiveMissing = (current?.consecutiveMissing || 0) + 1;
  const status = consecutiveMissing >= input.threshold ? 'candidate_retired' : 'active';
  if (current) {
    await db.update(schema.modelSyncStates).set({
      consecutiveMissing,
      lastSyncAt: input.syncAt,
      status,
      updatedAt: input.syncAt,
    }).where(eq(schema.modelSyncStates.id, current.id)).run();
  } else {
    await db.insert(schema.modelSyncStates).values({
      accountId: input.accountId,
      modelName: input.modelName,
      consecutiveMissing,
      lastSeenAt: null,
      lastSyncAt: input.syncAt,
      status,
      createdAt: input.syncAt,
      updatedAt: input.syncAt,
    }).run();
  }
  return consecutiveMissing;
}

/**
 * Reconcile a successful, management-endpoint model discovery with the last
 * known model set. Missing models remain routable until the contract threshold
 * is reached; discovery failures should call restore instead of this method.
 */
export async function reconcileModelSyncPolicy(input: {
  accountId: number;
  previousRows?: Array<typeof schema.modelAvailability.$inferSelect>;
  discoveredModels: string[];
  retireMissingAfterConsecutiveRuns?: number;
  syncAt?: string;
}): Promise<ModelSyncReconcileResult> {
  const syncAt = input.syncAt || new Date().toISOString();
  const threshold = normalizeThreshold(input.retireMissingAfterConsecutiveRuns);
  const discovered = [...new Map(
    input.discoveredModels
      .map(normalizeModelName)
      .filter(Boolean)
      .map((name) => [modelKey(name), name] as const),
  ).values()];
  const discoveredKeys = new Set(discovered.map(modelKey));
  const priorRows = input.previousRows ?? await db.select().from(schema.modelAvailability).where(and(
    eq(schema.modelAvailability.accountId, input.accountId),
    eq(schema.modelAvailability.isManual, false),
  )).all();
  const retained: string[] = [];
  const retired: string[] = [];
  const missingCounts: Record<string, number> = {};

  for (const modelName of discovered) {
    await upsertSeenState({ accountId: input.accountId, modelName, syncAt });
  }

  for (const prior of priorRows) {
    const key = modelKey(prior.modelName);
    if (discoveredKeys.has(key)) continue;
    const consecutiveMissing = await upsertMissingState({
      accountId: input.accountId,
      modelName: prior.modelName,
      syncAt,
      threshold,
    });
    missingCounts[prior.modelName] = consecutiveMissing;
    const isRetired = consecutiveMissing >= threshold;
    if (isRetired) retired.push(prior.modelName);
    else retained.push(prior.modelName);
    const availabilityPatch = {
      available: isRetired ? false : (prior.available ?? true),
      isManual: false,
      latencyMs: prior.latencyMs,
      checkedAt: prior.checkedAt,
    };
    const existingAvailability = await db.select({ id: schema.modelAvailability.id })
      .from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.id, prior.id))
      .get();
    if (existingAvailability) {
      await db.update(schema.modelAvailability).set(availabilityPatch)
        .where(eq(schema.modelAvailability.id, prior.id)).run();
    } else {
      await db.insert(schema.modelAvailability).values({
        accountId: input.accountId,
        modelName: prior.modelName,
        ...availabilityPatch,
      }).run();
    }
  }

  return { accountId: input.accountId, discovered, retained, retired, missingCounts };
}

/** Restore the exact last known non-manual set after a failed discovery. */
export async function restoreModelAvailabilitySnapshot(input: {
  accountId: number;
  rows: Array<typeof schema.modelAvailability.$inferSelect>;
}): Promise<void> {
  const current = await db.select({ id: schema.modelAvailability.id })
    .from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, input.accountId),
      eq(schema.modelAvailability.isManual, false),
    )).all();
  if (current.length > 0) {
    await db.delete(schema.modelAvailability).where(and(
      eq(schema.modelAvailability.accountId, input.accountId),
      eq(schema.modelAvailability.isManual, false),
    )).run();
  }
  if (input.rows.length > 0) {
    await db.insert(schema.modelAvailability).values(
      input.rows.map(({ id: _id, ...row }) => row),
    ).run();
  }
}

export async function listModelSyncStates(options?: {
  accountId?: number;
  status?: 'active' | 'candidate_retired';
}): Promise<ModelSyncStatePublic[]> {
  const conditions = [] as ReturnType<typeof eq>[];
  if (options?.accountId !== undefined) conditions.push(eq(schema.modelSyncStates.accountId, options.accountId));
  if (options?.status) conditions.push(eq(schema.modelSyncStates.status, options.status));
  const rows = await db.select().from(schema.modelSyncStates)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(schema.modelSyncStates.accountId, schema.modelSyncStates.modelName)
    .all();
  return rows.map((row) => ({
    accountId: row.accountId,
    modelName: row.modelName,
    consecutiveMissing: row.consecutiveMissing,
    lastSeenAt: row.lastSeenAt ?? null,
    lastSyncAt: row.lastSyncAt ?? null,
    status: row.status as 'active' | 'candidate_retired',
    lastError: row.lastError ?? null,
    updatedAt: row.updatedAt ?? null,
  }));
}

export async function listModelCapabilityMatrix(options?: {
  accountId?: number;
  status?: 'active' | 'candidate_retired' | 'manual_override';
}): Promise<ModelCapabilityMatrixPublic[]> {
  const availabilityRows = await db.select({
    accountId: schema.modelAvailability.accountId,
    siteId: schema.accounts.siteId,
    siteName: schema.sites.name,
    username: schema.accounts.username,
    modelName: schema.modelAvailability.modelName,
    available: schema.modelAvailability.available,
    isManual: schema.modelAvailability.isManual,
    checkedAt: schema.modelAvailability.checkedAt,
  }).from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(options?.accountId !== undefined ? eq(schema.modelAvailability.accountId, options.accountId) : undefined)
    .all();

  const stateRows = await db.select().from(schema.modelSyncStates)
    .where(options?.accountId !== undefined ? eq(schema.modelSyncStates.accountId, options.accountId) : undefined)
    .all();
  type ModelSyncStateRow = typeof schema.modelSyncStates.$inferSelect;
  const stateByKey = new Map<string, ModelSyncStateRow>();
  for (const row of stateRows) {
    stateByKey.set(`${row.accountId}:${modelKey(row.modelName)}`, row);
  }
  const seen = new Set<string>();
  const result: ModelCapabilityMatrixPublic[] = [];

  for (const row of availabilityRows) {
    const key = `${row.accountId}:${modelKey(row.modelName)}`;
    seen.add(key);
    const syncState = stateByKey.get(key);
    const effectiveStatus = row.isManual
      ? 'manual_override'
      : ((syncState?.status as 'active' | 'candidate_retired' | undefined) || 'active');
    if (options?.status && effectiveStatus !== options.status) continue;
    result.push({
      accountId: row.accountId,
      siteId: row.siteId,
      siteName: row.siteName,
      username: row.username ?? null,
      modelName: row.modelName,
      available: row.available ?? null,
      source: row.isManual ? 'manual' : 'discovered',
      effectiveStatus,
      consecutiveMissing: syncState?.consecutiveMissing ?? 0,
      lastSeenAt: syncState?.lastSeenAt ?? null,
      lastSyncAt: syncState?.lastSyncAt ?? null,
      lastError: syncState?.lastError ?? null,
      checkedAt: row.checkedAt ?? null,
    });
  }

  for (const row of stateRows) {
    const key = `${row.accountId}:${modelKey(row.modelName)}`;
    if (seen.has(key)) continue;
    const effectiveStatus = row.status as 'active' | 'candidate_retired';
    if (options?.status && effectiveStatus !== options.status) continue;
    const accountRow = await db.select({
      siteId: schema.accounts.siteId,
      siteName: schema.sites.name,
      username: schema.accounts.username,
    }).from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, row.accountId)).get();
    if (!accountRow) continue;
    result.push({
      accountId: row.accountId,
      siteId: accountRow.siteId,
      siteName: accountRow.siteName,
      username: accountRow.username ?? null,
      modelName: row.modelName,
      available: null,
      source: 'sync_state',
      effectiveStatus,
      consecutiveMissing: row.consecutiveMissing,
      lastSeenAt: row.lastSeenAt ?? null,
      lastSyncAt: row.lastSyncAt ?? null,
      lastError: row.lastError ?? null,
      checkedAt: null,
    });
  }

  return result.sort((left, right) => (
    left.modelName.localeCompare(right.modelName)
    || left.siteName.localeCompare(right.siteName)
    || left.accountId - right.accountId
  ));
}
