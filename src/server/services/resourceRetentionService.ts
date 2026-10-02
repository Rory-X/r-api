import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, resolve, sep, join } from 'node:path';
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { getUsageAggregationProjectionStatus, runUsageAggregationProjectionPass } from './usageAggregationService.js';

export type RetentionResource =
  | 'proxy_logs'
  | 'proxy_request_ledger'
  | 'program_events'
  | 'proxy_debug_traces'
  | 'proxy_files'
  | 'notification_outbox';

export const RETENTION_RESOURCES: readonly RetentionResource[] = [
  'proxy_logs',
  'proxy_request_ledger',
  'program_events',
  'proxy_debug_traces',
  'proxy_files',
  'notification_outbox',
];

export type RetentionPolicy = {
  resource: RetentionResource;
  enabled: boolean;
  hotDays: number;
  archiveEnabled: boolean;
  archiveDays: number | null;
  deleteDays: number | null;
  batchSize: number;
  schedule: string;
  implementation: 'archive' | 'cleanup' | 'observe_only';
};

export type RetentionPreview = {
  resource: RetentionResource;
  policy: RetentionPolicy;
  now: string;
  archiveCutoffUtc: string | null;
  deleteCutoffUtc: string | null;
  archiveCandidates: number;
  deleteCandidates: number;
  blockedCandidates: number;
  blockedByProjection: boolean;
  projectedThroughId: number | null;
  candidateMaxId: number | null;
  note: string | null;
};

export type RetentionRunResult = {
  resource: RetentionResource;
  dryRun: boolean;
  preview: RetentionPreview;
  archivedRows: number;
  deletedRows: number;
  manifest: typeof schema.archiveManifests.$inferSelect | null;
};

const ARCHIVE_SCHEMA_VERSION = 1;
const DEFAULT_ARCHIVE_DAYS = 365;
const DEFAULT_LEDGER_HOT_DAYS = 30;
const DEFAULT_PROGRAM_EVENT_HOT_DAYS = 90;
const DEFAULT_DEBUG_HOT_DAYS = 1;
const DEFAULT_BATCH_SIZE = 250;
const TERMINAL_LEDGER_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

function normalizeDays(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBatchSize(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(2_000, parsed) : DEFAULT_BATCH_SIZE;
}

function cutoffUtc(days: number | null, nowMs: number): string | null {
  if (days == null || days <= 0) return null;
  return formatUtcSqlDateTime(new Date(nowMs - days * 24 * 60 * 60 * 1_000));
}

function buildPolicies(): RetentionPolicy[] {
  const logDays = normalizeDays(
    config.logCleanupRetentionDays || config.proxyLogRetentionDays,
    30,
  );
  const fileDays = normalizeDays(config.proxyFileRetentionDays, 7);
  const outboxDays = normalizeDays(config.notifyOutboxRetentionDays, 30);
  return [
    {
      resource: 'proxy_logs',
      enabled: config.logCleanupUsageLogsEnabled || config.proxyLogRetentionDays > 0,
      hotDays: logDays,
      archiveEnabled: true,
      archiveDays: DEFAULT_ARCHIVE_DAYS,
      deleteDays: DEFAULT_ARCHIVE_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
      schedule: config.logCleanupCron || 'manual',
      implementation: 'archive',
    },
    {
      resource: 'proxy_request_ledger',
      enabled: true,
      hotDays: DEFAULT_LEDGER_HOT_DAYS,
      archiveEnabled: true,
      archiveDays: DEFAULT_ARCHIVE_DAYS,
      deleteDays: DEFAULT_ARCHIVE_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
      schedule: 'manual',
      implementation: 'archive',
    },
    {
      resource: 'program_events',
      enabled: config.logCleanupProgramLogsEnabled,
      hotDays: DEFAULT_PROGRAM_EVENT_HOT_DAYS,
      archiveEnabled: false,
      archiveDays: null,
      deleteDays: DEFAULT_ARCHIVE_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
      schedule: config.logCleanupCron || 'manual',
      implementation: 'cleanup',
    },
    {
      resource: 'proxy_debug_traces',
      enabled: config.proxyDebugTraceEnabled,
      hotDays: DEFAULT_DEBUG_HOT_DAYS,
      archiveEnabled: false,
      archiveDays: null,
      deleteDays: DEFAULT_DEBUG_HOT_DAYS,
      batchSize: DEFAULT_BATCH_SIZE,
      schedule: 'on_write',
      implementation: 'cleanup',
    },
    {
      resource: 'proxy_files',
      enabled: config.proxyFileRetentionDays > 0,
      hotDays: fileDays,
      archiveEnabled: false,
      archiveDays: null,
      deleteDays: fileDays,
      batchSize: DEFAULT_BATCH_SIZE,
      schedule: 'manual',
      implementation: 'cleanup',
    },
    {
      resource: 'notification_outbox',
      enabled: true,
      hotDays: outboxDays,
      archiveEnabled: false,
      archiveDays: null,
      deleteDays: outboxDays,
      batchSize: DEFAULT_BATCH_SIZE,
      schedule: 'hourly',
      implementation: 'cleanup',
    },
  ];
}

export function getRetentionPolicies(): RetentionPolicy[] {
  return buildPolicies();
}

function getPolicy(resource: RetentionResource): RetentionPolicy {
  const policy = buildPolicies().find((item) => item.resource === resource);
  if (!policy) throw new Error(`unknown retention resource: ${resource}`);
  return policy;
}

function withWhere<T>(query: T, where: SQL | undefined): T {
  return where ? (query as any).where(where) : query;
}

async function countRows(table: unknown, where?: SQL): Promise<number> {
  const query = db.select({ count: sql<number>`count(*)` }).from(table as any);
  const row = await withWhere(query, where).get();
  return Math.max(0, Math.trunc(Number(row?.count || 0)));
}

async function maxId(table: unknown, where?: SQL): Promise<number | null> {
  const query = db.select({ maxId: sql<number>`max(id)` }).from(table as any);
  const row = await withWhere(query, where).get();
  const value = Math.trunc(Number(row?.maxId || 0));
  return value > 0 ? value : null;
}

function oldRowCondition(createdAt: any, cutoff: string): SQL {
  return lt(createdAt, cutoff);
}

function formatObjectKey(resource: RetentionResource, now: Date, fileName: string): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return join('archives', resource, year, month, fileName).split(sep).join('/');
}

