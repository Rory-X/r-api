import { gunzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type RetentionModule = typeof import('./resourceRetentionService.js');

describe('resourceRetentionService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let retention: RetentionModule;
  let dataDir = '';
  let originalConfig: {
    logCleanupUsageLogsEnabled: boolean;
    logCleanupProgramLogsEnabled: boolean;
    logCleanupRetentionDays: number;
    proxyLogRetentionDays: number;
    proxyDebugTraceEnabled: boolean;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-resource-retention-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    retention = await import('./resourceRetentionService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    originalConfig = {
      logCleanupUsageLogsEnabled: config.logCleanupUsageLogsEnabled,
      logCleanupProgramLogsEnabled: config.logCleanupProgramLogsEnabled,
      logCleanupRetentionDays: config.logCleanupRetentionDays,
      proxyLogRetentionDays: config.proxyLogRetentionDays,
      proxyDebugTraceEnabled: config.proxyDebugTraceEnabled,
    };
  });

  beforeEach(async () => {
    await db.delete(schema.proxyRequestAttempts).run();
    await db.delete(schema.proxyRequests).run();
    await db.delete(schema.archiveManifests).run();
    await db.delete(schema.analyticsProjectionCheckpoints).run();
    await db.delete(schema.downstreamKeyDayUsage).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.events).run();

    config.logCleanupUsageLogsEnabled = true;
    config.logCleanupProgramLogsEnabled = true;
    config.logCleanupRetentionDays = 30;
    config.proxyLogRetentionDays = 30;
    config.proxyDebugTraceEnabled = true;
  });

  afterAll(async () => {
    config.logCleanupUsageLogsEnabled = originalConfig.logCleanupUsageLogsEnabled;
    config.logCleanupProgramLogsEnabled = originalConfig.logCleanupProgramLogsEnabled;
    config.logCleanupRetentionDays = originalConfig.logCleanupRetentionDays;
    config.proxyLogRetentionDays = originalConfig.proxyLogRetentionDays;
    config.proxyDebugTraceEnabled = originalConfig.proxyDebugTraceEnabled;
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('archives projected proxy logs to gzip NDJSON and preserves the source during archive retention', async () => {
    await db.insert(schema.proxyLogs).values({
      downstreamApiKeyId: 7,
      modelRequested: 'gpt-4.1-mini',
      status: 'success',
      totalTokens: 100,
      estimatedCost: 0.2,
      createdAt: '2026-01-01 00:00:00',
    }).run();

    const result = await retention.runResourceRetention({
      resource: 'proxy_logs',
      nowMs: Date.parse('2026-08-20T00:00:00Z'),
    });

    expect(result.archivedRows).toBe(1);
    expect(result.deletedRows).toBe(0);
    expect(result.manifest).toMatchObject({
      resource: 'proxy_logs',
      status: 'committed',
      rowCount: 1,
      storageDriver: 'local',
    });
    const objectKey = result.manifest?.objectKey;
    expect(objectKey).toMatch(/\.ndjson\.gz$/);
    const archivePath = resolve(dataDir, objectKey!);
    expect(existsSync(archivePath)).toBe(true);
    const lines = gunzipSync(readFileSync(archivePath)).toString('utf8').trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({
      downstreamApiKeyId: 7,
      modelRequested: 'gpt-4.1-mini',
      totalTokens: 100,
    });

    const source = await db.select().from(schema.proxyLogs).get();
    expect(source?.archivedAt).toBeTruthy();
    const aggregate = await db.select().from(schema.downstreamKeyDayUsage).get();
    expect(aggregate).toMatchObject({ downstreamApiKeyId: 7, totalCalls: 1, totalTokens: 100 });
  });

  it('archives only terminal request ledger rows with attempts attached', async () => {
    const terminal = await db.insert(schema.proxyRequests).values({
      requestId: 'retention-terminal',
      requestedModel: 'gpt-4.1-mini',
      downstreamPath: '/v1/responses',
      status: 'succeeded',
      retryOwner: 'cooperative',
      replaySafety: 'safe_only',
      policySnapshotJson: '{}',
      retryBudgetJson: '{}',
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    }).returning().get();
    await db.insert(schema.proxyRequestAttempts).values({
      requestRowId: terminal.id,
      attemptId: 'retention-terminal:attempt:0',
      attemptIndex: 0,
      status: 'succeeded',
      commitState: 'completed',
      startedAt: '2026-01-01 00:00:00',
      finishedAt: '2026-01-01 00:00:01',
      updatedAt: '2026-01-01 00:00:01',
    }).run();
    await db.insert(schema.proxyRequests).values({
      requestId: 'retention-active',
      requestedModel: 'gpt-4.1-mini',
      downstreamPath: '/v1/responses',
      status: 'active',
      retryOwner: 'cooperative',
      replaySafety: 'safe_only',
      policySnapshotJson: '{}',
      retryBudgetJson: '{}',
      createdAt: '2026-01-01 00:00:00',
      updatedAt: '2026-01-01 00:00:00',
    }).run();

    const result = await retention.runResourceRetention({
      resource: 'proxy_request_ledger',
      nowMs: Date.parse('2026-08-20T00:00:00Z'),
    });

    expect(result.archivedRows).toBe(1);
    expect(result.manifest).toMatchObject({
      resource: 'proxy_request_ledger',
      status: 'committed',
      rowCount: 1,
      minId: terminal.id,
      maxId: terminal.id,
    });
    const archivePath = resolve(dataDir, result.manifest?.objectKey!);
    const payload = JSON.parse(gunzipSync(readFileSync(archivePath)).toString('utf8').trim());
    expect(payload.request).toMatchObject({ requestId: 'retention-terminal', status: 'succeeded' });
    expect(payload.attempts).toHaveLength(1);

    const terminalAfter = await db.select().from(schema.proxyRequests).where(
      eq(schema.proxyRequests.requestId, 'retention-terminal'),
    ).get();
    const activeAfter = await db.select().from(schema.proxyRequests).where(
      eq(schema.proxyRequests.requestId, 'retention-active'),
    ).get();
    expect(terminalAfter?.archivedAt).toBeTruthy();
    expect(activeAfter?.archivedAt).toBeNull();
  });

  it('keeps unread error events out of automatic cleanup', async () => {
    await db.insert(schema.events).values([
      {
        type: 'proxy',
        title: 'read info',
        level: 'info',
        read: true,
        createdAt: '2025-01-01 00:00:00',
      },
      {
        type: 'proxy',
        title: 'unread critical',
        level: 'error',
        read: false,
        createdAt: '2025-01-01 00:00:00',
      },
    ]).run();

    const result = await retention.runResourceRetention({
      resource: 'program_events',
      nowMs: Date.parse('2027-01-01T00:00:00Z'),
    });

    expect(result.deletedRows).toBe(1);
    expect(result.preview.blockedCandidates).toBe(1);
    const remaining = await db.select().from(schema.events).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.title).toBe('unread critical');
  });
});
