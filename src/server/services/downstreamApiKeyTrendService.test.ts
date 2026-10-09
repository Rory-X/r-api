import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type TrendServiceModule = typeof import('./downstreamApiKeyTrendService.js');

const INSERT_BATCH_SIZE = 100;

describe('downstreamApiKeyTrendService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let trendService: TrendServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-downstream-trend-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const trendServiceModule = await import('./downstreamApiKeyTrendService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    trendService = trendServiceModule;
  });

  beforeEach(async () => {
    await db.delete(schema.analyticsProjectionCheckpoints).run();
    await db.delete(schema.downstreamKeyDayUsage).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(async () => {
    await closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('reads all-range buckets across cursor pages when many rows share the same createdAt', async () => {
    const inserted = await db.insert(schema.downstreamApiKeys).values({
      name: 'cursor-key',
      key: 'sk-cursor-key-001',
      enabled: true,
    }).returning().get();

    const sharedCreatedAt = '2026-04-05T00:15:00.000Z';
    const sharedRows = Array.from({ length: 5_001 }, () => ({
      downstreamApiKeyId: inserted.id,
      status: 'success',
      totalTokens: 1,
      estimatedCost: 0.001,
      createdAt: sharedCreatedAt,
    }));

    for (let index = 0; index < sharedRows.length; index += INSERT_BATCH_SIZE) {
      await db.insert(schema.proxyLogs).values(sharedRows.slice(index, index + INSERT_BATCH_SIZE)).run();
    }

    await db.insert(schema.proxyLogs).values({
      downstreamApiKeyId: inserted.id,
      status: 'failed',
      totalTokens: 2,
      estimatedCost: 0.002,
      createdAt: '2026-04-06T00:30:00.000Z',
    }).run();

    // Pick a different zone from the daily projection so this exercises raw
    // cursor pagination on both UTC CI runners and local development machines.
    const timeZone = trendService.resolveDownstreamTrendTimeZone() === 'UTC' ? 'Asia/Tokyo' : 'UTC';
    const offsetHours = timeZone === 'Asia/Tokyo' ? 9 : 0;
    const bucketStart = (day: number) => new Date(Date.UTC(2026, 3, day) - offsetHours * 3_600_000).toISOString();
    const trend = await trendService.readDownstreamApiKeyTrendBuckets({
      downstreamApiKeyId: inserted.id,
      range: 'all',
      timeZone,
    });

    expect(trend.bucketSeconds).toBe(86400);
    expect(trend.timeZone).toBe(timeZone);
    expect(trend.source).toBe('raw');
    expect(trend.buckets).toHaveLength(2);
    expect(trend.buckets[0]).toMatchObject({
      startUtc: bucketStart(5),
      totalRequests: 5_001,
      successRequests: 5_001,
      failedRequests: 0,
      totalTokens: 5_001,
    });
    expect(trend.buckets[0]?.totalCost).toBeCloseTo(5.001, 6);
    expect(trend.buckets[1]).toMatchObject({
      startUtc: bucketStart(6),
      totalRequests: 1,
      successRequests: 0,
      failedRequests: 1,
      totalTokens: 2,
    });
    expect(trend.buckets[1]?.totalCost).toBeCloseTo(0.002, 6);
  });

  it('normalizes trend time zones consistently for explicit and invalid values', () => {
    const fallback = trendService.resolveDownstreamTrendTimeZone();

    expect(trendService.resolveDownstreamTrendTimeZone('UTC')).toBe('UTC');
    expect(trendService.resolveDownstreamTrendTimeZone('Invalid/Zone')).toBe(fallback);
    expect(trendService.resolveDownstreamTrendTimeZone('  ')).toBe(fallback);
  });

  it('keeps all-range trend data after raw logs are deleted in the projection time zone', async () => {
    const inserted = await db.insert(schema.downstreamApiKeys).values({
      name: 'retained-trend-key',
      key: 'sk-retained-trend-key-001',
      enabled: true,
    }).returning().get();
    await db.insert(schema.proxyLogs).values({
      downstreamApiKeyId: inserted.id,
      status: 'success',
      totalTokens: 300,
      estimatedCost: 0.6,
      createdAt: '2026-08-17T01:00:00.000Z',
    }).run();

    const initial = await trendService.readDownstreamApiKeyTrendBuckets({
      downstreamApiKeyId: inserted.id,
      range: 'all',
    });
    expect(initial.source).toBe('aggregate');
    expect(initial.buckets).toMatchObject([
      { totalRequests: 1, successRequests: 1, totalTokens: 300, totalCost: 0.6 },
    ]);

    await db.delete(schema.proxyLogs).run();
    const retained = await trendService.readDownstreamApiKeyTrendBuckets({
      downstreamApiKeyId: inserted.id,
      range: 'all',
    });
    expect(retained.source).toBe('aggregate');
    expect(retained.buckets).toMatchObject([
      { totalRequests: 1, successRequests: 1, totalTokens: 300, totalCost: 0.6 },
    ]);
  });

  it('uses local hour buckets for windowed ranges in half-hour offset time zones', async () => {
    const inserted = await db.insert(schema.downstreamApiKeys).values({
      name: 'windowed-local-hour-key',
      key: 'sk-windowed-local-hour-key-001',
      enabled: true,
    }).returning().get();

    const baseHour = new Date(Date.now() - 2 * 60 * 60 * 1000);
    baseHour.setUTCMinutes(0, 0, 0);
    const firstCreatedAt = new Date(baseHour);
    firstCreatedAt.setUTCMinutes(10, 0, 0);
    const secondCreatedAt = new Date(baseHour);
    secondCreatedAt.setUTCMinutes(40, 0, 0);

    await db.insert(schema.proxyLogs).values([
      {
        downstreamApiKeyId: inserted.id,
        status: 'success',
        totalTokens: 10,
        estimatedCost: 0.01,
        createdAt: firstCreatedAt.toISOString(),
      },
      {
        downstreamApiKeyId: inserted.id,
        status: 'failed',
        totalTokens: 20,
        estimatedCost: 0.02,
        createdAt: secondCreatedAt.toISOString(),
      },
    ]).run();

    const trend = await trendService.readDownstreamApiKeyTrendBuckets({
      downstreamApiKeyId: inserted.id,
      range: '24h',
      timeZone: 'Asia/Kolkata',
    });

    expect(trend.bucketSeconds).toBe(3600);
    expect(trend.timeZone).toBe('Asia/Kolkata');
    expect(trend.buckets).toMatchObject([
      {
        startUtc: expectedFixedOffsetHourBucketStartUtc(firstCreatedAt.toISOString(), 330),
        totalRequests: 1,
        successRequests: 1,
        failedRequests: 0,
        totalTokens: 10,
        totalCost: 0.01,
      },
      {
        startUtc: expectedFixedOffsetHourBucketStartUtc(secondCreatedAt.toISOString(), 330),
        totalRequests: 1,
        successRequests: 0,
        failedRequests: 1,
        totalTokens: 20,
        totalCost: 0.02,
      },
    ]);
  });
});

function expectedFixedOffsetHourBucketStartUtc(raw: string, offsetMinutes: number): string {
  const parsed = new Date(raw);
  const localMs = parsed.getTime() + offsetMinutes * 60_000;
  const localBucketStart = new Date(localMs);
  localBucketStart.setUTCMinutes(0, 0, 0);
  return new Date(localBucketStart.getTime() - offsetMinutes * 60_000).toISOString();
}
