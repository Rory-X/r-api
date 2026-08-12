import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { extractClientIp, getAdminAuthContext, isIpAllowed } from '../../middleware/auth.js';
import { parseAuthChangePayload } from '../../contracts/supportRoutePayloads.js';
import {
  authenticateAdminSessionRequest,
  clearAdminSessionCookie,
  createAdminSession,
  replaceAdminCredential,
  revokeAllAdminSessionsExcept,
  revokeAdminSession,
  setAdminSessionSecondFactorVerified,
  setAdminSessionCookie,
  verifyAdminCredential,
} from '../../services/adminAuthService.js';
import {
  AdminTotpError,
  beginAdminTotpSetup,
  confirmAdminTotpSetup,
  createAdminLoginTotpChallenge,
  disableAdminTotp,
  getAdminTotpStatus,
  isAdminTotpEnabled,
  regenerateAdminRecoveryCodes,
  verifyAdminLoginTotpChallenge,
  verifyAndConsumeAdminSecondFactor,
} from '../../services/adminTotpService.js';

const MIN_ADMIN_CREDENTIAL_LENGTH = 12;
const MAX_ADMIN_CREDENTIAL_LENGTH = 1024;

const limitAdminLogin = createRateLimitGuard({
  bucket: 'admin-login',
  max: 5,
  windowMs: 60_000,
  message: '登录尝试过于频繁，请稍后再试',
});

const limitAdminTokenChange = createRateLimitGuard({
  bucket: 'auth-change',
  max: 3,
  windowMs: 60_000,
});

const limitAdminTotpVerify = createRateLimitGuard({
  bucket: 'admin-totp-verify',
  max: 10,
  windowMs: 60_000,
  message: '动态验证码尝试过于频繁，请稍后再试',
});

const limitAdminTotpManagement = createRateLimitGuard({
  bucket: 'admin-totp-management',
  max: 5,
  windowMs: 60_000,
});

function enforceAdminIpAllowlist(request: FastifyRequest, reply: FastifyReply): boolean {
  const clientIp = extractClientIp(request.ip);
  if (isIpAllowed(clientIp, config.adminIpAllowlist)) return true;
  reply.code(403).send({ error: 'IP not allowed' });
  return false;
}

function parseLoginCredential(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const value = typeof record.token === 'string'
    ? record.token
    : (typeof record.password === 'string' ? record.password : '');
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_ADMIN_CREDENTIAL_LENGTH) return null;
  return normalized;
}

function parseStringField(body: unknown, key: string, maxLength = 2048): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : '';
}

function requestClientMetadata(request: FastifyRequest): { clientIp: string; userAgent: string | null } {
  return {
    clientIp: extractClientIp(request.ip),
    userAgent: typeof request.headers['user-agent'] === 'string'
      ? request.headers['user-agent']
      : null,
  };
}

function requireAdminBrowserSession(request: FastifyRequest, reply: FastifyReply) {
  const context = getAdminAuthContext(request);
  if (context?.method === 'session') return context.session;
  reply.code(403).send({
    success: false,
    code: 'admin_browser_session_required',
    message: '此操作需要 WebUI 管理会话',
  });
  return null;
}

