import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('browser credential recovery routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-browser-recovery-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./browserCredentialRecovery.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.browserCredentialRecoveryRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.browserCredentialRecoveryTasks).run();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'route-browser-site',
      url: 'https://route-browser.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('creates an admin task and completes it through the public one-time handoff', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/browser-credential-tasks',
      payload: { siteId, mode: 'assisted', credentialName: 'route browser' },
    });
    expect(created.statusCode).toBe(200);
    const createdJson = created.json();
    expect(createdJson.task.status).toBe('pending');
    expect(createdJson.launchPath).toContain('/browser-credential-recovery#task=');

    const claimed = await app.inject({
      method: 'POST',
      url: '/api/browser-credential-tasks/public/claim',
      payload: {
        taskId: createdJson.task.id,
        token: createdJson.token,
        claimedBy: 'extension-test',
      },
    });
    expect(claimed.statusCode).toBe(200);
    const claimedJson = claimed.json();
    expect(claimedJson.task.status).toBe('claimed');
    expect(claimedJson.claimToken).toBeTruthy();

    const completed = await app.inject({
      method: 'POST',
      url: '/api/browser-credential-tasks/public/complete',
      payload: {
        taskId: createdJson.task.id,
        claimToken: claimedJson.claimToken,
        origin: 'https://route-browser.example.com',
        fields: [{ name: 'session_cookie', kind: 'cookie', value: 'sid=route-secret' }],
      },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      success: true,
      idempotent: false,
      task: { status: 'completed' },
      credential: { kind: 'browser_storage' },
    });

    const listed = await app.inject({ method: 'GET', url: '/api/browser-credential-tasks' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).not.toHaveProperty('taskTokenHash');
  });

  it('rejects a second claim with the consumed task token', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/browser-credential-tasks',
      payload: { siteId, mode: 'manual' },
    });
    const json = created.json();
    const first = await app.inject({
      method: 'POST',
      url: '/api/browser-credential-tasks/public/claim',
      payload: { taskId: json.task.id, token: json.token },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/browser-credential-tasks/public/claim',
      payload: { taskId: json.task.id, token: json.token },
    });
    expect(second.statusCode).toBe(400);
  });
});
