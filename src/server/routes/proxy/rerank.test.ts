import { request as httpRequest } from 'node:http';
import { canBindLocalTestListener } from '../../test-fixtures/localListenerCapability.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Response } from 'undici';
type ConfigModule = typeof import('../../config.js');

const fetchMock = vi.fn();
vi.mock('undici', async () => ({ ...await vi.importActual<typeof import('undici')>('undici'), fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../../services/modelPricingService.js', async () => ({
  ...await vi.importActual<typeof import('../../services/modelPricingService.js')>('../../services/modelPricingService.js'),
  fetchModelPricingCatalog: vi.fn(async () => null),
  estimateProxyCost: vi.fn(async (input: { totalTokens: number }) => input.totalTokens * 0.01),
  buildProxyBillingDetails: vi.fn(async () => ({ source: 'test-catalog' })),
}));
vi.mock('../../services/routeRefreshWorkflow.js', () => ({ refreshModelsAndRebuildRoutes: vi.fn(async () => {}) }));
vi.mock('../../services/alertService.js', () => ({ reportProxyAllFailed: vi.fn(async () => {}), reportTokenExpired: vi.fn(async () => {}) }));

type DbModule = typeof import('../../db/index.js');
type RouterModule = typeof import('../../services/tokenRouter.js');
describe('rerank authorization, routing, billing and durable ledger', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let router: RouterModule;
  let config: ConfigModule['config'];
  const body = { model: 'rank-alias', query: 'question', documents: ['alpha', 'beta'], top_n: 1 };
  const payload = (usage: unknown = { input_tokens: 6, output_tokens: 0, total_tokens: 6 }) => ({ results: [{ index: 1, relevance_score: 0.95 }], ...(usage === null ? {} : { usage }) });
  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'r-api-rerank-'));
    ({ config } = await import('../../config.js'));
    await import('../../db/migrate.js');
    ({ db, schema } = await import('../../db/index.js'));
    router = await import('../../services/tokenRouter.js');
    app = Fastify();
    app.addHook('onRequest', (await import('../../middleware/auth.js')).proxyAuthMiddleware);
    await app.register((await import('./rerank.js')).rerankProxyRoute);
  });
  beforeEach(async () => {
    fetchMock.mockReset();
    config.proxyMaxChannelAttempts = 3;
    config.proxyFirstByteTimeoutSec = 0;
    await db.delete(schema.proxyRequestAttempts).run();
    await db.delete(schema.proxyRequests).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
    router.invalidateTokenRouterCache();
  });
  afterAll(async () => { await app.close(); delete process.env.DATA_DIR; });
  const key = (extra = {}) => db.insert(schema.downstreamApiKeys).values({ name: 'test-key', key: 'sk-rerank', supportedModels: JSON.stringify(['rank-alias']), ...extra }).returning().get();
  async function channel(platform = 'openai', priority = 0, routeId?: number) {
    const site = await db.insert(schema.sites).values({ name: 'rank-site', url: `https://rank-${priority}.example.com/api/custom/v1`, platform, maxConcurrency: 1 }).returning().get();
    const account = await db.insert(schema.accounts).values({ siteId: site.id, username: 'user', accessToken: '', balance: 100, apiToken: `upstream-${priority}`, extraConfig: JSON.stringify({ credentialMode: 'apikey' }) }).returning().get();
    await db.insert(schema.modelAvailability).values({ accountId: account.id, modelName: 'rank-real', available: true }).run();
    const route = routeId ? { id: routeId } : await db.insert(schema.tokenRoutes).values({ modelPattern: 'rank-alias', modelMapping: JSON.stringify({ 'rank-alias': 'rank-real' }), routingStrategy: 'stable_first' }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({ routeId: route.id, accountId: account.id, sourceModel: 'rank-alias', priority }).returning().get();
    router.invalidateTokenRouterCache();
    return { site, account, route, channel };
  }
  const send = (payloadBody: unknown = body) => app.inject({ method: 'POST', url: '/v1/rerank', headers: { authorization: 'Bearer sk-rerank' }, payload: payloadBody });
  const ledger = async (id: string) => (await import('../../services/proxyAttemptLedgerStore.js')).getProxyRequestLedgerDetail(id);

  it('routes a real rerank identity, mapped model, true usage and cost into quotas/logs/ledger', async () => {
    const downstream = await key();
    const selected = await channel();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload()), { headers: { 'Content-Type': 'application/json' } }));
    const response = await send();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ results: [{ index: 1 }] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://rank-0.example.com/api/custom/v1/rerank');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ ...body, model: 'rank-real' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer upstream-0');
    expect(await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, downstream.id)).get()).toMatchObject({ usedRequests: 1, usedCost: 0.06 });
    expect(await db.select().from(schema.proxyLogs).get()).toMatchObject({ modelActual: 'rank-real', totalTokens: 6, estimatedCost: 0.06 });
    const record = await ledger(String(response.headers['x-metapi-request-id']));
    expect(record).toMatchObject({ status: 'succeeded', downstreamPath: '/v1/rerank', attempts: [{ endpoint: 'rerank', status: 'succeeded', commitState: 'completed', channelId: selected.channel.id }] });
    expect(record?.routingExplanation).toBeTruthy();
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
  });

  it.each([[], ['other-model']])('denies empty or unauthorized model scope %j without selecting or dispatching', async (supportedModels) => {
    await key({ supportedModels: JSON.stringify(supportedModels) });
    await channel();
    const response = await send();
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', attempts: [] });
  });

  it.each([{ maxCost: 1, usedCost: 1 }, { maxRequests: 1, usedRequests: 1 }])('rejects an exhausted key before upstream dispatch: %j', async (limits) => {
    await key(limits);
    const response = await send();
    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps unknown usage null and invents neither tokens nor cost', async () => {
    await key(); await channel();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload(null))));
    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(await db.select().from(schema.proxyLogs).get()).toMatchObject({ totalTokens: null, promptTokens: null, completionTokens: null, estimatedCost: 0 });
  });

  it('retries a terminal pre-output 503 on another eligible channel and records each attempt', async () => {
    await key(); const first = await channel(); await channel('openai', 1, first.route.id);
    fetchMock.mockResolvedValueOnce(new Response('service temporarily unavailable', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'succeeded', attempts: [{ status: 'failed', endpoint: 'rerank' }, { status: 'succeeded', endpoint: 'rerank' }] });
  });

  it('isolates unsupported rerank from chat model capability and does not retry a non-JSON 404', async () => {
    await key(); const selected = await channel();
    fetchMock.mockResolvedValue(new Response('rerank endpoint not supported', { status: 404, headers: { 'content-type': 'text/plain' } }));
    const response = await send();
    expect(response.statusCode).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, selected.account.id)).get()).toMatchObject({ available: true });
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', attempts: [{ endpoint: 'rerank', statusCode: 404 }] });
  });

  it('excludes a native-only platform before dispatch and records the rejected routing decision', async () => {
    await key(); await channel('codex');
    const response = await send();
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    const record = await ledger(String(response.headers['x-metapi-request-id']));
    expect(record?.routingExplanation).toBeTruthy();
    expect(record?.attempts).toHaveLength(0);
  });

  it('rechecks changed policy after a site queue and releases capacity without dispatch/health damage', async () => {
    const downstream = await key(); const selected = await channel();
    await db.update(schema.sites).set({ concurrencyWaitTimeoutMs: 1000 }).where(eq(schema.sites.id, selected.site.id)).run();
    router.invalidateTokenRouterCache();
    const service = await import('../../services/siteConcurrencyService.js');
    const held = await service.acquireSiteConcurrencyLease(selected.site.id);
    const acquire = vi.spyOn(service, 'acquireSiteConcurrencyLease');
    try {
      const pending = send();
      await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
      await db.update(schema.downstreamApiKeys).set({ supportedModels: '[]', policyVersion: 2 }).where(eq(schema.downstreamApiKeys.id, downstream.id)).run();
      await held?.release();
      const response = await pending;
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'downstream_policy_changed' } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
      expect(await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, selected.channel.id)).get()).toMatchObject({ failCount: 0 });
      expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', attempts: [{ commitState: 'not_started', status: 'failed' }] });
    } finally { acquire.mockRestore(); await held?.release(); }
  });

  it('keeps interrupted response bodies terminal and never replays an accepted response', async () => {
    await key(); const first = await channel(); await channel('openai', 1, first.route.id);
    let reads = 0;
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"results":')); else controller.error(new Error('connection dropped')); } }, { highWaterMark: 0 })));
    const response = await send();
    expect(response.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', attempts: [{ status: 'failed', commitState: 'response_started' }] });
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
  });


  it('updates token quota windows from real usage and rejects the next exhausted request', async () => {
    const downstream = await key(); await channel();
    const quota = await import('../../services/downstreamKeyQuotaService.js');
    await quota.replaceDownstreamKeyLimitPolicies(downstream.id, [
      { metric: 'total_tokens', windowType: 'fixed', windowSeconds: 3600, limitValue: 6, enforcement: 'hard' },
      { metric: 'input_tokens', windowType: 'fixed', windowSeconds: 3600, limitValue: 6, enforcement: 'hard' },
    ]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload())));
    expect((await send()).statusCode).toBe(200);
    const windows = await quota.readDownstreamKeyQuotaWindows({ keyId: downstream.id });
    expect(windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'total_tokens', usedValue: 6, remaining: 0 }),
      expect.objectContaining({ metric: 'input_tokens', usedValue: 6, remaining: 0 }),
    ]));
    expect((await send()).statusCode).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('permits the last request already admitted by the request-count reservation', async () => {
    await key({ maxRequests: 1 }); await channel();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload())));
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(403);
  });

  it('does not use token-like document fields as upstream accounting', async () => {
    await key(); await channel();
    const result = payload(null);
    Object.assign(result.results[0], { document: { text: 'x', input_tokens: 9999 } });
    fetchMock.mockResolvedValue(new Response(JSON.stringify(result)));
    expect((await send()).statusCode).toBe(200);
    expect(await db.select().from(schema.proxyLogs).get()).toMatchObject({ totalTokens: null, estimatedCost: 0 });
  });

  it('keeps rerank independent of chat runtime capability failures and does not overwrite them on success', async () => {
    await key(); const selected = await channel();
    await db.update(schema.modelAvailability).set({ available: false }).where(eq(schema.modelAvailability.accountId, selected.account.id)).run();
    router.invalidateTokenRouterCache();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload())));
    expect((await send()).statusCode).toBe(200);
    expect(await db.select().from(schema.modelAvailability).where(eq(schema.modelAvailability.accountId, selected.account.id)).get()).toMatchObject({ available: false });
  });


  it('returns identifiable capacity failure without health damage or a sent attempt', async () => {
    await key(); const selected = await channel();
    const held = await (await import('../../services/siteConcurrencyService.js')).acquireSiteConcurrencyLease(selected.site.id);
    try {
      const response = await send();
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'site_capacity_unavailable' } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', attempts: [{ commitState: 'not_started' }] });
      expect(await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, selected.channel.id)).get()).toMatchObject({ failCount: 0 });
    } finally { await held?.release(); }
  });

  it('ends on lease loss after response acceptance without replay or channel health damage', async () => {
    await key(); const selected = await channel();
    const service = await import('../../services/siteConcurrencyService.js');
    const acquire = vi.spyOn(service, 'acquireSiteConcurrencyLease');
    let emitted = false;
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (!emitted) { emitted = true; controller.enqueue(new TextEncoder().encode('{"results":')); } } }, { highWaterMark: 0 })));
    try {
      const pending = send();
      await vi.waitFor(async () => expect(await db.select().from(schema.proxyRequestAttempts).get()).toMatchObject({ commitState: 'response_started' }));
      const lease = (await acquire.mock.results[0].value)!;
      await db.delete(schema.siteConcurrencyLeases).run();
      await expect(lease.renew()).rejects.toThrow('lost');
      const response = await pending;
      expect(response.statusCode).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', attempts: [{ status: 'failed' }] });
      expect(await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, selected.channel.id)).get()).toMatchObject({ failCount: 0 });
    } finally { acquire.mockRestore(); }
  });

  it('rotates a terminal upstream HTTP timeout through the address pool and releases before the next attempt', async () => {
    await key(); const selected = await channel();
    await db.insert(schema.siteApiEndpoints).values([
      { siteId: selected.site.id, url: 'https://address-a.example.com', sortOrder: 0 },
      { siteId: selected.site.id, url: 'https://address-b.example.com', sortOrder: 1 },
    ]).run();
    fetchMock.mockResolvedValueOnce(new Response('first byte timeout reported by upstream', { status: 408 })).mockImplementationOnce(async () => {
      expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(1);
      return new Response(JSON.stringify(payload()));
    });
    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://address-a.example.com/v1/rerank', 'https://address-b.example.com/v1/rerank']);
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ attempts: [{ status: 'failed', endpoint: 'rerank' }, { status: 'succeeded', endpoint: 'rerank' }] });
  });

  it.skipIf(!canBindLocalTestListener())('cancels a real disconnected HTTP client, releases capacity and records cancelled without billing/health penalties', async () => {
    const downstream = await key(); const selected = await channel();
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })));
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = httpRequest(`${url}/v1/rerank`, { method: 'POST', headers: { authorization: 'Bearer sk-rerank', 'content-type': 'application/json' } });
    client.on('error', () => {});
    client.end(JSON.stringify(body));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    client.destroy();
    await vi.waitFor(async () => {
      expect(await db.select().from(schema.proxyRequests).get()).toMatchObject({ status: 'cancelled' });
      expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
    });
    expect(await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, selected.channel.id)).get()).toMatchObject({ failCount: 0, successCount: 0 });
    expect(await db.select().from(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, downstream.id)).get()).toMatchObject({ usedCost: 0 });
  });


  it('respects upstream-owned channel retries and leaves a terminal failure at one attempt', async () => {
    await key(); const first = await channel(); await channel('openai', 1, first.route.id);
    await db.update(schema.routeChannels).set({ retryOwner: 'upstream_gateway' }).where(eq(schema.routeChannels.id, first.channel.id)).run();
    router.invalidateTokenRouterCache();
    fetchMock.mockResolvedValueOnce(new Response('service temporarily unavailable', { status: 503 })).mockResolvedValueOnce(new Response(JSON.stringify(payload())));
    const response = await send();
    expect(response.statusCode).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'failed', retryOwner: 'upstream_gateway', attempts: [{ status: 'failed' }] });
  });

  it('does not replay an ambiguous first-byte timeout and records an unknown ledger outcome', async () => {
    await key(); const first = await channel(); await channel('openai', 1, first.route.id);
    config.proxyFirstByteTimeoutSec = 0.02;
    fetchMock.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({}, { highWaterMark: 0 })));
    const response = await send();
    expect(response.statusCode).toBe(408);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await ledger(String(response.headers['x-metapi-request-id']))).toMatchObject({ status: 'unknown', attempts: [{ status: 'unknown', commitState: 'sent_unknown' }] });
    expect(await db.select().from(schema.siteConcurrencyLeases).all()).toHaveLength(0);
  });

  it.each([{ ...body, model: '' }, { ...body, documents: [] }, { ...body, top_n: 3 }, { ...body, stream: true }, { ...body, query: 1 }])('rejects malformed payload without dispatch: %j', async (invalid) => {
    await key();
    expect((await send(invalid)).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