function sendTotpError(reply: FastifyReply, error: unknown) {
  if (error instanceof AdminTotpError) {
    return reply.code(error.statusCode).send({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>(
    '/api/auth/login',
    { preHandler: [limitAdminLogin] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!enforceAdminIpAllowlist(request, reply)) return;

      const credential = parseLoginCredential(request.body);
      if (!credential) {
        return reply.code(400).send({ success: false, message: '请输入管理员登录凭据' });
      }
      if (!await verifyAdminCredential(credential)) {
        return reply.code(401).send({ success: false, message: '管理员登录凭据无效' });
      }

      const client = requestClientMetadata(request);
      if (await isAdminTotpEnabled()) {
        const challenge = await createAdminLoginTotpChallenge(client);
        clearAdminSessionCookie(request, reply);
        return {
          success: true,
          authenticated: false,
          requiresTotp: true,
          challengeToken: challenge.challengeToken,
          expiresAt: challenge.expiresAt,
        };
      }

      const session = await createAdminSession({
        ...client,
      });
      setAdminSessionCookie(request, reply, session);
      return {
        success: true,
        authenticated: true,
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt,
        secondFactorVerified: session.secondFactorVerified,
      };
    },
  );

  app.post<{ Body: unknown }>(
    '/api/auth/totp/verify',
    { preHandler: [limitAdminTotpVerify] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      if (!enforceAdminIpAllowlist(request, reply)) return;
      const challengeToken = parseStringField(request.body, 'challengeToken');
      const code = parseStringField(request.body, 'code', 128);
      if (!challengeToken || !code) {
        return reply.code(400).send({ success: false, message: '请填写动态验证码或恢复码' });
      }
      try {
        const client = requestClientMetadata(request);
        const verified = await verifyAdminLoginTotpChallenge({
          challengeToken,
          code,
          ...client,
        });
        const now = new Date();
        const session = await createAdminSession({
          ...client,
          secondFactorVerifiedAt: now,
          now,
        });
        setAdminSessionCookie(request, reply, session);
        return {
          success: true,
          authenticated: true,
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          secondFactorVerified: true,
          secondFactorType: verified.type,
          recoveryCodesRemaining: verified.recoveryCodesRemaining,
        };
      } catch (error) {
        return sendTotpError(reply, error);
      }
    },
  );

  app.get('/api/auth/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!enforceAdminIpAllowlist(request, reply)) return;

    const session = await authenticateAdminSessionRequest(request);
    if (!session) {
      clearAdminSessionCookie(request, reply);
      return { authenticated: false };
    }
    return {
      authenticated: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      secondFactorVerified: session.secondFactorVerified,
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const context = getAdminAuthContext(request);
    if (context?.method === 'session') {
      await revokeAdminSession(context.session.id);
    }
    clearAdminSessionCookie(request, reply);
    return { success: true };
  });

  app.post<{ Body: unknown }>(
    '/api/settings/auth/change',
    { preHandler: [limitAdminTokenChange] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const parsedBody = parseAuthChangePayload(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send({ success: false, message: parsedBody.error });
      }

      const { oldToken, newToken } = parsedBody.data;
      if (!oldToken || !newToken) {
        return reply.code(400).send({ success: false, message: '请填写所有字段' });
      }
      if (newToken.length < MIN_ADMIN_CREDENTIAL_LENGTH) {
        return reply.code(400).send({
          success: false,
          message: `新登录凭据至少 ${MIN_ADMIN_CREDENTIAL_LENGTH} 个字符`,
        });
      }
      if (newToken.length > MAX_ADMIN_CREDENTIAL_LENGTH) {
        return reply.code(400).send({ success: false, message: '新登录凭据过长' });
      }
      if (!await verifyAdminCredential(oldToken)) {
        return reply.code(403).send({ success: false, message: '旧登录凭据验证失败' });
      }

      await replaceAdminCredential(newToken);
      clearAdminSessionCookie(request, reply);

      try {
        const createdAt = formatUtcSqlDateTime(new Date());
        await db.insert(schema.events).values({
          type: 'token',
          title: '管理员登录凭据已更新',
          message: '管理员登录凭据已修改，所有现有管理会话均已撤销。',
          level: 'warning',
          relatedType: 'settings',
          createdAt,
        }).run();
      } catch {}

      return {
        success: true,
        message: '登录凭据已更新，请重新登录',
        requiresLogin: true,
      };
    },
  );

  app.get('/api/settings/auth/info', async (_, reply) => {
    reply.header('cache-control', 'no-store');
    const totp = await getAdminTotpStatus();
    return {
      masked: '************',
      algorithm: 'argon2id',
      sessionTtlMs: config.adminSessionTtlMs,
      totp,
    };
  });

  app.post<{ Body: unknown }>(
    '/api/settings/auth/totp/setup',
    { preHandler: [limitAdminTotpManagement] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const session = requireAdminBrowserSession(request, reply);
      if (!session) return;
      const password = parseStringField(request.body, 'password', MAX_ADMIN_CREDENTIAL_LENGTH);
      if (!password || !await verifyAdminCredential(password)) {
        return reply.code(403).send({ success: false, message: '管理员登录凭据验证失败' });
      }
      try {
        const setup = await beginAdminTotpSetup({
          sessionId: session.id,
          ...requestClientMetadata(request),
        });
        return { success: true, ...setup };
      } catch (error) {
        return sendTotpError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    '/api/settings/auth/totp/confirm',
    { preHandler: [limitAdminTotpManagement] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const session = requireAdminBrowserSession(request, reply);
      if (!session) return;
      const setupToken = parseStringField(request.body, 'setupToken');
      const code = parseStringField(request.body, 'code', 128);
      if (!setupToken || !code) {
        return reply.code(400).send({ success: false, message: '请填写动态验证码' });
      }
      try {
        const confirmed = await confirmAdminTotpSetup(setupToken, code, {
          sessionId: session.id,
          ...requestClientMetadata(request),
        });
        await setAdminSessionSecondFactorVerified(session.id, true);
        await revokeAllAdminSessionsExcept(session.id);
        return {
          success: true,
          enabled: true,
          recoveryCodes: confirmed.recoveryCodes,
          recoveryCodesRemaining: confirmed.recoveryCodesRemaining,
        };
      } catch (error) {
        return sendTotpError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    '/api/settings/auth/totp/recovery-codes',
    { preHandler: [limitAdminTotpManagement] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const session = requireAdminBrowserSession(request, reply);
      if (!session) return;
      const password = parseStringField(request.body, 'password', MAX_ADMIN_CREDENTIAL_LENGTH);
      const code = parseStringField(request.body, 'code', 128);
      if (!password || !await verifyAdminCredential(password)) {
        return reply.code(403).send({ success: false, message: '管理员登录凭据验证失败' });
      }
      const verified = await verifyAndConsumeAdminSecondFactor(code);
      if (!verified.ok) {
        return reply.code(401).send({ success: false, message: '动态验证码或恢复码无效' });
      }
      try {
        const recoveryCodes = await regenerateAdminRecoveryCodes();
        await setAdminSessionSecondFactorVerified(session.id, true);
        await revokeAllAdminSessionsExcept(session.id);
        return {
          success: true,
          recoveryCodes,
          recoveryCodesRemaining: recoveryCodes.length,
        };
      } catch (error) {
        return sendTotpError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    '/api/settings/auth/totp/disable',
    { preHandler: [limitAdminTotpManagement] },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const session = requireAdminBrowserSession(request, reply);
      if (!session) return;
      const password = parseStringField(request.body, 'password', MAX_ADMIN_CREDENTIAL_LENGTH);
      const code = parseStringField(request.body, 'code', 128);
      if (!password || !await verifyAdminCredential(password)) {
        return reply.code(403).send({ success: false, message: '管理员登录凭据验证失败' });
      }
      const verified = await verifyAndConsumeAdminSecondFactor(code);
      if (!verified.ok) {
        return reply.code(401).send({ success: false, message: '动态验证码或恢复码无效' });
      }
      await disableAdminTotp();
      await setAdminSessionSecondFactorVerified(session.id, false);
      await revokeAllAdminSessionsExcept(session.id);
      return { success: true, enabled: false };
    },
  );
}
