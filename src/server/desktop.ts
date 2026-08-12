import type { FastifyInstance } from 'fastify';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';

export function isPublicApiRoute(url: string): boolean {
  const path = String(url || '').split('?')[0];
  return path === DESKTOP_HEALTH_ROUTE
    || path === '/api/auth/login'
    || path === '/api/auth/session'
    || path === '/api/auth/totp/verify'
    || path.startsWith('/api/oauth/callback/')
    || path.startsWith('/api/browser-credential-tasks/public/')
    || path.startsWith('/api/interaction-adapters/public/')
    || path.startsWith('/api/local-connector/public/');
}

export async function registerDesktopRoutes(app: FastifyInstance) {
  app.get(DESKTOP_HEALTH_ROUTE, async () => ({ ok: true }));
}
