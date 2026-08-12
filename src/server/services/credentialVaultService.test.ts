import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./credentialVaultService.js');

describe('credential vault service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-vault-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./credentialVaultService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'vault-site',
      url: 'https://vault.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  it('stores encrypted material and only returns safe metadata', async () => {
    const item = await service.storeCredentialVaultItem({
      siteId,
      name: 'panel session',
      kind: 'session_token',
      secret: 'session-secret-123',
      metadata: {
        source: 'manual',
        username: 'alice',
        origin: 'https://vault.example.com',
      },
    });

    expect(item).toMatchObject({
      siteId,
      name: 'panel session',
      kind: 'session_token',
      status: 'active',
      metadata: {
        source: 'manual',
        username: 'alice',
      },
    });
    expect(item).not.toHaveProperty('ciphertext');
    expect(item).not.toHaveProperty('secret');

    const stored = await db.select().from(schema.credentialVaultItems).get();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain('session-secret-123');

    const resolved = await service.resolveCredentialVaultSecret(item.id);
    expect(resolved?.secret).toBe('session-secret-123');
    expect(resolved?.item.lastUsedAt).toBeTruthy();
  });

  it('rejects credential kinds that the site adapter does not declare', async () => {
    await expect(service.storeCredentialVaultItem({
      siteId,
      name: 'oauth refresh',
      kind: 'oauth_refresh_token',
      secret: 'refresh-secret',
    })).rejects.toThrow('不声明支持');
  });

  it('revoke prevents resolution and delete removes the encrypted row', async () => {
    const item = await service.storeCredentialVaultItem({
      siteId,
      name: 'cookie',
      kind: 'cookie',
      secret: 'sid=abc',
    });

    await expect(service.resolveCredentialVaultSecret(item.id)).resolves.toMatchObject({
      secret: 'sid=abc',
    });
    await expect(service.revokeCredentialVaultItem(item.id)).resolves.toBe(true);
    await expect(service.resolveCredentialVaultSecret(item.id)).resolves.toBeNull();
    await expect(service.revokeCredentialVaultItem(item.id)).resolves.toBe(false);
    await expect(service.deleteCredentialVaultItem(item.id)).resolves.toBe(true);
    await expect(service.listCredentialVaultItems()).resolves.toEqual([]);
  });

  it('expires an item before exposing it to internal consumers', async () => {
    const item = await service.storeCredentialVaultItem({
      siteId,
      name: 'expiring',
      kind: 'session_token',
      secret: 'expiring-secret',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    await expect(service.resolveCredentialVaultSecret(item.id)).resolves.toBeNull();
    const rows = await service.listCredentialVaultItems({ status: 'expired' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('expired');
  });
});
