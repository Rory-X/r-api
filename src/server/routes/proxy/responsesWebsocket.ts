import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createCodexWebsocketRuntime, CodexWebsocketRuntimeError } from '../../proxy-core/runtime/codexWebsocketRuntime.js';
import { buildCodexSessionResponseStoreKey } from '../../proxy-core/runtime/codexSessionResponseStore.js';
import {
  acquireDownstreamConcurrencyLease,
  authorizeDownstreamToken,
  consumeManagedKeyRequest,
  isModelAllowedByPolicyOrAllowedRoutes,
  resolveDownstreamPolicySnapshot,
  type DownstreamConcurrencyLease,
  type DownstreamTokenAuthSuccess,
} from '../../services/downstreamApiKeyService.js';
import {
  createProxyAuthHandoffHeaders,
  type ProxyAuthContext,
} from '../../middleware/auth.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { buildOauthProviderHeaders } from '../../services/oauth/service.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import { buildUpstreamEndpointRequest } from './upstreamEndpoint.js';
import { config } from '../../config.js';
import { applyOpenAiServiceTierPolicy } from '../../proxy-core/serviceTierPolicy.js';
import {
  classifyRetryErrorScope,
  createRetryBudget,
} from '../../services/proxyRetryContract.js';
import { resolveApiChannelRetryPolicy } from '../../services/proxyRetryOwnership.js';
import { startProxyAttemptLedgerSession } from '../../services/proxyAttemptLedgerRuntime.js';
import { parseCodexTurnMetadata } from '../../proxy-core/codexTurnMetadata.js';
import { detectDownstreamClientContext } from '../../proxy-core/downstreamClientContext.js';
import { resolveBridgeProxyRoutePlan } from '../../services/bridgeContinuationRouting.js';
import { selectProxyChannelForAttempt } from '../../proxy-core/channelSelection.js';
import { carriesHardResponsesContinuity } from '../../proxy-core/surfaces/openAiResponsesSurface.js';

const installedApps = new WeakSet<FastifyInstance>();
const WS_TURN_STATE_HEADER = 'x-codex-turn-state';
const RESPONSES_WEBSOCKET_MODE_HEADER = 'x-metapi-responses-websocket-mode';
const RESPONSES_WEBSOCKET_TRANSPORT_HEADER = 'x-metapi-responses-websocket-transport';
const codexWebsocketRuntime = createCodexWebsocketRuntime();

type SelectedChannel = NonNullable<Awaited<ReturnType<typeof tokenRouter.selectChannel>>>;
type ResponsesWebsocketAuthContext = DownstreamTokenAuthSuccess;
type BridgeRouteResolution = Awaited<ReturnType<typeof resolveBridgeProxyRoutePlan>>;

