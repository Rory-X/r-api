import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('model sync routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-sync-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./modelSync.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.modelSyncRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.modelSyncStates).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'model-sync-route-site',
      url: 'https://model-sync-route.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'token',
      status: 'active',
    }).returning().get();
    accountId = account.id;
    await db.insert(schema.modelSyncStates).values({
      accountId,
      modelName: 'gpt-4.1',
      consecutiveMissing: 2,
      status: 'active',
    }).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('lists durable model sync state and filters by account/status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/model-sync/states?accountId=${accountId}&status=active`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      items: [{ accountId, modelName: 'gpt-4.1', consecutiveMissing: 2 }],
    });
  });

  it('rejects invalid query filters', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/model-sync/states?status=unknown' });
    expect(response.statusCode).toBe(400);
  });

  it('lists the effective capability matrix including manual overrides', async () => {
    await db.insert(schema.modelAvailability).values([
      {
        accountId,
        modelName: 'gpt-4.1',
        available: false,
        isManual: false,
        checkedAt: '2026-08-04T00:00:00.000Z',
      },
      {
        accountId,
        modelName: 'manual-model',
        available: true,
        isManual: true,
        checkedAt: '2026-08-04T00:00:00.000Z',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/model-sync/matrix?accountId=${accountId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      items: [
        { modelName: 'gpt-4.1', effectiveStatus: 'active', source: 'discovered', consecutiveMissing: 2 },
        { modelName: 'manual-model', effectiveStatus: 'manual_override', source: 'manual' },
      ],
    });
  });
});
