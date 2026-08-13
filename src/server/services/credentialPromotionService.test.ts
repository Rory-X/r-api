import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type IngestionModule = typeof import('./credentialIngestionService.js');
type PromotionModule = typeof import('./credentialPromotionService.js');

describe('credential promotion service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let ingestion: IngestionModule;
  let promotion: PromotionModule;
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-promotion-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    ingestion = await import('./credentialIngestionService.js');
    promotion = await import('./credentialPromotionService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Promotion Vault Site',
      url: 'https://promotion-vault.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('promotes into the encrypted Vault and safely skips a repeated request', async () => {
    const input = { api_key: 'sk-promotion-vault-secret', name: 'vault import' };
    const candidates = ingestion.normalizeCredentialInput(input).candidates;
    const batchFingerprint = ingestion.buildCredentialBatchPreview(candidates, 'vault').batchFingerprint;

    const first = await promotion.promoteCredentialBatch({
      input,
      target: 'vault',
      siteId,
      batchFingerprint,
    });
    expect(first).toMatchObject({
      success: true,
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      items: [{ status: 'imported', kind: 'api_key' }],
    });

    const stored = await db.select().from(schema.credentialVaultItems).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.ciphertext).toBeTruthy();
    expect(stored[0]?.ciphertext).not.toContain('sk-promotion-vault-secret');

    const second = await promotion.promoteCredentialBatch({
      input,
      target: 'vault',
      siteId,
      batchFingerprint,
    });
    expect(second).toMatchObject({
      success: true,
      imported: 0,
      skipped: 1,
      failed: 0,
      items: [{ status: 'skipped', message: 'Vault 中已存在相同凭证' }],
    });
    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(1);

    const events = await db.select().from(schema.events).all();
    expect(events).toHaveLength(2);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).toContain(batchFingerprint);
    expect(serializedEvents).not.toContain('sk-promotion-vault-secret');
  });

  it('skips duplicates inside one batch and records only one Vault item', async () => {
    const input = ['sk-batch-vault-secret', 'sk-batch-vault-secret'];
    const candidates = ingestion.normalizeCredentialInput(input).candidates;
    const batchFingerprint = ingestion.buildCredentialBatchPreview(candidates, 'vault').batchFingerprint;

    const result = await promotion.promoteCredentialBatch({
      input,
      target: 'vault',
      siteId,
      batchFingerprint,
    });

    expect(result).toMatchObject({
      success: true,
      imported: 1,
      skipped: 1,
      failed: 0,
      items: [
        { status: 'imported' },
        { status: 'skipped', duplicateOfIndex: 0 },
      ],
    });
    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(1);
  });
});
