import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isPublicApiRoute, registerDesktopRoutes } from './desktop.js';

describe('desktop server routes', () => {
  it('marks only explicit bootstrap/callback routes as public', () => {
    expect(isPublicApiRoute('/api/desktop/health')).toBe(true);
    expect(isPublicApiRoute('/api/auth/login')).toBe(true);
    expect(isPublicApiRoute('/api/auth/session?refresh=1')).toBe(true);
    expect(isPublicApiRoute('/api/auth/logout')).toBe(false);
    expect(isPublicApiRoute('/api/local-connector/public/heartbeat')).toBe(true);
    expect(isPublicApiRoute('/api/local-connector/devices')).toBe(false);
    expect(isPublicApiRoute('/api/stats/dashboard')).toBe(false);
  });

  it('registers a public desktop health probe', async () => {
    const app = Fastify();
    await registerDesktopRoutes(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/desktop/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