type NormalizedResponsesWebsocketRequest =
  | {
    ok: true;
    request: Record<string, unknown>;
    nextRequestSnapshot: Record<string, unknown>;
  }
  | {
    ok: false;
    status: number;
    message: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getServiceTierPolicyRules(): unknown {
  return (config as typeof config & { openAiServiceTierRules?: unknown }).openAiServiceTierRules;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function headerValueToTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function toBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return null;
}

function parseExtraConfigRecord(extraConfig: unknown): Record<string, unknown> | null {
  if (isRecord(extraConfig)) return extraConfig;
  if (typeof extraConfig !== 'string') return null;
  try {
    const parsed = JSON.parse(extraConfig);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const nested = value[key];
  return isRecord(nested) ? nested : null;
}
function selectedChannelModelMatches(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const selectedModel = asTrimmedString(selectedChannel.actualModel).toLowerCase();
  const normalizedRequestModel = asTrimmedString(requestModel).toLowerCase();
  if (!selectedModel || !normalizedRequestModel) return true;
  return selectedModel === normalizedRequestModel;
}

function selectedChannelSupportsCodexWebsocketTransport(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const platform = asTrimmedString(selectedChannel.site?.platform).toLowerCase();
  if (platform !== 'codex') return false;
  if (!selectedChannelModelMatches(selectedChannel, requestModel)) return false;
  if (!config.codexUpstreamWebsocketEnabled) return false;

  const extraConfig = parseExtraConfigRecord(selectedChannel.account.extraConfig);
  const oauth = readNestedRecord(extraConfig, 'oauth');
  const providerData = readNestedRecord(oauth, 'providerData');
  const candidateFlags = [
    extraConfig?.websockets,
    readNestedRecord(extraConfig, 'attributes')?.websockets,
    readNestedRecord(extraConfig, 'metadata')?.websockets,
    providerData?.websockets,
    readNestedRecord(providerData, 'attributes')?.websockets,
    readNestedRecord(providerData, 'metadata')?.websockets,
  ];
  for (const candidate of candidateFlags) {
    const parsed = toBooleanLike(candidate);
    if (parsed !== null) return parsed;
  }
  return true;
}

function selectedChannelSupportsIncrementalInput(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  return selectedChannelSupportsCodexWebsocketTransport(selectedChannel, requestModel);
}

function unwrapCodexWebsocketRuntimeError(error: unknown): CodexWebsocketRuntimeError {
  if (error instanceof CodexWebsocketRuntimeError) return error;
  if (error instanceof SiteApiEndpointRequestError && error.cause instanceof CodexWebsocketRuntimeError) {
    return error.cause;
  }
  return new CodexWebsocketRuntimeError(
    error instanceof Error && error.message.trim()
      ? error.message
      : 'upstream websocket request failed',
  );
}

function shouldReuseSelectedChannel(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const selectedModel = asTrimmedString(selectedChannel.actualModel).toLowerCase();
  const normalizedRequestModel = asTrimmedString(requestModel).toLowerCase();
  if (!selectedModel || !normalizedRequestModel) return true;
  return selectedModel === normalizedRequestModel;
}

function buildBridgeRouteResolutionIdentity(
  metadata: ReturnType<typeof parseCodexTurnMetadata>,
  resolution: BridgeRouteResolution,
): string {
  const directive = metadata?.bridgeRouteDirective;
  if (!directive) return 'none';
  const plan = resolution.plan;
  return [
    directive.taskId,
    directive.routeAction,
    directive.continuationNumber,
    plan?.effectiveAction || 'ignored',
    plan?.previousSelection.requestId || '',
    plan?.previousSelection.attemptId || '',
    plan?.previousSelection.channelId || '',
    plan?.previousSelection.accountId || '',
    plan?.previousSelection.tokenId ?? '',
    resolution.ignoredReason || '',
  ].join(':');
}

function deriveCodexExplicitSessionId(body: Record<string, unknown>, sessionId: string): string {
  void body;
  return sessionId;
}

function parseJsonObject(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(raw));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cloneJsonObject<T>(value: T): T {
  return structuredClone(value);
}

function toResponseInputArray(value: unknown): unknown[] {
  return Array.isArray(value) ? cloneJsonObject(value) : [];
}

function normalizeResponsesWebsocketRequest(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  lastResponseOutput: unknown[],
  supportsIncrementalInput: boolean,
): NormalizedResponsesWebsocketRequest {
  const requestType = asTrimmedString(parsed.type);
  if (requestType !== 'response.create' && requestType !== 'response.append') {
    return {
      ok: false,
      status: 400,
      message: `unsupported websocket request type: ${requestType || 'unknown'}`,
    };
  }

  if (!lastRequest) {
    if (requestType !== 'response.create') {
      return {
        ok: false,
        status: 400,
        message: 'websocket request received before response.create',
      };
    }
    const next = cloneJsonObject(parsed);
    delete next.type;
    if (!supportsIncrementalInput && parsed.generate === false) {
      delete next.generate;
    }
    next.stream = true;
    if (!Array.isArray(next.input)) next.input = [];
    const modelName = asTrimmedString(next.model);
    if (!modelName) {
      return {
        ok: false,
        status: 400,
        message: 'missing model in response.create request',
      };
    }
    return {
      ok: true,
      request: next,
      nextRequestSnapshot: cloneJsonObject(next),
    };
  }

  if (!Array.isArray(parsed.input)) {
    return {
      ok: false,
      status: 400,
      message: 'websocket request requires array field: input',
    };
  }

  const next = cloneJsonObject(parsed);
  delete next.type;
  next.stream = true;
  if (!('model' in next) && typeof lastRequest.model === 'string') {
    next.model = lastRequest.model;
  }
  if (!('instructions' in next) && lastRequest.instructions !== undefined) {
    next.instructions = cloneJsonObject(lastRequest.instructions);
  }

  if (supportsIncrementalInput && requestType === 'response.create' && asTrimmedString(parsed.previous_response_id)) {
    return {
      ok: true,
      request: next,
      nextRequestSnapshot: cloneJsonObject(next),
    };
  }

  const mergedInput = [
    ...toResponseInputArray(lastRequest.input),
    ...cloneJsonObject(lastResponseOutput),
    ...cloneJsonObject(parsed.input),
  ];
  delete next.previous_response_id;
  next.input = mergedInput;

  return {
    ok: true,
    request: next,
    nextRequestSnapshot: cloneJsonObject(next),
  };
}

function shouldHandleResponsesWebsocketPrewarmLocally(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  supportsIncrementalInput: boolean,
): boolean {
  if (supportsIncrementalInput || lastRequest) return false;
  if (asTrimmedString(parsed.type) !== 'response.create') return false;
  return parsed.generate === false;
}

function writeResponsesWebsocketError(
  socket: WebSocket,
  status: number,
  message: string,
  errorPayload?: unknown,
) {
  socket.send(JSON.stringify({
    type: 'error',
    status,
    error: isRecord(errorPayload) && isRecord(errorPayload.error)
      ? errorPayload.error
      : {
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        message,
      },
  }));
}

function synthesizePrewarmResponsePayloads(request: Record<string, unknown>) {
  const responseId = `resp_prewarm_${randomUUID()}`;
  const modelName = asTrimmedString(request.model) || 'unknown';
  const createdAt = Math.floor(Date.now() / 1000);
  return [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model: modelName,
        output: [],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: modelName,
        output: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    },
  ];
}

function collectResponsesOutput(payloads: unknown[]): unknown[] {
  const outputByIndex = new Map<number, unknown>();
  let completedOutput: unknown[] | null = null;
  const fallbackStatusForType = (type: string): string => {
    if (type === 'response.completed') return 'completed';
    if (type === 'response.failed') return 'failed';
    return 'incomplete';
  };

  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    const type = asTrimmedString(payload.type);
    if ((type === 'response.output_item.added' || type === 'response.output_item.done')
      && Number.isInteger(payload.output_index)
      && payload.item !== undefined) {
      outputByIndex.set(Number(payload.output_index), cloneJsonObject(payload.item));
      continue;
    }
    if (
      (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed')
      && isRecord(payload.response)
      && Array.isArray(payload.response.output)
    ) {
      const terminalOutput = cloneJsonObject(payload.response.output);
      if (terminalOutput.length > 0 || outputByIndex.size === 0) {
        completedOutput = terminalOutput;
      }
      continue;
    }
    if (
      (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed')
      && isRecord(payload.response)
      && typeof payload.response.output_text === 'string'
      && payload.response.output_text.trim()
    ) {
      completedOutput = [{
        id: `msg_${asTrimmedString(payload.response.id) || type}`,
        type: 'message',
        role: 'assistant',
        status: asTrimmedString(payload.response.status) || fallbackStatusForType(type),
        content: [{
          type: 'output_text',
          text: payload.response.output_text,
        }],
      }];
      continue;
    }
    if (Array.isArray(payload.output)) {
      const terminalOutput = cloneJsonObject(payload.output);
      if (terminalOutput.length > 0 || outputByIndex.size === 0) {
        completedOutput = terminalOutput;
      }
      continue;
    }
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
      const fallbackStatus = asTrimmedString(payload.status) || fallbackStatusForType(type || 'response.completed');
      completedOutput = [{
        id: `msg_${type || 'response'}`,
        type: 'message',
        role: 'assistant',
        status: fallbackStatus,
        content: [{
          type: 'output_text',
          text: payload.output_text,
        }],
      }];
    }
  }

  if (completedOutput) return completedOutput;
  return [...outputByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value);
}

async function forwardResponsesRequestViaHttp(input: {
  app: FastifyInstance;
  socket: WebSocket;
  request: IncomingMessage;
  payload: Record<string, unknown>;
  preserveIncrementalMode: boolean;
  authContext: ProxyAuthContext;
}): Promise<unknown[] | null> {
  const injectHeaders: Record<string, string | string[]> = {
    ...buildInjectHeaders(input.request),
    ...createProxyAuthHandoffHeaders(input.authContext),
    [RESPONSES_WEBSOCKET_TRANSPORT_HEADER]: '1',
    ...(input.preserveIncrementalMode ? { [RESPONSES_WEBSOCKET_MODE_HEADER]: 'incremental' } : {}),
  };
  if (
    !headerValueToTrimmedString(injectHeaders.authorization)
    && !headerValueToTrimmedString(injectHeaders['x-api-key'])
    && !headerValueToTrimmedString(injectHeaders['x-goog-api-key'])
  ) {
    injectHeaders.authorization = `Bearer ${input.authContext.token}`;
  }

  const response = await input.app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: injectHeaders,
    payload: input.payload,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = null;
    }
    writeResponsesWebsocketError(
      input.socket,
      response.statusCode,
      response.statusMessage || 'Upstream error',
      payload,
    );
    return null;
  }

  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    try {
      const payload = JSON.parse(response.body);
      const output = collectResponsesOutput([payload]);
      input.socket.send(JSON.stringify(payload));
      return output;
    } catch {
      writeResponsesWebsocketError(input.socket, 502, 'Unexpected non-JSON websocket proxy response');
      return null;
    }
  }

  const pulled = openAiResponsesTransformer.pullSseEvents(response.body);
  const forwardedPayloads: unknown[] = [];
  let sawTerminalPayload = false;
  for (const event of pulled.events) {
    if (event.data === '[DONE]') continue;
    try {
      const payload = JSON.parse(event.data);
      forwardedPayloads.push(payload);
      const type = isRecord(payload) ? asTrimmedString(payload.type) : '';
      if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
        sawTerminalPayload = true;
      }
      input.socket.send(JSON.stringify(payload));
    } catch {
      // Ignore malformed SSE frames; the HTTP route already normalizes them.
    }
  }
  if (!sawTerminalPayload) {
    writeResponsesWebsocketError(input.socket, 408, 'stream closed before response.completed');
  }
  return collectResponsesOutput(forwardedPayloads);
}

function buildInjectHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(request.headers)) {
    const key = rawKey.toLowerCase();
    if (!rawValue) continue;
    if (
      key === 'host'
      || key === 'connection'
      || key === 'upgrade'
      || key === 'sec-websocket-key'
      || key === 'sec-websocket-version'
      || key === 'sec-websocket-extensions'
      || key === 'sec-websocket-protocol'
    ) {
      continue;
    }
    headers[rawKey] = rawValue as string | string[];
  }
  return headers;
}

function extractWebsocketAuthToken(request: IncomingMessage, url: URL): string {
  const auth = headerValueToTrimmedString(request.headers.authorization);
  if (auth) return auth.replace(/^Bearer\s+/i, '').trim();
  const apiKey = headerValueToTrimmedString(request.headers['x-api-key']);
  if (apiKey) return apiKey;
  const googApiKey = headerValueToTrimmedString(request.headers['x-goog-api-key']);
  if (googApiKey) return googApiKey;
  return asTrimmedString(url.searchParams.get('key'));
}

function writeUpgradeHttpError(socket: Duplex, status: number, message: string): void {
  const statusText = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 400
        ? 'Bad Request'
        : 'Error';
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n'
    + '\r\n'
    + body,
  );
}

async function supportsResponsesWebsocketIncrementalInput(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  authContext: ResponsesWebsocketAuthContext,
): Promise<boolean> {
  const requestModel = asTrimmedString(parsed.model) || asTrimmedString(lastRequest?.model);
  if (!requestModel) return false;

  try {
    const selected = await tokenRouter.previewSelectedChannel(requestModel, authContext.policy);
    return selectedChannelSupportsIncrementalInput(selected, requestModel);
  } catch {
    return false;
  }
}

