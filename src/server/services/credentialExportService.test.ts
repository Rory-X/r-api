import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ExportModule = typeof import('./credentialExportService.js');
type IngestionModule = typeof import('./credentialIngestionService.js');
type VaultModule = typeof import('./credentialVaultService.js');

describe('credential export service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let exports: ExportModule;
  let ingestion: IngestionModule;
  let vault: VaultModule;
  let dataDir = '';
  let siteId = 0;
  let accountId = 0;
  let vaultItemId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-exports-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    exports = await import('./credentialExportService.js');
    ingestion = await import('./credentialIngestionService.js');
    vault = await import('./credentialVaultService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.credentialImportProvenance).run();
    await db.delete(schema.credentialImportItems).run();
    await db.delete(schema.credentialImportJobs).run();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: 'Export NewAPI',
      url: 'https://export-newapi.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'export-user',
      accessToken: '',
      apiToken: 'sk-export-account-secret',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey', platformUserId: 88 }),
    }).returning().get();
    accountId = account.id;
    const stored = await vault.storeCredentialVaultItem({
      siteId,
      name: 'exported vault session',
      kind: 'session_token',
      secret: 'vault-export-session-secret',
      metadata: { source: 'manual', username: 'vault-user', adapterPlatform: 'new-api' },
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    vaultItemId = stored.id;
  });

  afterAll(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('exports metadata without account, Vault, or encryption secrets', async () => {
    const result = await exports.exportCredentials({
      mode: 'metadata_only',
      siteId,
      operatorId: 'webui:exporter',
    });

    expect(result).toMatchObject({
      schema: 'r-api.credential-transfer',
      version: 1,
      mode: 'metadata_only',
      item_count: 2,
      items: [
        {
          source: { type: 'account', id: accountId },
          kind: 'api_key',
          recoverability: 'recoverable',
          secret_presence: { apiKey: true },
        },
        {
          source: { type: 'vault_item', id: vaultItemId },
          kind: 'session_token',
          recoverability: 'recoverable',
          secret_presence: { secret: true },
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-export-account-secret');
    expect(serialized).not.toContain('vault-export-session-secret');
    expect(serialized).not.toContain('ciphertext');
    expect(result.items.every((item) => !Object.prototype.hasOwnProperty.call(item, 'credential'))).toBe(true);

    const event = await db.select().from(schema.events).get();
    expect(event).toMatchObject({ type: 'credential_export', level: 'info' });
    expect(JSON.stringify(event)).not.toContain('sk-export-account-secret');
  });

  it('creates a passphrase-encrypted backup that decrypts into an ingestible transfer', async () => {
    const passphrase = 'correct horse battery staple';
    const result = await exports.exportCredentials({
      mode: 'encrypted_backup',
      accountIds: [accountId],
      vaultItemIds: [vaultItemId],
      passphrase,
      expiresInSec: 3600,
    });

    expect(result).toMatchObject({
      schema: 'r-api.credential-backup',
      version: 1,
      item_count: 2,
      encryption: {
        kdf: 'scrypt',
        cipher: 'aes-256-gcm',
        ciphertext: expect.any(String),
      },
    });
    const encrypted = JSON.stringify(result);
    expect(encrypted).not.toContain('sk-export-account-secret');
    expect(encrypted).not.toContain('vault-export-session-secret');
    expect(encrypted).not.toContain(passphrase);

    const transfer = exports.decryptCredentialBackup(result, passphrase);
    expect(transfer).toMatchObject({
      schema: 'r-api.credential-transfer',
      mode: 'portable_secret',
      item_count: 2,
    });
    const normalized = ingestion.normalizeCredentialInput(transfer);
    expect(normalized.detection).toMatchObject({
      format: 'r_api_credential_transfer',
      isBatch: true,
      confidence: 'high',
    });
    expect(normalized.candidates).toHaveLength(2);
    expect(normalized.candidates.map((candidate) => candidate.kind)).toEqual([
      'api_key',
      'session_token',
    ]);

    expect(() => exports.decryptCredentialBackup(result, 'wrong password value'))
      .toThrow('口令错误');
  });

  it('requires explicit confirmation before portable secret export', async () => {
    await expect(exports.exportCredentials({
      mode: 'portable_secret',
      accountIds: [accountId],
    })).rejects.toThrow('EXPORT_SECRETS');

    const result = await exports.exportCredentials({
      mode: 'portable_secret',
      accountIds: [accountId],
      confirmation: 'EXPORT_SECRETS',
      operatorId: 'webui:exporter',
    });
    expect(result).toMatchObject({
      schema: 'r-api.credential-transfer',
      mode: 'portable_secret',
      item_count: 1,
      items: [{ api_key: 'sk-export-account-secret' }],
    });

    const event = await db.select().from(schema.events).get();
    expect(event).toMatchObject({ type: 'credential_export', level: 'warning' });
    expect(JSON.stringify(event)).not.toContain('sk-export-account-secret');
  });

  it('exports native OAuth and Sub2API token sets with target-specific fields', async () => {
    const oauthSite = await db.insert(schema.sites).values({
      name: 'Export OAuth',
      url: 'https://chatgpt.com',
      platform: 'codex',
    }).returning().get();
    const oauth = await db.insert(schema.accounts).values({
      siteId: oauthSite.id,
      username: 'oauth-export@example.com',
      accessToken: 'oauth-export-access',
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-export-oauth',
      oauthCredentialPayload: JSON.stringify({
        email: 'oauth-export@example.com',
        refreshToken: 'oauth-export-refresh',
        idToken: 'oauth-export-id',
        tokenExpiresAt: 1_800_000_000_000,
      }),
    }).returning().get();
    const subSite = await db.insert(schema.sites).values({
      name: 'Export Sub2API',
      url: 'https://sub2api-export.example.com',
      platform: 'sub2api',
    }).returning().get();
    const sub = await db.insert(schema.accounts).values({
      siteId: subSite.id,
      username: 'sub-export',
      accessToken: 'sub-export-access',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 42,
        sub2apiAuth: {
          refreshToken: 'sub-export-refresh',
          tokenExpiresAt: 1_810_000_000_000,
        },
      }),
    }).returning().get();

    const result = await exports.exportCredentials({
      mode: 'portable_secret',
      accountIds: [oauth.id, sub.id],
      confirmation: 'EXPORT_SECRETS',
    });
    const transfer = result as ExportModule['PortableCredentialTransfer'];
    expect(transfer.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'codex',
        access_token: 'oauth-export-access',
        refresh_token: 'oauth-export-refresh',
        account_key: 'acct-export-oauth',
      }),
      expect.objectContaining({
        type: 'sub2api-data',
        access_token: 'sub-export-access',
        refresh_token: 'sub-export-refresh',
        account_id: 42,
      }),
    ]));
    const normalized = ingestion.normalizeCredentialInput(transfer);
    expect(normalized.candidates.map((candidate) => candidate.provider)).toEqual(['codex', 'sub2api']);
    expect(normalized.candidates.every((candidate) => candidate.kind === 'oauth_token_set')).toBe(true);
  });
});
