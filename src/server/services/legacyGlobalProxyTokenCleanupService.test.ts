import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('legacyGlobalProxyTokenCleanupService', () => {
  let db: typeof import('../db/index.js')['db'];
  let schema: typeof import('../db/index.js')['schema'];
  let cleanupLegacyGlobalProxyTokenState: typeof import('./legacyGlobalProxyTokenCleanupService.js')['cleanupLegacyGlobalProxyTokenState'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-legacy-proxy-token-cleanup-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const cleanupModule = await import('./legacyGlobalProxyTokenCleanupService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    cleanupLegacyGlobalProxyTokenState = cleanupModule.cleanupLegacyGlobalProxyTokenState;
  });

  beforeEach(async () => {
    await db.delete(schema.proxyFiles).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('deletes the legacy setting and files while preserving project-owned files', async () => {
    await db.insert(schema.settings).values([
      { key: 'proxy_token', value: JSON.stringify('sk-obsolete') },
      { key: 'system_proxy_url', value: JSON.stringify('') },
    ]).run();
    await db.insert(schema.proxyFiles).values([
      {
        publicId: 'file-metapi-legacy',
        ownerType: 'global_proxy_token',
        ownerId: 'global',
        filename: 'legacy.txt',
        mimeType: 'text/plain',
        byteSize: 6,
        sha256: 'legacy',
        contentBase64: Buffer.from('legacy').toString('base64'),
      },
      {
        publicId: 'file-metapi-project',
        ownerType: 'managed_key',
        ownerId: '8',
        filename: 'project.txt',
        mimeType: 'text/plain',
        byteSize: 7,
        sha256: 'project',
        contentBase64: Buffer.from('project').toString('base64'),
      },
    ]).run();

    await cleanupLegacyGlobalProxyTokenState();

    expect(await db.select().from(schema.settings).all()).toEqual([
      { key: 'system_proxy_url', value: JSON.stringify('') },
    ]);
    expect((await db.select().from(schema.proxyFiles).all()).map((row) => row.publicId)).toEqual([
      'file-metapi-project',
    ]);
  });
});
