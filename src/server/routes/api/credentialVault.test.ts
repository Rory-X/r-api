import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('credential vault routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-vault-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./credentialVault.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.credentialVaultRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'vault-route-site',
      url: 'https://vault-route.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('creates and lists a vault item without returning its secret', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/credential-vault',
      payload: {
        siteId,
        name: 'route session',
        kind: 'session_token',
        secret: 'route-secret',
        metadata: { source: 'manual', username: 'bob' },
      },
    });

    expect(created.statusCode).toBe(200);
    const item = created.json().item as Record<string, unknown>;
    expect(item).toMatchObject({
      siteId,
      name: 'route session',
      kind: 'session_token',
      status: 'active',
    });
    expect(item).not.toHaveProperty('ciphertext');
    expect(item).not.toHaveProperty('secret');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/credential-vault?siteId=' + siteId,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
  });

  it('rejects unsupported kinds and supports revoke/delete actions', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/credential-vault',
      payload: {
        siteId,
        name: 'official refresh',
        kind: 'oauth_refresh_token',
        secret: 'refresh-secret',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().message).toContain('不声明支持');

    const created = await app.inject({
      method: 'POST',
      url: '/api/credential-vault',
      payload: {
        siteId,
        name: 'cookie',
        kind: 'cookie',
        secret: 'sid=route',
      },
    });
    const id = created.json().item.id as number;

    const revoked = await app.inject({
      method: 'POST',
      url: '/api/credential-vault/' + id + '/revoke',
    });
    expect(revoked.statusCode).toBe(200);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/credential-vault/' + id,
    });
    expect(deleted.statusCode).toBe(200);
  });
});
