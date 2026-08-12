import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('site adapter contract route', () => {
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-adapter-contract-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const routesModule = await import('./sites.js');
    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns read-only adapter capabilities without probing an upstream', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/sites/adapters',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      adapters: Array<{
        platformName: string;
        credentialStorage: string;
        browser: { supported: boolean };
      }>;
    };
    expect(body.adapters.some((adapter) => adapter.platformName === 'new-api')).toBe(true);
    expect(body.adapters.find((adapter) => adapter.platformName === 'new-api')).toMatchObject({
      credentialStorage: 'encrypted_vault_only',
      browser: { supported: true },
    });
  });

  it('attaches the matching contract to URL detection results', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/detect',
      payload: { url: 'https://api.openai.com/v1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      platform: 'openai',
      contract: {
        platformName: 'openai',
        probePolicy: 'metadata_only',
        credentialStorage: 'encrypted_vault_only',
      },
    });
  });
});
