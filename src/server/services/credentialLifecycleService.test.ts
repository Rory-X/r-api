import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const verifyTokenMock = vi.fn();
const refreshOauthMock = vi.fn();
const refreshSub2ApiMock = vi.fn();
const rebuildRoutesMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  }),
}));

vi.mock('./oauth/service.js', () => ({
  refreshOauthAccessToken: (...args: unknown[]) => refreshOauthMock(...args),
}));

vi.mock('./sub2apiRefreshSingleflight.js', () => ({
  refreshSub2ApiManagedSessionSingleflight: (...args: unknown[]) => refreshSub2ApiMock(...args),
}));

vi.mock('./routeRefreshWorkflow.js', () => ({
  rebuildRoutesBestEffort: (...args: unknown[]) => rebuildRoutesMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type LifecycleModule = typeof import('./credentialLifecycleService.js');
type VaultModule = typeof import('./credentialVaultService.js');
type AccountCredentialModule = typeof import('./accountCredentialService.js');

describe('credential lifecycle service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let lifecycle: LifecycleModule;
  let vault: VaultModule;
  let accountCredential: AccountCredentialModule;
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-lifecycle-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    lifecycle = await import('./credentialLifecycleService.js');
    vault = await import('./credentialVaultService.js');
    accountCredential = await import('./accountCredentialService.js');
  });

  beforeEach(async () => {
    verifyTokenMock.mockReset();
    refreshOauthMock.mockReset();
    refreshSub2ApiMock.mockReset();
    rebuildRoutesMock.mockReset();
    rebuildRoutesMock.mockResolvedValue(true);
    await db.delete(schema.credentialImportProvenance).run();
    await db.delete(schema.credentialImportItems).run();
    await db.delete(schema.credentialImportJobs).run();
    await db.delete(schema.oauthRefreshLeases).run();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Lifecycle Site',
      url: 'https://lifecycle.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('derives refreshing, refresh_failed, expiring, expired, and disabled states from existing sources', async () => {
    const nowMs = Date.parse('2026-08-13T12:00:00.000Z');
    const oauthRefreshing = await db.insert(schema.accounts).values({
      siteId,
      username: 'refreshing@example.com',
      accessToken: 'refreshing-access-secret',
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-refreshing',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'refreshing-refresh-secret',
        tokenExpiresAt: nowMs + 10 * 60 * 1000,
      }),
      oauthCredentialVersion: 2,
      oauthRefreshState: 'ready',
    }).returning().get();
    await db.insert(schema.oauthRefreshLeases).values({
      accountId: oauthRefreshing.id,
      provider: 'codex',
      providerSlot: 1,
      leaseToken: 'lifecycle-lease',
      leaseOwner: 'test',
      credentialVersion: 2,
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    }).run();
    await db.insert(schema.accounts).values({
      siteId,
      username: 'failed@example.com',
      accessToken: 'failed-access-secret',
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-failed',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'failed-refresh-secret',
        tokenExpiresAt: nowMs + 7 * 24 * 60 * 60 * 1000,
      }),
      oauthRefreshState: 'transient_error',
      oauthRefreshLastError: 'provider temporarily unavailable',
    }).run();
    await db.insert(schema.accounts).values({
      siteId,
      username: 'disabled-user',
      accessToken: 'disabled-secret',
      status: 'disabled',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).run();
    await vault.storeCredentialVaultItem({
      siteId,
      name: 'expiring vault',
      kind: 'session_token',
      secret: 'expiring-vault-secret',
      expiresAt: new Date(nowMs + 30 * 60 * 1000).toISOString(),
    });
    await vault.storeCredentialVaultItem({
      siteId,
      name: 'expired vault',
      kind: 'session_token',
      secret: 'expired-vault-secret',
      expiresAt: new Date(nowMs - 60_000).toISOString(),
    });

    const records = await lifecycle.listCredentialLifecycle({ nowMs });
    expect(records.find((item) => item.name === 'refreshing@example.com')).toMatchObject({
      status: 'refreshing',
      refreshOwner: 'r_api',
      actions: { refresh: true },
    });
    expect(records.find((item) => item.name === 'failed@example.com')).toMatchObject({
      status: 'refresh_failed',
      statusReason: 'provider temporarily unavailable',
    });
    expect(records.find((item) => item.name === 'disabled-user')).toMatchObject({
      status: 'disabled',
      actions: { enable: true, disable: false },
    });
    expect(records.find((item) => item.name === 'expiring vault')).toMatchObject({
      status: 'expiring',
    });
    expect(records.find((item) => item.name === 'expired vault')).toMatchObject({
      status: 'expired',
    });
    expect(JSON.stringify(records)).not.toContain('refreshing-access-secret');
    expect(JSON.stringify(records)).not.toContain('expiring-vault-secret');
  });

  it('validates, disables, enables, and revokes Vault credentials in one batch contract', async () => {
    const stored = await vault.storeCredentialVaultItem({
      siteId,
      name: 'managed vault key',
      kind: 'api_key',
      secret: 'lifecycle-vault-api-secret',
    });
    verifyTokenMock.mockResolvedValue({ tokenType: 'apikey', models: ['gpt-test'] });

    const validation = await lifecycle.executeCredentialLifecycleBatch({
      action: 'validate',
      items: [{ entityType: 'vault_item', entityId: stored.id }],
    });
    expect(validation).toMatchObject({
      succeeded: 1,
      failed: 0,
      items: [{ success: true, message: '远端验证通过：apikey' }],
    });
    expect(verifyTokenMock).toHaveBeenCalledWith('https://lifecycle.example.com', 'lifecycle-vault-api-secret');

    const disabled = await lifecycle.executeCredentialLifecycleBatch({
      action: 'disable',
      items: [{ entityType: 'vault_item', entityId: stored.id }],
    });
    expect(disabled.items[0]).toMatchObject({ success: true, status: 'disabled' });

    const enabled = await lifecycle.executeCredentialLifecycleBatch({
      action: 'enable',
      items: [{ entityType: 'vault_item', entityId: stored.id }],
    });
    expect(enabled.items[0]).toMatchObject({ success: true, status: 'active' });

    const revoked = await lifecycle.executeCredentialLifecycleBatch({
      action: 'revoke',
      items: [{ entityType: 'vault_item', entityId: stored.id }],
    });
    expect(revoked.items[0]).toMatchObject({ success: true, status: 'revoked' });
    expect(JSON.stringify(await db.select().from(schema.events).all()))
      .not.toContain('lifecycle-vault-api-secret');
  });

  it('refreshes managed OAuth through the existing coordinated workflow', async () => {
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'refresh-me@example.com',
      accessToken: 'oauth-lifecycle-access',
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-refresh-me',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'oauth-lifecycle-refresh',
        tokenExpiresAt: Date.parse('2026-08-14T00:00:00.000Z'),
      }),
      oauthRefreshState: 'ready',
    }).returning().get();
    refreshOauthMock.mockResolvedValue({ refreshed: true, reused: false });

    const result = await lifecycle.executeCredentialLifecycleBatch({
      action: 'refresh',
      items: [{ entityType: 'account', entityId: account.id }],
    });

    expect(result).toMatchObject({
      succeeded: 1,
      failed: 0,
      items: [{ success: true, message: 'OAuth 凭证刷新完成' }],
    });
    expect(refreshOauthMock).toHaveBeenCalledWith(account.id, { reason: 'manual', force: true });
  });

  it('revokes an account locally, clears managed secrets, and preserves identity for audit', async () => {
    const password = accountCredential.encryptAccountPassword('lifecycle-password-secret');
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'revoke@example.com',
      accessToken: 'revoke-access-secret',
      apiToken: 'revoke-api-secret',
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-revoke',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'revoke-refresh-secret',
        idToken: 'revoke-id-secret',
      }),
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        autoRelogin: { username: 'revoke@example.com', passwordCipher: password },
        sub2apiAuth: { refreshToken: 'revoke-sub2-secret', tokenExpiresAt: 1_900_000_000_000 },
        oauth: { provider: 'codex', accountKey: 'acct-revoke', refreshToken: 'legacy-refresh-secret' },
      }),
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'revoke-routed-secret',
      enabled: true,
      isDefault: true,
    }).run();

    const result = await lifecycle.executeCredentialLifecycleBatch({
      action: 'revoke',
      items: [{ entityType: 'account', entityId: account.id }],
    });
    expect(result.items[0]).toMatchObject({
      success: true,
      status: 'revoked',
    });

    const persisted = await db.select().from(schema.accounts)
      .where((await import('drizzle-orm')).eq(schema.accounts.id, account.id)).get();
    expect(persisted).toMatchObject({
      status: 'revoked',
      accessToken: '',
      apiToken: null,
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-revoke',
      oauthCredentialPayload: null,
      oauthRefreshState: 'reauthorization_required',
    });
    expect(persisted?.extraConfig).not.toContain('autoRelogin');
    expect(persisted?.extraConfig).not.toContain('sub2apiAuth');
    expect(persisted?.extraConfig).not.toContain('legacy-refresh-secret');
    expect(await db.select().from(schema.accountTokens).all()).toHaveLength(0);
    expect(rebuildRoutesMock).toHaveBeenCalled();

    const serializedAudit = JSON.stringify(await db.select().from(schema.events).all());
    for (const secret of [
      'revoke-access-secret',
      'revoke-api-secret',
      'revoke-refresh-secret',
      'revoke-id-secret',
      'revoke-sub2-secret',
      'revoke-routed-secret',
      'lifecycle-password-secret',
    ]) {
      expect(serializedAudit).not.toContain(secret);
    }
  });
});
