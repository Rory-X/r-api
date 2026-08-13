import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type ExportModule = typeof import('./officialCredentialExportService.js');

function buildJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`;
}

describe('official credential Sub2API export', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let exports: ExportModule;
  let siteId = 0;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-official-credential-export-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    exports = await import('./officialCredentialExportService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('exports the Cockpit sub2api-data v1 account shape with official identity metadata', async () => {
    const idToken = buildJwt({
      sub: 'user-123',
      email: 'official@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-123',
        chatgpt_user_id: 'user-123',
        organization_id: 'org-123',
        chatgpt_plan_type: 'team',
        chatgpt_subscription_active_until: '2026-12-31T23:59:59.000Z',
      },
    });
    const accessToken = buildJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
    });
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'Official Team',
      accessToken,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'account-123',
      oauthCredentialPayload: JSON.stringify({
        email: 'official@example.com',
        planType: 'team',
        refreshToken: 'refresh-token-123',
        idToken,
        tokenExpiresAt: 1_800_000_000_000,
        quota: {
          subscription: { activeUntil: '2026-12-31T23:59:59.000Z' },
        },
      }),
    }).returning().get();

    const result = await exports.exportOfficialCredentialsAsSub2Api({
      accountIds: [account.id, account.id],
      confirmation: exports.OFFICIAL_CREDENTIAL_SECRET_EXPORT_CONFIRMATION,
      now: new Date('2026-08-13T12:34:56.789Z'),
    });

    expect(result).toEqual({
      type: 'sub2api-data',
      version: 1,
      exported_at: '2026-08-13T12:34:56Z',
      proxies: [],
      accounts: [{
        name: 'Official Team',
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: accessToken,
          expires_at: '2027-01-15T08:00:00.000Z',
          refresh_token: 'refresh-token-123',
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
          id_token: idToken,
          email: 'official@example.com',
          chatgpt_account_id: 'account-123',
          chatgpt_user_id: 'user-123',
          organization_id: 'org-123',
          plan_type: 'team',
          subscription_expires_at: '2026-12-31T23:59:59.000Z',
        },
        concurrency: 3,
        priority: 50,
      }],
    });
  });

  it('requires explicit confirmation before exporting plaintext official secrets', async () => {
    await expect(exports.exportOfficialCredentialsAsSub2Api({
      accountIds: [1],
      confirmation: '',
    })).rejects.toThrow('explicit secret export confirmation is required');
  });

  it('marks access-token-only credentials for automatic pause at expiry', async () => {
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'Access Only',
      accessToken: 'access-only-token',
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'access-only-account',
      oauthCredentialPayload: JSON.stringify({
        email: 'access-only@example.com',
        tokenExpiresAt: 1_800_000_000_000,
      }),
    }).returning().get();

    const result = await exports.exportOfficialCredentialsAsSub2Api({
      accountIds: [account.id],
      confirmation: exports.OFFICIAL_CREDENTIAL_SECRET_EXPORT_CONFIRMATION,
    });

    expect(result.accounts[0]).toMatchObject({
      expires_at: 1_800_000_000,
      auto_pause_on_expired: true,
      credentials: {
        access_token: 'access-only-token',
        expires_at: '2027-01-15T08:00:00.000Z',
        email: 'access-only@example.com',
      },
    });
    expect(result.accounts[0]?.credentials).not.toHaveProperty('refresh_token');
    expect(result.accounts[0]?.credentials).not.toHaveProperty('client_id');
  });

  it('rejects non-Codex official credentials instead of producing a misleading package', async () => {
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'Claude Official',
      accessToken: 'claude-access-token',
      status: 'active',
      oauthProvider: 'claude',
      oauthAccountKey: 'claude-account',
      oauthCredentialPayload: JSON.stringify({ refreshToken: 'claude-refresh-token' }),
    }).returning().get();

    await expect(exports.exportOfficialCredentialsAsSub2Api({
      accountIds: [account.id],
      confirmation: exports.OFFICIAL_CREDENTIAL_SECRET_EXPORT_CONFIRMATION,
    })).rejects.toThrow('supports Codex/OpenAI official credentials only');
  });
});