async function handleResponsesWebsocketConnection(
  app: FastifyInstance,
  socket: WebSocket,
  request: IncomingMessage,
  authContext: ResponsesWebsocketAuthContext,
) {
  const websocketSessionId = headerValueToTrimmedString(request.headers['session-id'])
    || headerValueToTrimmedString(request.headers['session_id'])
    || headerValueToTrimmedString(request.headers['conversation-id'])
    || headerValueToTrimmedString(request.headers['conversation_id'])
    || randomUUID();
  const runtimeSessionKeys = new Set<string>();
  let lastRequest: Record<string, unknown> | null = null;
  let lastResponseOutput: unknown[] = [];
  let selectedChannel: SelectedChannel | null = null;
  let selectedPolicyIdentity = '';
  let activeTurnMetadata: ReturnType<typeof parseCodexTurnMetadata> = null;
  let activeTurnClientContext: ReturnType<typeof detectDownstreamClientContext> | null = null;
  let activeBridgeRouteResolution: BridgeRouteResolution = {
    plan: null,
    ignoredReason: 'not_bridge_request',
  };
  let activeBridgeRouteIdentity = 'none';
  let activeTurnLease: DownstreamConcurrencyLease | null = null;
  let messageQueue = Promise.resolve();

  socket.once('close', () => {
    void activeTurnLease?.release();
    activeTurnLease = null;
    const sessionKeys = runtimeSessionKeys.size > 0
      ? Array.from(runtimeSessionKeys)
      : [websocketSessionId];
    void Promise.all(sessionKeys.map(async (sessionKey) => {
      try {
        await codexWebsocketRuntime.closeSession(sessionKey);
      } catch {
        // Ignore close-time cleanup failures after downstream disconnects.
      }
    }));
  });

  socket.on('message', (raw) => {
    messageQueue = messageQueue
      .catch(() => undefined)
      .then(async () => {
        let turnLease: DownstreamConcurrencyLease | null = null;
        try {
          const parsed = parseJsonObject(raw);
          if (!parsed) {
            writeResponsesWebsocketError(socket, 400, 'Invalid websocket JSON payload');
            return;
          }

          const turnAuthResult = await authorizeDownstreamToken(authContext.token);
          if (!turnAuthResult.ok) {
            writeResponsesWebsocketError(socket, turnAuthResult.statusCode, turnAuthResult.error);
            return;
          }
          const turnSnapshot = resolveDownstreamPolicySnapshot(turnAuthResult);
          const leaseResult = await acquireDownstreamConcurrencyLease(turnSnapshot);
          if (!leaseResult.ok) {
            writeResponsesWebsocketError(socket, leaseResult.statusCode, leaseResult.error);
            return;
          }
          turnLease = leaseResult.lease;
          activeTurnLease = turnLease;
          const turnAuthContext: ResponsesWebsocketAuthContext = {
            ...turnAuthResult,
            policy: turnSnapshot.policy,
            snapshot: turnSnapshot,
          };
          const proxyAuthContext: ProxyAuthContext = {
            token: turnAuthContext.token,
            source: turnAuthContext.source,
            keyId: turnAuthContext.key.id,
            keyName: turnAuthContext.key.name,
            policy: turnSnapshot.policy,
            snapshot: turnSnapshot,
          };
          const turnPolicyIdentity = [
            turnSnapshot.source,
            turnSnapshot.keyId ?? 'internal',
            turnSnapshot.policyVersion,
            turnSnapshot.tokenFingerprint,
          ].join(':');
          if (selectedPolicyIdentity && selectedPolicyIdentity !== turnPolicyIdentity) {
            selectedChannel = null;
          }
          selectedPolicyIdentity = turnPolicyIdentity;

          const requestType = asTrimmedString(parsed.type);
          let turnMetadata = activeTurnMetadata;
          let turnClientContext = activeTurnClientContext;
          let bridgeRouteResolution = activeBridgeRouteResolution;
          if (requestType === 'response.create') {
            turnMetadata = parseCodexTurnMetadata({
              headers: request.headers as Record<string, unknown>,
              body: parsed,
            });
            turnClientContext = detectDownstreamClientContext({
              downstreamPath: '/v1/responses',
              headers: request.headers as Record<string, unknown>,
              body: parsed,
            });
            bridgeRouteResolution = await resolveBridgeProxyRoutePlan({
              directive: turnMetadata?.bridgeRouteDirective || null,
              identity: turnMetadata?.identity || {
                sessionId: turnClientContext.sessionId || websocketSessionId,
                threadId: turnClientContext.threadId || null,
                turnId: turnClientContext.turnId || null,
                requestKind: null,
              },
              downstreamApiKeyId: turnAuthContext.key?.id ?? null,
              hardContinuity: carriesHardResponsesContinuity(parsed),
            });
            const bridgeRouteIdentity = buildBridgeRouteResolutionIdentity(
              turnMetadata,
              bridgeRouteResolution,
            );
            if (bridgeRouteIdentity !== activeBridgeRouteIdentity) {
              selectedChannel = null;
            }
            activeTurnMetadata = turnMetadata;
            activeTurnClientContext = turnClientContext;
            activeBridgeRouteResolution = bridgeRouteResolution;
            activeBridgeRouteIdentity = bridgeRouteIdentity;
          } else if (!turnClientContext) {
            turnClientContext = detectDownstreamClientContext({
              downstreamPath: '/v1/responses',
              headers: request.headers as Record<string, unknown>,
              body: parsed,
            });
          }

          const requestModel = asTrimmedString(parsed.model) || asTrimmedString(lastRequest?.model);
          if (requestModel && !await isModelAllowedByPolicyOrAllowedRoutes(requestModel, turnAuthContext.policy)) {
            writeResponsesWebsocketError(socket, 403, 'model is not allowed for this downstream key');
            return;
          }
          const serviceTierPolicy = applyOpenAiServiceTierPolicy({
            body: parsed,
            context: {
              requestedModel: requestModel,
            },
            rules: getServiceTierPolicyRules(),
          });
          if (!serviceTierPolicy.ok) {
            writeResponsesWebsocketError(
              socket,
              serviceTierPolicy.statusCode,
              serviceTierPolicy.payload.error.message,
              serviceTierPolicy.payload,
            );
            return;
          }
          parsed.service_tier = serviceTierPolicy.body.service_tier;
          if (serviceTierPolicy.body.service_tier === undefined) delete parsed.service_tier;
          if (
            bridgeRouteResolution.plan
            && !shouldReuseSelectedChannel(selectedChannel, requestModel)
          ) {
            selectedChannel = requestModel
              ? await selectProxyChannelForAttempt({
                requestedModel: requestModel,
                downstreamPolicy: turnAuthContext.policy,
                excludeChannelIds: [],
                retryCount: 0,
                bridgeRoutePlan: bridgeRouteResolution.plan,
                excludeCredentials: [],
              })
              : null;
          }
          const supportsIncrementalInput = selectedChannelSupportsIncrementalInput(selectedChannel, requestModel)
            || (
              !bridgeRouteResolution.plan
              && await supportsResponsesWebsocketIncrementalInput(parsed, lastRequest, turnAuthContext)
            );
          const shouldHandleLocalPrewarm = shouldHandleResponsesWebsocketPrewarmLocally(
            parsed,
            lastRequest,
            supportsIncrementalInput,
          );
          const normalized = normalizeResponsesWebsocketRequest(
            parsed,
            lastRequest,
            lastResponseOutput,
            supportsIncrementalInput,
          );
          if (!normalized.ok) {
            writeResponsesWebsocketError(socket, normalized.status, normalized.message);
            return;
          }

          if (turnAuthContext.source === 'managed' && turnAuthContext.key?.id) {
            await consumeManagedKeyRequest(turnAuthContext.key.id);
          }

          if (shouldHandleLocalPrewarm) {
            lastRequest = normalized.nextRequestSnapshot;
            lastResponseOutput = [];
            for (const payload of synthesizePrewarmResponsePayloads(normalized.request)) {
              socket.send(JSON.stringify(payload));
            }
            return;
          }

          if (!shouldReuseSelectedChannel(selectedChannel, requestModel)) {
            selectedChannel = requestModel
              ? await selectProxyChannelForAttempt({
                requestedModel: requestModel,
                downstreamPolicy: turnAuthContext.policy,
                excludeChannelIds: [],
                retryCount: 0,
                bridgeRoutePlan: bridgeRouteResolution.plan,
                excludeCredentials: [],
              })
              : null;
          }

          const selectedServiceTierPolicy = applyOpenAiServiceTierPolicy({
            body: normalized.request,
            context: {
              requestedModel: requestModel,
              actualModel: asTrimmedString(selectedChannel?.actualModel),
              sitePlatform: asTrimmedString(selectedChannel?.site?.platform),
              accountType: getOauthInfoFromAccount(selectedChannel?.account)?.planType,
            },
            rules: getServiceTierPolicyRules(),
          });
          if (!selectedServiceTierPolicy.ok) {
            writeResponsesWebsocketError(
              socket,
              selectedServiceTierPolicy.statusCode,
              selectedServiceTierPolicy.payload.error.message,
              selectedServiceTierPolicy.payload,
            );
            return;
          }
          normalized.request = selectedServiceTierPolicy.body;
          normalized.nextRequestSnapshot = {
            ...normalized.nextRequestSnapshot,
            service_tier: selectedServiceTierPolicy.body.service_tier,
          };
          if (selectedServiceTierPolicy.body.service_tier === undefined) {
            delete normalized.nextRequestSnapshot.service_tier;
          }
          lastRequest = normalized.nextRequestSnapshot;

          const codexWebsocketChannel = selectedChannelSupportsCodexWebsocketTransport(selectedChannel, requestModel)
            ? selectedChannel
            : null;

          if (codexWebsocketChannel) {
            const turnSessionId = turnClientContext?.sessionId
              || turnMetadata?.identity.sessionId
              || websocketSessionId;
            const downstreamHeaders: Record<string, unknown> = {
              ...(request.headers as Record<string, unknown>),
              [RESPONSES_WEBSOCKET_TRANSPORT_HEADER]: '1',
              ...(supportsIncrementalInput ? { [RESPONSES_WEBSOCKET_MODE_HEADER]: 'incremental' } : {}),
            };
            const providerHeaders = buildOauthProviderHeaders({
              account: codexWebsocketChannel.account,
              downstreamHeaders,
            });

            const websocketRuntimeSessionKey = buildCodexSessionResponseStoreKey({
              sessionId: turnSessionId,
              siteId: codexWebsocketChannel.site.id,
              accountId: codexWebsocketChannel.account.id,
              channelId: codexWebsocketChannel.channel.id,
            }) || websocketSessionId;
            runtimeSessionKeys.add(websocketRuntimeSessionKey);

            const websocketAttemptLedger = await startProxyAttemptLedgerSession({
              requestedModel: requestModel || asTrimmedString(codexWebsocketChannel.actualModel) || 'unknown',
              downstreamPath: '/v1/responses',
              clientKind: turnClientContext?.clientKind || 'responses-websocket',
              sessionId: turnSessionId,
              clientThreadId: turnClientContext?.threadId || turnMetadata?.identity.threadId || null,
              clientTurnId: turnClientContext?.turnId || turnMetadata?.identity.turnId || null,
              bridgeTaskId: turnMetadata?.bridgeRouteDirective?.taskId || null,
              bridgeRouteAction: turnMetadata?.bridgeRouteDirective?.routeAction || null,
              bridgeContinuationNumber: turnMetadata?.bridgeRouteDirective?.continuationNumber ?? null,
              downstreamApiKeyId: turnAuthContext.key?.id ?? null,
              channelId: codexWebsocketChannel.channel.id,
              accountId: codexWebsocketChannel.account.id,
              tokenId: codexWebsocketChannel.token?.id ?? null,
              policy: {
                retryOwner: resolveApiChannelRetryPolicy(codexWebsocketChannel.channel).retryOwner,
                replaySafety: 'safe_only',
                retryBudget: createRetryBudget({ maxAttempts: 2 }),
              },
            });
            const websocketAttemptIdentities = new Map<number, { attemptId: string; attemptIndex: number }>();
            let websocketRequestFinished = false;
            let websocketSawUnknownAttempt = false;
            let websocketSawKnownFailure = false;
            const finishWebsocketRequest = async (status: 'succeeded' | 'failed' | 'unknown') => {
              if (websocketRequestFinished) return;
              websocketRequestFinished = true;
              await websocketAttemptLedger?.finishRequest(status);
            };
            const observeWebsocketAttempt = async (event: Parameters<NonNullable<Parameters<typeof codexWebsocketRuntime.sendRequest>[0]['onAttemptEvent']>>[0]) => {
              if (!websocketAttemptLedger) return;
              if (event.type === 'attempt_started') {
                const identity = await websocketAttemptLedger.beginAttempt({
                  endpoint: 'responses-websocket',
                  requestPath: event.requestPath,
                  targetUrl: event.requestUrl,
                });
                websocketAttemptIdentities.set(event.attemptIndex, identity);
                return;
              }
              const identity = websocketAttemptIdentities.get(event.attemptIndex);
              if (!identity) return;
              if (event.type === 'request_sent') {
                await websocketAttemptLedger.markAttemptCommit({
                  attemptId: identity.attemptId,
                  event: 'request_sent',
                });
                return;
              }
              if (event.type === 'response_started') {
                await websocketAttemptLedger.markAttemptCommit({
                  attemptId: identity.attemptId,
                  event: 'response_started',
                  statusCode: event.status ?? null,
                });
                return;
              }
              if (event.type === 'completed') {
                await websocketAttemptLedger.finishAttempt({
                  attemptId: identity.attemptId,
                  status: 'succeeded',
                  commitState: 'completed',
                  statusCode: event.status ?? 200,
                });
                return;
              }
              if (event.type === 'failed') {
                const terminal = event.terminal === true;
                await websocketAttemptLedger.finishAttempt({
                  attemptId: identity.attemptId,
                  status: 'failed',
                  commitState: terminal
                    ? 'completed'
                    : (event.responseStarted ? 'response_started' : 'request_sent'),
                  errorScope: classifyRetryErrorScope({
                    status: event.status ?? 0,
                    rawErrorText: event.message || '',
                  }),
                  statusCode: event.status ?? null,
                  errorSummary: event.message || null,
                });
                if (!event.recoverable) websocketSawKnownFailure = true;
                return;
              }
              if (event.type === 'transport_unknown') {
                await websocketAttemptLedger.markAttemptCommit({
                  attemptId: identity.attemptId,
                  event: 'transport_unknown',
                  statusCode: event.status ?? 408,
                  errorSummary: event.message || 'upstream websocket closed before terminal response',
                });
                websocketSawUnknownAttempt = true;
              }
            };

            try {
              const runtimeResult = await runWithSiteApiEndpointPool(
                codexWebsocketChannel.site as Parameters<typeof runWithSiteApiEndpointPool>[0],
                async (target) => {
                  const prepared = buildUpstreamEndpointRequest({
                    endpoint: 'responses',
                    modelName: asTrimmedString(codexWebsocketChannel.actualModel) || requestModel,
                    stream: true,
                    tokenValue: codexWebsocketChannel.tokenValue,
                    sitePlatform: codexWebsocketChannel.site.platform,
                    siteUrl: target.baseUrl,
                    codexFingerprintEnabled: (codexWebsocketChannel.site as { codexFingerprintEnabled?: boolean }).codexFingerprintEnabled === true,
                    openaiBody: normalized.request,
                    downstreamFormat: 'responses',
                    responsesOriginalBody: normalized.request,
                    downstreamHeaders,
                    providerHeaders,
                    codexExplicitSessionId: deriveCodexExplicitSessionId(normalized.request, turnSessionId),
                  });
                  const requestUrl = `${target.baseUrl.replace(/\/+$/, '')}${prepared.path}`;

                  try {
                    return await codexWebsocketRuntime.sendRequest({
                      sessionId: websocketRuntimeSessionKey,
                      requestUrl,
                      headers: prepared.headers,
                      body: prepared.body,
                      onAttemptEvent: observeWebsocketAttempt,
                    });
                  } catch (error) {
                    const runtimeError = error instanceof CodexWebsocketRuntimeError
                      ? error
                      : new CodexWebsocketRuntimeError('upstream websocket request failed');
                    throw new SiteApiEndpointRequestError(runtimeError.message, {
                      status: runtimeError.status,
                      cause: runtimeError,
                    });
                  }
                },
              );
              lastResponseOutput = collectResponsesOutput(runtimeResult.events);
              for (const payload of runtimeResult.events) {
                socket.send(JSON.stringify(payload));
              }
              const terminalType = runtimeResult.events
                .map((payload) => asTrimmedString(payload.type))
                .find((type) => type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete');
              await finishWebsocketRequest(
                websocketSawUnknownAttempt
                  ? 'unknown'
                  : terminalType === 'response.completed'
                    ? 'succeeded'
                    : 'failed',
              );
            } catch (error) {
              const runtimeError = unwrapCodexWebsocketRuntimeError(error);
              if (!websocketRequestFinished) {
                await finishWebsocketRequest(
                  websocketSawUnknownAttempt
                    ? 'unknown'
                    : 'failed',
                );
              }
              if (runtimeError.status && runtimeError.events.length === 0) {
                const forwarded = await forwardResponsesRequestViaHttp({
                  app,
                  socket,
                  request,
                  payload: normalized.request,
                  preserveIncrementalMode: supportsIncrementalInput,
                  authContext: proxyAuthContext,
                });
                if (forwarded) {
                  lastResponseOutput = forwarded;
                }
                return;
              }
              lastResponseOutput = collectResponsesOutput(runtimeError.events);
              for (const payload of runtimeError.events) {
                socket.send(JSON.stringify(payload));
              }
              const emittedTerminalResponsesEvent = runtimeError.events.some((payload) => {
                if (!isRecord(payload)) return false;
                const type = asTrimmedString(payload.type);
                return type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete';
              });
              if (!emittedTerminalResponsesEvent) {
                writeResponsesWebsocketError(
                  socket,
                  runtimeError.status || 408,
                  runtimeError.message,
                  runtimeError.payload,
                );
              }
            }
            return;
          }

          const forwarded = await forwardResponsesRequestViaHttp({
            app,
            socket,
            request,
            payload: normalized.request,
            preserveIncrementalMode: supportsIncrementalInput,
            authContext: proxyAuthContext,
          });
          if (forwarded) {
            lastResponseOutput = forwarded;
          }
        } catch {
          writeResponsesWebsocketError(socket, 500, 'internal websocket proxy error');
        } finally {
          if (activeTurnLease === turnLease) {
            activeTurnLease = null;
          }
          await turnLease?.release();
        }
      });
  });
}

export function ensureResponsesWebsocketTransport(app: FastifyInstance) {
  if (installedApps.has(app)) return;
  installedApps.add(app);

  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on('headers', (headers, request) => {
    const turnState = headerValueToTrimmedString(request.headers[WS_TURN_STATE_HEADER]);
    if (!turnState) return;
    headers.push(`${WS_TURN_STATE_HEADER}: ${turnState}`);
  });

  app.server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== '/v1/responses') return;
      const token = extractWebsocketAuthToken(request, url);
      if (!token) {
        writeUpgradeHttpError(socket, 401, 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter');
        return;
      }
      const authResult = await authorizeDownstreamToken(token);
      if (!authResult.ok) {
        writeUpgradeHttpError(socket, authResult.statusCode, authResult.error);
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        void handleResponsesWebsocketConnection(app, client, request, authResult);
      });
    })().catch(() => {
      writeUpgradeHttpError(socket, 500, 'internal websocket proxy error');
    });
  });

  app.addHook('onClose', async () => {
    await codexWebsocketRuntime.closeAllSessions();
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
  });
}
