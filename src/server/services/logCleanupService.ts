import { and, lt, lte, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';
import {
  getUsageAggregationProjectionStatus,
  runUsageAggregationProjectionPass,
} from './usageAggregationService.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type LogCleanupOptions = {
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
  nowMs?: number;
};

export type LogCleanupResult = {
  enabled: boolean;
  usageLogsEnabled: boolean;
  programLogsEnabled: boolean;
  retentionDays: number;
  cutoffUtc: string | null;
  usageLogsDeleted: number;
  usageLogsCandidateMaxId: number;
  usageLogsProjectedThroughId: number;
  usageLogsBlockedByProjection: boolean;
  programLogsDeleted: number;
  totalDeleted: number;
};

export function getLogCleanupCutoffUtc(retentionDays: number, nowMs = Date.now()): string | null {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  return formatUtcSqlDateTime(new Date(nowMs - normalizedDays * DAY_MS));
}

export async function cleanupUsageLogs(retentionDays: number, nowMs = Date.now()): Promise<{
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
  candidateMaxId: number;
  projectedThroughId: number;
  blockedByProjection: boolean;
}> {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  const cutoffUtc = getLogCleanupCutoffUtc(normalizedDays, nowMs);
  if (!cutoffUtc) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
      candidateMaxId: 0,
      projectedThroughId: 0,
      blockedByProjection: false,
    };
  }

  const candidate = await db.select({
    maxId: sql<number>`coalesce(max(${schema.proxyLogs.id}), 0)`,
  })
    .from(schema.proxyLogs)
    .where(lt(schema.proxyLogs.createdAt, cutoffUtc))
    .get();
  const candidateMaxId = Math.max(0, Math.trunc(Number(candidate?.maxId || 0)));
  if (candidateMaxId <= 0) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc,
      deleted: 0,
      candidateMaxId: 0,
      projectedThroughId: 0,
      blockedByProjection: false,
    };
  }

  await runUsageAggregationProjectionPass();
  const projection = await getUsageAggregationProjectionStatus();
  const projectedThroughId = Math.max(0, projection.safeProxyLogId);
  const deleted = (
    await db.delete(schema.proxyLogs)
      .where(and(
        lt(schema.proxyLogs.createdAt, cutoffUtc),
        lte(schema.proxyLogs.id, projectedThroughId),
      ))
      .run()
  ).changes;

  return {
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
    candidateMaxId,
    projectedThroughId,
    blockedByProjection: projectedThroughId < candidateMaxId,
  };
}

export async function cleanupProgramLogs(retentionDays: number, nowMs = Date.now()): Promise<{
  retentionDays: number;
  cutoffUtc: string | null;
  deleted: number;
}> {
  const normalizedDays = normalizeLogCleanupRetentionDays(retentionDays);
  const cutoffUtc = getLogCleanupCutoffUtc(normalizedDays, nowMs);
  if (!cutoffUtc) {
    return {
      retentionDays: normalizedDays,
      cutoffUtc: null,
      deleted: 0,
    };
  }

  const deleted = (
    await db.delete(schema.events)
      .where(lt(schema.events.createdAt, cutoffUtc))
      .run()
  ).changes;

  return {
    retentionDays: normalizedDays,
    cutoffUtc,
    deleted,
  };
}

export async function cleanupConfiguredLogs(options: LogCleanupOptions = {}): Promise<LogCleanupResult> {
  const usageLogsEnabled = options.usageLogsEnabled ?? config.logCleanupUsageLogsEnabled;
  const programLogsEnabled = options.programLogsEnabled ?? config.logCleanupProgramLogsEnabled;
  const retentionDays = normalizeLogCleanupRetentionDays(
    options.retentionDays ?? config.logCleanupRetentionDays,
    config.logCleanupRetentionDays,
  );
  const nowMs = options.nowMs ?? Date.now();
  const enabled = usageLogsEnabled || programLogsEnabled;
  const cutoffUtc = enabled ? getLogCleanupCutoffUtc(retentionDays, nowMs) : null;

  if (!enabled || !cutoffUtc) {
    return {
      enabled: false,
      usageLogsEnabled,
      programLogsEnabled,
      retentionDays,
      cutoffUtc,
      usageLogsDeleted: 0,
      usageLogsCandidateMaxId: 0,
      usageLogsProjectedThroughId: 0,
      usageLogsBlockedByProjection: false,
      programLogsDeleted: 0,
      totalDeleted: 0,
    };
  }

  const usageResult = usageLogsEnabled
    ? await cleanupUsageLogs(retentionDays, nowMs)
    : {
      deleted: 0,
      candidateMaxId: 0,
      projectedThroughId: 0,
      blockedByProjection: false,
    };
  const programResult = programLogsEnabled
    ? await cleanupProgramLogs(retentionDays, nowMs)
    : { deleted: 0 };

  return {
    enabled: true,
    usageLogsEnabled,
    programLogsEnabled,
    retentionDays,
    cutoffUtc,
    usageLogsDeleted: usageResult.deleted,
    usageLogsCandidateMaxId: usageResult.candidateMaxId,
    usageLogsProjectedThroughId: usageResult.projectedThroughId,
    usageLogsBlockedByProjection: usageResult.blockedByProjection,
    programLogsDeleted: programResult.deleted,
    totalDeleted: usageResult.deleted + programResult.deleted,
  };
}
