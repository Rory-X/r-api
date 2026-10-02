import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('pattern group convergence', () => {
  let database: typeof import('../db/index.js');
  let models: typeof import('./modelService.js');
  let sync: typeof import('./patternRouteChannelSyncService.js');
  let config: typeof import('../config.js')['config'];
  let app: FastifyInstance;
  let directory: string;
  const previousDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'r-api-pattern-sync-'));
    process.env.DATA_DIR = directory;
    await import('../db/migrate.js');
    database = await import('../db/index.js');
    models = await import('./modelService.js');
    sync = await import('./patternRouteChannelSyncService.js');
    ({ config } = await import('../config.js'));
    app = Fastify();
    await app.register((await import('../routes/api/tokens.js')).tokensRoutes);
    await app.register((await import('../routes/api/sites.js')).sitesRoutes);
    await app.register((await import('../routes/api/accounts.js')).accountsRoutes);
  });
  beforeEach(async () => {
    const { db, schema } = database;
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    config.globalAllowedModels = [];
    config.globalBlockedBrands = [];
  });
  afterAll(async () => {
    await app.close();
    await database.closeDbConnections();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  async function seed(model = 'gpt-a') {
    const { db, schema } = database;
    const site = await db.insert(schema.sites).values({ name: 'Site', url: `https://example.com/${Math.random()}`, platform: 'new-api' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, accessToken: 'session' }).returning().get();
    const token = await db.insert(schema.accountTokens).values({ accountId: account.id, name: 'token', token: 'sk-ready', enabled: true }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({ tokenId: token.id, modelName: model, available: true }).run();
    return { site, account, token };
  }
  async function group(pattern = 'gpt-*') {
    return database.db.insert(database.schema.tokenRoutes).values({ modelPattern: pattern, displayName: 'group', routingStrategy: 'manual' }).returning().get();
  }
  async function channels(routeId: number) {
    return database.db.select().from(database.schema.routeChannels).where(eq(database.schema.routeChannels.routeId, routeId)).all();
  }

  it('adds and removes only the delta, preserving identity, manual order and runtime state', async () => {
    const { db, schema } = database;
    const source = await seed();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const first = (await channels(route.id))[0];
    await db.update(schema.routeChannels).set({ priority: 3, sortOrder: 7, weight: 19, failCount: 4, successCount: 8, cooldownUntil: '2099-01-01T00:00:00.000Z' }).where(eq(schema.routeChannels.id, first.id)).run();
    await db.insert(schema.tokenModelAvailability).values({ tokenId: source.token.id, modelName: 'gpt-b', available: true }).run();
    await Promise.all([models.rebuildTokenRoutesFromAvailability(), models.rebuildTokenRoutesFromAvailability()]);
    const stable = (await channels(route.id)).find((channel) => channel.id === first.id)!;
    expect(stable).toMatchObject({ priority: 3, sortOrder: 7, weight: 19, failCount: 4, successCount: 8, cooldownUntil: '2099-01-01T00:00:00.000Z' });
    expect((await channels(route.id)).map((channel) => channel.sourceModel).sort()).toEqual(['gpt-a', 'gpt-b']);
    await db.delete(schema.tokenModelAvailability).where(eq(schema.tokenModelAvailability.modelName, 'gpt-b')).run();
    await models.rebuildTokenRoutesFromAvailability();
    expect((await channels(route.id)).map((channel) => channel.id)).toEqual([first.id]);
  });

  it('keeps manual overrides and distinguishes credentials for the same source model', async () => {
    const { db, schema } = database;
    const source = await seed();
    const token = await db.insert(schema.accountTokens).values({ accountId: source.account.id, name: 'second', token: 'sk-second' }).returning().get();
    await db.insert(schema.tokenModelAvailability).values({ tokenId: token.id, modelName: 'gpt-a', available: true }).run();
    const route = await group('re:^gpt-');
    const manual = await db.insert(schema.routeChannels).values({ routeId: route.id, accountId: source.account.id, tokenId: source.token.id, sourceModel: 'manual-only', manualOverride: true, sortOrder: 99 }).returning().get();
    await models.rebuildTokenRoutesFromAvailability();
    expect(await channels(route.id)).toHaveLength(3);
    await db.update(schema.accountTokens).set({ enabled: false }).where(eq(schema.accountTokens.id, token.id)).run();
    await models.rebuildTokenRoutesFromAvailability();
    expect((await channels(route.id)).map((channel) => channel.id)).toContain(manual.id);
    expect((await channels(route.id)).filter((channel) => !channel.manualOverride)).toHaveLength(1);
  });

  it('applies site filters per credential even when another site has the same model', async () => {
    const { db, schema } = database;
    const blocked = await seed();
    const allowed = await seed();
    const route = await group();
    await db.insert(schema.siteDisabledModels).values({ siteId: blocked.site.id, modelName: 'GPT-A' }).run();
    await models.rebuildTokenRoutesFromAvailability();
    expect((await channels(route.id)).map((channel) => channel.accountId)).toEqual([allowed.account.id]);
    config.globalAllowedModels = ['other-model'];
    await models.rebuildTokenRoutesFromAvailability();
    expect(await channels(route.id)).toHaveLength(0);
    config.globalAllowedModels = [];
    await models.rebuildTokenRoutesFromAvailability();
    expect(await channels(route.id)).toHaveLength(1);
  });

  it('does not mutate explicit groups or rebuild valid channels on pattern edits', async () => {
    const { db, schema } = database;
    await seed();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const first = (await channels(route.id))[0];
    const explicit = await db.insert(schema.tokenRoutes).values({ routeMode: 'explicit_group', modelPattern: 'explicit', displayName: 'explicit' }).returning().get();
    await db.insert(schema.routeGroupSources).values({ groupRouteId: explicit.id, sourceRouteId: route.id }).run();
    const result = await app.inject({ method: 'PUT', url: `/api/routes/${route.id}`, payload: { modelPattern: 're:^gpt-' } });
    expect(result.statusCode).toBe(200);
    expect((await channels(route.id))[0].id).toBe(first.id);
    expect(await channels(explicit.id)).toHaveLength(0);
  });

  it('syncs site/model disable and re-enable through the API without a manual rebuild', async () => {
    const source = await seed();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    for (const modelNames of [['gpt-a'], []]) {
      const response = await app.inject({ method: 'PUT', url: `/api/sites/${source.site.id}/disabled-models`, payload: { models: modelNames } });
      expect(response.statusCode).toBe(200);
      expect(await channels(route.id)).toHaveLength(modelNames.length ? 0 : 1);
    }
    for (const status of ['disabled', 'active']) {
      const response = await app.inject({ method: 'PUT', url: `/api/sites/${source.site.id}`, payload: { status } });
      expect(response.statusCode).toBe(200);
      expect(await channels(route.id)).toHaveLength(status === 'disabled' ? 0 : 1);
    }
  });

  it('keeps deleted exact models excluded across rebuilds until explicitly restored', async () => {
    await seed();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const { db, schema } = database;
    const exact = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'gpt-a')).get();
    const response = await app.inject({ method: 'DELETE', url: `/api/routes/${exact!.id}` });
    expect(response.statusCode).toBe(200);
    expect(await channels(route.id)).toHaveLength(0);
    await models.rebuildTokenRoutesFromAvailability();
    expect(await channels(route.id)).toHaveLength(0);
    const recreated = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'gpt-a')).get();
    await app.inject({ method: 'PUT', url: `/api/routes/${recreated!.id}`, payload: { enabled: true } });
    expect(await channels(route.id)).toHaveLength(1);
  });

  it('retains direct manual model coverage and removes it on manual deletion', async () => {
    const { db, schema } = database;
    const source = await seed('other');
    await db.update(schema.accounts).set({ apiToken: 'sk-direct', extraConfig: JSON.stringify({ credentialMode: 'apikey' }) }).where(eq(schema.accounts.id, source.account.id)).run();
    const route = await group();
    const add = await app.inject({ method: 'POST', url: `/api/accounts/${source.account.id}/models/manual`, payload: { models: ['gpt-manual'] } });
    expect(add.statusCode).toBe(200);
    expect((await channels(route.id))[0]).toMatchObject({ accountId: source.account.id, tokenId: null, sourceModel: 'gpt-manual' });
    const remove = await app.inject({ method: 'DELETE', url: `/api/accounts/${source.account.id}/models/manual`, payload: { models: ['gpt-manual'] } });
    expect(remove.json()).toMatchObject({ rebuiltRoutes: true });
    expect(await channels(route.id)).toHaveLength(0);
  });

  it('preserves group rows when a synchronization transaction fails', async () => {
    await seed();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const original = await channels(route.id);
    const { db } = database;
    const malformed = new Map([['gpt-b', new Map([['bad', { accountId: 999999, tokenId: null, oauthRouteUnitId: null }]])]]);
    await expect(sync.rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern)).resolves.toMatchObject({ createdChannels: 0, removedChannels: 0 });
    await expect(sync.syncPatternRouteChannels({ candidates: malformed })).rejects.toThrow();
    expect(await channels(route.id)).toEqual(original);
  });

  it('combines concurrent model exclusions without overwriting either deletion', async () => {
    await seed('gpt-a');
    await seed('gpt-b');
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const { db, schema } = database;
    const exact = (await db.select().from(schema.tokenRoutes).all()).filter((item) => ['gpt-a', 'gpt-b'].includes(item.modelPattern));
    const responses = await Promise.all(exact.map((item) => app.inject({ method: 'DELETE', url: `/api/routes/${item.id}` })));
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    const setting = await db.select().from(schema.settings).where(eq(schema.settings.key, 'token_route_deleted_model_exclusions_v1')).get();
    expect(JSON.parse(setting!.value)).toEqual(['gpt-a', 'gpt-b']);
    await models.rebuildTokenRoutesFromAvailability();
    expect(await channels(route.id)).toHaveLength(0);
  });

  it('keeps channels on invalid patterns and releases the mutation lock after failure', async () => {
    await seed();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const original = await channels(route.id);
    const { db, schema } = database;
    await db.update(schema.tokenRoutes).set({ modelPattern: 're:[' }).where(eq(schema.tokenRoutes.id, route.id)).run();
    await expect(sync.rebuildAutomaticRouteChannelsByModelPattern(route.id, 're:[')).rejects.toThrow('Invalid route pattern');
    expect(await channels(route.id)).toEqual(original);
    await db.update(schema.tokenRoutes).set({ modelPattern: 'gpt-*' }).where(eq(schema.tokenRoutes.id, route.id)).run();
    await expect(sync.rebuildAutomaticRouteChannelsByModelPattern(route.id, 'gpt-*')).resolves.toMatchObject({ createdChannels: 0, removedChannels: 0 });
  });

  it('keys OAuth unit coverage by unit and model rather than the representative account', () => {
    const key = (accountId: number, unitId: number, sourceModel: string) => sync.buildPatternChannelIdentity({ accountId, tokenId: null, oauthRouteUnitId: unitId, sourceModel });
    expect(key(1, 10, 'gpt-a')).toBe(key(2, 10, 'gpt-a'));
    expect(key(1, 10, 'gpt-a')).not.toBe(key(1, 11, 'gpt-a'));
    expect(key(1, 10, 'gpt-a')).not.toBe(key(1, 10, 'gpt-b'));
  });

  it('moves an OAuth unit to its active representative while preserving channel identity', async () => {
    const { db, schema } = database;
    const source = await seed('other');
    const first = source.account;
    const second = await db.insert(schema.accounts).values({ siteId: source.site.id, accessToken: 'oauth-second', extraConfig: JSON.stringify({ oauth: { provider: 'codex' } }) }).returning().get();
    await db.update(schema.accounts).set({ extraConfig: JSON.stringify({ oauth: { provider: 'codex' } }) }).where(eq(schema.accounts.id, first.id)).run();
    const unit = await db.insert(schema.oauthRouteUnits).values({ siteId: source.site.id, name: 'Pool', provider: 'codex' }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([{ unitId: unit.id, accountId: first.id, sortOrder: 0 }, { unitId: unit.id, accountId: second.id, sortOrder: 1 }]).run();
    await db.insert(schema.modelAvailability).values([{ accountId: first.id, modelName: 'gpt-a', available: true }, { accountId: second.id, modelName: 'gpt-a', available: true }]).run();
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const original = (await channels(route.id))[0];
    expect(original).toMatchObject({ accountId: first.id, oauthRouteUnitId: unit.id });
    await db.update(schema.routeChannels).set({ failCount: 3, sortOrder: 8 }).where(eq(schema.routeChannels.id, original.id)).run();
    await db.update(schema.accounts).set({ status: 'disabled' }).where(eq(schema.accounts.id, first.id)).run();
    await models.rebuildTokenRoutesFromAvailability();
    expect((await channels(route.id))[0]).toMatchObject({ id: original.id, accountId: second.id, failCount: 3, sortOrder: 8, oauthRouteUnitId: unit.id });
  });

  it('invalidates only changed routes and their explicit-group dependents', async () => {
    const { db, schema } = database;
    const source = await seed('gpt-a');
    await seed('other-model');
    const route = await group();
    await models.rebuildTokenRoutesFromAvailability();
    const other = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.modelPattern, 'other-model')).get();
    const explicit = await db.insert(schema.tokenRoutes).values({ modelPattern: 'explicit', displayName: 'explicit', routeMode: 'explicit_group', decisionSnapshot: '{"keep":true}' }).returning().get();
    await db.insert(schema.routeGroupSources).values({ groupRouteId: explicit.id, sourceRouteId: route.id }).run();
    await db.update(schema.tokenRoutes).set({ decisionSnapshot: '{"keep":true}' }).where(eq(schema.tokenRoutes.id, route.id)).run();
    await db.update(schema.tokenRoutes).set({ decisionSnapshot: '{"keep":true}' }).where(eq(schema.tokenRoutes.id, other!.id)).run();
    await db.insert(schema.tokenModelAvailability).values({ tokenId: source.token.id, modelName: 'gpt-b', available: true }).run();
    await models.rebuildTokenRoutesFromAvailability();
    const rows = await db.select().from(schema.tokenRoutes).all();
    expect(rows.find((row) => row.id === other!.id)!.decisionSnapshot).toBe('{"keep":true}');
    expect(rows.find((row) => row.id === route.id)!.decisionSnapshot).toBeNull();
    expect(rows.find((row) => row.id === explicit.id)!.decisionSnapshot).toBeNull();
  });
});
