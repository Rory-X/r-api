import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('monitor routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-monitor-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./monitor.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.monitorRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('rejects malformed monitor config payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: {
        ldohCookie: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid ldohCookie. Expected string or null.',
    });

    const aihubResponse = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: { aihubCookie: 123 },
    });
    expect(aihubResponse.statusCode).toBe(400);
    expect(aihubResponse.json()).toMatchObject({
      success: false,
      message: 'Invalid aihubCookie. Expected string or null.',
    });
  });

  it('accepts null monitor cookie payloads and clears the stored cookie', async () => {
    const saveResponse = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: {
        ldohCookie: 'ld_auth_session=abcdefghijklmnopqrstuvwxyz',
      },
    });
    expect(saveResponse.statusCode).toBe(200);

    const clearResponse = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: {
        ldohCookie: null,
      },
    });

    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toMatchObject({
      success: true,
      ldohCookieConfigured: false,
    });

    const saved = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'monitor_ldoh_cookie'))
      .get();
    expect(saved?.value).toBe('""');
  });

  it('stores AIHub and LDOH OAuth cookies independently', async () => {
    const initial = await app.inject({ method: 'GET', url: '/api/monitor/config' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      ldohCookieConfigured: false,
      aihubCookieConfigured: false,
    });

    const aihubSaved = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: { aihubCookie: 'ld_auth_session=aihub-abcdefghijklmnopqrstuvwxyz' },
    });
    expect(aihubSaved.statusCode).toBe(200);
    expect(aihubSaved.json()).toMatchObject({
      success: true,
      ldohCookieConfigured: false,
      aihubCookieConfigured: true,
    });

    const ldohSaved = await app.inject({
      method: 'PUT',
      url: '/api/monitor/config',
      payload: { ldohCookie: 'ld_auth_session=ldoh-abcdefghijklmnopqrstuvwxyz' },
    });
    expect(ldohSaved.statusCode).toBe(200);
    expect(ldohSaved.json()).toMatchObject({
      success: true,
      ldohCookieConfigured: true,
      aihubCookieConfigured: true,
    });

    const aihub = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'monitor_aihub_cookie')).get();
    expect(aihub?.value).toBe('"ld_auth_session=aihub-abcdefghijklmnopqrstuvwxyz"');
  });
});
