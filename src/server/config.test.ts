import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildConfig, buildFastifyOptions } from './config.js';

describe('buildConfig', () => {
  it('defaults to external listen host for server deployments', () => {
    const config = buildConfig({});

    expect(config.demoMode).toBe(false);
    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe('./data');
  });

  it('enables the public read-only demo mode only when explicitly configured', () => {
    expect(buildConfig({ DEMO_MODE: 'true' }).demoMode).toBe(true);
    expect(buildConfig({ DEMO_MODE: 'false' }).demoMode).toBe(false);
  });

  it('aligns desktop deployments with server deployments for listen host', () => {
    const config = buildConfig({
      HOST: '0.0.0.0',
      METAPI_DESKTOP: '1',
      PORT: '4312',
      DATA_DIR: '/tmp/metapi-data',
    });

    expect(config.listenHost).toBe('0.0.0.0');
    expect(config.port).toBe(4312);
    expect(config.dataDir).toBe('/tmp/metapi-data');
  });

  it('honors explicit loopback host outside desktop mode', () => {
    const config = buildConfig({
      HOST: '127.0.0.1',
    });

    expect(config.listenHost).toBe('127.0.0.1');
  });

  it('keeps upstream connections warm and enables dual-stack fallback by default', () => {
    const defaults = buildConfig({});
    expect(defaults).toMatchObject({
      upstreamHttp2Enabled: true,
      upstreamHttpConnectionsPerOrigin: 100,
      upstreamHttpKeepAliveTimeoutMs: 90_000,
      upstreamHttpKeepAliveMaxTimeoutMs: 600_000,
      upstreamHttpAutoSelectFamily: true,
      upstreamHttpAutoSelectFamilyAttemptTimeoutMs: 250,
    });

    const overridden = buildConfig({
      UPSTREAM_HTTP2_ENABLED: 'false',
      UPSTREAM_HTTP_CONNECTIONS_PER_ORIGIN: '24',
      UPSTREAM_HTTP_KEEP_ALIVE_TIMEOUT_MS: '45000',
      UPSTREAM_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS: '120000',
      UPSTREAM_HTTP_AUTO_SELECT_FAMILY: 'false',
      UPSTREAM_HTTP_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS: '100',
    });
    expect(overridden).toMatchObject({
      upstreamHttp2Enabled: false,
      upstreamHttpConnectionsPerOrigin: 24,
      upstreamHttpKeepAliveTimeoutMs: 45_000,
      upstreamHttpKeepAliveMaxTimeoutMs: 120_000,
      upstreamHttpAutoSelectFamily: false,
      upstreamHttpAutoSelectFamilyAttemptTimeoutMs: 100,
    });
  });

  it('keeps all active inference probes disabled unless explicitly enabled', () => {
    expect(buildConfig({})).toMatchObject({
      modelAvailabilityProbeEnabled: false,
      channelRecoveryProbeEnabled: false,
    });
    expect(buildConfig({
      MODEL_AVAILABILITY_PROBE_ENABLED: 'true',
      CHANNEL_RECOVERY_PROBE_ENABLED: 'true',
    })).toMatchObject({
      modelAvailabilityProbeEnabled: true,
      channelRecoveryProbeEnabled: true,
    });
  });

  it('normalizes administrator session security settings', () => {
    const config = buildConfig({
      AUTH_TOKEN: 'explicit-admin-credential',
      AUTH_TOKEN_HASH: '$argon2id$v=19$m=19456,t=2,p=1$example$hash',
      ADMIN_CREDENTIAL_BOOTSTRAP_REQUIRED: 'true',
      ADMIN_SESSION_TTL_MS: '7200000',
      ADMIN_SESSION_TOUCH_INTERVAL_MS: '120000',
      ADMIN_COOKIE_SECURE: 'true',
      TRUST_PROXY: '127.0.0.1,10.0.0.0/8',
    });

    expect(config.authTokenHash).toContain('$argon2id$');
    expect(config.adminCredentialBootstrapConfigured).toBe(true);
    expect(config.adminCredentialBootstrapRequired).toBe(true);
    expect(config.adminSessionTtlMs).toBe(7_200_000);
    expect(config.adminSessionTouchIntervalMs).toBe(120_000);
    expect(config.adminCookieSecure).toBe(true);
    expect(config.trustProxy).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });

  it('defaults telegram api base url to the official endpoint', () => {
    const config = buildConfig({});

    expect(config.telegramApiBaseUrl).toBe('https://api.telegram.org');
    expect(config.telegramMessageThreadId).toBe('');
  });

  it('defaults notification delivery to retry-safe delivery preference and normalizes policy', () => {
    expect(buildConfig({}).notifyDeliveryPolicy).toBe('prefer_delivery');
    expect(buildConfig({ NOTIFY_DELIVERY_POLICY: 'prefer_no_duplicate' }).notifyDeliveryPolicy)
      .toBe('prefer_no_duplicate');
    expect(buildConfig({ NOTIFY_DELIVERY_POLICY: 'unexpected' }).notifyDeliveryPolicy)
      .toBe('prefer_delivery');
  });

  it('accepts telegram message thread id from environment', () => {
    const config = buildConfig({
      TELEGRAM_MESSAGE_THREAD_ID: '77',
    });

    expect(config.telegramMessageThreadId).toBe('77');
  });

  it('ships CLI-aligned OAuth defaults', () => {
    const config = buildConfig({});

    expect(config.codexClientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2026-02-06');
    expect(config.claudeClientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(config.claudeClientSecret).toBe('');
    expect(config.geminiCliClientId).toBe('681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com');
    expect(config.geminiCliClientSecret).toBe('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');
  });

  it('allows overriding the codex websocket beta gate from environment', () => {
    const config = buildConfig({
      CODEX_RESPONSES_WEBSOCKET_BETA: 'responses_websockets=2099-01-01',
    });

    expect(config.codexResponsesWebsocketBeta).toBe('responses_websockets=2099-01-01');
  });

  it('normalizes OAuth refresh lease, provider concurrency, and backoff settings', () => {
    const config = buildConfig({
      OAUTH_REFRESH_LEASE_TTL_MS: '120000',
      OAUTH_REFRESH_LEASE_HEARTBEAT_MS: '20000',
      OAUTH_REFRESH_LEASE_WAIT_MS: '7500',
      OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS: '500',
      OAUTH_REFRESH_PROVIDER_DEFAULT_CONCURRENCY: '4',
      OAUTH_REFRESH_PROVIDER_CONCURRENCY_JSON: JSON.stringify({
        Codex: 2,
        CLAUDE: 100,
        invalid: 0,
        broken: 'nope',
      }),
      OAUTH_REFRESH_TRANSIENT_BACKOFF_BASE_MS: '45000',
    });

    expect(config).toMatchObject({
      oauthRefreshLeaseTtlMs: 120_000,
      oauthRefreshLeaseHeartbeatMs: 20_000,
      oauthRefreshLeaseWaitMs: 7_500,
      oauthRefreshProviderMinIntervalMs: 500,
      oauthRefreshProviderDefaultConcurrency: 4,
      oauthRefreshProviderConcurrency: {
        codex: 2,
        claude: 32,
      },
      oauthRefreshTransientBackoffBaseMs: 45_000,
    });
  });

  it('accepts JSON request bodies larger than Fastify default 1 MiB', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));
    const largeText = 'a'.repeat(2 * 1024 * 1024);

    app.post('/echo', async (request) => {
      const body = request.body as { text?: string };
      return { textLength: body.text?.length ?? 0 };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { text: largeText },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ textLength: largeText.length });
    await app.close();
  });

  it('does not trust forwarded client IP headers by default', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({})));

    app.get('/ip', async (request) => ({
      ip: request.ip,
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.8',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: '10.0.0.8' });
    await app.close();
  });

  it('trusts forwarded client IP headers only for configured proxies', async () => {
    const app = Fastify(buildFastifyOptions(buildConfig({ TRUST_PROXY: '10.0.0.8' })));

    app.get('/ip', async (request) => ({
      ip: request.ip,
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '10.0.0.8',
      headers: {
        'x-forwarded-for': '203.0.113.5, 10.0.0.8',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ip: '203.0.113.5' });
    await app.close();
  });
});
