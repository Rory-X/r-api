import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authorizeDownstreamTokenMock = vi.fn();
const consumeManagedKeyRequestMock = vi.fn();
const acquireDownstreamConcurrencyLeaseMock = vi.fn();
const releaseConcurrencyLeaseMock = vi.fn();

vi.mock('../services/downstreamApiKeyService.js', () => ({
  authorizeDownstreamToken: (...args: unknown[]) => authorizeDownstreamTokenMock(...args),
  consumeManagedKeyRequest: (...args: unknown[]) => consumeManagedKeyRequestMock(...args),
  acquireDownstreamConcurrencyLease: (...args: unknown[]) => acquireDownstreamConcurrencyLeaseMock(...args),
  resolveDownstreamPolicySnapshot: (auth: any) => auth.snapshot || {
    capturedAt: '2026-08-03T00:00:00.000Z',
    source: auth.source,
    tokenFingerprint: 'test-fingerprint',
    keyId: auth.key?.id ?? null,
    keyName: auth.key?.name || 'global',
    policyVersion: auth.key?.policyVersion ?? 1,
    expiresAt: auth.key?.expiresAt ?? null,
    maxConcurrency: auth.key?.maxConcurrency ?? null,
    policy: auth.policy,
  },
  verifyDownstreamPolicySnapshotActive: async () => ({ ok: true }),
}));

describe('proxyAuthMiddleware', () => {
  beforeEach(() => {
    authorizeDownstreamTokenMock.mockReset();
    consumeManagedKeyRequestMock.mockReset();
    acquireDownstreamConcurrencyLeaseMock.mockReset();
    releaseConcurrencyLeaseMock.mockReset();
    acquireDownstreamConcurrencyLeaseMock.mockResolvedValue({
      ok: true,
      lease: { release: releaseConcurrencyLeaseMock },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects missing proxy credentials', async () => {
    const { proxyAuthMiddleware } = await import('./auth.js');
    const app = Fastify();
    app.addHook('onRequest', proxyAuthMiddleware);
    app.get('/v1/ping', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/v1/ping' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('Missing Authorization') });
    await app.close();
  });

  it('stores managed key context and consumes request usage', async () => {
    authorizeDownstreamTokenMock.mockResolvedValue({
      ok: true,
      source: 'managed',
      token: 'sk-managed-001',
      key: { id: 12, name: 'project-key' },
      policy: { supportedModels: ['gpt-5.2'], allowedRouteIds: [3], siteWeightMultipliers: { 1: 1.2 } },
    });
    consumeManagedKeyRequestMock.mockResolvedValue(undefined);

    const { proxyAuthMiddleware, getProxyAuthContext, getProxyResourceOwner } = await import('./auth.js');
    const app = Fastify();
    app.addHook('onRequest', proxyAuthMiddleware);
    app.get('/v1/ping', async (request) => ({
      auth: getProxyAuthContext(request),
      owner: getProxyResourceOwner(request),
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { Authorization: 'Bearer sk-managed-001' },
    });

    expect(res.statusCode).toBe(200);
    expect(authorizeDownstreamTokenMock).toHaveBeenCalledWith('sk-managed-001');
    expect(consumeManagedKeyRequestMock).toHaveBeenCalledWith(12);
    expect(acquireDownstreamConcurrencyLeaseMock).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({
      auth: {
        source: 'managed',
        keyId: 12,
        keyName: 'project-key',
        policy: {
          supportedModels: ['gpt-5.2'],
          allowedRouteIds: [3],
          siteWeightMultipliers: { 1: 1.2 },
        },
      },
      owner: {
        ownerType: 'managed_key',
        ownerId: '12',
      },
    });
    expect(releaseConcurrencyLeaseMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('returns 429 and Retry-After when managed key concurrency is exhausted', async () => {
    authorizeDownstreamTokenMock.mockResolvedValue({
      ok: true,
      source: 'managed',
      token: 'sk-managed-busy',
      key: { id: 13, name: 'busy-key', maxConcurrency: 1 },
      policy: { supportedModels: [], allowedRouteIds: [], siteWeightMultipliers: {} },
    });
    acquireDownstreamConcurrencyLeaseMock.mockResolvedValue({
      ok: false,
      statusCode: 429,
      error: 'API key concurrency limit reached',
      reason: 'max_concurrency',
      retryAfterSeconds: 1,
    });

    const { proxyAuthMiddleware } = await import('./auth.js');
    const app = Fastify();
    app.addHook('onRequest', proxyAuthMiddleware);
    app.get('/v1/ping', async () => ({ ok: true }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/ping',
      headers: { Authorization: 'Bearer sk-managed-busy' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expect(consumeManagedKeyRequestMock).not.toHaveBeenCalled();
    await app.close();
  });
});
