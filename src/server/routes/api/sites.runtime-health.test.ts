import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('GET /api/sites runtime health', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let tokenRouter: TokenRouterModule['tokenRouter'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-runtime-health-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;
    tokenRouter = tokenRouterModule.tokenRouter;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    resetSiteRuntimeHealthState();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app.close();
    resetSiteRuntimeHealthState();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('returns the fault domain, breaker level and recovery progress', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'runtime-health-site',
      url: 'https://runtime-health.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'runtime-health-user',
      accessToken: 'runtime-health-access',
      apiToken: 'runtime-health-api',
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'runtime-health-token',
      enabled: true,
      isDefault: true,
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      enabled: true,
    }).returning().get();

    await tokenRouter.recordFailure(channel.id, {
      errorText: 'fetch failed: ECONNREFUSED runtime-health.example.com',
      modelName: 'gpt-5.4',
    });

    const response = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(response.statusCode).toBe(200);
    const sites = response.json() as Array<{
      id: number;
      runtimeHealth: Array<Record<string, unknown>>;
    }>;
    expect(sites.find((row) => row.id === site.id)?.runtimeHealth).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'site',
        state: 'open',
        breakerLevel: 1,
        recoverySuccessCount: 0,
        recoverySuccessThreshold: 2,
        recoveryTrafficRatio: 0.1,
        firstByteLatencyEmaMs: null,
        firstByteSampleCount: 0,
        firstByteMultiplier: 1,
        lastFailureDomain: 'endpoint',
        lastFailureReason: 'fetch failed: ECONNREFUSED runtime-health.example.com',
      }),
    ]));
  });
});
