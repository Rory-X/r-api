import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter OAuth refresh state eligibility', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let publishTokenRouterCacheInvalidation: typeof import('./tokenRouterCacheInvalidation.js')['publishTokenRouterCacheInvalidation'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-oauth-refresh-state-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    const cacheInvalidationModule = await import('./tokenRouterCacheInvalidation.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    publishTokenRouterCacheInvalidation = cacheInvalidationModule.publishTokenRouterCacheInvalidation;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  async function createSite() {
    return await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();
  }

  async function createAccount(siteId: number, input: {
    suffix: string;
    refreshState: string;
  }) {
    return await db.insert(schema.accounts).values({
      siteId,
      username: `${input.suffix}@example.com`,
      accessToken: `oauth-access-${input.suffix}`,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: `account-${input.suffix}`,
      oauthRefreshState: input.refreshState,
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: `account-${input.suffix}`,
          accountKey: `account-${input.suffix}`,
        },
      }),
    }).returning().get();
  }

  it.each(['refresh_unknown', 'reauthorization_required'])(
    'removes an ordinary OAuth channel in %s from routing',
    async (refreshState) => {
      const site = await createSite();
      const account = await createAccount(site.id, { suffix: refreshState, refreshState });
      const route = await db.insert(schema.tokenRoutes).values({
        modelPattern: `gpt-${refreshState}`,
        enabled: true,
      }).returning().get();
      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: account.id,
        tokenId: null,
        priority: 0,
        weight: 10,
        enabled: true,
      }).run();

      await expect(new TokenRouter().selectChannel(route.modelPattern)).resolves.toBeNull();
    },
  );

  it('skips unsafe OAuth route-unit members and stops routing when no safe member remains', async () => {
    const site = await createSite();
    const unknownAccount = await createAccount(site.id, {
      suffix: 'unknown',
      refreshState: 'refresh_unknown',
    });
    const readyAccount = await createAccount(site.id, {
      suffix: 'ready',
      refreshState: 'ready',
    });
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-refresh-pool',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Refresh-safe Codex Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: unknownAccount.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: readyAccount.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: unknownAccount.id, modelName: route.modelPattern, available: true },
      { accountId: readyAccount.id, modelName: route.modelPattern, available: true },
    ]).run();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: unknownAccount.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).run();

    const router = new TokenRouter();
    const selected = await router.selectChannel(route.modelPattern);
    expect(selected?.account.id).toBe(readyAccount.id);

    await db.update(schema.accounts).set({
      oauthRefreshState: 'reauthorization_required',
    }).where(eq(schema.accounts.id, readyAccount.id)).run();
    publishTokenRouterCacheInvalidation();

    await expect(router.selectChannel(route.modelPattern)).resolves.toBeNull();
  });
});
