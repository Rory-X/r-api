import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { Headers } from 'undici';
import { config } from '../../config.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const shouldRetryProxyRequestMock = vi.fn();
const shouldAbortSameSiteEndpointFallbackMock = vi.fn();
const estimateProxyCostMock = vi.fn(async (_arg?: any) => 0);
const buildProxyBillingDetailsMock = vi.fn(async (_arg?: any) => null);
const fetchModelPricingCatalogMock = vi.fn(async (_arg?: any): Promise<any> => null);
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const insertProxyLogMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
  buildProxyBillingDetails: (arg: any) => buildProxyBillingDetailsMock(arg),
  fetchModelPricingCatalog: (arg: any) => fetchModelPricingCatalogMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  shouldRetryProxyRequest: (...args: unknown[]) => shouldRetryProxyRequestMock(...args),
  shouldAbortSameSiteEndpointFallback: (...args: unknown[]) => shouldAbortSameSiteEndpointFallbackMock(...args),
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../services/proxyLogStore.js', () => ({
  insertProxyLog: (...args: unknown[]) => insertProxyLogMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('chat proxy site api endpoint rotation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-chat-site-api-endpoint-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./chat.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.chatProxyRoute);
  });

  beforeEach(async () => {
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    shouldRetryProxyRequestMock.mockReset();
    shouldAbortSameSiteEndpointFallbackMock.mockReset();
    estimateProxyCostMock.mockClear();
    buildProxyBillingDetailsMock.mockClear();
    fetchModelPricingCatalogMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    insertProxyLogMock.mockReset();
    resetUpstreamEndpointRuntimeState();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.sites).run();

    fetchModelPricingCatalogMock.mockResolvedValue(null);
    shouldRetryProxyRequestMock.mockReturnValue(false);
    shouldAbortSameSiteEndpointFallbackMock.mockReturnValue(false);
    (config as any).codexHeaderDefaults = {
      userAgent: '',
      betaFeatures: '',
    };
    (config as any).payloadRules = {
      default: [],
      defaultRaw: [],
      override: [],
      overrideRaw: [],
      filter: [],
    };
    (config as any).disableCrossProtocolFallback = false;
    config.proxyEmptyContentFailEnabled = false;
    config.proxyErrorKeywords = [];
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    delete process.env.DATA_DIR;
  });

  it.each([false, true])('keeps site header priority %s when rotating endpoints after transport failures', async (enabled) => {
    const site = await db.insert(schema.sites).values({
      name: 'nihao-panel',
      url: 'https://console.example.com',
      platform: 'openai',
      status: 'active',
      customHeaders: '{"Authorization":"Bearer site","Cookie":"site=1","Content-Type":"application/site+json","X-Site-Scope":"pool"}',
      customHeadersOverrideRequestHeaders: enabled,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'nihao-user',
      accessToken: '',
      apiToken: 'sk-nihao',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await db.insert(schema.siteApiEndpoints).values([
      {
        siteId: site.id,
        url: 'https://api-a.example.com',
        enabled: true,
        sortOrder: 0,
      },
      {
        siteId: site.id,
        url: 'https://api-b.example.com',
        enabled: true,
        sortOrder: 1,
      },
    ]).run();

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site,
      account,
      tokenName: 'default',
      tokenValue: 'sk-nihao',
      actualModel: 'gpt-4o-mini',
    });
    selectNextChannelMock.mockReturnValue(null);

    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-ok',
        object: 'chat.completion',
        created: 1_706_000_000,
        model: 'gpt-4o-mini',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok via api-b' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()?.choices?.[0]?.message?.content).toBe('ok via api-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0] || '')).toBe('https://api-a.example.com/v1/responses');
    expect(String(fetchMock.mock.calls[1]?.[0] || '')).toBe('https://api-b.example.com/v1/responses');
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe(enabled ? 'Bearer site' : 'Bearer sk-nihao');
      expect(headers.get('cookie')).toBe('site=1');
      expect(headers.get('content-type')).toBe(enabled ? 'application/site+json' : 'application/json');
      expect(headers.get('x-site-scope')).toBe('pool');
    }
    expect(selectNextChannelMock).not.toHaveBeenCalled();
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);

    const storedEndpoints = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.siteId, site.id))
      .orderBy(asc(schema.siteApiEndpoints.sortOrder), asc(schema.siteApiEndpoints.id))
      .all();
    expect(storedEndpoints[0]).toMatchObject({
      url: 'https://api-a.example.com',
      lastFailureReason: 'fetch failed: ECONNREFUSED',
    });
    expect(storedEndpoints[0]?.cooldownUntil).toBeTruthy();
    expect(storedEndpoints[1]?.lastSelectedAt).toBeTruthy();
  });

  it('keeps the shared endpoint available and switches to another key after HTTP 503', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'aihub-panel',
      url: 'https://aihub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'aihub-key-a',
      accessToken: '',
      apiToken: 'sk-aihub-a',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'aihub-key-b',
      accessToken: '',
      apiToken: 'sk-aihub-b',
      status: 'active',
      checkinEnabled: false,
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const configuredEndpoint = await db.insert(schema.siteApiEndpoints).values({
      siteId: site.id,
      url: 'https://api.aihub.example.com',
      enabled: true,
      sortOrder: 0,
    }).returning().get();

    const selectedA = {
      channel: { id: 11, routeId: 22, retryOwner: 'local_proxy' },
      site,
      account: accountA,
      tokenName: 'key-a',
      tokenValue: 'sk-aihub-a',
      actualModel: 'gpt-5.4',
    };
    const selectedB = {
      channel: { id: 12, routeId: 22, retryOwner: 'local_proxy' },
      site,
      account: accountB,
      tokenName: 'key-b',
      tokenValue: 'sk-aihub-b',
      actualModel: 'gpt-5.4',
    };
    let excludedChannelIdsAtRetry: number[] = [];
    selectChannelMock.mockReturnValue(selectedA);
    selectNextChannelMock.mockImplementation((_model, excludedChannelIds) => {
      excludedChannelIdsAtRetry = [...excludedChannelIds];
      return selectedB;
    });
    shouldRetryProxyRequestMock.mockReturnValue(true);
    shouldAbortSameSiteEndpointFallbackMock.mockReturnValue(true);

    fetchMock
      .mockResolvedValueOnce(new Response('Service temporarily unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-key-b',
        object: 'chat.completion',
        created: 1_706_000_000,
        model: 'gpt-5.4',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok via key b' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()?.choices?.[0]?.message?.content).toBe('ok via key b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0] || ''))).toEqual([
      'https://api.aihub.example.com/v1/chat/completions',
      'https://api.aihub.example.com/v1/chat/completions',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-aihub-a' }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-aihub-b' }),
    });
    expect(selectNextChannelMock).toHaveBeenCalledTimes(1);
    expect(selectNextChannelMock.mock.calls[0]?.[0]).toBe('gpt-5.4');
    expect(excludedChannelIdsAtRetry).toEqual([11]);
    expect(recordFailureMock).toHaveBeenCalledWith(11, expect.objectContaining({
      status: 503,
      modelName: 'gpt-5.4',
      endpointId: configuredEndpoint.id,
    }));

    const endpoint = await db.select().from(schema.siteApiEndpoints)
      .where(eq(schema.siteApiEndpoints.siteId, site.id))
      .get();
    expect(endpoint).toMatchObject({
      cooldownUntil: null,
      lastFailureReason: null,
    });
  });
});
