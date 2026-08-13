import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('official credential provider site visibility', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-official-provider-sites-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('hides internal OAuth provider anchors while retaining user-managed upstream sites', async () => {
    await db.insert(schema.sites).values([{
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }, {
      name: 'User Codex Compatible Site',
      url: 'https://codex-proxy.example.com',
      platform: 'codex',
      status: 'active',
    }, {
      name: 'NewAPI Production',
      url: 'https://newapi.example.com',
      platform: 'new-api',
      status: 'active',
    }]).run();

    const response = await app.inject({ method: 'GET', url: '/api/sites' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'User Codex Compatible Site' }),
      expect.objectContaining({ name: 'NewAPI Production' }),
    ]));
    expect(response.json()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ChatGPT Codex OAuth' }),
    ]));
  });
});
