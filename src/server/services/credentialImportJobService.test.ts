import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type JobModule = typeof import('./credentialImportJobService.js');

describe('credential import job service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let jobs: JobModule;
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-import-jobs-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    jobs = await import('./credentialImportJobService.js');
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
      name: 'Credential Import Job Site',
      url: 'https://credential-import-job.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists only secret-free preview metadata and deduplicates by request key', async () => {
    const rawSecret = 'sk-job-preview-secret';
    const first = await jobs.createCredentialImportPreviewJob({
      input: { api_key: rawSecret, name: 'preview key' },
      target: 'vault',
      siteId,
      operatorId: 'webui:tester',
      idempotencyKey: 'preview-job-1',
    });
    const second = await jobs.createCredentialImportPreviewJob({
      input: { api_key: rawSecret, name: 'preview key' },
      target: 'vault',
      siteId,
      operatorId: 'webui:tester',
      idempotencyKey: 'preview-job-1',
    });

    expect(second).toMatchObject({ importJobId: first.importJobId, deduplicated: true });
    const job = await jobs.getCredentialImportJob(first.importJobId);
    expect(job).toMatchObject({
      status: 'previewed',
      target: 'vault',
      operatorId: 'webui:tester',
      items: [{
        identity: {},
        secretSummary: { apiKey: true },
        compatibleTargets: ['api_key', 'new_api', 'sub2api', 'vault'],
        status: 'previewed',
      }],
    });

    const persisted = JSON.stringify({
      jobs: await db.select().from(schema.credentialImportJobs).all(),
      items: await db.select().from(schema.credentialImportItems).all(),
    });
    expect(persisted).not.toContain(rawSecret);

    await expect(jobs.createCredentialImportPreviewJob({
      input: { api_key: 'sk-job-preview-different' },
      target: 'vault',
      siteId,
      operatorId: 'webui:tester',
      idempotencyKey: 'preview-job-1',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('executes a job once, persists provenance, and replays its result on retry', async () => {
    const rawSecret = 'sk-job-execution-secret';
    const preview = await jobs.createCredentialImportPreviewJob({
      input: { api_key: rawSecret, name: 'execution key' },
      target: 'vault',
      siteId,
      operatorId: 'webui:tester',
      idempotencyKey: 'execute-job-1',
    });

    const first = await jobs.executeCredentialImportJob({
      importJobId: preview.importJobId,
      input: { api_key: rawSecret, name: 'execution key' },
      target: 'vault',
      siteId,
      batchFingerprint: preview.batchFingerprint,
      operatorId: 'webui:tester',
    });
    expect(first).toMatchObject({
      importJobId: preview.importJobId,
      deduplicated: false,
      jobStatus: 'completed',
      imported: 1,
      failed: 0,
    });

    const second = await jobs.executeCredentialImportJob({
      importJobId: preview.importJobId,
      input: { api_key: rawSecret, name: 'execution key' },
      target: 'vault',
      siteId,
      batchFingerprint: preview.batchFingerprint,
      operatorId: 'webui:tester',
    });
    expect(second).toMatchObject({
      importJobId: preview.importJobId,
      deduplicated: true,
      jobStatus: 'completed',
      imported: 1,
      failed: 0,
    });

    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(1);
    const provenance = await db.select().from(schema.credentialImportProvenance).all();
    expect(provenance).toMatchObject([{
      jobId: preview.importJobId,
      targetEntityType: 'vault_item',
      targetEntityId: first.items[0]?.vaultItemIds?.[0],
      sourceFormat: 'api_key',
      operatorId: 'webui:tester',
      conflictPolicy: 'skip',
      importAction: 'imported',
    }]);
    const detail = await jobs.getCredentialImportJob(preview.importJobId);
    expect(detail).toMatchObject({
      status: 'completed',
      imported: 1,
      items: [{ status: 'imported', vaultItemIds: expect.any(Array) }],
    });
    expect(JSON.stringify({ provenance, detail })).not.toContain(rawSecret);
  });

  it('rejects changed execution input without consuming the preview job', async () => {
    const original = { api_key: 'sk-job-original-secret' };
    const preview = await jobs.createCredentialImportPreviewJob({
      input: original,
      target: 'vault',
      siteId,
    });

    await expect(jobs.executeCredentialImportJob({
      importJobId: preview.importJobId,
      input: { api_key: 'sk-job-changed-secret' },
      target: 'vault',
      siteId,
      batchFingerprint: preview.batchFingerprint,
    })).rejects.toThrow('凭证输入已变化');

    expect(await jobs.getCredentialImportJob(preview.importJobId)).toMatchObject({
      status: 'previewed',
    });
    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(0);
  });
});
