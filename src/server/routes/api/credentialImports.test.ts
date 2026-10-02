import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

describe('credential import preview routes', () => {
  let app: FastifyInstance;
  let credentialImportRoutes: typeof import('./credentialImports.js')['credentialImportRoutes'];
  let credentialLifecycleRoutes: typeof import('./credentialLifecycle.js')['credentialLifecycleRoutes'];
  let db: typeof import('../../db/index.js')['db'];
  let schema: typeof import('../../db/index.js')['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-import-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    ({ credentialImportRoutes } = await import('./credentialImports.js'));
    ({ credentialLifecycleRoutes } = await import('./credentialLifecycle.js'));
  });

  afterAll(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    resetRequestRateLimitStore();
    app = Fastify();
    await app.register(credentialImportRoutes);
    await app.register(credentialLifecycleRoutes);
  });

  it('returns safe previews without exposing credential material', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: {
        input: {
          type: 'sub2api-bundle',
          accounts: [{
            account_id: 'sub-preview',
            access_token: 'route-access-secret',
            refresh_token: 'route-refresh-secret',
          }],
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      importJobId: expect.any(String),
      status: 'previewed',
      detection: { format: 'sub2api_bundle' },
      candidates: [{
        candidate: {
          provider: 'sub2api',
          kind: 'oauth_token_set',
          identity: { externalId: 'sub-preview' },
          secretSummary: { accessToken: true, refreshToken: true },
          compatibleTargets: ['sub2api', 'vault'],
        },
        validation: { status: 'ready', errors: [] },
      }],
    });
    expect(response.body).not.toContain('route-access-secret');
    expect(response.body).not.toContain('route-refresh-secret');
    expect(response.body).not.toContain('"secrets"');
  });

  it('accepts plain API keys and rejects missing input', async () => {
    const preview = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: { input: 'sk-route-preview-secret' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().importJobId).toEqual(expect.any(String));
    expect(preview.json().candidates[0]).toMatchObject({
      candidate: {
        kind: 'api_key',
        secretSummary: { apiKey: true },
      },
      validation: { status: 'ready', errors: [] },
    });
    expect(preview.body).not.toContain('sk-route-preview-secret');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().message).toBe('input 不能为空');
  });

  it('reports target validation and batch duplicates without returning secrets', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: {
        target: 'api_key',
        input: ['sk-duplicate-route-secret', 'sk-duplicate-route-secret'],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      duplicateCount: 1,
      batchFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidates: [
        { validation: { status: 'ready', target: 'api_key' } },
        { duplicateOfIndex: 0, validation: { status: 'ready', target: 'api_key' } },
      ],
    });
    expect(response.body).not.toContain('sk-duplicate-route-secret');

    const invalidTarget = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: { target: 'unknown', input: 'sk-secret' },
    });
    expect(invalidTarget.statusCode).toBe(400);
    expect(invalidTarget.json().message).toBe('target 无效');
  });

  it('rejects payloads larger than the preview limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: { input: `sk-${'x'.repeat(2 * 1024 * 1024)}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('2MB');
  });

  it('rejects promotion when the input no longer matches the preview fingerprint', async () => {
    const previewInput = {
      type: 'codex',
      access_token: 'same-route-access',
      refresh_token: 'same-route-refresh',
      email: 'before@example.com',
    };
    const preview = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: { target: 'native_oauth', input: previewInput },
    });
    expect(preview.statusCode).toBe(200);

    const promoted = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/promote',
      payload: {
        target: 'native_oauth',
        importJobId: preview.json().importJobId,
        batchFingerprint: preview.json().batchFingerprint,
        input: { ...previewInput, email: 'after@example.com' },
      },
    });

    expect(promoted.statusCode).toBe(400);
    expect(promoted.json().message).toContain('重新预览');
    expect(promoted.body).not.toContain('same-route-access');
    expect(promoted.body).not.toContain('same-route-refresh');
  });

  it('persists idempotent previews and exposes secret-free job details', async () => {
    const payload = {
      target: 'vault',
      idempotencyKey: 'route-preview-job-1',
      input: { api_key: 'route-persisted-secret', name: 'persisted preview' },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload,
    });

    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({
      importJobId: first.json().importJobId,
      deduplicated: true,
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/credential-imports/${first.json().importJobId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      success: true,
      job: {
        status: 'previewed',
        target: 'vault',
        items: [{ secretSummary: { apiKey: true }, status: 'previewed' }],
      },
    });
    expect(detail.body).not.toContain('route-persisted-secret');

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: { ...payload, input: { api_key: 'different-route-secret' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().message).toContain('幂等键');
    expect(conflict.body).not.toContain('different-route-secret');
  });

  it('writes successful import results to the shared credential audit query', async () => {
    const input = { api_key: 'sk-import-audit-secret', name: 'audit import' };
    const site = await db.insert(schema.sites).values({
      name: 'Import Audit Vault Site',
      url: 'https://import-audit-vault.example.com',
      platform: 'new-api',
    }).returning().get();
    const preview = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/preview',
      payload: { target: 'vault', siteId: site.id, operatorId: 'admin:import-audit', input },
    });
    expect(preview.statusCode, preview.body).toBe(200);

    const promoted = await app.inject({
      method: 'POST',
      url: '/api/credential-imports/promote',
      payload: {
        target: 'vault',
        siteId: site.id,
        operatorId: 'admin:import-audit',
        importJobId: preview.json().importJobId,
        batchFingerprint: preview.json().batchFingerprint,
        input,
      },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(promoted.json()).toMatchObject({ success: true, imported: 1, failed: 0 });

    const audits = await app.inject({
      method: 'GET',
      url: '/api/credential-lifecycle/audits?action=import&operatorId=admin%3Aimport-audit',
    });
    expect(audits.statusCode, audits.body).toBe(200);
    expect(audits.json()).toMatchObject({
      success: true,
      total: 1,
      items: [{
        action: 'import',
        operatorId: 'admin:import-audit',
        outcome: 'succeeded',
        metadata: expect.objectContaining({ importJobId: preview.json().importJobId }),
      }],
    });
    expect(audits.body).not.toContain('sk-import-audit-secret');
  });
});
