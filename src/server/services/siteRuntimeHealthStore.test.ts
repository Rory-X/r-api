import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./siteRuntimeHealthStore.js');

describe('siteRuntimeHealthStore', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-runtime-health-store-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = await import('./siteRuntimeHealthStore.js');
  });

  beforeEach(async () => {
    await db.delete(schema.siteRuntimeHealthStates).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedHealthState() {
    const site = await db.insert(schema.sites).values({
      name: 'health-store-site',
      url: 'https://health-store.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await store.upsertSiteRuntimeHealthRecords([{
      scopeKey: `site:${site.id}`,
      siteId: site.id,
      scope: 'site',
      modelName: null,
      recoveryState: 'open',
      penaltyScore: 2.5,
      latencyEmaMs: 1_200,
      firstByteLatencyEmaMs: 800,
      firstByteSampleCount: 4,
      transientFailureStreak: 3,
      lastTransientFailureAtMs: 1_787_050_000_000,
      recentSuccessCount: 1.5,
      recentFailureCount: 3.5,
      recentWindowUpdatedAtMs: 1_787_050_000_000,
      breakerLevel: 2,
      breakerUntilMs: 1_787_050_300_000,
      recoverySuccessCount: 0,
      lastProbeAtMs: null,
      lastProbeSuccessAtMs: null,
      lastUpdatedAtMs: 1_787_050_000_000,
      lastFailureAtMs: 1_787_050_000_000,
      lastSuccessAtMs: null,
      lastFailureReason: 'connect ECONNREFUSED',
      lastFailureDomain: 'endpoint',
      lastFailureEndpointId: null,
    }]);
    return site;
  }

  it('persists health as structured queryable columns', async () => {
    const site = await seedHealthState();

    const stored = await db.select().from(schema.siteRuntimeHealthStates).get();
    expect(stored).toMatchObject({
      scopeKey: `site:${site.id}`,
      siteId: site.id,
      scope: 'site',
      recoveryState: 'open',
      breakerLevel: 2,
      lastFailureDomain: 'endpoint',
      lastFailureReason: 'connect ECONNREFUSED',
    });
    await expect(store.loadSiteRuntimeHealthRecords()).resolves.toEqual([
      expect.objectContaining({
        scopeKey: `site:${site.id}`,
        recoveryState: 'open',
        penaltyScore: 2.5,
      }),
    ]);
  });

  it('fences concurrent recovery probes and permits takeover after release', async () => {
    const site = await seedHealthState();
    const scopeKey = `site:${site.id}`;
    const first = await store.claimSiteRuntimeRecoveryProbeLease({
      scopeKeys: [scopeKey],
      channelId: 11,
      nowMs: 1_787_050_000_000,
      leaseMs: 30_000,
    });
    expect(first).not.toBeNull();

    await expect(store.claimSiteRuntimeRecoveryProbeLease({
      scopeKeys: [scopeKey],
      channelId: 12,
      nowMs: 1_787_050_001_000,
      leaseMs: 30_000,
    })).resolves.toBeNull();
    await expect(store.listOwnedSiteRuntimeRecoveryProbeScopes({
      scopeKeys: [scopeKey],
      token: first!.token,
      nowMs: 1_787_050_001_000,
    })).resolves.toEqual(new Set([scopeKey]));

    await store.releaseSiteRuntimeRecoveryProbeLease(first!.token);
    await expect(store.claimSiteRuntimeRecoveryProbeLease({
      scopeKeys: [scopeKey],
      channelId: 12,
      nowMs: 1_787_050_002_000,
      leaseMs: 30_000,
    })).resolves.toMatchObject({ channelId: 12 });
  });
});
