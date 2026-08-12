import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('proxy file admin routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let saveProxyFile: typeof import('../../services/proxyFileStore.js').saveProxyFile;
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-proxy-file-admin-'));
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const storeModule = await import('../../services/proxyFileStore.js');
    const routeModule = await import('./proxyFiles.js');
    db = dbModule.db;
    schema = dbModule.schema;
    saveProxyFile = storeModule.saveProxyFile;
    app = Fastify();
    await app.register(routeModule.proxyFileAdminRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyFiles).run();
  });

  afterAll(async () => {
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('serves a stored downstream file through the administrator API surface', async () => {
    const file = await saveProxyFile({
      ownerType: 'managed_key',
      ownerId: '12',
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('PDF').toString('base64'),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/proxy-files/${encodeURIComponent(file.publicId)}/content`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('brief.pdf');
    expect(response.rawPayload).toEqual(Buffer.from('PDF'));
  });

  it('does not expose missing or soft-deleted files', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy-files/file-metapi-missing/content',
    });
    expect(response.statusCode).toBe(404);
  });
});
