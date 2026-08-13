import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('credential export routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-export-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routes = await import('./credentialExports.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routes.credentialExportRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Export Route Site',
      url: 'https://export-route.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'route-export-user',
      accessToken: '',
      apiToken: 'route-export-secret',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    accountId = account.id;
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('returns safe metadata exports and rejects unconfirmed secret exports', async () => {
    const metadata = await app.inject({
      method: 'POST',
      url: '/api/credential-exports',
      payload: { mode: 'metadata_only', accountIds: [accountId] },
    });
    expect(metadata.statusCode, metadata.body).toBe(200);
    expect(metadata.json()).toMatchObject({
      success: true,
      export: { mode: 'metadata_only', item_count: 1 },
    });
    expect(metadata.body).not.toContain('route-export-secret');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/credential-exports',
      payload: { mode: 'portable_secret', accountIds: [accountId] },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().message).toContain('EXPORT_SECRETS');
    expect(rejected.body).not.toContain('route-export-secret');
  });
});
