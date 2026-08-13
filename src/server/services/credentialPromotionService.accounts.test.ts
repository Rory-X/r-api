import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const verifyTokenMock = vi.fn();
const getModelsMock = vi.fn();
const getApiTokensMock = vi.fn();
const refreshBalanceMock = vi.fn();
const refreshModelsForAccountMock = vi.fn();
const rebuildRoutesOnlyMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    platformName: 'new-api',
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./modelService.js', () => ({
  refreshModelsForAccount: (...args: unknown[]) => refreshModelsForAccountMock(...args),
}));

vi.mock('./routeRefreshWorkflow.js', () => ({
  rebuildRoutesOnly: (...args: unknown[]) => rebuildRoutesOnlyMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

type DbModule = typeof import('../db/index.js');
type IngestionModule = typeof import('./credentialIngestionService.js');
type PromotionModule = typeof import('./credentialPromotionService.js');

describe('credential promotion account targets', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ingestion: IngestionModule;
  let promotion: PromotionModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-promotion-accounts-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ingestion = await import('./credentialIngestionService.js');
    promotion = await import('./credentialPromotionService.js');
  });

  beforeEach(async () => {
    verifyTokenMock.mockReset();
    getModelsMock.mockReset();
    getApiTokensMock.mockReset();
    refreshBalanceMock.mockReset();
    refreshModelsForAccountMock.mockReset();
    rebuildRoutesOnlyMock.mockReset();
    getApiTokensMock.mockResolvedValue([]);
    refreshBalanceMock.mockResolvedValue({ balance: 1, used: 0, quota: 1 });
    refreshModelsForAccountMock.mockResolvedValue({
      accountId: 1,
      refreshed: true,
      status: 'success',
      errorCode: null,
      errorMessage: '',
      modelCount: 1,
      modelsPreview: ['gpt-test'],
      models: ['gpt-test'],
      policyProbe: null,
    });
    rebuildRoutesOnlyMock.mockResolvedValue({ success: true });

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  async function insertSite(platform: string) {
    return db.insert(schema.sites).values({
      name: `${platform} promotion site`,
      url: `https://${platform}.example.com`,
      platform,
    }).returning().get();
  }

  function fingerprint(input: unknown, target: IngestionModule['CredentialTarget'] extends never ? never : Parameters<IngestionModule['buildCredentialBatchPreview']>[1]) {
    const candidates = ingestion.normalizeCredentialInput(input).candidates;
    return ingestion.buildCredentialBatchPreview(candidates, target).batchFingerprint;
  }

  it('creates an API-key account and skips the same credential on retry', async () => {
    const site = await insertSite('new-api');
    const input = { api_key: 'opaque-api-key-secret', name: 'primary key' };
    getModelsMock.mockResolvedValue(['gpt-test']);

    const first = await promotion.promoteCredentialBatch({
      input,
      target: 'api_key',
      siteId: site.id,
      batchFingerprint: fingerprint(input, 'api_key'),
    });
    expect(first).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
    expect(await db.select().from(schema.accounts).all()).toHaveLength(1);
    expect((await db.select().from(schema.accounts).get())?.apiToken).toBe('opaque-api-key-secret');

    const second = await promotion.promoteCredentialBatch({
      input,
      target: 'api_key',
      siteId: site.id,
      batchFingerprint: fingerprint(input, 'api_key'),
    });
    expect(second).toMatchObject({ imported: 0, skipped: 1, failed: 0 });
    expect(await db.select().from(schema.accounts).all()).toHaveLength(1);
  });

  it('updates a matching NewAPI session account through the shared rebind workflow', async () => {
    const site = await insertSite('new-api');
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'old-session',
      apiToken: 'old-api-key',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();
    const input = {
      type: 'new_api',
      username: 'alice',
      access_token: 'new-session-secret',
    };
    verifyTokenMock.mockResolvedValue({
      tokenType: 'session',
      userInfo: { username: 'alice' },
      apiToken: 'new-synced-api-key',
    });

    const result = await promotion.promoteCredentialBatch({
      input,
      target: 'new_api',
      siteId: site.id,
      conflictPolicy: 'update',
      batchFingerprint: fingerprint(input, 'new_api'),
    });

    expect(result).toMatchObject({ imported: 0, updated: 1, failed: 0 });
    const latest = await db.select().from(schema.accounts).get();
    expect(latest).toMatchObject({
      id: account.id,
      accessToken: 'new-session-secret',
      apiToken: 'new-synced-api-key',
    });
    expect(await db.select().from(schema.accounts).all()).toHaveLength(1);
  });

  it('imports Sub2API access, refresh, and expiry through the existing account model', async () => {
    const site = await insertSite('sub2api');
    const input = {
      type: 'sub2api-data',
      account_id: '42',
      access_token: 'sub2api-access-secret',
      refresh_token: 'sub2api-refresh-secret',
      token_expires_at: 1_800_000_000_000,
    };
    verifyTokenMock.mockResolvedValue({
      tokenType: 'session',
      userInfo: { username: 'sub-user' },
      apiToken: null,
    });

    const result = await promotion.promoteCredentialBatch({
      input,
      target: 'sub2api',
      siteId: site.id,
      batchFingerprint: fingerprint(input, 'sub2api'),
    });

    expect(result).toMatchObject({ imported: 1, failed: 0 });
    const account = await db.select().from(schema.accounts).get();
    expect(account?.accessToken).toBe('sub2api-access-secret');
    expect(JSON.parse(account?.extraConfig || '{}')).toMatchObject({
      credentialMode: 'session',
      platformUserId: 42,
      sub2apiAuth: {
        refreshToken: 'sub2api-refresh-secret',
        tokenExpiresAt: 1_800_000_000_000,
      },
    });
  });

  it('redacts candidate secrets from failed promotion messages', async () => {
    const site = await insertSite('new-api');
    const input = { api_key: 'leaky-api-key-secret' };
    getModelsMock.mockRejectedValue(new Error('upstream rejected leaky-api-key-secret'));

    const result = await promotion.promoteCredentialBatch({
      input,
      target: 'api_key',
      siteId: site.id,
      batchFingerprint: fingerprint(input, 'api_key'),
    });

    expect(result.failed).toBe(1);
    expect(result.items[0]?.message).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('leaky-api-key-secret');
    expect(JSON.stringify(await db.select().from(schema.events).all())).not.toContain('leaky-api-key-secret');
  });
});
