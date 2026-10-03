import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('accounts manual models endpoint', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-manual-models-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  }, 30_000);

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.DATA_DIR;
  }, 30_000);

  it('adds manual models and sets isManual to true', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Test Site',
      url: 'https://test.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'test-token',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/models/manual`,
      payload: {
        models: ['gpt-4-manual', 'claude-3-manual'],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);

    const models = await db.select().from(schema.modelAvailability).where(
      eq(schema.modelAvailability.accountId, account.id)
    ).all();
    
    expect(models).toHaveLength(2);
    expect(models.map(m => m.modelName).sort()).toEqual(['claude-3-manual', 'gpt-4-manual']);
    expect(models[0]?.isManual).toBe(true);
    expect(models[1]?.isManual).toBe(true);
  });
  it('exposes sourced metadata and leaves names-only model context unknown', async () => {
    const site = await db.insert(schema.sites).values({ name: 'context', url: 'https://context.example.com', platform: 'openai' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'test-token' }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: account.id, modelName: 'known', available: true, contextLength: 128000, contextSource: 'openai.models:context_length', contextUpdatedAt: '2026-10-04T00:00:00Z' },
      { accountId: account.id, modelName: 'unknown', available: true },
    ]).run();
    const response = await app.inject({ method: 'GET', url: `/api/accounts/${account.id}/models` });
    expect(response.statusCode).toBe(200);
    expect(response.json().models.find((model: any) => model.name === 'known')).toMatchObject({ contextLength: 128000, contextSource: 'openai.models:context_length', contextUpdatedAt: '2026-10-04T00:00:00Z' });
    expect(response.json().models.find((model: any) => model.name === 'unknown')).not.toHaveProperty('contextLength');
  });

  it('updates existing synced models to manual if provided', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Test Site',
      url: 'https://test.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'test-token',
    }).returning().get();

    // Already-synced model that is NOT manual
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-existing',
      available: true,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/models/manual`,
      payload: {
        models: ['gpt-existing', 'gpt-new'],
      },
    });

    expect(response.statusCode).toBe(200);

    const models = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();
    
    expect(models).toHaveLength(2);
    const existing = models.find(m => m.modelName === 'gpt-existing');
    const newModel = models.find(m => m.modelName === 'gpt-new');

    expect(existing?.isManual).toBe(true); // Should be updated
    expect(newModel?.isManual).toBe(true);
  });

  it('fails if account does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/999/models/manual',
      payload: {
        models: ['gpt-4-manual'],
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns validation error for empty models array', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Test Site',
      url: 'https://test.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'test-token',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/models/manual`,
      payload: {
        models: [],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects non-string manual model entries at the route boundary', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Test Site',
      url: 'https://test.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'test-token',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/accounts/${account.id}/models/manual`,
      payload: {
        models: ['gpt-4-manual', 123],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Invalid models. Expected string[].',
    });
  });

  it('deletes only manual models for the target account', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Test Site',
      url: 'https://test.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'test-token',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'manual-a',
        available: true,
        isManual: true,
      },
      {
        accountId: account.id,
        modelName: 'manual-b',
        available: true,
        isManual: true,
      },
      {
        accountId: account.id,
        modelName: 'synced-model',
        available: true,
        isManual: false,
      },
    ]);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${account.id}/models/manual`,
      payload: {
        models: ['manual-a'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, deletedCount: 1, rebuiltRoutes: true });

    const models = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    expect(models.map((model) => `${model.modelName}:${model.isManual}`).sort()).toEqual([
      'manual-b:true',
      'synced-model:false',
    ]);
  });

  it('ignores duplicate and whitespace model names when deleting manual models', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Test Site',
      url: 'https://test.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: 'test-token',
    }).returning().get();

    await db.insert(schema.modelAvailability).values([
      {
        accountId: account.id,
        modelName: 'manual-a',
        available: true,
        isManual: true,
      },
      {
        accountId: account.id,
        modelName: 'manual-b',
        available: true,
        isManual: true,
      },
    ]);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${account.id}/models/manual`,
      payload: {
        models: [' manual-a ', 'manual-a', '   '],
      },
    });

    expect(response.statusCode).toBe(200);

    const models = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .all();

    expect(models.map((model) => model.modelName)).toEqual(['manual-b']);
  });

  it('preserves auto-discovered models and the same manual model on another account', async () => {
    const site = await db.insert(schema.sites).values({ name: 'Site', url: 'https://test.example.com', platform: 'new-api' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'session-a' }).returning().get();
    const other = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'session-b' }).returning().get();
    await db.insert(schema.modelAvailability).values([
      { accountId: account.id, modelName: 'manual-a', available: true, isManual: true },
      { accountId: account.id, modelName: 'synced-a', available: true, isManual: false },
      { accountId: other.id, modelName: 'manual-a', available: true, isManual: true },
    ]).run();

    const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}/models/manual`, payload: { models: ['manual-a', 'synced-a'] } });
    expect(response.json()).toMatchObject({ success: true, deletedCount: 1 });
    const remaining = await db.select().from(schema.modelAvailability).all();
    expect(remaining.map((model) => `${model.accountId}:${model.modelName}`).sort()).toEqual([
      `${account.id}:synced-a`, `${other.id}:manual-a`,
    ].sort());
  });

  it('does not rebuild routes for a deletion that changes no manual records', async () => {
    const site = await db.insert(schema.sites).values({ name: 'Site', url: 'https://test.example.com', platform: 'new-api' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'session' }).returning().get();
    const workflow = await import('../../services/routeRefreshWorkflow.js');
    const rebuild = vi.spyOn(workflow, 'rebuildRoutesBestEffort');
    try {
      const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${account.id}/models/manual`, payload: { models: ['absent'] } });
      expect(response.json()).toMatchObject({ success: true, deletedCount: 0 });
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      rebuild.mockRestore();
    }
  });

  it('rejects missing accounts, malformed identifiers and invalid delete payloads', async () => {
    const missing = await app.inject({ method: 'DELETE', url: '/api/accounts/999/models/manual', payload: { models: ['manual-a'] } });
    expect(missing.statusCode).toBe(404);
    for (const id of ['0', '1junk']) {
      const response = await app.inject({ method: 'DELETE', url: `/api/accounts/${id}/models/manual`, payload: { models: ['manual-a'] } });
      expect(response.statusCode).toBe(400);
    }
    for (const models of [[], ['   '], [123]]) {
      const response = await app.inject({ method: 'DELETE', url: '/api/accounts/1/models/manual', payload: { models } });
      expect(response.statusCode).toBe(400);
    }
  });
});
