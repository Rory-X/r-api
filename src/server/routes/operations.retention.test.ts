import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('retention operation routes', () => {
  let app: ReturnType<typeof Fastify>;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-retention-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const { operationsRoutes } = await import('./operations.js');
    app = Fastify();
    await app.register(operationsRoutes);
  });

  afterAll(async () => {
    await app.close();
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('exposes retention policies and dry-run previews', async () => {
    const policies = await app.inject({
      method: 'GET',
      url: '/api/operations/retention/policies',
    });
    const preview = await app.inject({
      method: 'GET',
      url: '/api/operations/retention/preview?resource=proxy_logs',
    });
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/operations/retention/preview?resource=unknown',
    });

    expect(policies.statusCode).toBe(200);
    expect(policies.json().resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'proxy_logs', archiveEnabled: true }),
      expect.objectContaining({ resource: 'proxy_request_ledger', archiveEnabled: true }),
    ]));
    expect(preview.statusCode).toBe(200);
    expect(preview.json().previews[0]).toMatchObject({
      resource: 'proxy_logs',
      blockedByProjection: false,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('runs a retention dry-run without mutating archive state', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/operations/retention/run',
      payload: { resource: 'proxy_request_ledger', dryRun: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      result: {
        resource: 'proxy_request_ledger',
        dryRun: true,
        archivedRows: 0,
        deletedRows: 0,
      },
    });
  });
});
