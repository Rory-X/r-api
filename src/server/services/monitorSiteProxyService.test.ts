import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./monitorSiteProxyService.js');

describe('monitor site proxy service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-monitor-site-proxy-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./monitorSiteProxyService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('stores isolated LinuxDo sessions for LDOH and AIHub', async () => {
    await service.saveMonitorSiteCookie('ldoh-105117', 'ld_auth_session=ldoh-abcdefghijklmnopqrstuvwxyz');
    await service.saveMonitorSiteCookie('aihub-top', 'other=ignored; ld_auth_session=aihub-abcdefghijklmnopqrstuvwxyz');

    await expect(service.getMonitorCookieConfig()).resolves.toMatchObject({
      ldohCookieConfigured: true,
      aihubCookieConfigured: true,
    });
    const ldoh = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'monitor_ldoh_cookie')).get();
    const aihub = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'monitor_aihub_cookie')).get();
    expect(ldoh?.value).toBe('"ld_auth_session=ldoh-abcdefghijklmnopqrstuvwxyz"');
    expect(aihub?.value).toBe('"ld_auth_session=aihub-abcdefghijklmnopqrstuvwxyz"');
  });

  it('rewrites each site through its own proxy while preserving external OAuth redirects', () => {
    expect(service.rewriteMonitorProxyText(
      'ldoh-105117',
      '<script src="/_next/app.js"></script><a href="/console">console</a>',
    )).toContain('href="/monitor-proxy/ldoh/console"');
    expect(service.rewriteMonitorProxyText(
      'aihub-top',
      '<script src="/_next/app.js"></script><a href="/console">console</a>',
    )).toContain('src="/monitor-proxy/aihub/_next/app.js"');
    expect(service.rewriteMonitorLocation(
      'aihub-top',
      'https://connect.linux.do/oauth2/authorize',
    )).toBe('https://connect.linux.do/oauth2/authorize');
    expect(service.rewriteMonitorLocation('aihub-top', '/console')).toBe('/monitor-proxy/aihub/console');
  });

  it('forwards the AIHub session cookie through the shared proxy flow', async () => {
    await service.saveMonitorSiteCookie('aihub-top', 'ld_auth_session=aihub-abcdefghijklmnopqrstuvwxyz');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      '<a href="/console">console</a>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await service.executeMonitorProxyRequest('aihub-top', {
      requestUrl: '/monitor-proxy/aihub/',
      query: { view: 'full' },
      method: 'GET',
      headers: {},
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://aihub.top/?view=full');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ cookie: 'ld_auth_session=aihub-abcdefghijklmnopqrstuvwxyz' }),
      redirect: 'manual',
    });
    expect(response.body).toContain('href="/monitor-proxy/aihub/console"');
  });
});
