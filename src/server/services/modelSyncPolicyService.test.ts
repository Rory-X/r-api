import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./modelSyncPolicyService.js');

describe('model sync policy service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-sync-policy-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./modelSyncPolicyService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.modelSyncStates).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'sync-site',
      url: 'https://sync.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sync-user',
      accessToken: 'session',
      status: 'active',
    }).returning().get();
    accountId = account.id;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('retains a missing model until the third consecutive sync, then retires it', async () => {
    const initial = await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'gpt-4.1',
      contextLength: 128000, contextSource: 'openai.models:context_length', contextUpdatedAt: '2026-08-03T00:00:00Z',
      available: true,
      isManual: false,
      checkedAt: '2026-08-03T00:00:00.000Z',
    }).returning().get();

    for (const [index, expectedStatus] of ['active', 'active', 'candidate_retired'].entries()) {
      const result = await service.reconcileModelSyncPolicy({
        accountId,
        previousRows: index === 0 ? [initial] : await db.select().from(schema.modelAvailability)
          .where(eq(schema.modelAvailability.accountId, accountId)).all(),
        discoveredModels: [],
        retireMissingAfterConsecutiveRuns: 3,
        syncAt: `2026-08-03T00:0${index + 1}:00.000Z`,
      });
      expect(result.missingCounts['gpt-4.1']).toBe(index + 1);
      expect((await service.listModelSyncStates({ accountId }))[0]?.status).toBe(expectedStatus);
      const row = await db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, accountId)).get();
      expect(row?.available).toBe(index < 2);
      expect(row?.contextLength).toBe(128000);
      expect(row?.contextSource).toBe('openai.models:context_length');
    }
  });

  it('resets the missing counter when a model is discovered again', async () => {
    const row = await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'claude-3-7-sonnet',
      available: true,
      isManual: false,
    }).returning().get();
    await service.reconcileModelSyncPolicy({ accountId, previousRows: [row], discoveredModels: [], retireMissingAfterConsecutiveRuns: 2 });
    await db.delete(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, accountId)).run();
    await service.reconcileModelSyncPolicy({ accountId, previousRows: [row], discoveredModels: ['claude-3-7-sonnet'], retireMissingAfterConsecutiveRuns: 2 });
    const state = (await service.listModelSyncStates({ accountId }))[0];
    expect(state).toMatchObject({ modelName: 'claude-3-7-sonnet', consecutiveMissing: 0, status: 'active' });
  });

  it('restores the last known snapshot after a failed discovery', async () => {
    const row = await db.insert(schema.modelAvailability).values({
      accountId,
      modelName: 'gemini-2.5-pro',
      available: true,
      isManual: false,
    }).returning().get();
    await db.delete(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, accountId)).run();
    await service.restoreModelAvailabilitySnapshot({ accountId, rows: [row] });
    const restored = await db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, accountId)).get();
    expect(restored?.modelName).toBe('gemini-2.5-pro');
    expect(restored?.available).toBe(true);
  });
});
