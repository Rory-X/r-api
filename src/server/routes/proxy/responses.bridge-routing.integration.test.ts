import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const resolveBridgeProxyRoutePlanMock = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/bridgeContinuationRouting.js', () => ({
  resolveBridgeProxyRoutePlan: (...args: unknown[]) => resolveBridgeProxyRoutePlanMock(...args),
}));

vi.mock('../../services/modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/modelPricingService.js')>(
    '../../services/modelPricingService.js',
  );
  return {
    ...actual,
    getCachedModelRoutingReferenceCost: () => null,
    refreshModelPricingCatalog: async () => null,
    fetchModelPricingCatalog: async () => null,
    estimateProxyCost: async () => 0,
    buildProxyBillingDetails: async () => null,
  };
});

vi.mock('../../services/proxyUsageFallbackService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/proxyUsageFallbackService.js')>(
    '../../services/proxyUsageFallbackService.js',
  );
  return {
    ...actual,
    resolveProxyUsageWithSelfLogFallback: async ({ usage }: any) => ({
      ...usage,
      estimatedCostFromQuota: 0,
      recoveredFromSelfLog: false,
      selfLogBillingMeta: null,
      usageSource: 'upstream',
    }),
  };
});

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: async () => undefined,
  reportTokenExpired: async () => undefined,
}));

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');

