import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const importOauthMock = vi.fn();

vi.mock('./oauth/service.js', () => ({
  importOauthConnectionsFromNativeJson: (...args: unknown[]) => importOauthMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type IngestionModule = typeof import('./credentialIngestionService.js');
type PromotionModule = typeof import('./credentialPromotionService.js');

describe('credential promotion native OAuth target', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ingestion: IngestionModule;
  let promotion: PromotionModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-promotion-oauth-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ingestion = await import('./credentialIngestionService.js');
    promotion = await import('./credentialPromotionService.js');
  });

  beforeEach(async () => {
    importOauthMock.mockReset();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  function batchFingerprint(input: unknown): string {
    const candidates = ingestion.normalizeCredentialInput(input).candidates;
    return ingestion.buildCredentialBatchPreview(candidates, 'native_oauth').batchFingerprint;
  }

  it('maps the canonical token set into the existing native OAuth import contract', async () => {
    const input = {
      type: 'openai',
      access_token: 'oauth-promotion-access-secret',
      refresh_token: 'oauth-promotion-refresh-secret',
      id_token: 'oauth-promotion-id-secret',
      email: 'oauth@example.com',
      account_id: 'acct-oauth-1',
      account_key: 'acct-oauth-1',
      expired: 1_900_000_000_000,
      disabled: true,
    };
    importOauthMock.mockResolvedValue({
      success: true,
      imported: 1,
      skipped: 0,
      failed: 0,
      items: [{
        name: 'oauth@example.com',
        status: 'imported',
        provider: 'codex',
        accountId: 71,
      }],
    });

    const result = await promotion.promoteCredentialBatch({
      input,
      target: 'native_oauth',
      batchFingerprint: batchFingerprint(input),
    });

    expect(result).toMatchObject({
      success: true,
      imported: 1,
      updated: 0,
      failed: 0,
      items: [{ status: 'imported', provider: 'codex', accountId: 71 }],
    });
    expect(importOauthMock).toHaveBeenCalledWith({
      items: [{
        type: 'codex',
        access_token: 'oauth-promotion-access-secret',
        refresh_token: 'oauth-promotion-refresh-secret',
        id_token: 'oauth-promotion-id-secret',
        email: 'oauth@example.com',
        account_id: 'acct-oauth-1',
        account_key: 'acct-oauth-1',
        expired: 1_900_000_000_000,
        disabled: true,
      }],
    });
    expect(JSON.stringify(result)).not.toContain('oauth-promotion-access-secret');
    expect(JSON.stringify(await db.select().from(schema.events).all()))
      .not.toContain('oauth-promotion-refresh-secret');
  });

  it('skips an existing provider identity by default', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Codex OAuth',
      url: 'https://chatgpt.com',
      platform: 'codex',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'existing@example.com',
      accessToken: 'existing-access',
      oauthProvider: 'codex',
      oauthAccountKey: 'acct-existing',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();
    const input = {
      type: 'codex',
      access_token: 'new-access-secret',
      refresh_token: 'new-refresh-secret',
      account_key: 'acct-existing',
      email: 'existing@example.com',
    };

    const result = await promotion.promoteCredentialBatch({
      input,
      target: 'native_oauth',
      batchFingerprint: batchFingerprint(input),
    });

    expect(result).toMatchObject({
      success: true,
      imported: 0,
      updated: 0,
      skipped: 1,
      failed: 0,
      items: [{ status: 'skipped', accountId: account.id }],
    });
    expect(importOauthMock).not.toHaveBeenCalled();
  });

  it('rejects create_duplicate because OAuth identities must converge', async () => {
    const input = {
      type: 'codex',
      access_token: 'duplicate-oauth-access',
      account_key: 'acct-duplicate',
    };
    await expect(promotion.promoteCredentialBatch({
      input,
      target: 'native_oauth',
      conflictPolicy: 'create_duplicate',
      batchFingerprint: batchFingerprint(input),
    })).rejects.toThrow('不支持 create_duplicate');
    expect(importOauthMock).not.toHaveBeenCalled();
  });
});
