import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ login: vi.fn(), getApiToken: vi.fn(), getApiTokens: vi.fn() }));
vi.mock('./platforms/index.js', () => ({ getAdapter: () => mocks }));
vi.mock('./accountMutationWorkflow.js', () => ({ convergeAccountMutation: vi.fn() }));

describe('account login identity persistence', () => {
  let dbModule: typeof import('../db/index.js');
  let loginAndPersistAccount: typeof import('./accountLoginService.js')['loginAndPersistAccount'];
  let directory: string;
  const previousDataDir = process.env.DATA_DIR;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'r-api-login-identity-'));
    process.env.DATA_DIR = directory;
    await import('../db/migrate.js');
    dbModule = await import('../db/index.js');
    ({ loginAndPersistAccount } = await import('./accountLoginService.js'));
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await dbModule.db.delete(dbModule.schema.accounts).run();
    await dbModule.db.delete(dbModule.schema.sites).run();
    mocks.getApiToken.mockResolvedValue(null);
    mocks.getApiTokens.mockResolvedValue([]);
  });
  afterAll(async () => {
    await dbModule.closeDbConnections();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(directory, { recursive: true, force: true });
  });

  it('uses the reported identity for token discovery and persisted account settings', async () => {
    const { db, schema } = dbModule;
    const site = await db.insert(schema.sites).values({ name: 'Site', url: 'https://example.com', platform: 'new-api' }).returning().get();
    mocks.login.mockResolvedValue({ success: true, accessToken: 'session', platformUserId: 500123 });
    const result = await loginAndPersistAccount({ siteId: site.id, username: 'alice_1999', password: 'password' });
    expect(result.success).toBe(true);
    expect(mocks.getApiToken).toHaveBeenCalledWith(site.url, 'session', 500123);
    expect(mocks.getApiTokens).toHaveBeenCalledWith(site.url, 'session', 500123);
    if (!result.success) throw new Error(result.message);
    expect(JSON.parse(result.account.extraConfig!)).toMatchObject({ platformUserId: 500123, autoRelogin: { username: 'alice_1999' } });
  });

  it('preserves settings changed during token discovery and replaces a stale stored ID', async () => {
    const { db, schema } = dbModule;
    const site = await db.insert(schema.sites).values({ name: 'Site', url: 'https://example.com', platform: 'new-api' }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, username: 'alice_1999', accessToken: 'old', extraConfig: JSON.stringify({ platformUserId: 1999, marker: 'old' }) }).returning().get();
    mocks.login.mockResolvedValue({ success: true, accessToken: 'fresh', platformUserId: 500123 });
    mocks.getApiTokens.mockImplementationOnce(async () => {
      await db.update(schema.accounts).set({ extraConfig: JSON.stringify({ platformUserId: 1999, marker: 'changed' }) }).where(eq(schema.accounts.id, account.id)).run();
      return [];
    });
    const result = await loginAndPersistAccount({ siteId: site.id, username: 'alice_1999', password: 'password' });
    if (!result.success) throw new Error(result.message);
    expect(result.reusedAccount).toBe(true);
    expect(JSON.parse(result.account.extraConfig!)).toMatchObject({ platformUserId: 500123, marker: 'changed' });
  });
});
