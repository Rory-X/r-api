import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('credential lifecycle routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-lifecycle-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routes = await import('./credentialLifecycle.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routes.credentialLifecycleRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.credentialLifecycleAudits).run();
    await db.delete(schema.credentialRefreshJobs).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Lifecycle Route Site',
      url: 'https://lifecycle-route.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'lifecycle-route-user',
      accessToken: 'lifecycle-route-secret',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();
    accountId = account.id;
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('lists secret-free lifecycle records and applies batch disable', async () => {
    const listed = await app.inject({ method: 'GET', url: '/api/credential-lifecycle' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      success: true,
      items: [{
        entityType: 'account',
        entityId: accountId,
        status: 'active',
        refreshOwner: 'external',
      }],
    });
    expect(listed.body).not.toContain('lifecycle-route-secret');

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/credential-lifecycle/actions',
      payload: {
        action: 'disable',
        items: [{ entityType: 'account', entityId: accountId }],
        operatorId: 'admin:route-test',
        source: 'webui',
      },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json()).toMatchObject({
      success: true,
      succeeded: 1,
      failed: 0,
      items: [{ success: true, status: 'disabled' }],
    });

    const audits = await app.inject({
      method: 'GET',
      url: '/api/credential-lifecycle/audits?source=native&operatorId=admin%3Aroute-test&status=disabled',
    });
    expect(audits.statusCode, audits.body).toBe(200);
    expect(audits.json()).toMatchObject({
      success: true,
      total: 1,
      items: [{
        entityType: 'account',
        entityId: accountId,
        credentialSource: 'native',
        operatorId: 'admin:route-test',
        action: 'disable',
        status: 'disabled',
        outcome: 'succeeded',
      }],
    });

    const policy = await app.inject({ method: 'GET', url: '/api/credential-lifecycle/policy' });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json()).toMatchObject({
      success: true,
      policy: { automaticRemindersEnabled: true, retryMaxAttempts: 8 },
    });
  });
});
