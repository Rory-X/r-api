import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../../db/index.js');
describe('site concurrency management contract', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'r-api-sites-capacity-'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    app = Fastify();
    await app.register((await import('./sites.js')).sitesRoutes);
  });
  beforeEach(async () => { await db.delete(schema.sites).run(); });
  afterAll(async () => { await app.close(); delete process.env.DATA_DIR; });
  const create = (extra = {}) => app.inject({ method: 'POST', url: '/api/sites', payload: { name: 'site', url: 'https://example.com', platform: 'openai', ...extra } });

  it('keeps default unlimited behavior and persists a configured deployment limit', async () => {
    const response = await create();
    expect(response.statusCode).toBe(200);
    const id = response.json().id;
    expect(response.json()).toMatchObject({ maxConcurrency: null, concurrencyWaitTimeoutMs: 0 });
    const updated = await app.inject({ method: 'PUT', url: `/api/sites/${id}`, payload: { maxConcurrency: 8, concurrencyWaitTimeoutMs: 2_500 } });
    expect(updated.statusCode).toBe(200);
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get()).toMatchObject({ maxConcurrency: 8, concurrencyWaitTimeoutMs: 2_500 });
    await app.inject({ method: 'PUT', url: `/api/sites/${id}`, payload: { name: 'renamed' } });
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get()).toMatchObject({ maxConcurrency: 8, concurrencyWaitTimeoutMs: 2_500 });
    await app.inject({ method: 'PUT', url: `/api/sites/${id}`, payload: { maxConcurrency: null, concurrencyWaitTimeoutMs: 0 } });
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get()).toMatchObject({ maxConcurrency: null, concurrencyWaitTimeoutMs: 0 });
  });

  it('accepts inclusive boundaries at creation', async () => {
    const response = await create({ maxConcurrency: 10_000, concurrencyWaitTimeoutMs: 60_000 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ maxConcurrency: 10_000, concurrencyWaitTimeoutMs: 60_000 });
  });

  it.each([
    { maxConcurrency: 0 }, { maxConcurrency: -1 }, { maxConcurrency: 1.5 }, { maxConcurrency: 10001 }, { maxConcurrency: '2' }, { maxConcurrency: false },
    { concurrencyWaitTimeoutMs: -1 }, { concurrencyWaitTimeoutMs: 60001 }, { concurrencyWaitTimeoutMs: 1.5 }, { concurrencyWaitTimeoutMs: '10' }, { concurrencyWaitTimeoutMs: null },
  ])('rejects invalid config at creation and update without changing stored policy: %j', async (invalid) => {
    expect((await create(invalid)).statusCode).toBe(400);
    expect(await db.select().from(schema.sites).all()).toHaveLength(0);
    const existing = await create({ maxConcurrency: 3, concurrencyWaitTimeoutMs: 20 });
    const id = existing.json().id;
    expect((await app.inject({ method: 'PUT', url: `/api/sites/${id}`, payload: invalid })).statusCode).toBe(400);
    expect(await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get()).toMatchObject({ maxConcurrency: 3, concurrencyWaitTimeoutMs: 20 });
  });
});