describe('Responses Bridge routing integration', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-responses-bridge-routing-'));
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const { responsesProxyRoute } = await import('./responses.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;

    app = Fastify();
    await app.register(responsesProxyRoute);
  });

  afterAll(async () => {
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();
    await app.close();
    await closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('uses canonical metadata to rotate credentials and then switch sites for HTTP SSE requests', async () => {
    const model = 'gpt-5.4-bridge-http';
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: model,
      routingStrategy: 'round_robin',
      enabled: true,
    }).returning().get();
    const siteA = await db.insert(schema.sites).values({
      name: 'bridge-http-site-a',
      url: 'https://bridge-http-a.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const siteB = await db.insert(schema.sites).values({
      name: 'bridge-http-site-b',
      url: 'https://bridge-http-b.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const accountA = await db.insert(schema.accounts).values({
      siteId: siteA.id,
      username: 'bridge-http-account-a',
      accessToken: '',
      apiToken: '',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'bridge-http-account-b',
      accessToken: '',
      apiToken: '',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();
    const tokenA1 = await db.insert(schema.accountTokens).values({
      accountId: accountA.id,
      name: 'site-a-primary',
      token: 'sk-site-a-primary',
      enabled: true,
      isDefault: false,
    }).returning().get();
    const tokenA2 = await db.insert(schema.accountTokens).values({
      accountId: accountA.id,
      name: 'site-a-rotated',
      token: 'sk-site-a-rotated',
      enabled: true,
      isDefault: false,
    }).returning().get();
    const tokenB = await db.insert(schema.accountTokens).values({
      accountId: accountB.id,
      name: 'site-b-switched',
      token: 'sk-site-b-switched',
      enabled: true,
      isDefault: false,
    }).returning().get();
    const channelA1 = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA1.id,
      sourceModel: model,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const channelA2 = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: tokenA2.id,
      sourceModel: model,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      sourceModel: model,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();

    const selectionBeforeRotate = {
      requestId: 'request-before-rotate',
      attemptId: 'attempt-before-rotate',
      channelId: channelA1.id,
      routeId: route.id,
      siteId: siteA.id,
      accountId: accountA.id,
      tokenId: tokenA1.id,
      startedAt: '2026-08-04 08:00:00',
    };
    const selectionBeforeSwitch = {
      requestId: 'request-before-switch',
      attemptId: 'attempt-before-switch',
      channelId: channelA2.id,
      routeId: route.id,
      siteId: siteA.id,
      accountId: accountA.id,
      tokenId: tokenA2.id,
      startedAt: '2026-08-04 08:01:00',
    };
    resolveBridgeProxyRoutePlanMock.mockImplementation(async ({ directive }: any) => {
      if (!directive) return { plan: null, ignoredReason: 'not_bridge_request' };
      const previousSelection = directive.routeAction === 'rotate_credential'
        ? selectionBeforeRotate
        : selectionBeforeSwitch;
      return {
        plan: {
          taskId: directive.taskId,
          requestedAction: directive.routeAction,
          effectiveAction: directive.routeAction,
          continuationNumber: directive.continuationNumber,
          previousSelection,
          reason: 'directive_applied',
        },
        ignoredReason: null,
      };
    });
    fetchMock.mockImplementation(async (_url: string) => {
      const responseId = `resp_bridge_http_${fetchMock.mock.calls.length}`;
      return new Response([
        'event: response.completed\n',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            model,
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    });

    const clientMetadata = (
      routeAction: 'rotate_credential' | 'switch_channel',
      turnId: string,
      continuationNumber: number,
    ) => ({
      'x-codex-turn-metadata': {
        session_id: 'session-bridge-http',
        thread_id: 'thread-bridge-http',
        turn_id: turnId,
        request_kind: 'turn',
        metapi_bridge_task_id: 'task-bridge-http',
        metapi_bridge_route_action: routeAction,
        metapi_bridge_continuation_number: continuationNumber,
      },
    });
    const sendTurn = async (
      routeAction: 'rotate_credential' | 'switch_channel',
      turnId: string,
      continuationNumber: number,
    ) => await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: { 'user-agent': 'CodexClient/1.0' },
      payload: {
        model,
        stream: true,
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: routeAction }],
        }],
        client_metadata: clientMetadata(routeAction, turnId, continuationNumber),
      },
    });

    const rotateResponse = await sendTurn('rotate_credential', 'turn-bridge-http-1', 2);
    const switchResponse = await sendTurn('switch_channel', 'turn-bridge-http-2', 3);

    expect(rotateResponse.statusCode, rotateResponse.body).toBe(200);
    expect(switchResponse.statusCode, switchResponse.body).toBe(200);
    expect(rotateResponse.headers['content-type']).toContain('text/event-stream');
    expect(switchResponse.headers['content-type']).toContain('text/event-stream');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [rotateUrl, rotateOptions] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    const [switchUrl, switchOptions] = fetchMock.mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(rotateUrl).toBe('https://bridge-http-a.example.com/v1/responses');
    expect(rotateOptions.headers.Authorization || rotateOptions.headers.authorization)
      .toBe('Bearer sk-site-a-rotated');
    expect(switchUrl).toBe('https://bridge-http-b.example.com/v1/responses');
    expect(switchOptions.headers.Authorization || switchOptions.headers.authorization)
      .toBe('Bearer sk-site-b-switched');

    expect(resolveBridgeProxyRoutePlanMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      directive: {
        taskId: 'task-bridge-http',
        routeAction: 'rotate_credential',
        continuationNumber: 2,
      },
      identity: expect.objectContaining({
        sessionId: 'session-bridge-http',
        threadId: 'thread-bridge-http',
        turnId: 'turn-bridge-http-1',
      }),
    }));
    expect(resolveBridgeProxyRoutePlanMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      directive: expect.objectContaining({ routeAction: 'switch_channel' }),
      identity: expect.objectContaining({ turnId: 'turn-bridge-http-2' }),
    }));

    const requestRows = (await db.select().from(schema.proxyRequests).all())
      .filter((row) => row.bridgeTaskId === 'task-bridge-http')
      .sort((left, right) => left.id - right.id);
    expect(requestRows).toMatchObject([
      {
        clientThreadId: 'thread-bridge-http',
        clientTurnId: 'turn-bridge-http-1',
        bridgeRouteAction: 'rotate_credential',
        bridgeContinuationNumber: 2,
      },
      {
        clientThreadId: 'thread-bridge-http',
        clientTurnId: 'turn-bridge-http-2',
        bridgeRouteAction: 'switch_channel',
        bridgeContinuationNumber: 3,
      },
    ]);
    const requestRowIds = new Set(requestRows.map((row) => row.id));
    const attemptRows = (await db.select().from(schema.proxyRequestAttempts).all())
      .filter((row) => requestRowIds.has(row.requestRowId))
      .sort((left, right) => left.id - right.id);
    expect(attemptRows).toMatchObject([
      {
        channelId: channelA2.id,
        accountId: accountA.id,
        tokenId: tokenA2.id,
        status: 'succeeded',
      },
      {
        channelId: channelB.id,
        accountId: accountB.id,
        tokenId: tokenB.id,
        status: 'succeeded',
      },
    ]);
  });
});
