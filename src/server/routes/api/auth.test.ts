import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import * as OTPAuth from 'otpauth';

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

type LoginResult = {
  cookie: string;
  csrfToken: string;
  expiresAt: string;
};

describe('auth routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let resetRequestRateLimitStore: () => void;
  let resetAdminBearerFailureStore: () => void;
  let ensureAdminAuthReady: () => Promise<string>;
  let dataDir = '';
  let originalDataDir: string | undefined;
  let originalAuthToken = '';
  let originalAuthTokenHash = '';
  let originalBootstrapConfigured = false;
  let originalBootstrapRequired = false;
  let originalAdminIpAllowlist: string[] = [];
  let originalAccountCredentialSecret = '';

  async function login(token = 'secret-token'): Promise<LoginResult> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'][0]
      : response.headers['set-cookie'];
    expect(setCookie).toBeTruthy();
    return {
      cookie: String(setCookie).split(';')[0],
      csrfToken: body.csrfToken,
      expiresAt: body.expiresAt,
    };
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-auth-routes-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const configModule = await import('../../config.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./auth.js');
    const middlewareModule = await import('../../middleware/auth.js');
    const adminAuthModule = await import('../../services/adminAuthService.js');
    const desktopModule = await import('../../desktop.js');
    const rateLimitModule = await import('../../middleware/requestRateLimit.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    resetRequestRateLimitStore = rateLimitModule.resetRequestRateLimitStore;
    resetAdminBearerFailureStore = middlewareModule.resetAdminBearerFailureStore;
    ensureAdminAuthReady = adminAuthModule.ensureAdminAuthReady;
    originalAuthToken = config.authToken;
    originalAuthTokenHash = config.authTokenHash;
    originalBootstrapConfigured = config.adminCredentialBootstrapConfigured;
    originalBootstrapRequired = config.adminCredentialBootstrapRequired;
    originalAdminIpAllowlist = [...config.adminIpAllowlist];
    originalAccountCredentialSecret = config.accountCredentialSecret;

    app = Fastify();
    await app.register(cookie);
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/api/') && !desktopModule.isPublicApiRoute(request.url)) {
        await middlewareModule.authMiddleware(request, reply);
      }
    });
    await app.register(routesModule.authRoutes);
  });

  beforeEach(async () => {
    resetRequestRateLimitStore();
    resetAdminBearerFailureStore();
    config.authToken = 'secret-token';
    config.authTokenHash = '';
    config.adminCredentialBootstrapConfigured = true;
    config.adminCredentialBootstrapRequired = false;
    config.adminIpAllowlist = [];
    config.accountCredentialSecret = 'auth-route-totp-root-secret-0123456789abcdef';
    await db.delete(schema.adminAuthChallenges).run();
    await db.delete(schema.adminSessions).run();
    await db.delete(schema.adminTotpConfigs).run();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
  });

  afterAll(async () => {
    config.authToken = originalAuthToken;
    config.authTokenHash = originalAuthTokenHash;
    config.adminCredentialBootstrapConfigured = originalBootstrapConfigured;
    config.adminCredentialBootstrapRequired = originalBootstrapRequired;
    config.adminIpAllowlist = originalAdminIpAllowlist;
    config.accountCredentialSecret = originalAccountCredentialSecret;
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('creates an HttpOnly session and stores only Argon2id/hash material', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: true,
      csrfToken: expect.stringMatching(/^mac_/),
      expiresAt: expect.any(String),
    });
    expect(String(response.headers['set-cookie'])).toContain('metapi_admin_session=');
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(response.headers['set-cookie'])).toContain('SameSite=Strict');

    const passwordHash = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'admin_password_hash'))
      .get();
    expect(passwordHash?.value).toContain('$argon2id$');
    expect(passwordHash?.value).not.toContain('secret-token');

    const storedSession = await db.select().from(schema.adminSessions).get();
    expect(storedSession?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession?.tokenHash).not.toContain('mas_');
  });

  it('restores session metadata from the HttpOnly cookie', async () => {
    const session = await login();
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: session.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      authenticated: true,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      secondFactorVerified: false,
    });
  });

  it('requires the session CSRF token for mutations', async () => {
    const session = await login();
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      headers: { cookie: session.cookie },
      payload: { oldToken: 'secret-token', newToken: 'new-secret-token-123' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json()).toMatchObject({ code: 'admin_csrf_invalid' });

    const changed = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      headers: {
        cookie: session.cookie,
        'x-metapi-csrf': session.csrfToken,
      },
      payload: { oldToken: 'secret-token', newToken: 'new-secret-token-123' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ success: true, requiresLogin: true });

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: session.cookie },
    });
    expect(revoked.json()).toEqual({ authenticated: false });

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'new-secret-token-123' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('keeps explicit Bearer admin calls compatible without CSRF', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/auth/info',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ algorithm: 'argon2id' });
  });

  it('migrates the legacy plaintext auth_token setting on first verification', async () => {
    config.authToken = 'different-bootstrap-token';
    await db.insert(schema.settings).values({
      key: 'auth_token',
      value: JSON.stringify('legacy-secret-token'),
    }).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'legacy-secret-token' },
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.select().from(schema.settings).all();
    expect(rows.some((row) => row.key === 'auth_token')).toBe(false);
    expect(rows.find((row) => row.key === 'admin_password_hash')?.value).toContain('$argon2id$');
  });

  it('fails closed on first startup when no administrator bootstrap credential is configured', async () => {
    config.adminCredentialBootstrapConfigured = false;
    config.adminCredentialBootstrapRequired = true;

    await expect(ensureAdminAuthReady()).rejects.toThrow(
      'set AUTH_TOKEN or AUTH_TOKEN_HASH for the first startup',
    );
    expect(await db.select().from(schema.settings).all()).toEqual([]);
  });

  it('rate limits repeated invalid administrator Bearer credentials per resolved client IP', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/settings/auth/info',
        remoteAddress: '203.0.113.21',
        headers: { authorization: `Bearer invalid-${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: 'GET',
      url: '/api/settings/auth/info',
      remoteAddress: '203.0.113.21',
      headers: { authorization: 'Bearer invalid-final' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    expect(limited.json()).toMatchObject({ code: 'admin_auth_rate_limited' });
  });

  it('does not let untrusted forwarded headers bypass login rate limits or the IP allowlist', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.31',
        headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` },
        payload: { token: `invalid-login-${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.31',
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { token: 'invalid-login-final' },
    });
    expect(limited.statusCode).toBe(429);

    resetRequestRateLimitStore();
    config.adminIpAllowlist = ['203.0.113.99'];
    const spoofedAllowlist = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.31',
      headers: { 'x-forwarded-for': '203.0.113.99' },
      payload: { token: 'secret-token' },
    });
    expect(spoofedAllowlist.statusCode).toBe(403);
  });

  it('supports TOTP setup, login challenge, recovery-code rotation and disable end to end', async () => {
    const primary = await login();
    const secondary = await login();
    const protectedHeaders = {
      cookie: primary.cookie,
      'x-metapi-csrf': primary.csrfToken,
    };

    const setupResponse = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/totp/setup',
      headers: protectedHeaders,
      payload: { password: 'secret-token' },
    });
    expect(setupResponse.statusCode).toBe(200);
    const setup = setupResponse.json() as {
      setupToken: string;
      secret: string;
      otpauthUrl: string;
    };
    expect(setup.setupToken).toMatch(/^mat_/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');

    const totp = new OTPAuth.TOTP({
      issuer: 'r-api',
      label: 'administrator',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(setup.secret),
    });
    const confirmResponse = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/totp/confirm',
      headers: protectedHeaders,
      payload: {
        setupToken: setup.setupToken,
        code: totp.generate(),
      },
    });
    expect(confirmResponse.statusCode).toBe(200);
    const confirmed = confirmResponse.json() as { recoveryCodes: string[] };
    expect(confirmed.recoveryCodes).toHaveLength(10);

    const primarySession = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: primary.cookie },
    });
    expect(primarySession.json()).toMatchObject({
      authenticated: true,
      secondFactorVerified: true,
    });
    const revokedSecondary = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: secondary.cookie },
    });
    expect(revokedSecondary.json()).toEqual({ authenticated: false });

    const passwordStep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'user-agent': 'totp-route-client' },
      payload: { token: 'secret-token' },
    });
    expect(passwordStep.statusCode).toBe(200);
    const challenge = passwordStep.json() as {
      authenticated: false;
      requiresTotp: true;
      challengeToken: string;
    };
    expect(challenge).toMatchObject({ authenticated: false, requiresTotp: true });

    const secondFactorStep = await app.inject({
      method: 'POST',
      url: '/api/auth/totp/verify',
      headers: { 'user-agent': 'totp-route-client' },
      payload: {
        challengeToken: challenge.challengeToken,
        code: totp.generate({ timestamp: Date.now() + 30_000 }),
      },
    });
    expect(secondFactorStep.statusCode).toBe(200);
    expect(secondFactorStep.json()).toMatchObject({
      authenticated: true,
      secondFactorVerified: true,
      secondFactorType: 'totp',
    });

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/totp/recovery-codes',
      headers: protectedHeaders,
      payload: {
        password: 'secret-token',
        code: confirmed.recoveryCodes[0],
      },
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedCodes = (rotated.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(rotatedCodes).toHaveLength(10);
    expect(rotatedCodes).not.toEqual(confirmed.recoveryCodes);

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/totp/disable',
      headers: protectedHeaders,
      payload: {
        password: 'secret-token',
        code: rotatedCodes[0],
      },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ success: true, enabled: false });

    resetRequestRateLimitStore();
    const directLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'secret-token' },
    });
    expect(directLogin.statusCode).toBe(200);
    expect(directLogin.json()).toMatchObject({ authenticated: true, secondFactorVerified: false });
  });

  it('rejects malformed auth change payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      headers: { authorization: 'Bearer secret-token' },
      payload: {
        oldToken: 'secret-token',
        newToken: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid newToken. Expected string.',
    });
  });
});
