import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { extractClientIp, isIpAllowed } from '../../middleware/auth.js';
import { parseMonitorConfigPayload } from '../../contracts/supportRoutePayloads.js';
import { authenticateAdminSessionRequest } from '../../services/adminAuthService.js';
import {
  MissingMonitorCookieError,
  executeMonitorProxyRequest,
  getMonitorCookieConfig,
  saveMonitorSiteCookie,
  type AuthenticatedMonitorSiteId,
} from '../../services/monitorSiteProxyService.js';

const limitMonitorConfigRead = createRateLimitGuard({
  bucket: 'monitor-config-read',
  max: 30,
  windowMs: 60_000,
});

const limitMonitorConfigWrite = createRateLimitGuard({
  bucket: 'monitor-config-write',
  max: 10,
  windowMs: 60_000,
});

const limitMonitorSession = createRateLimitGuard({
  bucket: 'monitor-session',
  max: 10,
  windowMs: 60_000,
});

const limitMonitorProxy = createRateLimitGuard({
  bucket: 'monitor-proxy',
  max: 60,
  windowMs: 60_000,
});

async function ensureMonitorAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const clientIp = extractClientIp(request.ip);
  if (!isIpAllowed(clientIp, config.adminIpAllowlist)) {
    reply.code(403).send({ error: 'IP not allowed' });
    return false;
  }
  if (!await authenticateAdminSessionRequest(request)) {
    reply.code(401).send({ error: 'Missing or invalid monitor session' });
    return false;
  }
  return true;
}

function createMonitorProxyHandler(siteId: AuthenticatedMonitorSiteId) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!await ensureMonitorAuth(request, reply)) return;
    try {
      const result = await executeMonitorProxyRequest(siteId, {
        requestUrl: String(request.url || ''),
        wildcardPath: String((request.params as Record<string, unknown>)['*'] || ''),
        query: request.query as Record<string, unknown>,
        method: request.method,
        headers: {
          accept: request.headers.accept ? String(request.headers.accept) : undefined,
          acceptLanguage: request.headers['accept-language'] ? String(request.headers['accept-language']) : undefined,
          userAgent: request.headers['user-agent'] ? String(request.headers['user-agent']) : undefined,
          contentType: request.headers['content-type'] ? String(request.headers['content-type']) : undefined,
          referer: request.headers.referer ? String(request.headers.referer) : undefined,
        },
        body: request.body,
      });
      if (result.location) reply.header('location', result.location);
      if (result.contentType) reply.header('content-type', result.contentType);
      if (result.cacheControl) reply.header('cache-control', result.cacheControl);
      return reply.code(result.status).send(result.body);
    } catch (error) {
      if (error instanceof MissingMonitorCookieError) {
        return reply.code(409).send({ error: error.message });
      }
      return reply.code(502).send({
        error: error instanceof Error ? error.message : 'Monitor proxy request failed',
      });
    }
  };
}

export async function monitorRoutes(app: FastifyInstance) {
  app.get('/api/monitor/config', { preHandler: [limitMonitorConfigRead] }, async () => {
    return await getMonitorCookieConfig();
  });

  app.put<{ Body: unknown }>(
    '/api/monitor/config',
    { preHandler: [limitMonitorConfigWrite] },
    async (request, reply) => {
      const parsedBody = parseMonitorConfigPayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: parsedBody.error });
      }

      const updates: Array<Promise<unknown>> = [];
      if (Object.prototype.hasOwnProperty.call(parsedBody.data, 'ldohCookie')) {
        updates.push(saveMonitorSiteCookie('ldoh-105117', parsedBody.data.ldohCookie));
      }
      if (Object.prototype.hasOwnProperty.call(parsedBody.data, 'aihubCookie')) {
        updates.push(saveMonitorSiteCookie('aihub-top', parsedBody.data.aihubCookie));
      }
      if (updates.length === 0) {
        return reply.code(400).send({ success: false, message: '未提供监控站点 Cookie' });
      }

      try {
        await Promise.all(updates);
        return { success: true, ...(await getMonitorCookieConfig()) };
      } catch (error) {
        return reply.code(400).send({
          success: false,
          message: error instanceof Error ? error.message : '保存监控站点 Cookie 失败',
        });
      }
    },
  );

  app.post('/api/monitor/session', { preHandler: [limitMonitorSession] }, async () => {
    return { success: true };
  });

  const handleLdohProxy = createMonitorProxyHandler('ldoh-105117');
  const handleAihubProxy = createMonitorProxyHandler('aihub-top');

  app.all('/monitor-proxy/ldoh', { preHandler: [limitMonitorProxy] }, handleLdohProxy);
  app.all('/monitor-proxy/ldoh/', { preHandler: [limitMonitorProxy] }, handleLdohProxy);
  app.all('/monitor-proxy/ldoh/*', { preHandler: [limitMonitorProxy] }, handleLdohProxy);
  app.all('/monitor-proxy/aihub', { preHandler: [limitMonitorProxy] }, handleAihubProxy);
  app.all('/monitor-proxy/aihub/', { preHandler: [limitMonitorProxy] }, handleAihubProxy);
  app.all('/monitor-proxy/aihub/*', { preHandler: [limitMonitorProxy] }, handleAihubProxy);
}
