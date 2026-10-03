import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { DiscoveredModel } from '../contracts/modelDiscovery.js';

const { discover, fetchMock } = vi.hoisted(() => ({ discover: vi.fn(), fetchMock: vi.fn() }));
vi.mock('./platforms/index.js', () => ({ getAdapter: () => ({ discoverModels: discover, getModels: vi.fn(), getApiToken: vi.fn().mockResolvedValue(null) }) }));
vi.mock('undici', async () => ({ ...await vi.importActual<typeof import('undici')>('undici'), fetch: fetchMock }));

type DbModule = typeof import('../db/index.js');
describe('persisted context discovery and routing', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: typeof import('./modelService.js');
  let routing: typeof import('./tokenRouter.js');
  let context: typeof import('./modelContextService.js');
  let account: typeof schema.accounts.$inferSelect;
  let site: typeof schema.sites.$inferSelect;
  const known = (modelName: string, contextLength = 128000): DiscoveredModel => ({ modelName, contextLength, contextSource: 'test.models:context_length' });
  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'r-api-model-context-'));
    await import('../db/migrate.js');
    ({ db, schema } = await import('../db/index.js'));
    service = await import('./modelService.js');
    routing = await import('./tokenRouter.js');
    context = await import('./modelContextService.js');
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    discover.mockReset();
    fetchMock.mockReset();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    site = await db.insert(schema.sites).values({ name: 'context', url: 'https://context.example.com', platform: 'openai' }).returning().get();
    account = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'one', accessToken: '', apiToken: 'key-one', status: 'active',
      extraConfig: '{"credentialMode":"apikey"}',
    }).returning().get();
    routing.invalidateTokenRouterCache();
  });
  afterAll(() => { delete process.env.DATA_DIR; });
  const rows = () => db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, account.id)).all();
  async function refresh(catalog: DiscoveredModel[]) {
    discover.mockResolvedValue(catalog);
    expect((await service.refreshModelsForAccount(account.id)).status).toBe('success');
  }
  async function route(modelPattern: string, entries: Array<{ accountId: number; tokenId?: number; sourceModel?: string }>, extra = {}) {
    const route = await db.insert(schema.tokenRoutes).values({ modelPattern, enabled: true, ...extra }).returning().get();
    await db.insert(schema.routeChannels).values(entries.map((entry) => ({ routeId: route.id, enabled: true, ...entry }))).run();
    routing.invalidateTokenRouterCache();
    return route;
  }
  it('stores evidence by account, survives a fresh router and clears removed metadata on success', async () => {
    await refresh([known('known'), { modelName: 'unknown' }]);
    expect(await rows()).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelName: 'known', contextLength: 128000, contextSource: 'test.models:context_length', contextUpdatedAt: expect.any(String) }),
      expect.objectContaining({ modelName: 'unknown', contextLength: null, contextSource: null, contextUpdatedAt: null }),
    ]));
    await route('known', [{ accountId: account.id }]);
    expect(await new routing.TokenRouter().getModelContextLength('known')).toBe(128000);
    vi.resetModules();
    const restarted = await import('./modelContextService.js');
    expect(await restarted.getKnownModelContextLength([{ accountId: account.id, modelName: 'KNOWN' }])).toBe(128000);
    await refresh([{ modelName: 'known' }]);
    expect(await context.getKnownModelContextLength([{ accountId: account.id, modelName: 'known' }])).toBeUndefined();
  });
  it('isolates effective account credentials from session observations', async () => {
    await db.update(schema.accounts).set({ accessToken: 'session' }).where(eq(schema.accounts.id, account.id)).run();
    discover.mockImplementation(async (_url: string, credential: string) => [known('same', credential === 'session' ? 1000000 : 32000)]);
    await service.refreshModelsForAccount(account.id);
    expect((await rows())[0].contextLength).toBe(32000);
  });
  it('retains both account and token metadata on policy failure and invalidates on raw failure', async () => {
    await db.update(schema.accounts).set({ accessToken: 'session', extraConfig: '{"credentialMode":"session"}' }).where(eq(schema.accounts.id, account.id)).run();
    const token = await db.insert(schema.accountTokens).values({ accountId: account.id, name: 'one', token: 'token-one', enabled: true }).returning().get();
    await refresh([known('same')]);
    discover.mockRejectedValue(new Error('HTTP 503 unavailable'));
    expect((await service.refreshModelsForAccountWithPolicy(account.id)).status).toBe('failed');
    expect((await rows())[0].contextLength).toBe(128000);
    expect(await context.getKnownModelContextLength([{ accountId: account.id, tokenId: token.id, modelName: 'same' }])).toBe(128000);
    await service.refreshModelsForAccount(account.id);
    expect(await rows()).toEqual([]);
    expect(await context.getKnownModelContextLength([{ accountId: account.id, tokenId: token.id, modelName: 'same' }])).toBeUndefined();
  });
  it('publishes the minimum across actual token candidates and never falls back to another credential', async () => {
    await db.update(schema.accounts).set({ accessToken: 'session', extraConfig: '{"credentialMode":"session"}' }).where(eq(schema.accounts.id, account.id)).run();
    const tokens = await db.insert(schema.accountTokens).values([
      { accountId: account.id, name: 'one', token: 'token-one', enabled: true },
      { accountId: account.id, name: 'two', token: 'token-two', enabled: true },
    ]).returning().all();
    discover.mockImplementation(async (_url: string, credential: string) => [known('same', credential === 'token-two' ? 64000 : 128000)]);
    await service.refreshModelsForAccount(account.id);
    await route('same', tokens.map((token) => ({ accountId: account.id, tokenId: token.id })));
    const router = new routing.TokenRouter();
    expect(await router.getModelContextLength('same')).toBe(64000);
    await db.update(schema.tokenModelAvailability).set({ contextLength: null, contextSource: null, contextUpdatedAt: null })
      .where(eq(schema.tokenModelAvailability.tokenId, tokens[1].id)).run();
    expect(await router.getModelContextLength('same')).toBeUndefined();
    expect(await context.getKnownModelContextLength([{ accountId: account.id, tokenId: tokens[1].id, modelName: 'same' }])).toBeUndefined();
    await db.update(schema.accountTokens).set({ enabled: false }).where(eq(schema.accountTokens.id, tokens[1].id)).run();
    routing.invalidateTokenRouterCache();
    expect(await router.getModelContextLength('same')).toBe(128000);
  });
  it('resolves alias source models and omits a mixed known/unknown alias unless policy excludes the unknown site', async () => {
    await refresh([known('actual-a', 64000)]);
    const siteB = await db.insert(schema.sites).values({ name: 'b', url: 'https://b.example.com', platform: 'openai' }).returning().get();
    const other = await db.insert(schema.accounts).values({ siteId: siteB.id, username: 'two', accessToken: '', apiToken: 'key-two', status: 'active', extraConfig: '{"credentialMode":"apikey"}' }).returning().get();
    await db.insert(schema.modelAvailability).values({ accountId: other.id, modelName: 'actual-b', available: true }).run();
    await route('actual-*', [{ accountId: account.id, sourceModel: 'actual-a' }, { accountId: other.id, sourceModel: 'actual-b' }], { displayName: 'friendly' });
    const router = new routing.TokenRouter();
    expect(await router.getModelContextLength('friendly')).toBeUndefined();
    expect(await router.getModelContextLength('friendly', { supportedModels: ['friendly'], allowedRouteIds: [], siteWeightMultipliers: {}, excludedSiteIds: [siteB.id] })).toBe(64000);
    await db.update(schema.modelAvailability).set({ ...known('actual-b', 32000), contextUpdatedAt: new Date().toISOString() }).where(eq(schema.modelAvailability.accountId, other.id)).run();
    expect(await router.getModelContextLength('friendly')).toBe(32000);
  });
  it('applies model mappings and manual overrides remain unknown', async () => {
    await refresh([known('actual', 32000)]);
    await route('alias', [{ accountId: account.id }], { modelMapping: '{"alias":"actual"}' });
    expect(await new routing.TokenRouter().getModelContextLength('alias')).toBe(32000);
    await db.insert(schema.modelAvailability).values({ accountId: account.id, modelName: 'manual', available: true, isManual: true }).run();
    await route('manual', [{ accountId: account.id }]);
    expect(await new routing.TokenRouter().getModelContextLength('manual')).toBeUndefined();
  });
  it('keeps prior evidence visible during a scan and serializes same-account scans', async () => {
    await refresh([known('same', 32000)]);
    let release!: (models: DiscoveredModel[]) => void;
    discover.mockReset();
    discover.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce([known('same', 64000)]);
    const first = service.refreshModelsForAccount(account.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = service.refreshModelsForAccount(account.id);
    expect(discover).toHaveBeenCalledTimes(1);
    expect((await rows())[0].contextLength).toBe(32000);
    release([known('same', 128000)]);
    await Promise.all([first, second]);
    expect(discover).toHaveBeenCalledTimes(2);
    expect((await rows())[0].contextLength).toBe(64000);
  });
  it('keeps simultaneous accounts with the same upstream model in separate persisted scopes', async () => {
    const other = await db.insert(schema.accounts).values({
      siteId: site.id, username: 'two', apiToken: 'key-two', accessToken: '', status: 'active', extraConfig: '{"credentialMode":"apikey"}',
    }).returning().get();
    discover.mockImplementation(async (_url: string, credential: string) => [known('same', credential === 'key-one' ? 32000 : 64000)]);
    await Promise.all([service.refreshModelsForAccount(account.id), service.refreshModelsForAccount(other.id)]);
    expect(await context.getKnownModelContextLength([{ accountId: account.id, modelName: 'same' }])).toBe(32000);
    expect(await context.getKnownModelContextLength([{ accountId: other.id, modelName: 'same' }])).toBe(64000);
  });
  it.each(['claude', 'antigravity', 'gemini-cli'])('keeps %s OAuth metadata honest', async (provider) => {
    await db.update(schema.sites).set({ platform: provider }).where(eq(schema.sites.id, site.id)).run();
    await db.update(schema.accounts).set({
      apiToken: null, accessToken: 'oauth-one', oauthProvider: provider, oauthAccountKey: 'one', oauthProjectId: 'project',
      extraConfig: JSON.stringify({ credentialMode: 'session', oauth: { provider, accountId: 'one', projectId: 'project' } }),
    }).where(eq(schema.accounts.id, account.id)).run();
    fetchMock.mockResolvedValue({ ok: true, json: async () => provider === 'claude'
      ? { data: [{ id: 'known', context_length: 64000 }, { id: 'unknown' }] }
      : provider === 'antigravity' ? { models: { known: { contextWindow: 64000 }, unknown: {} } } : { state: 'ENABLED' },
    });
    expect((await service.refreshModelsForAccount(account.id)).status).toBe('success');
    const observed = await rows();
    if (provider === 'gemini-cli') {
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((row) => row.contextLength === null && row.contextSource === null)).toBe(true);
    } else {
      expect(observed.find((row) => row.modelName === 'known')).toMatchObject({ contextLength: 64000, contextSource: expect.stringContaining(`${provider}.models:`) });
      expect(observed.find((row) => row.modelName === 'unknown')).toMatchObject({ contextLength: null, contextSource: null });
    }
  });
  it('propagates cloud OAuth evidence and includes all healthy pool members in aggregation', async () => {
    await db.update(schema.sites).set({ platform: 'codex' }).where(eq(schema.sites.id, site.id)).run();
    await db.update(schema.accounts).set({ apiToken: null, accessToken: 'oauth-one', oauthProvider: 'codex', oauthAccountKey: 'one', extraConfig: '{"credentialMode":"session","oauth":{"provider":"codex","accountId":"one"}}' }).where(eq(schema.accounts.id, account.id)).run();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ models: [{ slug: 'codex-model', context_window: 128000 }] }) });
    expect((await service.refreshModelsForAccount(account.id)).status).toBe('success');
    expect((await rows())[0]).toMatchObject({ contextLength: 128000, contextSource: 'codex.models:context_window' });
    const other = await db.insert(schema.accounts).values({ siteId: site.id, username: 'two', apiToken: null, accessToken: 'oauth-two', status: 'active', oauthProvider: 'codex', oauthAccountKey: 'two', extraConfig: '{"credentialMode":"session","oauth":{"provider":"codex","accountId":"two"}}' }).returning().get();
    await db.insert(schema.modelAvailability).values({ accountId: other.id, modelName: 'codex-model', available: true }).run();
    const unit = await db.insert(schema.oauthRouteUnits).values({ siteId: site.id, provider: 'codex', name: 'pool', strategy: 'round_robin', enabled: true }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([{ unitId: unit.id, accountId: account.id }, { unitId: unit.id, accountId: other.id }]).run();
    const routeRow = await db.insert(schema.tokenRoutes).values({ modelPattern: 'codex-model', enabled: true }).returning().get();
    await db.insert(schema.routeChannels).values({ routeId: routeRow.id, accountId: account.id, oauthRouteUnitId: unit.id, enabled: true }).run();
    routing.invalidateTokenRouterCache();
    expect(await new routing.TokenRouter().getModelContextLength('codex-model')).toBeUndefined();
    await db.update(schema.modelAvailability).set({ contextLength: 64000, contextSource: 'codex.models:context_window', contextUpdatedAt: new Date().toISOString() }).where(eq(schema.modelAvailability.accountId, other.id)).run();
    expect(await new routing.TokenRouter().getModelContextLength('codex-model')).toBe(64000);
  });
});
