import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../../db/index.js');

describe('GET /api/channels/overview', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-channels-overview-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./channels.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.channelsRoutes);
  });

  beforeEach(async () => {
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    tokenRouterModule.resetSiteRuntimeHealthState();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app?.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns one secret-free read model for sites, connections, OAuth and Vault', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'overview-site',
      url: 'https://overview.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api.overview.example.com/',
      enabled: true,
    }).run();

    await db.insert(schema.accounts).values([
      {
        siteId: site.id,
        username: 'active-user',
        accessToken: 'session-secret',
        status: 'active',
      },
      {
        siteId: site.id,
        username: 'disabled-user',
        accessToken: 'api-secret',
        status: 'disabled',
        extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
      },
      {
        siteId: site.id,
        username: 'oauth-user',
        accessToken: 'oauth-secret',
        status: 'active',
        oauthProvider: 'codex',
        oauthAccountKey: 'oauth-account-key',
        oauthCredentialPayload: JSON.stringify({ email: 'oauth@example.com' }),
      },
    ]).run();

    await db.insert(schema.credentialVaultItems).values([
      {
        siteId: site.id,
        name: 'active credential',
        kind: 'session_token',
        status: 'active',
        ciphertext: 'encrypted-active-secret',
        fingerprint: 'active-fingerprint',
        metadata: JSON.stringify({ source: 'manual' }),
      },
      {
        siteId: site.id,
        name: 'revoked credential',
        kind: 'session_token',
        status: 'revoked',
        ciphertext: 'encrypted-revoked-secret',
        fingerprint: 'revoked-fingerprint',
      },
      {
        siteId: null,
        accountId: null,
        name: 'system credential',
        kind: 'integration_secret',
        status: 'active',
        ciphertext: 'encrypted-system-secret',
        fingerprint: 'system-fingerprint',
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/channels/overview',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, any>;
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.totals).toEqual({
      sites: 1,
      ordinaryConnections: 2,
      officialConnections: 1,
      activeCredentials: 1,
    });
    expect(body.channels).toEqual([
      expect.objectContaining({
        id: site.id,
        connectionCount: 2,
        activeConnectionCount: 1,
        credentialCount: 2,
        activeCredentialCount: 1,
        apiEndpoints: [expect.objectContaining({
          url: 'https://api.overview.example.com',
        })],
      }),
    ]);
    expect(body.connections).toHaveLength(2);
    expect(body.oauthConnections).toEqual([
      expect.objectContaining({
        provider: 'codex',
        username: 'oauth-user',
        email: 'oauth@example.com',
      }),
    ]);
    expect(body.credentials).toHaveLength(3);
    expect(body.connections[0]).not.toHaveProperty('accessToken');
    expect(body.oauthConnections[0]).not.toHaveProperty('oauthCredentialPayload');
    expect(body.credentials[0]).not.toHaveProperty('ciphertext');
  });

  it('queries persisted runtime health independently by Site and state', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'health-query-site',
      url: 'https://health-query.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const nowIso = new Date().toISOString();
    await db.insert(schema.siteRuntimeHealthStates).values({
      scopeKey: `site:${site.id}`,
      siteId: site.id,
      scope: 'site',
      recoveryState: 'open',
      recentWindowUpdatedAt: nowIso,
      breakerLevel: 2,
      breakerUntil: new Date(Date.now() + 60_000).toISOString(),
      lastFailureReason: 'connect ECONNREFUSED',
      lastFailureDomain: 'endpoint',
      updatedAt: nowIso,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: `/api/channels/health?siteId=${site.id}&state=open`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      items: [{
        siteId: site.id,
        scope: 'site',
        state: 'open',
        breakerLevel: 2,
        lastFailureReason: 'connect ECONNREFUSED',
      }],
    });
  });
});
