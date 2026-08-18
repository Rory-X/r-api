import {
  clearAuthSession,
  getCsrfToken,
  notifyAuthSessionExpired,
  persistAuthSession,
} from "./authSession.js";

type BufferLike = {
  from(data: ArrayBuffer): { toString(encoding: "base64"): string };
};

const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: BufferLike })
  .Buffer;

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

export type AdminAuthenticatedSession = {
  authenticated: true;
  csrfToken: string;
  expiresAt: string;
  secondFactorVerified: boolean;
};

export type AdminSessionResponse =
  | { authenticated: false }
  | AdminAuthenticatedSession;

export type AdminLoginTotpChallenge = {
  success: true;
  authenticated: false;
  requiresTotp: true;
  challengeToken: string;
  expiresAt: string;
};

export type AdminLoginResponse = AdminAuthenticatedSession | AdminLoginTotpChallenge;

export type AdminTotpStatus = {
  enabled: boolean;
  recoveryCodesRemaining: number;
  enabledAt: string | null;
};

export type AdminAuthInfo = {
  masked: string;
  algorithm: string;
  sessionTtlMs: number;
  totp: AdminTotpStatus;
};

export type AdminTotpSetupResponse = {
  success: true;
  setupToken: string;
  secret: string;
  otpauthUrl: string;
  expiresAt: string;
};

export type AdminRecoveryCodesResponse = {
  success: true;
  recoveryCodes: string[];
  recoveryCodesRemaining: number;
};

function isMutationMethod(method: string | undefined): boolean {
  const normalized = (method || "GET").trim().toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

function getBrowserSessionStorage(): Storage | null {
  return typeof sessionStorage !== "undefined" ? sessionStorage : null;
}

async function refreshAdminSessionMetadata(): Promise<string> {
  const response = await fetch("/api/auth/session", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    notifyAuthSessionExpired();
    throw new Error("Session expired");
  }
  const session = await response.json() as AdminSessionResponse;
  if (!session.authenticated) {
    notifyAuthSessionExpired();
    throw new Error("Session expired");
  }
  persistAuthSession(getBrowserSessionStorage(), session.csrfToken, session.expiresAt);
  return session.csrfToken;
}

async function requireCsrfToken(): Promise<string> {
  return getCsrfToken(getBrowserSessionStorage()) || await refreshAdminSessionMetadata();
}

async function extractResponseErrorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        if (json?.message && typeof json.message === "string") {
          message = json.message;
        } else if (json?.error && typeof json.error === "string") {
          message = json.error;
        } else if (
          json?.error?.message &&
          typeof json.error.message === "string"
        ) {
          message = json.error.message;
        } else {
          message = `${message}: ${text.slice(0, 120)}`;
        }
      } catch {
        message = `${message}: ${text.slice(0, 120)}`;
      }
    }
  } catch {}
  return message;
}

function createHttpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function parseContentDispositionFilename(
  headerValue: string | null,
): string | null {
  if (!headerValue) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = /filename=([^;]+)/i.exec(headerValue);
  return bareMatch?.[1]?.trim() || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (nodeBuffer) {
    return nodeBuffer.from(buffer).toString("base64");
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchAuthenticatedResponse(
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let cleanupExternalSignal = () => {};

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener("abort", abortHandler, { once: true });
      cleanupExternalSignal = () =>
        externalSignal.removeEventListener("abort", abortHandler);
    }
  }

  const headers = new Headers(fetchOptions.headers ?? {});
  if (isMutationMethod(fetchOptions.method)) {
    headers.set("X-Metapi-CSRF", await requireCsrfToken());
  }
  if (fetchOptions.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers,
      credentials: "same-origin",
    });
    if (res.status === 401) {
      notifyAuthSessionExpired();
      throw new Error("Session expired");
    }
    return res;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) throw error;
      throw new Error(
        `请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`,
      );
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    cleanupExternalSignal();
  }
}

async function request<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await fetchAuthenticatedResponse(url, options);
  if (!res.ok) {
    throw createHttpError(res.status, await extractResponseErrorMessage(res));
  }
  return res.json() as Promise<T>;
}

async function requestPublic<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    timeoutMs = 30_000,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(), timeoutMs);
  let cleanupExternalSignal = () => {};
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', abortHandler, { once: true });
      cleanupExternalSignal = () => externalSignal.removeEventListener('abort', abortHandler);
    }
  }
  const headers = new Headers(fetchOptions.headers ?? {});
  if (fetchOptions.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers,
      credentials: "same-origin",
    });
    if (!res.ok) throw createHttpError(res.status, await extractResponseErrorMessage(res));
    return res.json() as Promise<T>;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (externalSignal?.aborted) throw error;
      throw new Error(`请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`);
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    timeoutHandle = null;
    cleanupExternalSignal();
  }
}

