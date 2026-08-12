import { beforeAll, beforeEach, describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter proxy health domains', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let isSiteRuntimeBreakerOpen: TokenRouterModule['isSiteRuntimeBreakerOpen'];
  let claimSiteRuntimeRecoveryProbe: TokenRouterModule['claimSiteRuntimeRecoveryProbe'];
  let listDueSiteRuntimeRecoveryTargets: TokenRouterModule['listDueSiteRuntimeRecoveryTargets'];
  let dataDir = '';
  let seed = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-health-domain-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    isSiteRuntimeBreakerOpen = tokenRouterModule.isSiteRuntimeBreakerOpen;
    claimSiteRuntimeRecoveryProbe = tokenRouterModule.claimSiteRuntimeRecoveryProbe;
    listDueSiteRuntimeRecoveryTargets = tokenRouterModule.listDueSiteRuntimeRecoveryTargets;
  });

  beforeEach(async () => {
    seed = 0;
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    delete process.env.DATA_DIR;
  });

  const next = () => {
    seed += 1;
    return seed;
  };

  async function createSite() {
    return await db.insert(schema.sites).values({
      name: `health-site-${next()}`,
      url: `https://health-site-${next()}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
  }

  async function createAccount(siteId: number, name: string) {
    return await db.insert(schema.accounts).values({
      siteId,
      username: `${name}-${next()}`,
      accessToken: `${name}-access`,
      apiToken: `${name}-api`,
      status: 'active',
    }).returning().get();
  }

  async function createToken(accountId: number, name: string) {
    return await db.insert(schema.accountTokens).values({
      accountId,
      name,
      token: `${name}-token`,
      enabled: true,
      isDefault: true,
    }).returning().get();
  }

  it('scopes unsupported-model failures to model capability without cooling the channel', async () => {
    const site = await createSite();
    const accountA = await createAccount(site.id, 'model-a');
    const accountB = await createAccount(site.id, 'model-b');
    const tokenA = await createToken(accountA.id, 'model-a');
    const tokenB = await createToken(accountB.id, 'model-b');
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 1,
      weight: 10,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 400,
      errorText: 'model is not supported by this credential',
      modelName: 'gpt-5.4',
    });

    const storedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channelA.id))
      .get();
    expect(storedChannel).toMatchObject({ failCount: 0, cooldownUntil: null });

    const capability = await db.select().from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, tokenA.id),
        eq(schema.tokenModelAvailability.modelName, 'gpt-5.4'),
      ))
      .get();
    expect(capability).toMatchObject({ available: false });

    await expect(router.selectPreferredChannel('gpt-5.4', channelA.id)).resolves.toBeNull();
    await expect(router.selectChannel('gpt-5.4')).resolves.toMatchObject({
      channel: { id: channelB.id },
    });

    const explanation = await router.explainSelection('gpt-5.4');
    expect(explanation.candidates.find((candidate) => candidate.channelId === channelA.id)?.reason)
      .toContain('模型能力不可用');
  });

  it('scopes credential failures across sibling routes that share the same token', async () => {
    const site = await createSite();
    const accountA = await createAccount(site.id, 'credential-a');
    const accountB = await createAccount(site.id, 'credential-b');
    const tokenA = await createToken(accountA.id, 'credential-a');
    const tokenB = await createToken(accountB.id, 'credential-b');
    const routeA = await db.insert(schema.tokenRoutes).values({ modelPattern: 'gpt-5.4', enabled: true }).returning().get();
    const routeB = await db.insert(schema.tokenRoutes).values({ modelPattern: 'gpt-4o-mini', enabled: true }).returning().get();
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: routeA.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      enabled: true,
    }).returning().get();
    const siblingA = await db.insert(schema.routeChannels).values({
      routeId: routeB.id,
      accountId: accountA.id,
      tokenId: tokenA.id,
      enabled: true,
    }).returning().get();
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: routeA.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(channelA.id, {
      status: 401,
      errorText: 'access token expired',
      modelName: 'gpt-5.4',
    });

    const rows = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, [channelA.id, siblingA.id, channelB.id]))
      .all();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: channelA.id, cooldownUntil: expect.any(String) }),
      expect.objectContaining({ id: siblingA.id, cooldownUntil: expect.any(String) }),
      expect.objectContaining({ id: channelB.id, cooldownUntil: null }),
    ]));
  });

  it('immediately avoids a failed Site primary URL without cooling its credential', async () => {
    const failedSite = await createSite();
    const failedAccount = await createAccount(failedSite.id, 'transport-failed');
    const failedToken = await createToken(failedAccount.id, 'transport-failed');
    const healthySite = await createSite();
    const healthyAccount = await createAccount(healthySite.id, 'transport-healthy');
    const healthyToken = await createToken(healthyAccount.id, 'transport-healthy');
    const route = await db.insert(schema.tokenRoutes).values({ modelPattern: 'gpt-5.4', enabled: true }).returning().get();
    const failedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: failedAccount.id,
      tokenId: failedToken.id,
      priority: 0,
      enabled: true,
    }).returning().get();
    const healthyChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: healthyAccount.id,
      tokenId: healthyToken.id,
      priority: 1,
      enabled: true,
    }).returning().get();

    const router = new TokenRouter();
    await router.recordFailure(failedChannel.id, {
      errorText: 'fetch failed: ENOTFOUND upstream host',
      modelName: 'gpt-5.4',
    });

    const storedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, failedChannel.id))
      .get();
    expect(storedChannel).toMatchObject({ failCount: 0, cooldownUntil: null });
    expect(isSiteRuntimeBreakerOpen(failedSite.id)).toBe(true);

    await expect(router.selectPreferredChannel('gpt-5.4', failedChannel.id)).resolves.toBeNull();
    await expect(router.selectChannel('gpt-5.4')).resolves.toMatchObject({
      channel: { id: healthyChannel.id },
    });

    const explanation = await router.explainSelection('gpt-5.4');
    expect(explanation.selectedChannelId).toBe(healthyChannel.id);
    expect(explanation.candidates.find((candidate) => candidate.channelId === failedChannel.id)?.reason)
      .toContain('熔断中');
  });

  it('allows only one half-open probe and requires a second success to become healthy', async () => {
    const site = await createSite();
    const account = await createAccount(site.id, 'half-open');
    const token = await createToken(account.id, 'half-open');
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

    const router = new TokenRouter();
    const openedAtMs = Date.now();
    await router.recordFailure(channel.id, {
      errorText: 'fetch failed: ECONNREFUSED upstream host',
      modelName: 'gpt-5.4',
    });

    const halfOpenAtMs = openedAtMs + 61_000;
    await expect(claimSiteRuntimeRecoveryProbe({
      siteId: site.id,
      modelName: 'gpt-5.4',
      channelId: channel.id,
      nowMs: halfOpenAtMs,
    })).resolves.toBe(true);
    await expect(claimSiteRuntimeRecoveryProbe({
      siteId: site.id,
      modelName: 'gpt-5.4',
      channelId: channel.id,
      nowMs: halfOpenAtMs,
    })).resolves.toBe(false);

    await router.recordProbeSuccess(channel.id, 240, 'gpt-5.4');
    expect(isSiteRuntimeBreakerOpen(site.id)).toBe(false);
    const recoveringTargets = await listDueSiteRuntimeRecoveryTargets(halfOpenAtMs + 31_000);
    expect(recoveringTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        siteId: site.id,
        recoveryState: 'recovering',
        recoverySuccessCount: 1,
      }),
    ]));

    await expect(claimSiteRuntimeRecoveryProbe({
      siteId: site.id,
      modelName: 'gpt-5.4',
      channelId: channel.id,
      nowMs: halfOpenAtMs + 31_000,
    })).resolves.toBe(true);
    await router.recordProbeSuccess(channel.id, 210, 'gpt-5.4');

    expect(await listDueSiteRuntimeRecoveryTargets(halfOpenAtMs + 10 * 60_000))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ siteId: site.id })]));
    expect(isSiteRuntimeBreakerOpen(site.id)).toBe(false);
  });

  it('isolates an explicit API endpoint transport failure without opening the Site breaker', async () => {
    const site = await createSite();
    const account = await createAccount(site.id, 'explicit-endpoint');
    const token = await createToken(account.id, 'explicit-endpoint');
    const endpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api-endpoint.example.com',
      enabled: true,
      sortOrder: 0,
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

    const router = new TokenRouter();
    await router.recordFailure(channel.id, {
      errorText: 'fetch failed: ECONNREFUSED api-endpoint.example.com',
      modelName: 'gpt-5.4',
      endpointId: endpoint.id,
    });

    const storedEndpoint = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.id, endpoint.id))
      .get();
    const storedChannel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channel.id))
      .get();
    expect(storedEndpoint?.cooldownUntil).toEqual(expect.any(String));
    expect(storedChannel).toMatchObject({ failCount: 0, cooldownUntil: null });
    expect(isSiteRuntimeBreakerOpen(site.id)).toBe(false);
  });
});
