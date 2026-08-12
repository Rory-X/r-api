import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./browserCredentialRecoveryService.js');

describe('browser credential recovery service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-browser-recovery-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./browserCredentialRecoveryService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.browserCredentialRecoveryTasks).run();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'browser-site',
      url: 'https://browser.example.com/panel',
      homepageUrl: 'https://home.example.com/login',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('creates a contract-bound task and only exposes a one-time launch token', async () => {
    const created = await service.createBrowserRecoveryTask({
      siteId,
      mode: 'assisted',
      credentialName: 'browser session',
      ttlSec: 120,
    });

    expect(created.task).toMatchObject({
      siteId,
      mode: 'assisted',
      status: 'pending',
      credentialKind: 'browser_storage',
      targetUrl: 'https://home.example.com/login',
      targetOrigin: 'https://home.example.com',
    });
    expect(created.task.fields).toEqual([
      { name: 'session_cookie', kind: 'cookie', required: true, capture: { strategy: 'cookie_header' } },
      {
        name: 'user_id',
        kind: 'local_storage',
        required: false,
        capture: { strategy: 'json_path', key: 'user', path: ['id'] },
      },
    ]);
    expect(created.launchPath).toContain(created.task.id);
    expect(created.token.length).toBeGreaterThan(32);
    expect(created.task).not.toHaveProperty('taskTokenHash');

    const stored = await db.select().from(schema.browserCredentialRecoveryTasks).get();
    expect(stored?.taskTokenHash).toBeTruthy();
    expect(stored?.taskTokenHash).not.toBe(created.token);
    expect(JSON.parse(stored?.contractSnapshot || '{}').runtime).toMatchObject({
      kind: 'session_token',
      field: 'session_cookie',
      platformUserIdField: 'user_id',
    });
  });

  it('claims once, completes atomically, and supports idempotent completion', async () => {
    const created = await service.createBrowserRecoveryTask({ siteId, mode: 'manual' });
    const claimed = await service.claimBrowserRecoveryTask(created.task.id, created.token, 'test-connector');
    expect(claimed.task.status).toBe('claimed');
    expect(claimed.claimToken).not.toBe(created.token);

    await expect(service.claimBrowserRecoveryTask(created.task.id, created.token)).rejects.toThrow('已领取');

    const completed = await service.completeBrowserRecoveryTask({
      taskId: created.task.id,
      claimToken: claimed.claimToken,
      origin: 'https://home.example.com',
      fields: [{ name: 'session_cookie', kind: 'cookie', value: 'sid=browser-secret' }],
      username: 'alice',
    });
    expect(completed.idempotent).toBe(false);
    expect(completed.task.status).toBe('completed');
    expect(completed.credential.kind).toBe('browser_storage');
    expect(completed.credential).not.toHaveProperty('ciphertext');

    const stored = await db.select().from(schema.credentialVaultItems).get();
    expect(stored?.ciphertext).toBeTruthy();
    expect(stored?.ciphertext).not.toContain('browser-secret');

    const repeated = await service.completeBrowserRecoveryTask({
      taskId: created.task.id,
      claimToken: claimed.claimToken,
      origin: 'https://home.example.com',
      fields: [{ name: 'session_cookie', kind: 'cookie', value: 'sid=browser-secret' }],
    });
    expect(repeated.idempotent).toBe(true);
    expect(repeated.credential.id).toBe(completed.credential.id);
    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(1);
  });

  it('rejects origins and fields outside the adapter contract', async () => {
    const created = await service.createBrowserRecoveryTask({ siteId, mode: 'managed' });
    const claimed = await service.claimBrowserRecoveryTask(created.task.id, created.token);

    await expect(service.completeBrowserRecoveryTask({
      taskId: created.task.id,
      claimToken: claimed.claimToken,
      origin: 'https://evil.example.net',
      fields: [{ name: 'session_cookie', kind: 'cookie', value: 'sid=x' }],
    })).rejects.toThrow('白名单');

    await expect(service.completeBrowserRecoveryTask({
      taskId: created.task.id,
      claimToken: claimed.claimToken,
      origin: 'https://home.example.com',
      fields: [{ name: 'unknown', kind: 'cookie', value: 'x' }],
    })).rejects.toThrow('未声明');
  });

  it('expires pending tasks and refuses expired tokens', async () => {
    const created = await service.createBrowserRecoveryTask({ siteId, mode: 'manual', ttlSec: 30 });
    await db.update(schema.browserCredentialRecoveryTasks).set({
      expiresAt: '2020-01-01T00:00:00.000Z',
    }).where((await import('drizzle-orm')).eq(schema.browserCredentialRecoveryTasks.id, created.task.id)).run();

    expect(await service.expireBrowserRecoveryTasks('2021-01-01T00:00:00.000Z')).toBe(1);
    const rows = await service.listBrowserRecoveryTasks({ status: 'expired' });
    expect(rows).toHaveLength(1);
    await expect(service.claimBrowserRecoveryTask(created.task.id, created.token)).rejects.toThrow('已过期');
  });

  it('falls back to the request address when no homepage is configured', async () => {
    await db.update(schema.sites).set({ homepageUrl: null }).run();

    const created = await service.createBrowserRecoveryTask({ siteId, mode: 'manual' });

    expect(created.task.targetUrl).toBe('https://browser.example.com/panel');
    expect(created.task.targetOrigin).toBe('https://browser.example.com');
  });

  it('cancels a claimed task without creating a vault item', async () => {
    const created = await service.createBrowserRecoveryTask({ siteId, mode: 'manual' });
    await service.claimBrowserRecoveryTask(created.task.id, created.token);
    expect(await service.cancelBrowserRecoveryTask(created.task.id)).toBe(true);
    expect((await service.listBrowserRecoveryTasks({ status: 'cancelled' }))[0]?.status).toBe('cancelled');
    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(0);
  });
});