async function streamSse(
  url: string,
  handlers: {
    onLog?: (entry: any) => void;
    onDone?: (payload: any) => void;
    signal?: AbortSignal;
  },
) {
  const response = await fetchAuthenticatedResponse(url, {
    method: "GET",
    signal: handlers.signal,
    headers: {
      Accept: "text/event-stream",
    },
    timeoutMs: 120_000,
  });

  if (!response.ok) {
    throw new Error(await extractResponseErrorMessage(response));
  }
  if (!response.body) {
    throw new Error("响应未返回流式内容");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  const flushBuffer = (final = false) => {
    const chunks = final ? [...buffer.split("\n\n"), ""] : buffer.split("\n\n");
    if (!final) buffer = chunks.pop() || "";
    else buffer = "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (dataLines.length <= 0) continue;
      let payload: any = dataLines.join("\n");
      try {
        payload = JSON.parse(payload);
      } catch {
        // keep string payload
      }

      if (eventName === "log") {
        handlers.onLog?.(payload);
      } else if (eventName === "done") {
        handlers.onDone?.(payload);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushBuffer(false);
  }

  if (buffer.trim()) {
    flushBuffer(true);
  }
}

function buildQueryString(
  params?: Record<string, string | number | boolean | null | undefined>,
) {
  if (!params) return "";
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

type TestChatRequestPayload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  targetFormat?: "openai" | "claude" | "responses" | "gemini";
  stream?: boolean;
  forcedChannelId?: number | null;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export type ProxyTestMethod = "POST" | "GET" | "DELETE";
export type ProxyTestRequestKind = "json" | "multipart" | "empty";

export type ProxyTestMultipartFile = {
  field: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ProxyTestRequestEnvelope = {
  method: ProxyTestMethod;
  path: string;
  requestKind: ProxyTestRequestKind;
  stream?: boolean;
  jobMode?: boolean;
  rawMode?: boolean;
  forcedChannelId?: number | null;
  jsonBody?: unknown;
  rawJsonText?: string;
  multipartFields?: Record<string, string>;
  multipartFiles?: ProxyTestMultipartFile[];
};

const DEFAULT_PROXY_TEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_PROXY_TEST_TIMEOUT_MS = 150_000;

function resolveProxyTestTimeoutMs(data: ProxyTestRequestEnvelope) {
  if (data.jobMode) return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/images/generations")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/images/edits")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/videos" && data.method === "POST")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  return DEFAULT_PROXY_TEST_TIMEOUT_MS;
}

function proxyTestRequest(data: ProxyTestRequestEnvelope) {
  return request("/api/test/proxy", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

async function proxyTestStreamRequest(
  data: ProxyTestRequestEnvelope,
  signal?: AbortSignal,
) {
  return fetchAuthenticatedResponse("/api/test/proxy/stream", {
    method: "POST",
    signal,
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

export type ProxyTestJobResponse = {
  jobId: string;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  result?: unknown;
  error?: unknown;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type SystemProxyTestRequest = {
  proxyUrl?: string;
};

export type SystemProxyTestResponse = {
  success: true;
  proxyUrl: string;
  probeUrl: string;
  finalUrl: string;
  reachable: true;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
};

export type RuntimeRoutingWeightsPayload = {
  baseWeightFactor?: number;
  valueScoreFactor?: number;
  costWeight?: number;
  balanceWeight?: number;
  usageWeight?: number;
};

export type RuntimeSettingsPayload = {
  systemProxyUrl?: string;
  payloadRules?: Record<string, unknown> | null;
  modelAvailabilityProbeEnabled?: boolean;
  codexUpstreamWebsocketEnabled?: boolean;
  responsesCompactFallbackToResponsesEnabled?: boolean;
  disableCrossProtocolFallback?: boolean;
  proxySessionChannelConcurrencyLimit?: number;
  proxySessionChannelQueueWaitMs?: number;
  proxyDebugTraceEnabled?: boolean;
  proxyDebugCaptureHeaders?: boolean;
  proxyDebugCaptureBodies?: boolean;
  proxyDebugCaptureStreamChunks?: boolean;
  proxyDebugTargetSessionId?: string;
  proxyDebugTargetClientKind?: string;
  proxyDebugTargetModel?: string;
  proxyDebugRetentionHours?: number;
  proxyDebugMaxBodyBytes?: number;
  checkinCron?: string;
  checkinScheduleMode?: "cron" | "interval";
  checkinIntervalHours?: number;
  checkinSchedulePolicy?: {
    timeZone?: string;
    windowStart?: string;
    windowEnd?: string;
    jitterMinutes?: number;
    catchUp?: boolean;
  };
  balanceRefreshCron?: string;
  logCleanupCron?: string;
  logCleanupUsageLogsEnabled?: boolean;
  logCleanupProgramLogsEnabled?: boolean;
  logCleanupRetentionDays?: number;
  webhookUrl?: string;
  barkUrl?: string;
  webhookEnabled?: boolean;
  barkEnabled?: boolean;
  serverChanEnabled?: boolean;
  serverChanKey?: string;
  telegramEnabled?: boolean;
  telegramApiBaseUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramUseSystemProxy?: boolean;
  telegramMessageThreadId?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpTo?: string;
  notifyCooldownSec?: number;
  notifyDeliveryPolicy?: "prefer_delivery" | "prefer_no_duplicate";
  adminIpAllowlist?: string[] | string;
  routingFallbackUnitCost?: number;
  proxyFirstByteTimeoutSec?: number;
  firstByteRoutingPolicy?: {
    enabled?: boolean;
    baselineMs?: number;
    penaltyWindowMs?: number;
    maxPenaltyRatio?: number;
    minSamples?: number;
  };
  tokenRouterFailureCooldownMaxSec?: number;
  routingWeights?: RuntimeRoutingWeightsPayload;
  proxyErrorKeywords?: string[] | string;
  proxyEmptyContentFailEnabled?: boolean;
  globalBlockedBrands?: string[];
  globalAllowedModels?: string[];
  balanceRoutingPolicy?: {
    mode?: 'observe_only' | 'soft_avoid' | 'hard_block';
    threshold?: number;
    softAvoidMultiplier?: number;
  };
};

export type ProxyLogStatusFilter = "all" | "success" | "failed";
export type ProxyLogClientConfidence = "exact" | "heuristic" | "unknown" | null;
export type ProxyLogUsageSource = "upstream" | "self-log" | "unknown" | null;

export type RoutingObservabilityChannel = {
  channelId: number;
  label: string;
  siteName: string | null;
  accountName: string | null;
  selectedRequests: number;
  selectedAttempts: number;
  selectionShare: number;
  successfulAttempts: number;
  failedAttempts: number;
  currentFailCount: number;
  currentConsecutiveFailCount: number;
  currentCooldownUntil: string | null;
  enabled: boolean;
};

export type RoutingObservabilityRoute = {
  routeId: number | null;
  routeName: string;
  modelPattern: string | null;
  routingStrategy: string | null;
  enabled: boolean | null;
  requests: number;
  finalSuccessCount: number;
  finalSuccessRate: number;
  firstAttemptSuccessCount: number;
  firstAttemptSuccessRate: number;
  failoverRecoveredCount: number;
  failoverRecoveredRate: number;
  averageAttempts: number;
  p95LatencyMs: number | null;
  p95FirstByteLatencyMs: number | null;
  totalCost: number;
  successfulRequestCost: number | null;
  status503Count: number;
  channels: RoutingObservabilityChannel[];
};

export type RoutingObservabilityResponse = {
  generatedAt: string;
  range: { hours: number; from: string; to: string };
  caveats: string[];
  totals: {
    requests: number;
    finalSuccessCount: number;
    finalFailureCount: number;
    finalSuccessRate: number;
    firstAttemptSuccessCount: number;
    firstAttemptFailureCount: number;
    firstAttemptSuccessRate: number;
    failoverRecoveredCount: number;
    failoverRecoveredRate: number;
    averageAttempts: number;
    p95LatencyMs: number | null;
    p95FirstByteLatencyMs: number | null;
    totalCost: number;
    successfulRequestCost: number | null;
    status503Count: number;
  };
  routes: RoutingObservabilityRoute[];
  sampledLogRows: number;
  truncated: boolean;
};

export type ProxyLogBillingDetails = {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
} | null;

export type ProxyLogListItem = {
  id: number;
  createdAt: string;
  modelRequested: string;
  modelActual: string;
  status: string;
  latencyMs: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  totalTokens: number | null;
  retryCount: number;
  accountId?: number | null;
  siteId?: number | null;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
  downstreamKeyId?: number | null;
  downstreamKeyName?: string | null;
  downstreamKeyGroupName?: string | null;
  downstreamKeyTags?: string[];
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: ProxyLogClientConfidence;
  usageSource?: ProxyLogUsageSource;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCost?: number | null;
};

export type ProxyLogDetail = ProxyLogListItem & {
  routeId?: number | null;
  channelId?: number | null;
  httpStatus?: number | null;
  billingDetails?: ProxyLogBillingDetails;
};

export type ProxyLogsSummary = {
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalCost: number;
  totalTokensAll: number;
};

export type ProxyLogsQuery = {
  limit?: number;
  offset?: number;
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: string;
  siteId?: number;
  from?: string;
  to?: string;
};

export type ProxyLogClientOption = {
  value: string;
  label: string;
};

export type ProxyLogsResponse = {
  items: ProxyLogListItem[];
  total: number;
  page: number;
  pageSize: number;
  clientOptions: ProxyLogClientOption[];
  summary: ProxyLogsSummary;
};

export type ProxyRequestLedgerStatus =
  | "active"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type ProxyAttemptLedgerStatus =
  | "in_flight"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type ProxyAttemptCommitState =
  | "not_started"
  | "request_sent"
  | "response_started"
  | "completed"
  | "sent_unknown";

export type ProxyRequestLedgerListItem = {
  id: number;
  requestId: string;
  requestedModel: string;
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  clientThreadId?: string | null;
  clientTurnId?: string | null;
  bridgeTaskId?: string | null;
  bridgeRouteAction?: string | null;
  bridgeContinuationNumber?: number | null;
  downstreamApiKeyId?: number | null;
  downstreamApiKeyName?: string | null;
  status: ProxyRequestLedgerStatus;
  retryOwner: "local_proxy" | "upstream_gateway" | "cooperative";
  replaySafety: "safe_only" | "allow_explicit";
  policySnapshot: Record<string, unknown>;
  retryBudget: {
    startedAtMs: number;
    limits: {
      maxElapsedMs: number | null;
      maxAttempts: number | null;
      maxCredentialRotations: number | null;
      maxChannelSwitches: number | null;
    };
    attempts: number;
    credentialRotations: number;
    channelSwitches: number;
  };
  attemptCount: number;
  latestCommitState?: ProxyAttemptCommitState | null;
  hasSentUnknown: boolean;
  createdAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
};

export type ProxyRequestLedgerAttemptDetail = {
  id: number;
  attemptId: string;
  attemptIndex: number;
  channelId?: number | null;
  routeId?: number | null;
  routeModelPattern?: string | null;
  accountId?: number | null;
  accountUsername?: string | null;
  siteId?: number | null;
  siteName?: string | null;
  credentialId?: number | null;
  credentialName?: string | null;
  endpoint?: string | null;
  requestPath?: string | null;
  targetUrl?: string | null;
  status: ProxyAttemptLedgerStatus;
  commitState: ProxyAttemptCommitState;
  errorScope?: string | null;
  statusCode?: number | null;
  errorSummary?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
};

export type ProxyRequestLedgerDetail = ProxyRequestLedgerListItem & {
  attempts: ProxyRequestLedgerAttemptDetail[];
};

export type ProxyRequestLedgerSummary = {
  total: number;
  active: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  unknown: number;
  sentUnknown: number;
};

export type ProxyRequestLedgersQuery = {
  limit?: number;
  offset?: number;
  status?: ProxyRequestLedgerStatus | "all";
  commitState?: ProxyAttemptCommitState | "all";
  search?: string;
};

export type ProxyRequestLedgersResponse = {
  items: ProxyRequestLedgerListItem[];
  total: number;
  limit: number;
  offset: number;
  summary: ProxyRequestLedgerSummary;
};

export type ProxyDebugTraceListItem = {
  id: number;
  createdAt: string;
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  requestedModel?: string | null;
  selectedChannelId?: number | null;
  finalStatus?: string | null;
  finalHttpStatus?: number | null;
  finalUpstreamPath?: string | null;
};

export type ProxyDebugTraceDetail = {
  trace: {
    id: number;
    createdAt?: string | null;
    updatedAt?: string | null;
    downstreamPath?: string | null;
    clientKind?: string | null;
    sessionId?: string | null;
    traceHint?: string | null;
    requestedModel?: string | null;
    stickySessionKey?: string | null;
    stickyHitChannelId?: number | null;
    selectedChannelId?: number | null;
    selectedRouteId?: number | null;
    selectedAccountId?: number | null;
    selectedSiteId?: number | null;
    selectedSitePlatform?: string | null;
    endpointCandidatesJson?: string | null;
    endpointRuntimeStateJson?: string | null;
    decisionSummaryJson?: string | null;
    requestHeadersJson?: string | null;
    requestBodyJson?: string | null;
    finalStatus?: string | null;
    finalHttpStatus?: number | null;
    finalUpstreamPath?: string | null;
    finalResponseHeadersJson?: string | null;
    finalResponseBodyJson?: string | null;
  };
  attempts: Array<{
    id: number;
    attemptIndex: number;
    endpoint: string;
    requestPath: string;
    targetUrl: string;
    runtimeExecutor?: string | null;
    requestHeadersJson?: string | null;
    requestBodyJson?: string | null;
    responseStatus?: number | null;
    responseHeadersJson?: string | null;
    responseBodyJson?: string | null;
    rawErrorText?: string | null;
    recoverApplied?: boolean | null;
    downgradeDecision?: boolean | null;
    downgradeReason?: string | null;
    memoryWriteJson?: string | null;
    createdAt?: string | null;
  }>;
};

export type ProxyDebugTracesResponse = {
  items: ProxyDebugTraceListItem[];
};

export type OAuthProviderInfo = {
  provider: string;
  label: string;
  platform: string;
  enabled: boolean;
  loginType: "oauth";
  requiresProjectId: boolean;
  supportsDirectAccountRouting: boolean;
  supportsCloudValidation: boolean;
  supportsNativeProxy: boolean;
};

export type OAuthProvidersResponse = {
  providers: OAuthProviderInfo[];
  defaults?: {
    systemProxyConfigured?: boolean;
  };
};

export type OAuthRouteUnitStrategy = "round_robin" | "stick_until_unavailable";

export type OAuthRouteUnitSummary = {
  id?: number;
  routeUnitId?: number;
  name: string;
  strategy: OAuthRouteUnitStrategy;
  memberCount: number;
};

export type OAuthRouteParticipation =
  | {
      kind: "single";
    }
  | ({
      kind: "route_unit";
    } & OAuthRouteUnitSummary);

export type OAuthStartInstructions = {
  redirectUri: string;
  callbackPort: number;
  callbackPath: string;
  manualCallbackDelayMs: number;
  sshTunnelCommand?: string;
  sshTunnelKeyCommand?: string;
};

export type OAuthStartResponse = {
  provider: string;
  state: string;
  authorizationUrl: string;
  instructions: OAuthStartInstructions;
};

export type OAuthSessionInfo = {
  provider: string;
  state: string;
  status: "pending" | "success" | "error";
  accountId?: number;
  siteId?: number;
  error?: string;
};

export type OAuthQuotaWindowInfo = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string | null;
};

export type OAuthQuotaInfo = {
  status: "supported" | "unsupported" | "error";
  source: "official" | "reverse_engineered";
  lastSyncAt?: string | null;
  lastError?: string | null;
  providerMessage?: string | null;
  subscription?: {
    planType?: string | null;
    activeStart?: string | null;
    activeUntil?: string | null;
  } | null;
  windows: {
    fiveHour: OAuthQuotaWindowInfo;
    sevenDay: OAuthQuotaWindowInfo;
  };
  lastLimitResetAt?: string | null;
};

export type OAuthConnectionInfo = {
  accountId: number;
  siteId: number;
  provider: string;
  username?: string | null;
  email?: string | null;
  accountKey?: string | null;
  planType?: string | null;
  projectId?: string | null;
  modelCount: number;
  modelsPreview: string[];
  status: "healthy" | "abnormal";
  quota?: OAuthQuotaInfo | null;
  routeChannelCount?: number;
  scheduling?: {
    state: "ready" | "cooldown" | "blocked" | "unrouted";
    eligible: boolean;
    mode: "single" | "route_unit";
    routeCount: number;
    enabledRouteCount: number;
    cooldownUntil?: string | null;
    lastSelectedAt?: string | null;
    lastFailAt?: string | null;
    successCount: number;
    failCount: number;
    consecutiveFailCount: number;
    cooldownLevel: number;
  };
  lastModelSyncAt?: string | null;
  lastModelSyncError?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  routeUnit?: OAuthRouteUnitSummary | null;
  routeParticipation?: OAuthRouteParticipation | null;
  site?: { id: number; name: string; url: string; platform: string } | null;
};

export type OAuthConnectionsResponse = {
  items: OAuthConnectionInfo[];
  total: number;
  limit: number;
  offset: number;
};

export type OAuthConnectionProxyUpdateResponse = {
  success: true;
  accountId: number;
  proxyUrl: string | null;
  useSystemProxy: boolean;
  refreshedRoutes: true;
  modelRefresh: {
    success: boolean;
    status: "success" | "failed" | "skipped";
    errorCode: string | null;
    errorMessage: string | null;
    modelCount: number;
    modelsPreview: string[];
  };
};

export type OAuthConnectionProxyBatchUpdateResponse = {
  success: boolean;
  requested: number;
  updated: number;
  failed: number;
  refreshedRoutes: true;
  items: Array<{
    accountId: number;
    success: boolean;
    proxyUrl?: string | null;
    useSystemProxy?: boolean;
    modelRefresh?: OAuthConnectionProxyUpdateResponse['modelRefresh'];
    error?: string;
  }>;
};

export type OAuthQuotaBatchRefreshResponse = {
  success: boolean;
  refreshed: number;
  failed: number;
  items: Array<{
    accountId: number;
    success: boolean;
    quota?: OAuthQuotaInfo;
    error?: string;
  }>;
};

export type OAuthImportResponse = {
  success: boolean;
  imported: number;
  skipped: number;
  failed: number;
  items: Array<{
    name: string;
    status: "imported" | "skipped" | "failed";
    accountId?: number;
    provider?: string;
    message?: string;
  }>;
};

export type OAuthSub2ApiExport = {
  type: "sub2api-data";
  version: 1;
  exported_at: string;
  proxies: unknown[];
  accounts: Array<{
    name: string;
    platform: "openai";
    type: "oauth";
    credentials: Record<string, unknown>;
    concurrency: number;
    priority: number;
    expires_at?: number;
    auto_pause_on_expired?: boolean;
  }>;
};

export type OAuthRouteUnitMutationResponse = {
  success: boolean;
  routeUnit?: OAuthRouteUnitSummary;
};

export type DownstreamApiKeyTrendBucket = {
  startUtc: string | null;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number | null;
  totalTokens: number;
  totalCost: number;
};

export type DownstreamApiKeyTrendResponse = {
  success: boolean;
  range: "24h" | "7d" | "all";
  item: {
    id: number;
    name: string;
  };
  bucketSeconds: number;
  timeZone?: string | null;
  buckets: DownstreamApiKeyTrendBucket[];
};

export type SiteAdapterContract = {
  platformName: string;
  protocolFamilies: string[];
  credentialKinds: string[];
  operations: Record<string, boolean>;
  probePolicy: string;
  checkin: {
    support: string;
    idempotency: string;
    allowsAutomaticExecution: boolean;
  };
  modelSync: {
    readOnly: boolean;
    retireMissingAfterConsecutiveRuns: number;
  };
  browser: {
    supported: boolean;
    modes: string[];
    allowedOrigins: string[];
    fields: Array<{ name: string; kind: string; required: boolean }>;
    runtime?: {
      kind: 'session_token' | 'cookie';
      field: string;
      usernameField?: string;
      platformUserIdField?: string;
      refreshTokenField?: string;
      tokenExpiresAtField?: string;
    };
    taskTtlSec: number;
    requiresUserGesture: boolean;
  };
  credentialStorage: "encrypted_vault_only";
  notes: string[];
};

export type LocalConnectorScope =
  | "hooks.manage"
  | "hooks.emit"
  | "notify.manage"
  | "notify.emit"
  | "browser.recovery"
  | "app_server.observe"
  | "app_server.control";

export type LocalConnectorDevice = {
  id: string;
  name: string;
  platform: string;
  version?: string | null;
  status: "active" | "revoked";
  scopes: LocalConnectorScope[];
  capabilities: string[];
  healthChecks?: Array<{
    checkId: "connector_runtime" | "codex_notify";
    status: "unknown" | "healthy" | "unavailable";
    reason: string | null;
    observedAt: string | null;
    transitionedAt: string | null;
    incidentStartedAt: string | null;
    alertedAt: string | null;
    recoveryNotifiedAt: string | null;
    autoRepairActionId: string | null;
  }>;
  pairedAt: string;
  lastSeenAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type LocalConnectorThread = {
  id: string;
  deviceId: string;
  deviceName: string;
  devicePlatform: string;
  deviceStatus: "active" | "revoked";
  threadId: string;
  title: string | null;
  observationSource: "connector_app_server" | "codex_desktop";
  controlState: "available" | "external_owner";
  threadStatus: "unknown" | "not_loaded" | "idle" | "active" | "system_error";
  activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">;
  activeTurnId: string | null;
  lastEventKind: string;
  lastSeenAt: string;
  lastActiveAt: string | null;
};

export type LocalConnectorThreadActivityCategory =
  | "bridge"
  | "interaction"
  | "feishu"
  | "notification";

export type LocalConnectorThreadActivityItem = {
  id: string;
  category: LocalConnectorThreadActivityCategory;
  eventType: string;
  status: string | null;
  occurredAt: string | null;
  title: string;
  detail: string | null;
  referenceId: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

export type LocalConnectorThreadActivity = {
  thread: LocalConnectorThread;
  summary: {
    activityCount: number;
    bridgeTasks: number;
    interactions: number;
    feishuDeliveries: number;
    issues: number;
  };
  topicBindings: Array<{
    id: string;
    adapterId: string;
    adapterName: string;
    rootMessageId: string | null;
    feishuThreadId: string | null;
    lastMessageId: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  items: LocalConnectorThreadActivityItem[];
};

export type LocalConnectorAction = {
  id: string;
  deviceId: string;
  kind: "hook" | "notify";
  operation: "install" | "backup" | "rollback" | "uninstall";
  status: "pending" | "claimed" | "succeeded" | "failed" | "cancelled" | "expired";
  manifest: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  backupRef?: string | null;
  errorMessage?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  expiresAt: string;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type BridgeFailureClass =
  | "rate_limited"
  | "concurrency_limited"
  | "service_temporary"
  | "transport_failure"
  | "stream_interrupted"
  | "retry_exhausted"
  | "usage_limit"
  | "context_exhausted"
  | "session_budget_exhausted"
  | "authentication_failure"
  | "request_invalid"
  | "policy_rejected"
  | "sandbox_failure"
  | "turn_conflict"
  | "cancelled"
  | "unknown";

export type BridgeContinuationRuleAction =
  | "stop"
  | "continue_same_route"
  | "continue_rotate_credential"
  | "continue_switch_channel";

export type BridgeContinuationLimit =
  | { mode: "bounded"; maxContinuations: number }
  | { mode: "unlimited" };

export type BridgeContinuationRule = {
  action: BridgeContinuationRuleAction;
  limit: BridgeContinuationLimit;
};

export type BridgeContinuationPolicy = {
  capturedAt: string;
  fingerprint: string;
  policyVersion: number;
  enabled: boolean;
  continuePrompt: string;
  maxElapsedMs: number | null;
  backoff: {
    initialDelayMs: number;
    maxDelayMs: number;
    multiplier: number;
    jitterRatio: number;
  };
  rules: Record<BridgeFailureClass, BridgeContinuationRule>;
};

export type BridgeContinuationPolicyInput = {
  policyVersion?: number;
  enabled?: boolean;
  continuePrompt?: string;
  maxElapsedMs?: number | null;
  backoff?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitterRatio?: number;
  };
  rules?: Partial<Record<BridgeFailureClass, {
    action?: BridgeContinuationRuleAction;
    limit?: BridgeContinuationLimit | "unlimited" | number;
    maxContinuations?: number;
  }>>;
};

export type GlobalBridgeContinuationConfig = {
  enabled: boolean;
  policy: BridgeContinuationPolicy;
  updatedAt: string | null;
};

export type GlobalBridgeContinuationCoverage = {
  eligible: number;
  covered: number;
  created: number;
  blocked: number;
};

export type BridgeContinuationTaskStatus =
  | "waiting"
  | "backoff"
  | "running"
  | "stopped"
  | "superseded"
  | "dead";

export type BridgeContinuationTaskKind = "automatic" | "manual_prompt";
export type BridgeManualPromptSubmissionMode =
  | "auto"
  | "steer_current"
  | "start_next";
export type BridgeTurnSubmissionMethod = "turn/start" | "turn/steer";

export type BridgeContinuationTask = {
  state: {
    taskId: string;
    sessionKey: string;
    threadId: string;
    taskKind: BridgeContinuationTaskKind;
    submissionMode: BridgeManualPromptSubmissionMode | null;
    status: BridgeContinuationTaskStatus;
    reason: string;
    policy: BridgeContinuationPolicy;
    continuationCount: number;
    startedAtMs: number;
    updatedAtMs: number;
    nextRunAtMs: number | null;
    threadStatus: "unknown" | "not_loaded" | "idle" | "active" | "system_error";
    activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">;
    activeTurnId: string | null;
    lastFailure: {
      failureClass: BridgeFailureClass;
      source: "error_notification" | "turn_completed" | "control_error" | "gateway_observation";
      recoverability: "transient" | "conditional" | "terminal";
      codexErrorCode: string | null;
      httpStatusCode: number | null;
      messageSummary: string;
      messageFingerprint: string;
      willRetry: boolean | null;
    } | null;
    lastFailureTurnTerminal: boolean;
    retryAfterMs: number | null;
    pendingRouteAction: "preserve" | "rotate_credential" | "switch_channel" | null;
    pendingPrompt: string | null;
    pendingMethod: BridgeTurnSubmissionMethod | null;
  };
  deviceId: string | null;
  stateVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  stoppedAt: string | null;
  lease: { ownerId: string; expiresAt: string } | null;
  requestSource: "webui" | "im" | null;
  requestedBy: string | null;
  sourceAdapterId: string | null;
  promptFingerprint: string | null;
};

export type BridgeContinuationEvent = {
  id: number;
  taskId: string;
  deliveryId: string | null;
  eventType: string;
  fromStatus: BridgeContinuationTaskStatus | null;
  toStatus: BridgeContinuationTaskStatus;
  reason: string;
  metadata: string | null;
  createdAt: string | null;
};

export type InteractionRequestKind =
  | "command_approval"
  | "file_change_approval"
  | "permissions_approval"
  | "user_input"
  | "mcp_elicitation";

export type InteractionRequestStatus =
  | "pending"
  | "response_pending"
  | "resolved"
  | "cancelled"
  | "expired";

export type InteractionRequest = {
  state: {
    requestId: string;
    sourceRequestKey: string;
    kind: InteractionRequestKind;
    method: string;
    deviceId: string;
    connectionId: string;
    sourceRequestId: string;
    threadId: string | null;
    turnId: string | null;
    itemId: string | null;
    status: InteractionRequestStatus;
    reason: string;
    responsePayload: Record<string, unknown> | null;
    responseSource: "webui" | "im" | "signed_link" | null;
    responseOperatorId: string | null;
    responseIdempotencyKeyHash: string | null;
    responseCommittedAtMs: number | null;
    responseDeliveryCount: number;
    responseDeliveredAtMs: number | null;
    resolvedAtMs: number | null;
    cancelledAtMs: number | null;
    expiresAtMs: number;
    createdAtMs: number;
    updatedAtMs: number;
  };
  requestPayload: Record<string, unknown>;
  requestFingerprint: string;
  responseFingerprint: string | null;
  stateVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type InteractionEvent = {
  id: number;
  interactionId: string;
  deliveryId: string | null;
  eventType: string;
  fromStatus: InteractionRequestStatus | null;
  toStatus: InteractionRequestStatus;
  actorKind: string;
  actorId: string | null;
  metadata: string | null;
  createdAt: string | null;
};

export type FeishuInteractionAdapter = {
  id: string;
  deviceId: string | null;
  kind: "feishu";
  name: string;
  enabled: boolean;
  appId: string;
  apiBaseUrl: string;
  receiveIdType: "chat_id" | "open_id" | "user_id" | "union_id" | "email";
  receiveId: string;
  consoleBaseUrl: string | null;
  operatorAllowlist: string[];
  secretsConfigured: {
    appSecret: boolean;
    verificationToken: boolean;
    encryptKey: boolean;
  };
  callbackPath: string;
  lastDispatchAt: string | null;
  lastCallbackAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type FeishuLongConnection = {
  adapterId: string;
  appId: string;
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  reconnectAttempts: number;
  lastConnectTime: number | null;
  nextConnectTime: number | null;
};

export type InteractionDispatch = {
  id: string;
  subjectKind: "interaction" | "prompt_card";
  interactionId: string | null;
  promptCardId: string | null;
  adapterId: string;
  status: "pending" | "processing" | "delivered" | "delivery_unknown" | "failed" | "cancelled";
  attemptCount: number;
  nextAttemptAt: string;
  externalMessageId: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  cardUpdate: InteractionCardUpdate | null;
};

export type InteractionCardUpdate = {
  id: string;
  dispatchId: string;
  subjectRevision: number;
  targetStatus: string;
  cardFingerprint: string;
  status: "pending" | "processing" | "delivered" | "delivery_unknown" | "failed" | "cancelled";
  attemptCount: number;
  nextAttemptAt: string;
  deadlineAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type FeishuBridgePromptCard = {
  id: string;
  adapterId: string;
  deviceId: string;
  threadId: string;
  contextTaskId: string | null;
  status: "pending" | "consumed" | "expired" | "cancelled";
  expiresAt: string;
  requestedBy: string;
  consumedTaskId: string | null;
  consumedBy: string | null;
  consumedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dispatch: InteractionDispatch | null;
};

export type CredentialVaultItem = {
  id: number;
  siteId?: number | null;
  accountId?: number | null;
  name: string;
  kind: string;
  status: "active" | "disabled" | "revoked" | "expired";
  fingerprint: string;
  metadata?: Record<string, unknown> | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  version: number;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type CredentialLifecycleStatus =
  | "active"
  | "expiring"
  | "expired"
  | "refreshing"
  | "refresh_failed"
  | "revoked"
  | "invalid"
  | "disabled"
  | "metadata_only";

export type CredentialLifecycleEntityType = "account" | "vault_item";
export type CredentialLifecycleAction = "validate" | "refresh" | "enable" | "disable" | "revoke";

export type CredentialLifecycleItem = {
  entityType: CredentialLifecycleEntityType;
  entityId: number;
  siteId?: number;
  accountId?: number;
  name: string;
  site?: { id: number; name: string; platform: string; url: string };
  provider?: string;
  kind: string;
  status: CredentialLifecycleStatus;
  sourceStatus: string;
  statusReason: string;
  refreshOwner: "r_api" | "external" | "none";
  expiresAt?: string;
  fingerprint?: string;
  lastRefreshAttemptAt?: string;
  lastRefreshSuccessAt?: string;
  lastRefreshError?: string;
  actions: Record<CredentialLifecycleAction, boolean>;
  provenance?: {
    importJobId: string;
    sourceFormat: string;
    sourceVersion?: string;
    operatorId: string;
    conflictPolicy: string;
    importAction: string;
    createdAt?: string;
  };
};

export type CredentialLifecycleActionResult = {
  entityType: CredentialLifecycleEntityType;
  entityId: number;
  action: CredentialLifecycleAction;
  success: boolean;
  status?: CredentialLifecycleStatus;
  message: string;
};

export type CredentialImportTarget = "new_api" | "sub2api" | "native_oauth" | "api_key" | "vault";
export type CredentialConflictPolicy = "skip" | "update" | "create_duplicate";

export type CredentialImportPreviewCandidate = {
  candidate: {
    source: { format: string; version?: string | number; platform?: string; sourceIndex?: number };
    provider?: string;
    kind: string;
    identity: Record<string, string>;
    secretPresence: Record<string, boolean>;
    secretSummary: Record<string, boolean>;
    expiresAt?: number;
    disabled: boolean;
    fingerprint: string;
    warnings: string[];
    compatibleTargets: CredentialImportTarget[];
  };
  validation: {
    status: "ready" | "incomplete" | "metadata_only" | "unsupported";
    target?: CredentialImportTarget;
    errors: string[];
    warnings: string[];
  };
  duplicateOfIndex?: number;
};

export type CredentialImportPreviewResponse = {
  success: true;
  importJobId: string;
  deduplicated: boolean;
  status: string;
  detection: {
    format: string;
    version?: string | number;
    provider?: string;
    isBatch: boolean;
    confidence: "high" | "medium" | "low";
    warnings: string[];
  };
  warnings: string[];
  batchFingerprint: string;
  duplicateCount: number;
  candidates: CredentialImportPreviewCandidate[];
};

export type CredentialImportExecutionResponse = {
  success: boolean;
  importJobId: string;
  deduplicated: boolean;
  jobStatus: string;
  target: CredentialImportTarget;
  batchFingerprint: string;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  items: Array<{
    index: number;
    status: "imported" | "updated" | "skipped" | "failed";
    provider?: string;
    kind: string;
    fingerprint: string;
    duplicateOfIndex?: number;
    accountId?: number;
    vaultItemIds?: number[];
    message?: string;
  }>;
};

export type CredentialImportJob = {
  id: string;
  status: "previewed" | "running" | "completed" | "partial" | "failed";
  target?: CredentialImportTarget;
  siteId?: number;
  operatorId: string;
  conflictPolicy: CredentialConflictPolicy;
  detection: CredentialImportPreviewResponse["detection"];
  warnings: string[];
  batchFingerprint: string;
  candidateCount: number;
  duplicateCount: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  failureMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  items?: Array<{
    id: number;
    index: number;
    source: { format: string; version?: string; platform?: string };
    provider?: string;
    kind: string;
    identity: Record<string, string>;
    secretSummary: Record<string, boolean>;
    compatibleTargets: CredentialImportTarget[];
    expiresAt?: string;
    disabled: boolean;
    fingerprint: string;
    validation: { status: string; errors: string[]; warnings: string[] };
    duplicateOfIndex?: number;
    status: string;
    message?: string;
    accountId?: number;
    vaultItemIds?: number[];
  }>;
};

export type CredentialExportMode = "metadata_only" | "encrypted_backup" | "portable_secret";

export type BrowserRecoveryTask = {
  id: string;
  siteId: number;
  accountId?: number | null;
  mode: 'manual' | 'assisted' | 'managed';
  status: 'pending' | 'claimed' | 'completing' | 'completed' | 'cancelled' | 'expired';
  credentialName: string;
  credentialKind: 'browser_storage';
  adapterPlatform: string;
  targetUrl: string;
  targetOrigin: string;
  allowedOrigins: string[];
  fields: Array<{
    name: string;
    kind: string;
    required: boolean;
    capture?: {
      strategy: 'cookie_header' | 'named_cookie' | 'storage_value' | 'json_path' | 'manual';
      key?: string;
      path?: string[];
    };
  }>;
  requiresUserGesture: boolean;
  expiresAt: string;
  claimedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  resultCredentialId?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type ModelSyncState = {
  accountId: number;
  modelName: string;
  consecutiveMissing: number;
  lastSeenAt?: string | null;
  lastSyncAt?: string | null;
  status: 'active' | 'candidate_retired';
  lastError?: string | null;
  updatedAt?: string | null;
};

export const api = {
  getAdminSession: async () => {
    const session = await requestPublic<AdminSessionResponse>("/api/auth/session");
    if (session.authenticated) {
      persistAuthSession(getBrowserSessionStorage(), session.csrfToken, session.expiresAt);
    } else {
      clearAuthSession(getBrowserSessionStorage());
    }
    return session;
  },
  loginAdmin: async (token: string) => {
    const result = await requestPublic<AdminLoginResponse>(
      "/api/auth/login",
      { method: "POST", body: JSON.stringify({ token }) },
    );
    if (result.authenticated) {
      persistAuthSession(getBrowserSessionStorage(), result.csrfToken, result.expiresAt);
    } else {
      clearAuthSession(getBrowserSessionStorage());
    }
    return result;
  },
  verifyAdminTotp: async (challengeToken: string, code: string) => {
    const session = await requestPublic<AdminAuthenticatedSession & {
      success: true;
      secondFactorType: "totp" | "recovery_code";
      recoveryCodesRemaining: number;
    }>("/api/auth/totp/verify", {
      method: "POST",
      body: JSON.stringify({ challengeToken, code }),
    });
    persistAuthSession(getBrowserSessionStorage(), session.csrfToken, session.expiresAt);
    return session;
  },
  logoutAdmin: async () => {
    try {
      return await request<{ success: true }>("/api/auth/logout", { method: "POST" });
    } finally {
      clearAuthSession(getBrowserSessionStorage());
    }
  },

  // Sites
  getSites: () => request("/api/sites"),
  openSiteProbeStream: (
    siteId: number,
    params: URLSearchParams,
    signal?: AbortSignal,
  ) => fetchAuthenticatedResponse(
    `/api/sites/${siteId}/probe-stream?${params.toString()}`,
    { method: "GET", signal, timeoutMs: 120_000 },
  ),
  getLocalConnectorDevices: () =>
    request<{ items: LocalConnectorDevice[] }>("/api/local-connector/devices"),
  getLocalConnectorThreads: (params?: { deviceId?: string; limit?: number }) =>
    request<{ success: boolean; items: LocalConnectorThread[] }>(
      "/api/local-connector/threads" + buildQueryString(params),
    ),
  getLocalConnectorThreadActivity: (deviceId: string, threadId: string, limit = 120) =>
    request<{ success: boolean } & LocalConnectorThreadActivity>(
      `/api/local-connector/devices/${encodeURIComponent(deviceId)}`
        + `/sessions/${encodeURIComponent(threadId)}/activity`
        + buildQueryString({ limit }),
    ),
  createLocalConnectorPairing: (data: {
    deviceName: string;
    scopes?: LocalConnectorScope[];
    ttlSec?: number;
  }) =>
    request<{
      success: boolean;
      claimPath: string;
      pairingId: string;
      pairingToken: string;
      deviceName: string;
      scopes: LocalConnectorScope[];
      expiresAt: string;
    }>("/api/local-connector/pairings", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  cancelLocalConnectorPairing: (id: string) =>
    request(`/api/local-connector/pairings/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  revokeLocalConnectorDevice: (id: string) =>
    request(`/api/local-connector/devices/${encodeURIComponent(id)}/revoke`, {
      method: "POST",
    }),
  getLocalConnectorActions: (params?: { deviceId?: string; status?: string }) =>
    request<{ items: LocalConnectorAction[] }>(
      "/api/local-connector/actions" + buildQueryString(params),
    ),
  createLocalConnectorAction: (data: {
    deviceId: string;
    kind: "hook" | "notify";
    operation: "install" | "backup" | "rollback" | "uninstall";
    agent?: "codex" | "claude_code";
    backupRef?: string | null;
    eventNames?: string[];
    ttlSec?: number;
  }) =>
    request<{ success: boolean; action: LocalConnectorAction }>(
      "/api/local-connector/actions",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  cancelLocalConnectorAction: (id: string) =>
    request(`/api/local-connector/actions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  getBridgeContinuationTasks: (params?: {
    deviceId?: string;
    sessionKey?: string;
    status?: BridgeContinuationTaskStatus;
    limit?: number;
  }) => request<{ success: boolean; items: BridgeContinuationTask[] }>(
    "/api/bridge-continuations" + buildQueryString(params),
  ),
  getBridgeContinuationTask: (id: string, eventLimit = 100) =>
    request<{
      success: boolean;
      task: BridgeContinuationTask;
      events: BridgeContinuationEvent[];
    }>(
      `/api/bridge-continuations/${encodeURIComponent(id)}`
      + buildQueryString({ eventLimit }),
    ),
  createBridgeContinuationTask: (data: {
    sessionKey: string;
    threadId: string;
    deviceId?: string;
    policy: BridgeContinuationPolicyInput;
  }) => request<{ success: boolean; created: boolean; task: BridgeContinuationTask }>(
    "/api/bridge-continuations",
    { method: "POST", body: JSON.stringify(data) },
  ),
  getGlobalBridgeContinuation: () => request<{
    success: boolean;
    config: GlobalBridgeContinuationConfig;
    coverage: GlobalBridgeContinuationCoverage;
  }>("/api/bridge-continuations/global"),
  updateGlobalBridgeContinuation: (data: {
    enabled: boolean;
    policy?: BridgeContinuationPolicyInput;
  }) => request<{
    success: boolean;
    config: GlobalBridgeContinuationConfig;
    coverage: GlobalBridgeContinuationCoverage;
    stopped: number;
  }>("/api/bridge-continuations/global", {
    method: "PUT",
    body: JSON.stringify(data),
  }),
  takeOverLocalConnectorSession: (data: {
    deviceId: string;
    threadId: string;
    policy?: BridgeContinuationPolicyInput;
  }) => request<{ success: boolean; created: boolean; task: BridgeContinuationTask }>(
    `/api/local-connector/devices/${encodeURIComponent(data.deviceId)}`
      + `/sessions/${encodeURIComponent(data.threadId)}/takeover`,
    { method: "POST", body: JSON.stringify({ policy: data.policy }) },
  ),
  createManualBridgePromptTask: (data: {
    contextTaskId?: string;
    deviceId?: string;
    threadId?: string;
    threadStatus?: LocalConnectorThread["threadStatus"];
    activeFlags?: LocalConnectorThread["activeFlags"];
    activeTurnId?: string | null;
    prompt: string;
    submissionMode: BridgeManualPromptSubmissionMode;
    operatorId?: string;
    idempotencyKey: string;
  }) => request<{
    success: boolean;
    created: boolean;
    deduplicated: boolean;
    supersededTaskId: string | null;
    task: BridgeContinuationTask;
  }>(
    "/api/bridge-continuations/manual-prompts",
    {
      method: "POST",
      headers: { "Idempotency-Key": data.idempotencyKey },
      body: JSON.stringify(data),
    },
  ),
  stopBridgeContinuationTask: (id: string) =>
    request<{ success: boolean; task: BridgeContinuationTask }>(
      `/api/bridge-continuations/${encodeURIComponent(id)}/stop`,
      { method: "POST" },
    ),
  supersedeBridgeContinuationTask: (id: string) =>
    request<{ success: boolean; task: BridgeContinuationTask }>(
      `/api/bridge-continuations/${encodeURIComponent(id)}/supersede`,
      { method: "POST" },
    ),
  getInteractionRequests: (params?: {
    deviceId?: string;
    threadId?: string;
    kind?: InteractionRequestKind;
    status?: InteractionRequestStatus;
    limit?: number;
  }) => request<{ success: boolean; items: InteractionRequest[] }>(
    "/api/interactions" + buildQueryString(params),
  ),
  getInteractionRequest: (id: string, eventLimit = 100) =>
    request<{
      success: boolean;
      interaction: InteractionRequest;
      events: InteractionEvent[];
    }>(
      `/api/interactions/${encodeURIComponent(id)}` + buildQueryString({ eventLimit }),
    ),
  respondInteractionRequest: (id: string, data: {
    responsePayload: Record<string, unknown>;
    operatorId?: string;
    idempotencyKey: string;
  }) => request<{
    success: boolean;
    deduplicated: boolean;
    request: InteractionRequest;
  }>(`/api/interactions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    body: JSON.stringify(data),
  }),
  cancelInteractionRequest: (id: string, operatorId = "webui:admin") =>
    request<{ success: boolean; interaction: InteractionRequest }>(
      `/api/interactions/${encodeURIComponent(id)}/cancel`,
      { method: "POST", body: JSON.stringify({ operatorId }) },
    ),
  getInteractionAdapters: (params?: { deviceId?: string }) =>
    request<{ success: boolean; items: FeishuInteractionAdapter[] }>(
      "/api/interaction-adapters" + buildQueryString(params),
    ),
  getFeishuLongConnections: () =>
    request<{ success: boolean; items: FeishuLongConnection[] }>(
      "/api/interaction-adapters/connections",
    ),
  createFeishuInteractionAdapter: (data: {
    deviceId: string;
    name: string;
    enabled?: boolean;
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    apiBaseUrl: string;
    receiveIdType: FeishuInteractionAdapter["receiveIdType"];
    receiveId: string;
    consoleBaseUrl?: string | null;
    operatorAllowlist: string[];
  }) => request<{ success: boolean; adapter: FeishuInteractionAdapter }>(
    "/api/interaction-adapters/feishu",
    { method: "POST", body: JSON.stringify(data) },
  ),
  updateFeishuInteractionAdapter: (id: string, data: Partial<{
    deviceId: string;
    name: string;
    enabled: boolean;
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    apiBaseUrl: string;
    receiveIdType: FeishuInteractionAdapter["receiveIdType"];
    receiveId: string;
    consoleBaseUrl: string | null;
    operatorAllowlist: string[];
  }>) => request<{ success: boolean; adapter: FeishuInteractionAdapter }>(
    `/api/interaction-adapters/feishu/${encodeURIComponent(id)}`,
    { method: "PUT", body: JSON.stringify(data) },
  ),
  getInteractionDispatches: (params?: {
    adapterId?: string;
    interactionId?: string;
    promptCardId?: string;
    subjectKind?: "interaction" | "prompt_card";
    limit?: number;
  }) => request<{ success: boolean; items: InteractionDispatch[] }>(
    "/api/interaction-adapters/dispatches" + buildQueryString(params),
  ),
  runInteractionAdapterDispatch: () =>
    request<{ success: boolean; result: Record<string, number> }>(
      "/api/interaction-adapters/dispatch/run",
      { method: "POST" },
    ),
  retryInteractionDispatch: (id: string) =>
    request<{ success: boolean }>(
      `/api/interaction-adapters/dispatches/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    ),
  retryInteractionCardUpdate: (id: string) =>
    request<{ success: boolean }>(
      `/api/interaction-adapters/card-updates/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    ),
  createFeishuBridgePromptCard: (adapterId: string, data: {
    contextTaskId?: string;
    deviceId?: string;
    threadId?: string;
    ttlMs?: number;
    requestedBy?: string;
    idempotencyKey: string;
  }) => request<{
    success: boolean;
    created: boolean;
    card: FeishuBridgePromptCard;
  }>(`/api/interaction-adapters/feishu/${encodeURIComponent(adapterId)}/prompt-cards`, {
    method: "POST",
    body: JSON.stringify(data),
  }),
  getFeishuBridgePromptCards: (params?: {
    adapterId?: string;
    status?: FeishuBridgePromptCard["status"];
    limit?: number;
  }) => request<{ success: boolean; items: FeishuBridgePromptCard[] }>(
    "/api/interaction-adapters/prompt-cards" + buildQueryString(params),
  ),
  cancelFeishuBridgePromptCard: (id: string) =>
    request<{ success: boolean; card: FeishuBridgePromptCard }>(
      `/api/interaction-adapters/prompt-cards/${encodeURIComponent(id)}/cancel`,
      { method: "POST" },
    ),
  getSiteAdapterContracts: () =>
    request<{ adapters: SiteAdapterContract[] }>('/api/sites/adapters'),
  getCredentialVaultItems: (params?: {
    siteId?: number;
    accountId?: number;
    status?: "active" | "disabled" | "revoked" | "expired";
  }) =>
    request<{ items: CredentialVaultItem[] }>(
      "/api/credential-vault" + buildQueryString(params),
    ),
  createCredentialVaultItem: (data: {
    siteId?: number;
    accountId?: number;
    name: string;
    kind: string;
    secret: string;
    metadata?: Record<string, unknown>;
    expiresAt?: string | null;
  }) =>
    request<{ success: boolean; item: CredentialVaultItem }>('/api/credential-vault', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  revokeCredentialVaultItem: (id: number) =>
    request("/api/credential-vault/" + id + "/revoke", { method: 'POST' }),
  deleteCredentialVaultItem: (id: number) =>
    request("/api/credential-vault/" + id, { method: 'DELETE' }),
  getCredentialLifecycle: (params?: {
    siteId?: number;
    status?: CredentialLifecycleStatus;
    entityType?: CredentialLifecycleEntityType;
  }) => request<{ success: true; items: CredentialLifecycleItem[] }>(
    "/api/credential-lifecycle" + buildQueryString(params),
  ),
  runCredentialLifecycleAction: (data: {
    action: CredentialLifecycleAction;
    items: Array<{ entityType: CredentialLifecycleEntityType; entityId: number }>;
  }) => request<{
    success: true;
    action: CredentialLifecycleAction;
    succeeded: number;
    failed: number;
    items: CredentialLifecycleActionResult[];
  }>("/api/credential-lifecycle/actions", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: data.action === "refresh" || data.action === "validate" ? 120_000 : 30_000,
  }),
  previewCredentialImport: (data: {
    input: unknown;
    target?: CredentialImportTarget;
    siteId?: number;
    conflictPolicy?: CredentialConflictPolicy;
    operatorId?: string;
    idempotencyKey?: string;
    passphrase?: string;
  }) => request<CredentialImportPreviewResponse>("/api/credential-imports/preview", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: 60_000,
  }),
  executeCredentialImport: (data: {
    importJobId: string;
    input: unknown;
    target: CredentialImportTarget;
    siteId?: number;
    batchFingerprint: string;
    conflictPolicy?: CredentialConflictPolicy;
    operatorId?: string;
    passphrase?: string;
  }) => request<CredentialImportExecutionResponse>("/api/credential-imports/promote", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: 120_000,
  }),
  getCredentialImportJobs: (params?: { limit?: number; siteId?: number }) =>
    request<{ success: true; jobs: CredentialImportJob[] }>(
      "/api/credential-imports" + buildQueryString(params),
    ),
  getCredentialImportJob: (id: string) =>
    request<{ success: true; job: CredentialImportJob }>(
      `/api/credential-imports/${encodeURIComponent(id)}`,
    ),
  exportCredentials: (data: {
    mode: CredentialExportMode;
    siteId?: number;
    accountIds?: number[];
    vaultItemIds?: number[];
    passphrase?: string;
    confirmation?: string;
    expiresInSec?: number;
    operatorId?: string;
  }) => request<{ success: true; export: Record<string, unknown> }>("/api/credential-exports", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: 60_000,
  }),
  getBrowserRecoveryTasks: (params?: { siteId?: number; status?: BrowserRecoveryTask['status'] }) =>
    request<{ items: BrowserRecoveryTask[] }>(
      '/api/browser-credential-tasks' + buildQueryString(params),
    ),
  createBrowserRecoveryTask: (data: {
    siteId: number;
    accountId?: number | null;
    mode: BrowserRecoveryTask['mode'];
    credentialName?: string;
    ttlSec?: number;
  }) => request<{
    success: boolean;
    task: BrowserRecoveryTask;
    token: string;
    launchPath: string;
  }>('/api/browser-credential-tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  cancelBrowserRecoveryTask: (id: string) =>
    request('/api/browser-credential-tasks/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }),
  activateBrowserRecoveryTask: (id: string, accountId?: number | null) =>
    request<{ success: boolean; activation: {
      accountId: number;
      credentialId: number;
      tokenType: 'session';
      username: string | null;
      apiTokenFound: boolean;
      idempotent: boolean;
      created: boolean;
    } }>(`/api/browser-credential-tasks/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      body: JSON.stringify({ accountId }),
    }),
  claimBrowserRecoveryTask: (taskId: string, token: string, claimedBy?: string) =>
    requestPublic<{
      success: boolean;
      task: BrowserRecoveryTask;
      claimToken: string;
    }>('/api/browser-credential-tasks/public/claim', {
      method: 'POST',
      body: JSON.stringify({ taskId, token, claimedBy }),
    }),
  completeBrowserRecoveryTask: (data: {
    taskId: string;
    claimToken: string;
    origin: string;
    fields: Array<{ name: string; kind: string; value: string }>;
    username?: string;
  }) => requestPublic<{
    success: boolean;
    idempotent: boolean;
    task: BrowserRecoveryTask;
    credential: CredentialVaultItem;
  }>('/api/browser-credential-tasks/public/complete', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  getModelSyncStates: (params?: { accountId?: number; status?: ModelSyncState['status'] }) =>
    request<{ success: boolean; items: ModelSyncState[] }>(
      '/api/model-sync/states' + buildQueryString(params),
    ),
  addSite: (data: any) =>
    request("/api/sites", { method: "POST", body: JSON.stringify(data) }),
  updateSite: (id: number, data: any) =>
    request(`/api/sites/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSite: (id: number) => request(`/api/sites/${id}`, { method: "DELETE" }),
  batchUpdateSites: (data: any) =>
    request("/api/sites/batch", { method: "POST", body: JSON.stringify(data) }),
  detectSite: (url: string) =>
    request("/api/sites/detect", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  getSiteDisabledModels: (siteId: number) =>
    request(`/api/sites/${siteId}/disabled-models`),
  updateSiteDisabledModels: (siteId: number, models: string[]) =>
    request(`/api/sites/${siteId}/disabled-models`, {
      method: "PUT",
      body: JSON.stringify({ models }),
    }),
  getSiteAvailableModels: (siteId: number) =>
    request(`/api/sites/${siteId}/available-models`),
  probeSiteNow: (siteId: number, options?: { scope?: 'single' | 'all'; modelName?: string; latencyThresholdMs?: number }) =>
    request(`/api/sites/${siteId}/probe-now`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
      timeoutMs: options?.scope === 'all' ? 120_000 : 30_000,
    }),

  // Accounts
  getAccounts: async (params?: { includeOauth?: boolean }) => {
    const result = await request<any>(`/api/accounts${buildQueryString(params)}`);
    return Array.isArray(result?.accounts) ? result.accounts : result;
  },
  getAccountsSnapshot: (options?: { refresh?: boolean }) =>
    request(
      `/api/accounts${buildQueryString(options?.refresh ? { refresh: 1 } : undefined)}`,
    ) as Promise<{
      generatedAt: string;
      accounts: any[];
      sites: any[];
    }>,
  addAccount: (data: any) =>
    request("/api/accounts", { method: "POST", body: JSON.stringify(data) }),
  loginAccount: (data: {
    siteId: number;
    username: string;
    password: string;
  }) =>
    request("/api/accounts/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  verifyToken: (data: {
    siteId: number;
    accessToken: string;
    platformUserId?: number;
    credentialMode?: "auto" | "session" | "apikey";
  }) =>
    request("/api/accounts/verify-token", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  rebindAccountSession: (
    id: number,
    data: {
      accessToken: string;
      platformUserId?: number;
      refreshToken?: string;
      tokenExpiresAt?: number;
    },
  ) =>
    request(`/api/accounts/${id}/rebind-session`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAccount: (id: number, data: any) =>
    request(`/api/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAccount: (id: number) =>
    request(`/api/accounts/${id}`, { method: "DELETE" }),
  batchUpdateAccounts: (data: any) =>
    request("/api/accounts/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  refreshBalance: (id: number) =>
    request(`/api/accounts/${id}/balance`, { method: "POST" }),
  getAccountModels: (id: number) => request(`/api/accounts/${id}/models`),
  addAccountAvailableModels: (accountId: number, models: string[]) =>
    request(`/api/accounts/${accountId}/models/manual`, {
      method: "POST",
      body: JSON.stringify({ models }),
    }),
  refreshAccountHealth: (data?: { accountId?: number; wait?: boolean }) =>
    request("/api/accounts/health/refresh", {
      method: "POST",
      body: JSON.stringify(data || {}),
      timeoutMs: data?.wait ? 150_000 : 30_000,
    }),

  // Account tokens
  getAccountTokens: (accountId?: number) =>
    request(`/api/account-tokens${accountId ? `?accountId=${accountId}` : ""}`),
  addAccountToken: (data: any) =>
    request("/api/account-tokens", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAccountToken: (id: number, data: any) =>
    request(`/api/account-tokens/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAccountToken: (id: number) =>
    request(`/api/account-tokens/${id}`, { method: "DELETE" }),
  batchUpdateAccountTokens: (data: any) =>
    request("/api/account-tokens/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getAccountTokenGroups: (accountId: number) =>
    request(`/api/account-tokens/groups/${accountId}`),
  setDefaultAccountToken: (id: number) =>
    request(`/api/account-tokens/${id}/default`, { method: "POST" }),
  getAccountTokenValue: (id: number) =>
    request(`/api/account-tokens/${id}/value`),
  syncAccountTokens: (accountId: number) =>
    request(`/api/account-tokens/sync/${accountId}`, {
      method: "POST",
      timeoutMs: 45_000,
    }),
  syncAllAccountTokens: (wait = false) =>
    request("/api/account-tokens/sync-all", {
      method: "POST",
      body: JSON.stringify(wait ? { wait: true } : {}),
      timeoutMs: wait ? 150_000 : 30_000,
    }),

  // Check-in
  triggerCheckinAll: () => request("/api/checkin/trigger", { method: "POST" }),
  triggerCheckin: (id: number) =>
    request(`/api/checkin/trigger/${id}`, { method: "POST" }),
  getCheckinLogs: (params?: string) =>
    request(`/api/checkin/logs${params ? "?" + params : ""}`),
  updateCheckinSchedule: (cron: string) =>
    request("/api/checkin/schedule", {
      method: "PUT",
      body: JSON.stringify({ cron }),
    }),

  // Routes
  getRoutes: () => request("/api/routes"),
  getRoutesLite: () => request("/api/routes/lite"),
  getRoutesSummary: () => request("/api/routes/summary"),
  getRouteChannels: (routeId: number) =>
    request(`/api/routes/${routeId}/channels`),
  batchAddChannels: (
    routeId: number,
    channels: Array<{
      accountId: number;
      tokenId?: number;
      sourceModel?: string;
    }>,
  ) =>
    request(`/api/routes/${routeId}/channels/batch`, {
      method: "POST",
      body: JSON.stringify({ channels }),
    }),
  addRoute: (data: any) =>
    request("/api/routes", { method: "POST", body: JSON.stringify(data) }),
  updateRoute: (id: number, data: any) =>
    request(`/api/routes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRoute: (id: number) =>
    request(`/api/routes/${id}`, { method: "DELETE" }),
  clearRouteCooldown: (id: number) =>
    request(`/api/routes/${id}/cooldown/clear`, { method: "POST" }),
  batchUpdateRoutes: (data: { ids: number[]; action: "enable" | "disable" }) =>
    request("/api/routes/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  addChannel: (routeId: number, data: any) =>
    request(`/api/routes/${routeId}/channels`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateChannel: (id: number, data: any) =>
    request(`/api/channels/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  batchUpdateChannels: (
    updates: Array<{ id: number; priority: number; sortOrder: number }>,
    schedulingRouteId?: number,
  ) =>
    request("/api/channels/batch", {
      method: "PUT",
      body: JSON.stringify({ updates, schedulingRouteId }),
    }),
  deleteChannel: (id: number) =>
    request(`/api/channels/${id}`, { method: "DELETE" }),
  rebuildRoutes: (refreshModels = true, wait = false) =>
    request("/api/routes/rebuild", {
      method: "POST",
      body: JSON.stringify({ refreshModels, ...(wait ? { wait: true } : {}) }),
      timeoutMs: wait ? 150_000 : 30_000,
    }),
  refreshRouteDecisionSnapshots: () =>
    request("/api/routes/decision/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  getRouteDecision: (model: string) =>
    request(`/api/routes/decision?model=${encodeURIComponent(model)}`),
  getRouteDecisionsBatch: (
    models: string[],
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/batch", {
      method: "POST",
      body: JSON.stringify({
        models,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getRouteDecisionsByRouteBatch: (
    items: Array<{ routeId: number; model: string }>,
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/by-route/batch", {
      method: "POST",
      body: JSON.stringify({
        items,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getRouteWideDecisionsBatch: (
    routeIds: number[],
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/route-wide/batch", {
      method: "POST",
      body: JSON.stringify({
        routeIds,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getModelSyncMatrix: (params?: { accountId?: number; status?: string }) =>
    request(`/api/model-sync/matrix${buildQueryString({
      ...(params?.accountId ? { accountId: params.accountId } : {}),
      ...(params?.status ? { status: params.status } : {}),
    })}`),

  // Stats
  getDashboard: () => request("/api/stats/dashboard"),
  getDashboardSnapshot: (options?: { refresh?: boolean }) =>
    request(
      `/api/stats/dashboard${buildQueryString({
        view: "summary",
        ...(options?.refresh ? { refresh: 1 } : {}),
      })}`,
    ),
  getDashboardInsights: (options?: { refresh?: boolean }) =>
    request(
      `/api/stats/dashboard${buildQueryString({
        view: "insights",
        ...(options?.refresh ? { refresh: 1 } : {}),
      })}`,
    ),
  getRoutingObservability: (hours: 24 | 168 | 720 = 24) =>
    request<RoutingObservabilityResponse>(
      `/api/stats/routing-observability${buildQueryString({ hours })}`,
    ),
  getProxyLogs: (params?: ProxyLogsQuery) =>
    request(
      `/api/stats/proxy-logs${buildQueryString(params)}`,
    ) as Promise<ProxyLogsResponse>,
  getProxyLogsQuery: (params?: ProxyLogsQuery) =>
    request(
      `/api/stats/proxy-logs${buildQueryString({
        ...params,
        view: "query",
      })}`,
    ) as Promise<{
      items: ProxyLogsResponse["items"];
      total: number;
      page: number;
      pageSize: number;
    }>,
  getProxyLogsMeta: (
    params?: Omit<ProxyLogsQuery, "limit" | "offset"> & {
      refresh?: number | boolean;
    },
  ) => {
    const refresh =
      params?.refresh === true
        ? 1
        : typeof params?.refresh === "number"
          ? params.refresh
          : undefined;
    const queryParams = {
      ...params,
      view: "meta",
      ...(refresh !== undefined ? { refresh } : {}),
    } as Record<string, string | number | boolean | null | undefined>;
    if (refresh === undefined) delete queryParams.refresh;
    return request(
      `/api/stats/proxy-logs${buildQueryString(queryParams)}`,
    ) as Promise<{
      clientOptions: ProxyLogsResponse["clientOptions"];
      summary: ProxyLogsResponse["summary"];
      sites: Array<{ id: number; name: string; status?: string | null }>;
    }>;
  },
  getProxyLogDetail: (id: number) =>
    request(`/api/stats/proxy-logs/${id}`) as Promise<ProxyLogDetail>,
  getProxyRequestLedgers: (params?: ProxyRequestLedgersQuery) =>
    request(
      `/api/proxy-request-ledgers${buildQueryString(params)}`,
    ) as Promise<ProxyRequestLedgersResponse>,
  getProxyRequestLedgerDetail: (requestId: string) =>
    request(
      `/api/proxy-request-ledgers/${encodeURIComponent(requestId)}`,
    ) as Promise<ProxyRequestLedgerDetail>,
  getProxyDebugTraces: (params?: { limit?: number }) =>
    request(
      `/api/stats/proxy-debug/traces${buildQueryString(params)}`,
    ) as Promise<ProxyDebugTracesResponse>,
  getProxyDebugTraceDetail: (id: number) =>
    request(
      `/api/stats/proxy-debug/traces/${id}`,
    ) as Promise<ProxyDebugTraceDetail>,
  checkModels: (accountId: number) =>
    request(`/api/models/check/${accountId}`, { method: "POST" }),
  getSiteDistribution: () => request("/api/stats/site-distribution"),
  getSiteTrend: (days = 7) => request(`/api/stats/site-trend?days=${days}`),
  getSiteSnapshot: async (days = 7, options?: { refresh?: boolean }) => {
    const query = buildQueryString({
      days,
      ...(options?.refresh ? { refresh: 1 } : {}),
    });
    const [distribution, trend, sites] = await Promise.all([
      request<{ distribution: any[] }>(`/api/stats/site-distribution${query}`),
      request<{ trend: any[] }>(`/api/stats/site-trend${query}`),
      request<any[]>("/api/sites"),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      distribution: Array.isArray(distribution?.distribution)
        ? distribution.distribution
        : [],
      trend: Array.isArray(trend?.trend) ? trend.trend : [],
      sites: Array.isArray(sites) ? sites : [],
    };
  },
  getModelBySite: (siteId?: number, days = 7) =>
    request(
      `/api/stats/model-by-site?${siteId ? `siteId=${siteId}&` : ""}days=${days}`,
    ),

  // Search
  search: (query: string) =>
    request("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, limit: 20 }),
    }),

  // OAuth
  getOAuthProviders: () =>
    request("/api/oauth/providers") as Promise<OAuthProvidersResponse>,
  startOAuthProvider: (
    provider: string,
    data?: {
      accountId?: number;
      projectId?: string;
      proxyUrl?: string | null;
      useSystemProxy?: boolean;
    },
  ) =>
    request(`/api/oauth/providers/${encodeURIComponent(provider)}/start`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    }) as Promise<OAuthStartResponse>,
  getOAuthSession: (state: string) =>
    request(
      `/api/oauth/sessions/${encodeURIComponent(state)}`,
    ) as Promise<OAuthSessionInfo>,
  submitOAuthManualCallback: (state: string, callbackUrl: string) =>
    request(
      `/api/oauth/sessions/${encodeURIComponent(state)}/manual-callback`,
      {
        method: "POST",
        body: JSON.stringify({ callbackUrl }),
      },
    ) as Promise<{ success: true }>,
  getOAuthConnections: (params?: { limit?: number; offset?: number }) =>
    request(
      `/api/oauth/connections${buildQueryString(params)}`,
    ) as Promise<OAuthConnectionsResponse>,
  refreshOAuthConnectionQuota: (accountId: number) =>
    request(`/api/oauth/connections/${accountId}/quota/refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    }) as Promise<{ success: true; quota: OAuthQuotaInfo }>,
  refreshOAuthConnectionQuotaBatch: (accountIds: number[]) =>
    request("/api/oauth/connections/quota/refresh-batch", {
      method: "POST",
      body: JSON.stringify({ accountIds }),
    }) as Promise<OAuthQuotaBatchRefreshResponse>,
  updateOAuthConnectionProxy: (
    accountId: number,
    data: { proxyUrl?: string | null; useSystemProxy?: boolean },
  ) =>
    request(`/api/oauth/connections/${accountId}/proxy`, {
      method: "PATCH",
      body: JSON.stringify(data || {}),
    }) as Promise<OAuthConnectionProxyUpdateResponse>,
  updateOAuthConnectionsProxy: (
    accountIds: number[],
    data: { proxyUrl?: string | null; useSystemProxy?: boolean },
  ) =>
    request('/api/oauth/connections/proxy', {
      method: 'PATCH',
      body: JSON.stringify({ accountIds, ...data }),
    }) as Promise<OAuthConnectionProxyBatchUpdateResponse>,
  rebindOAuthConnection: (
    accountId: number,
    data?: { proxyUrl?: string | null; useSystemProxy?: boolean },
  ) =>
    request(`/api/oauth/connections/${accountId}/rebind`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    }) as Promise<OAuthStartResponse>,
  deleteOAuthConnection: (accountId: number) =>
    request(`/api/oauth/connections/${accountId}`, {
      method: "DELETE",
    }) as Promise<{ success: true }>,
  importOAuthConnections: (data: unknown) => {
    const payload = data && typeof data === "object" && !Array.isArray(data)
      && Array.isArray((data as Record<string, unknown>).items)
      ? data
      : { data };
    return request("/api/oauth/import", {
      method: "POST",
      body: JSON.stringify(payload),
    }) as Promise<OAuthImportResponse>;
  },
  exportOAuthConnectionsToSub2Api: (accountIds: number[], confirmation: string) =>
    request("/api/oauth/export/sub2api", {
      method: "POST",
      body: JSON.stringify({ accountIds, confirmation }),
    }) as Promise<{ success: true; export: OAuthSub2ApiExport }>,
  createOAuthRouteUnit: (data: {
    accountIds: number[];
    name: string;
    strategy: OAuthRouteUnitStrategy;
  }) =>
    request("/api/oauth/route-units", {
      method: "POST",
      body: JSON.stringify(data),
    }) as Promise<OAuthRouteUnitMutationResponse>,
  deleteOAuthRouteUnit: (routeUnitId: number) =>
    request(`/api/oauth/route-units/${routeUnitId}`, {
      method: "DELETE",
    }) as Promise<{ success: true }>,

  // Events
  getEvents: (params?: string) =>
    request(`/api/events${params ? "?" + params : ""}`),
  getEventCount: () => request("/api/events/count"),
  markEventRead: (id: number) =>
    request(`/api/events/${id}/read`, { method: "POST" }),
  markAllEventsRead: () => request("/api/events/read-all", { method: "POST" }),
  clearEvents: () => request("/api/events", { method: "DELETE" }),
  getSiteAnnouncements: (params?: string) =>
    request(`/api/site-announcements${params ? "?" + params : ""}`),
  markSiteAnnouncementRead: (id: number) =>
    request(`/api/site-announcements/${id}/read`, { method: "POST" }),
  markAllSiteAnnouncementsRead: () =>
    request("/api/site-announcements/read-all", { method: "POST" }),
  clearSiteAnnouncements: () =>
    request("/api/site-announcements", { method: "DELETE" }),
  syncSiteAnnouncements: (payload?: { siteId?: number }) =>
    request("/api/site-announcements/sync", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }),
  getTasks: (limit = 50) =>
    request(
      `/api/tasks?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
    ),
  getTask: (id: string) => request(`/api/tasks/${encodeURIComponent(id)}`),

  // Auth management
  getAuthInfo: () => request<AdminAuthInfo>("/api/settings/auth/info"),
  changeAuthToken: (oldToken: string, newToken: string) =>
    request("/api/settings/auth/change", {
      method: "POST",
      body: JSON.stringify({ oldToken, newToken }),
    }),
  beginAdminTotpSetup: (password: string) =>
    request<AdminTotpSetupResponse>("/api/settings/auth/totp/setup", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  confirmAdminTotpSetup: (setupToken: string, code: string) =>
    request<AdminRecoveryCodesResponse & { enabled: true }>("/api/settings/auth/totp/confirm", {
      method: "POST",
      body: JSON.stringify({ setupToken, code }),
    }),
  regenerateAdminRecoveryCodes: (password: string, code: string) =>
    request<AdminRecoveryCodesResponse>("/api/settings/auth/totp/recovery-codes", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    }),
  disableAdminTotp: (password: string, code: string) =>
    request<{ success: true; enabled: false }>("/api/settings/auth/totp/disable", {
      method: "POST",
      body: JSON.stringify({ password, code }),
    }),
  getRuntimeSettings: () => request("/api/settings/runtime"),
  getBrandList: () => request("/api/settings/brand-list"),
  updateRuntimeSettings: (data: RuntimeSettingsPayload) =>
    request("/api/settings/runtime", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getUpdateCenterStatus: () => request("/api/update-center/status"),
  saveUpdateCenterConfig: (data: any) =>
    request("/api/update-center/config", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  checkUpdateCenter: () =>
    request("/api/update-center/check", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  deployUpdateCenter: (data: {
    source: "github-release" | "docker-hub-tag";
    targetTag: string;
    targetDigest?: string | null;
  }) =>
    request("/api/update-center/deploy", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  rollbackUpdateCenter: (data: { targetRevision: string }) =>
    request("/api/update-center/rollback", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  streamUpdateCenterTaskLogs: (
    taskId: string,
    handlers: {
      onLog?: (entry: any) => void;
      onDone?: (payload: any) => void;
      signal?: AbortSignal;
    },
  ) =>
    streamSse(
      `/api/update-center/tasks/${encodeURIComponent(taskId)}/stream`,
      handlers,
    ),
  testSystemProxy: (data: SystemProxyTestRequest) =>
    request("/api/settings/system-proxy/test", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 20_000,
    }),
  getRuntimeDatabaseConfig: () => request("/api/settings/database/runtime"),
  updateRuntimeDatabaseConfig: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/runtime", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testExternalDatabaseConnection: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/test-connection", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  migrateExternalDatabase: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    overwrite?: boolean;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/migrate", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }),
  getDownstreamApiKeys: () => request("/api/downstream-keys"),
  createDownstreamApiKey: (data: any) =>
    request("/api/downstream-keys", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateDownstreamApiKey: (id: number, data: any) =>
    request(`/api/downstream-keys/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteDownstreamApiKey: (id: number) =>
    request(`/api/downstream-keys/${id}`, {
      method: "DELETE",
    }),
  batchDownstreamApiKeys: (data: {
    ids: number[];
    action: "enable" | "disable" | "delete" | "resetUsage" | "updateMetadata";
    groupOperation?: "keep" | "set" | "clear";
    groupName?: string;
    tagOperation?: "keep" | "append";
    tags?: string[];
  }) =>
    request("/api/downstream-keys/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  resetDownstreamApiKeyUsage: (id: number) =>
    request(`/api/downstream-keys/${id}/reset-usage`, {
      method: "POST",
    }),
  getDownstreamApiKeysSummary: (params?: {
    range?: "24h" | "7d" | "all";
    status?: "all" | "enabled" | "disabled";
    search?: string;
  }) => request(`/api/downstream-keys/summary${buildQueryString(params)}`),
  getDownstreamApiKeyOverview: (id: number) =>
    request(`/api/downstream-keys/${id}/overview`),
  getDownstreamApiKeyTrend: (
    id: number,
    params?: { range?: "24h" | "7d" | "all"; timeZone?: string },
  ) =>
    request<DownstreamApiKeyTrendResponse>(
      `/api/downstream-keys/${id}/trend${buildQueryString(params)}`,
    ),
  exportBackup: (type: "all" | "accounts" | "preferences" = "all") =>
    request(`/api/settings/backup/export?type=${encodeURIComponent(type)}`),
  importBackup: (data: any) =>
    request("/api/settings/backup/import", {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  getBackupWebdavConfig: () => request("/api/settings/backup/webdav"),
  saveBackupWebdavConfig: (data: {
    enabled: boolean;
    fileUrl: string;
    username: string;
    password?: string;
    clearPassword?: boolean;
    exportType: "all" | "accounts" | "preferences";
    autoSyncEnabled: boolean;
    autoSyncCron: string;
  }) =>
    request("/api/settings/backup/webdav", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  exportBackupToWebdav: (type?: "all" | "accounts" | "preferences") =>
    request("/api/settings/backup/webdav/export", {
      method: "POST",
      body: JSON.stringify(type ? { type } : {}),
      timeoutMs: 60_000,
    }),
  importBackupFromWebdav: () =>
    request("/api/settings/backup/webdav/import", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 60_000,
    }),
  clearRuntimeCache: () =>
    request("/api/settings/maintenance/clear-cache", { method: "POST" }),
  clearUsageData: () =>
    request("/api/settings/maintenance/clear-usage", { method: "POST" }),
  factoryReset: () =>
    request("/api/settings/maintenance/factory-reset", { method: "POST" }),
  testNotification: () =>
    request("/api/settings/notify/test", { method: "POST" }),
  getNotificationOutbox: (params?: { limit?: number; offset?: number; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set("limit", String(params.limit));
    if (params?.offset !== undefined) query.set("offset", String(params.offset));
    if (params?.status) query.set("status", params.status);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request(`/api/notifications/outbox${suffix}`);
  },
  retryNotificationOutbox: (id?: number) =>
    request("/api/notifications/outbox/retry", {
      method: "POST",
      body: JSON.stringify(id === undefined ? { all: true } : { id }),
    }),

  // Monitor embed
  getMonitorConfig: () => request("/api/monitor/config"),
  updateMonitorConfig: (data: { ldohCookie?: string | null; aihubCookie?: string | null }) =>
    request("/api/monitor/config", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  initMonitorSession: () => request("/api/monitor/session", { method: "POST" }),

  // Models marketplace
  getModelsMarketplace: (options?: {
    refresh?: boolean;
    includePricing?: boolean;
  }) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set("refresh", "1");
    if (options?.includePricing) params.set("includePricing", "1");
    const query = params.toString();
    return request(`/api/models/marketplace${query ? `?${query}` : ""}`, {
      timeoutMs: options?.refresh ? 45_000 : 15_000,
    });
  },
  getModelTokenCandidates: () => request("/api/models/token-candidates"),

  // Simple chat test from admin panel
  startTestChatJob: (data: TestChatRequestPayload) =>
    request("/api/test/chat/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getTestChatJob: (jobId: string) =>
    request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`),
  deleteTestChatJob: (jobId: string) =>
    request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  startProxyTestJob: (data: ProxyTestRequestEnvelope) =>
    request("/api/test/proxy/jobs", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  getProxyTestJob: (jobId: string) =>
    request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`),
  deleteProxyTestJob: (jobId: string) =>
    request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  getProxyFileContentDataUrl: async (
    fileId: string,
    options: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
  ) => {
    const response = await fetchAuthenticatedResponse(
      `/api/proxy-files/${encodeURIComponent(fileId)}/content`,
      {
        method: "GET",
        ...options,
      },
    );
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }

    const mimeType =
      (response.headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim() || "application/octet-stream";
    const filename = parseContentDispositionFilename(
      response.headers.get("content-disposition"),
    );
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    return {
      filename,
      mimeType,
      data: `data:${mimeType};base64,${base64}`,
    };
  },
  testProxy: proxyTestRequest,
  proxyTest: proxyTestRequest,
  testChat: (data: TestChatRequestPayload) =>
    request("/api/test/chat", { method: "POST", body: JSON.stringify(data) }),
  testProxyStream: proxyTestStreamRequest,
  proxyTestStream: proxyTestStreamRequest,
  testChatStream: async (
    data: TestChatRequestPayload,
    signal?: AbortSignal,
  ) => fetchAuthenticatedResponse("/api/test/chat/stream", {
      method: "POST",
      signal,
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }),
};