function resolveArchivePath(objectKey: string): string {
  return resolve(config.dataDir, objectKey);
}

function serializeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function createArchiveManifest(input: {
  resource: RetentionResource;
  rows: unknown[];
  nowIso: string;
}): Promise<number> {
  const ids = input.rows
    .map((row) => Number((row as { id?: unknown }).id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  const createdAtValues = input.rows
    .map((row) => String((row as { createdAt?: unknown }).createdAt || '').trim())
    .filter(Boolean)
    .sort();
  const result = await db.insert(schema.archiveManifests).values({
    resource: input.resource,
    status: 'writing',
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    rowCount: input.rows.length,
    minId: ids.length > 0 ? Math.min(...ids) : null,
    maxId: ids.length > 0 ? Math.max(...ids) : null,
    minCreatedAt: createdAtValues[0] || null,
    maxCreatedAt: createdAtValues.at(-1) || null,
    storageDriver: 'local',
    startedAt: input.nowIso,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }).run();
  return requireInsertedRowId(result, 'archive manifest insert did not return an id');
}

async function writeArchiveFile(input: {
  resource: RetentionResource;
  manifestId: number;
  rows: unknown[];
  now: Date;
}): Promise<{ objectKey: string; byteSize: number; sha256: string }> {
  const fileName = `${input.now.getTime()}-${input.manifestId}-${randomUUID()}.ndjson.gz`;
  const objectKey = formatObjectKey(input.resource, input.now, fileName);
  const finalPath = resolveArchivePath(objectKey);
  const tempPath = `${finalPath}.tmp`;
  const payload = gzipSync(input.rows.map(serializeLine).join(''), { level: 6 });
  const sha256 = createHash('sha256').update(payload).digest('hex');

  await mkdir(dirname(finalPath), { recursive: true });
  try {
    await writeFile(tempPath, payload, { mode: 0o600 });
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return { objectKey, byteSize: payload.byteLength, sha256 };
}

async function markManifestFailed(manifestId: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error || 'archive failed');
  await db.update(schema.archiveManifests).set({
    status: 'failed',
    lastError: message.slice(0, 2_000),
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.archiveManifests.id, manifestId)).run();
}

async function archiveRows(input: {
  resource: RetentionResource;
  rows: unknown[];
  manifestRows?: unknown[];
  now: Date;
  markArchived: () => Promise<number>;
}): Promise<{
  archivedRows: number;
  manifest: typeof schema.archiveManifests.$inferSelect;
}> {
  const nowIso = input.now.toISOString();
  const manifestId = await createArchiveManifest({
    resource: input.resource,
    rows: input.manifestRows || input.rows,
    nowIso,
  });
  try {
    const file = await writeArchiveFile({
      resource: input.resource,
      manifestId,
      rows: input.rows,
      now: input.now,
    });
    const committedAt = new Date().toISOString();
    await db.update(schema.archiveManifests).set({
      status: 'committed',
      objectKey: file.objectKey,
      byteSize: file.byteSize,
      sha256: file.sha256,
      committedAt,
      updatedAt: committedAt,
    }).where(eq(schema.archiveManifests.id, manifestId)).run();

    const archivedRows = await input.markArchived();
    const sourceDeletedAt = new Date().toISOString();
    const manifest = await db.update(schema.archiveManifests).set({
      updatedAt: sourceDeletedAt,
    }).where(eq(schema.archiveManifests.id, manifestId)).run();
    void manifest;
    const loaded = await db.select().from(schema.archiveManifests)
      .where(eq(schema.archiveManifests.id, manifestId)).get();
    if (!loaded) throw new Error('archive manifest disappeared after commit');
    return { archivedRows, manifest: loaded };
  } catch (error) {
    await markManifestFailed(manifestId, error);
    throw error;
  }
}

async function archiveProxyLogs(policy: RetentionPolicy, now: Date, safeProxyLogId: number) {
  const archiveCutoff = cutoffUtc(policy.hotDays, now.getTime());
  if (!archiveCutoff || safeProxyLogId <= 0) return { archivedRows: 0, manifest: null };
  const rows = await db.select().from(schema.proxyLogs)
    .where(and(
      isNull(schema.proxyLogs.archivedAt),
      oldRowCondition(schema.proxyLogs.createdAt, archiveCutoff),
      lte(schema.proxyLogs.id, safeProxyLogId),
    ))
    .orderBy(asc(schema.proxyLogs.id))
    .limit(policy.batchSize)
    .all();
  if (rows.length === 0) return { archivedRows: 0, manifest: null };
  const ids = rows.map((row) => row.id);
  return archiveRows({
    resource: 'proxy_logs',
    rows,
    now,
    markArchived: async () => Number((await db.update(schema.proxyLogs).set({
      archivedAt: new Date().toISOString(),
    }).where(inArray(schema.proxyLogs.id, ids)).run()).changes || 0),
  });
}

async function archiveProxyRequestLedger(policy: RetentionPolicy, now: Date) {
  const archiveCutoff = cutoffUtc(policy.hotDays, now.getTime());
  if (!archiveCutoff) return { archivedRows: 0, manifest: null };
  const rows = await db.select().from(schema.proxyRequests)
    .where(and(
      isNull(schema.proxyRequests.archivedAt),
      inArray(schema.proxyRequests.status, [...TERMINAL_LEDGER_STATUSES]),
      or(
        oldRowCondition(schema.proxyRequests.updatedAt, archiveCutoff),
        and(isNull(schema.proxyRequests.updatedAt), oldRowCondition(schema.proxyRequests.createdAt, archiveCutoff)),
      ),
    ))
    .orderBy(asc(schema.proxyRequests.id))
    .limit(policy.batchSize)
    .all();
  if (rows.length === 0) return { archivedRows: 0, manifest: null };
  const requestIds = rows.map((row) => row.id);
  const attempts = requestIds.length > 0
    ? await db.select().from(schema.proxyRequestAttempts)
      .where(inArray(schema.proxyRequestAttempts.requestRowId, requestIds))
      .orderBy(asc(schema.proxyRequestAttempts.requestRowId), asc(schema.proxyRequestAttempts.attemptIndex))
      .all()
    : [];
  const attemptsByRequestId = new Map<number, typeof attempts>();
  for (const attempt of attempts) {
    const bucket = attemptsByRequestId.get(attempt.requestRowId) || [];
    bucket.push(attempt);
    attemptsByRequestId.set(attempt.requestRowId, bucket);
  }
  const archiveRowsPayload = rows.map((request) => ({
    request,
    attempts: attemptsByRequestId.get(request.id) || [],
  }));
  return archiveRows({
    resource: 'proxy_request_ledger',
    rows: archiveRowsPayload,
    manifestRows: rows,
    now,
    markArchived: async () => Number((await db.update(schema.proxyRequests).set({
      archivedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).where(inArray(schema.proxyRequests.id, requestIds)).run()).changes || 0),
  });
}

async function deleteArchivedProxyLogs(policy: RetentionPolicy, now: Date, safeProxyLogId: number): Promise<number> {
  const deleteCutoff = cutoffUtc(policy.deleteDays, now.getTime());
  if (!deleteCutoff || safeProxyLogId <= 0) return 0;
  return Number((await db.delete(schema.proxyLogs).where(and(
    isNotNull(schema.proxyLogs.archivedAt),
    oldRowCondition(schema.proxyLogs.createdAt, deleteCutoff),
    lte(schema.proxyLogs.id, safeProxyLogId),
  )).run()).changes || 0);
}

async function deleteArchivedLedgers(policy: RetentionPolicy, now: Date): Promise<number> {
  const deleteCutoff = cutoffUtc(policy.deleteDays, now.getTime());
  if (!deleteCutoff) return 0;
  const rows = await db.select({ id: schema.proxyRequests.id }).from(schema.proxyRequests)
    .where(and(
      isNotNull(schema.proxyRequests.archivedAt),
      inArray(schema.proxyRequests.status, [...TERMINAL_LEDGER_STATUSES]),
      or(
        oldRowCondition(schema.proxyRequests.updatedAt, deleteCutoff),
        and(isNull(schema.proxyRequests.updatedAt), oldRowCondition(schema.proxyRequests.createdAt, deleteCutoff)),
      ),
    )).all();
  if (rows.length === 0) return 0;
  return Number((await db.delete(schema.proxyRequests)
    .where(inArray(schema.proxyRequests.id, rows.map((row) => row.id))).run()).changes || 0);
}

async function previewProxyLogs(policy: RetentionPolicy, now: Date): Promise<RetentionPreview> {
  const archiveCutoff = cutoffUtc(policy.hotDays, now.getTime());
  const deleteCutoff = cutoffUtc(policy.deleteDays, now.getTime());
  const projection = await getUsageAggregationProjectionStatus();
  const safeId = projection.safeProxyLogId;
  const archiveWhere = archiveCutoff
    ? and(isNull(schema.proxyLogs.archivedAt), oldRowCondition(schema.proxyLogs.createdAt, archiveCutoff))
    : undefined;
  const safeArchiveWhere = archiveWhere ? and(archiveWhere, lte(schema.proxyLogs.id, safeId)) : undefined;
  const blockedWhere = archiveWhere && safeId >= 0 ? and(archiveWhere, sql`${schema.proxyLogs.id} > ${safeId}`) : undefined;
  const deleteWhere = deleteCutoff
    ? and(isNotNull(schema.proxyLogs.archivedAt), oldRowCondition(schema.proxyLogs.createdAt, deleteCutoff), lte(schema.proxyLogs.id, safeId))
    : undefined;
  const [archiveCandidates, blockedCandidates, deleteCandidates, candidateMaxId] = await Promise.all([
    countRows(schema.proxyLogs, safeArchiveWhere),
    countRows(schema.proxyLogs, blockedWhere),
    countRows(schema.proxyLogs, deleteWhere),
    maxId(schema.proxyLogs, archiveWhere),
  ]);
  return {
    resource: policy.resource,
    policy,
    now: now.toISOString(),
    archiveCutoffUtc: archiveCutoff,
    deleteCutoffUtc: deleteCutoff,
    archiveCandidates,
    deleteCandidates,
    blockedCandidates,
    blockedByProjection: blockedCandidates > 0,
    projectedThroughId: safeId,
    candidateMaxId,
    note: blockedCandidates > 0 ? '成本投影尚未覆盖全部归档候选日志' : null,
  };
}

async function previewLedger(policy: RetentionPolicy, now: Date): Promise<RetentionPreview> {
  const archiveCutoff = cutoffUtc(policy.hotDays, now.getTime());
  const deleteCutoff = cutoffUtc(policy.deleteDays, now.getTime());
  const terminal = inArray(schema.proxyRequests.status, [...TERMINAL_LEDGER_STATUSES]);
  const archiveWhere = archiveCutoff
    ? and(isNull(schema.proxyRequests.archivedAt), terminal, or(
      oldRowCondition(schema.proxyRequests.updatedAt, archiveCutoff),
      and(isNull(schema.proxyRequests.updatedAt), oldRowCondition(schema.proxyRequests.createdAt, archiveCutoff)),
    ))
    : undefined;
  const deleteWhere = deleteCutoff
    ? and(isNotNull(schema.proxyRequests.archivedAt), terminal, or(
      oldRowCondition(schema.proxyRequests.updatedAt, deleteCutoff),
      and(isNull(schema.proxyRequests.updatedAt), oldRowCondition(schema.proxyRequests.createdAt, deleteCutoff)),
    ))
    : undefined;
  const blockedWhere = archiveCutoff
    ? and(isNull(schema.proxyRequests.archivedAt), sql`${schema.proxyRequests.status} in ('active', 'unknown')`, or(
      oldRowCondition(schema.proxyRequests.updatedAt, archiveCutoff),
      and(isNull(schema.proxyRequests.updatedAt), oldRowCondition(schema.proxyRequests.createdAt, archiveCutoff)),
    ))
    : undefined;
  const [archiveCandidates, deleteCandidates, blockedCandidates, candidateMaxId] = await Promise.all([
    countRows(schema.proxyRequests, archiveWhere),
    countRows(schema.proxyRequests, deleteWhere),
    countRows(schema.proxyRequests, blockedWhere),
    maxId(schema.proxyRequests, archiveWhere),
  ]);
  return {
    resource: policy.resource,
    policy,
    now: now.toISOString(),
    archiveCutoffUtc: archiveCutoff,
    deleteCutoffUtc: deleteCutoff,
    archiveCandidates,
    deleteCandidates,
    blockedCandidates,
    blockedByProjection: false,
    projectedThroughId: null,
    candidateMaxId,
    note: blockedCandidates > 0 ? '活跃或结果未知的请求账本不会自动归档' : null,
  };
}

async function previewSimpleResource(resource: RetentionResource, policy: RetentionPolicy, now: Date): Promise<RetentionPreview> {
  const deleteCutoff = cutoffUtc(policy.deleteDays, now.getTime());
  let archiveCandidates = 0;
  let deleteCandidates = 0;
  let blockedCandidates = 0;
  if (resource === 'program_events' && deleteCutoff) {
    const oldEvents = oldRowCondition(schema.events.createdAt, deleteCutoff);
    deleteCandidates = await countRows(schema.events, and(oldEvents, or(
      eq(schema.events.read, true),
      inArray(schema.events.level, ['info', 'warning']),
    )));
    blockedCandidates = await countRows(schema.events, and(
      oldEvents,
      eq(schema.events.read, false),
      eq(schema.events.level, 'error'),
    ));
  } else if (resource === 'proxy_debug_traces' && deleteCutoff) {
    deleteCandidates = await countRows(schema.proxyDebugTraces, oldRowCondition(schema.proxyDebugTraces.createdAt, deleteCutoff));
  } else if (resource === 'proxy_files' && deleteCutoff) {
    deleteCandidates = await countRows(schema.proxyFiles, or(
      oldRowCondition(schema.proxyFiles.createdAt, deleteCutoff),
      and(isNull(schema.proxyFiles.createdAt), oldRowCondition(schema.proxyFiles.updatedAt, deleteCutoff)),
    ));
  } else if (resource === 'notification_outbox' && deleteCutoff) {
    deleteCandidates = await countRows(schema.notificationOutbox, and(
      inArray(schema.notificationOutbox.status, ['delivered', 'delivery_unknown']),
      oldRowCondition(schema.notificationOutbox.createdAt, deleteCutoff),
    ));
  }
  return {
    resource,
    policy,
    now: now.toISOString(),
    archiveCutoffUtc: null,
    deleteCutoffUtc: deleteCutoff,
    archiveCandidates,
    deleteCandidates,
    blockedCandidates,
    blockedByProjection: false,
    projectedThroughId: null,
    candidateMaxId: null,
    note: blockedCandidates > 0
      ? '未读错误事件会被保留，直到人工确认'
      : '当前资源沿用现有清理器，归档提交协议尚未启用',
  };
}

async function executeSimpleCleanup(resource: RetentionResource, policy: RetentionPolicy, now: Date): Promise<number> {
  const deleteCutoff = cutoffUtc(policy.deleteDays, now.getTime());
  if (!deleteCutoff) return 0;
  if (resource === 'program_events') {
    return Number((await db.delete(schema.events).where(and(
      oldRowCondition(schema.events.createdAt, deleteCutoff),
      or(eq(schema.events.read, true), inArray(schema.events.level, ['info', 'warning'])),
    )).run()).changes || 0);
  }
  if (resource === 'proxy_debug_traces') {
    return Number((await db.delete(schema.proxyDebugTraces)
      .where(oldRowCondition(schema.proxyDebugTraces.createdAt, deleteCutoff)).run()).changes || 0);
  }
  if (resource === 'proxy_files') {
    return Number((await db.delete(schema.proxyFiles).where(or(
      oldRowCondition(schema.proxyFiles.createdAt, deleteCutoff),
      and(isNull(schema.proxyFiles.createdAt), oldRowCondition(schema.proxyFiles.updatedAt, deleteCutoff)),
    )).run()).changes || 0);
  }
  if (resource === 'notification_outbox') {
    return Number((await db.delete(schema.notificationOutbox).where(and(
      inArray(schema.notificationOutbox.status, ['delivered', 'delivery_unknown']),
      oldRowCondition(schema.notificationOutbox.createdAt, deleteCutoff),
    )).run()).changes || 0);
  }
  return 0;
}

export async function previewResourceRetention(
  resource: RetentionResource,
  nowMs = Date.now(),
): Promise<RetentionPreview> {
  const policy = getPolicy(resource);
  const now = new Date(nowMs);
  if (resource === 'proxy_logs') return previewProxyLogs(policy, now);
  if (resource === 'proxy_request_ledger') return previewLedger(policy, now);
  return previewSimpleResource(resource, policy, now);
}

export async function previewAllResourceRetention(nowMs = Date.now()): Promise<RetentionPreview[]> {
  return Promise.all(buildPolicies().map((policy) => previewResourceRetention(policy.resource, nowMs)));
}

export async function runResourceRetention(input: {
  resource: RetentionResource;
  dryRun?: boolean;
  nowMs?: number;
}): Promise<RetentionRunResult> {
  const now = new Date(input.nowMs ?? Date.now());
  const policy = getPolicy(input.resource);
  if (input.dryRun) {
    return {
      resource: input.resource,
      dryRun: true,
      preview: await previewResourceRetention(input.resource, now.getTime()),
      archivedRows: 0,
      deletedRows: 0,
      manifest: null,
    };
  }

  if (!policy.enabled) {
    return {
      resource: input.resource,
      dryRun: false,
      preview: await previewResourceRetention(input.resource, now.getTime()),
      archivedRows: 0,
      deletedRows: 0,
      manifest: null,
    };
  }

  let safeProxyLogId = 0;
  if (input.resource === 'proxy_logs') {
    await runUsageAggregationProjectionPass();
    safeProxyLogId = (await getUsageAggregationProjectionStatus()).safeProxyLogId;
  }

  const preview = await previewResourceRetention(input.resource, now.getTime());
  if (input.resource !== 'proxy_logs' && input.resource !== 'proxy_request_ledger') {
    return {
      resource: input.resource,
      dryRun: false,
      preview,
      archivedRows: 0,
      deletedRows: await executeSimpleCleanup(input.resource, policy, now),
      manifest: null,
    };
  }
  const archiveResult = input.resource === 'proxy_logs'
    ? await archiveProxyLogs(policy, now, safeProxyLogId)
    : await archiveProxyRequestLedger(policy, now);
  const deletedRows = input.resource === 'proxy_logs'
    ? await deleteArchivedProxyLogs(policy, now, safeProxyLogId)
    : await deleteArchivedLedgers(policy, now);

  return {
    resource: input.resource,
    dryRun: false,
    preview,
    archivedRows: archiveResult.archivedRows,
    deletedRows,
    manifest: archiveResult.manifest,
  };
}

export async function listArchiveManifests(input: {
  resource?: RetentionResource;
  limit?: number;
} = {}): Promise<Array<typeof schema.archiveManifests.$inferSelect>> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  const where = input.resource ? eq(schema.archiveManifests.resource, input.resource) : undefined;
  const query = db.select().from(schema.archiveManifests);
  return await (where ? query.where(where) : query)
    .orderBy(asc(schema.archiveManifests.createdAt), asc(schema.archiveManifests.id))
    .limit(limit)
    .all();
}
