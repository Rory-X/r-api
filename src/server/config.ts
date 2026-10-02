import 'dotenv/config';
import type { FastifyServerOptions } from 'fastify';
import { normalizePayloadRulesConfig } from './services/payloadRules.js';
import {
  DEFAULT_BALANCE_ROUTING_POLICY,
  normalizeBalanceRoutingPolicy,
  type BalanceRoutingPolicy,
} from './services/balanceRoutingPolicy.js';
import { normalizeCheckinSchedulePolicy } from './services/checkinSchedulePolicy.js';
import { normalizeFirstByteRoutingPolicy } from '../shared/firstByteRoutingPolicy.js';

const DEFAULT_REQUEST_BODY_LIMIT = 20 * 1024 * 1024;
const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_GEMINI_CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const DEFAULT_GEMINI_CLI_CLIENT_SECRET = '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';
export const TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING = 30 * 24 * 60 * 60;

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseOptionalSecret(value: string | undefined): string {
  return (value || '').trim();
}

function parseJsonValue(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parsePositiveIntegerRecord(value: string | undefined): Record<string, number> {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const result: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    const key = rawKey.trim().toLowerCase();
    const normalized = Math.trunc(Number(rawValue));
    if (!key || !Number.isFinite(normalized) || normalized <= 0) continue;
    result[key] = Math.min(32, normalized);
  }
  return result;
}

function parseDbType(value: string | undefined): 'sqlite' | 'mysql' | 'postgres' {
  const normalized = (value || 'sqlite').trim().toLowerCase();
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return 'sqlite';
}

export function normalizeNotificationDeliveryPolicy(value: unknown): 'prefer_delivery' | 'prefer_no_duplicate' {
  return String(value || '').trim().toLowerCase() === 'prefer_no_duplicate'
    ? 'prefer_no_duplicate'
    : 'prefer_delivery';
}

export function normalizeTokenRouterFailureCooldownMaxSec(value: unknown): number | null {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.min(
    TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    Math.max(1, Math.trunc(normalized)),
  );
}

function parseListenHost(env: NodeJS.ProcessEnv): string {
  return (env.HOST || '0.0.0.0').trim() || '0.0.0.0';
}

function parseTrustProxy(value: string | undefined): FastifyServerOptions['trustProxy'] {
  const normalized = (value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'false') return false;
  if (normalized.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(normalized)) return Math.max(0, Number(normalized));
  const entries = normalized.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.length <= 1 ? (entries[0] || false) : entries;
}

export function buildConfig(env: NodeJS.ProcessEnv) {
  const dataDir = env.DATA_DIR || './data';

  return {
    demoMode: parseBoolean(env.DEMO_MODE, false),
    authToken: env.AUTH_TOKEN || 'change-me-admin-token',
    authTokenHash: parseOptionalSecret(env.AUTH_TOKEN_HASH),
    metricsAuthToken: parseOptionalSecret(env.METRICS_AUTH_TOKEN),
    adminCredentialBootstrapConfigured: !!(
      parseOptionalSecret(env.AUTH_TOKEN)
      || parseOptionalSecret(env.AUTH_TOKEN_HASH)
    ),
    adminCredentialBootstrapRequired: parseBoolean(env.ADMIN_CREDENTIAL_BOOTSTRAP_REQUIRED, false),
    adminSessionTtlMs: Math.max(
      5 * 60 * 1000,
      Math.trunc(parseNumber(env.ADMIN_SESSION_TTL_MS, 12 * 60 * 60 * 1000)),
    ),
    adminSessionTouchIntervalMs: Math.max(
      60_000,
      Math.trunc(parseNumber(env.ADMIN_SESSION_TOUCH_INTERVAL_MS, 5 * 60 * 1000)),
    ),
    adminCookieSecure: parseBoolean(env.ADMIN_COOKIE_SECURE, false),
    deployHelperToken: parseOptionalSecret(env.DEPLOY_HELPER_TOKEN || env.UPDATE_CENTER_HELPER_TOKEN),
    codexClientId: parseOptionalSecret(env.CODEX_CLIENT_ID) || DEFAULT_CODEX_CLIENT_ID,
    claudeClientId: parseOptionalSecret(env.CLAUDE_CLIENT_ID) || DEFAULT_CLAUDE_CLIENT_ID,
    claudeClientSecret: parseOptionalSecret(env.CLAUDE_CLIENT_SECRET),
    geminiCliClientId: parseOptionalSecret(env.GEMINI_CLI_CLIENT_ID) || DEFAULT_GEMINI_CLI_CLIENT_ID,
    geminiCliClientSecret: parseOptionalSecret(env.GEMINI_CLI_CLIENT_SECRET) || DEFAULT_GEMINI_CLI_CLIENT_SECRET,
    systemProxyUrl: env.SYSTEM_PROXY_URL || '',
    accountCredentialSecret: env.ACCOUNT_CREDENTIAL_SECRET || env.AUTH_TOKEN || 'change-me-admin-token',
    checkinCron: env.CHECKIN_CRON || '0 8 * * *',
    checkinScheduleMode: (env.CHECKIN_SCHEDULE_MODE || 'cron').trim().toLowerCase() === 'interval'
      ? 'interval' as const
      : 'cron' as const,
    checkinIntervalHours: Math.min(24, Math.max(1, Math.trunc(parseNumber(env.CHECKIN_INTERVAL_HOURS, 6)))),
    checkinSchedulePolicy: normalizeCheckinSchedulePolicy(parseJsonValue(env.CHECKIN_SCHEDULE_POLICY_JSON) || {
      timeZone: env.CHECKIN_TIME_ZONE,
      windowStart: env.CHECKIN_WINDOW_START,
      windowEnd: env.CHECKIN_WINDOW_END,
      jitterMinutes: env.CHECKIN_JITTER_MINUTES,
      catchUp: env.CHECKIN_CATCH_UP === undefined ? undefined : parseBoolean(env.CHECKIN_CATCH_UP, true),
    }),
    balanceRefreshCron: env.BALANCE_REFRESH_CRON || '0 * * * *',
    logCleanupCron: env.LOG_CLEANUP_CRON || '0 6 * * *',
    logCleanupConfigured: false,
    logCleanupUsageLogsEnabled: parseBoolean(env.LOG_CLEANUP_USAGE_LOGS_ENABLED, false),
    logCleanupProgramLogsEnabled: parseBoolean(env.LOG_CLEANUP_PROGRAM_LOGS_ENABLED, false),
    logCleanupRetentionDays: Math.max(1, Math.trunc(parseNumber(env.LOG_CLEANUP_RETENTION_DAYS, 30))),
    webhookUrl: env.WEBHOOK_URL || '',
    barkUrl: env.BARK_URL || '',
    webhookEnabled: parseBoolean(env.WEBHOOK_ENABLED, true),
    barkEnabled: parseBoolean(env.BARK_ENABLED, true),
    serverChanEnabled: parseBoolean(env.SERVERCHAN_ENABLED, true),
    serverChanKey: env.SERVERCHAN_KEY || '',
    telegramEnabled: parseBoolean(env.TELEGRAM_ENABLED, false),
    telegramApiBaseUrl: 'https://api.telegram.org',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    telegramUseSystemProxy: parseBoolean(env.TELEGRAM_USE_SYSTEM_PROXY, false),
    telegramMessageThreadId: (env.TELEGRAM_MESSAGE_THREAD_ID || '').trim(),
    smtpEnabled: parseBoolean(env.SMTP_ENABLED, false),
    smtpHost: env.SMTP_HOST || '',
    smtpPort: parseInt(env.SMTP_PORT || '587'),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    smtpFrom: env.SMTP_FROM || '',
    smtpTo: env.SMTP_TO || '',
    notifyCooldownSec: Math.max(0, Math.trunc(parseNumber(env.NOTIFY_COOLDOWN_SEC, 300))),
    notifyDeliveryPolicy: normalizeNotificationDeliveryPolicy(env.NOTIFY_DELIVERY_POLICY),
    notifyOutboxPollIntervalMs: Math.max(250, Math.trunc(parseNumber(env.NOTIFY_OUTBOX_POLL_INTERVAL_MS, 1_000))),
    notifyOutboxLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.NOTIFY_OUTBOX_LEASE_TTL_MS, 30_000))),
    notifyOutboxRetryBaseMs: Math.max(1_000, Math.trunc(parseNumber(env.NOTIFY_OUTBOX_RETRY_BASE_MS, 5_000))),
    notifyOutboxRetryMaxMs: Math.max(5_000, Math.trunc(parseNumber(env.NOTIFY_OUTBOX_RETRY_MAX_MS, 15 * 60 * 1000))),
    notifyOutboxRetentionDays: Math.max(1, Math.trunc(parseNumber(env.NOTIFY_OUTBOX_RETENTION_DAYS, 30))),
    adminIpAllowlist: parseCsvList(env.ADMIN_IP_ALLOWLIST),
    port: Math.trunc(parseNumber(env.PORT, 4000)),
    listenHost: parseListenHost(env),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    dataDir,
    dbType: parseDbType(env.DB_TYPE),
    dbUrl: (env.DB_URL || '').trim(),
    dbSsl: parseBoolean(env.DB_SSL, false),
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    upstreamHttp2Enabled: parseBoolean(env.UPSTREAM_HTTP2_ENABLED, true),
    upstreamHttpConnectionsPerOrigin: Math.max(
      1,
      Math.min(512, Math.trunc(parseNumber(env.UPSTREAM_HTTP_CONNECTIONS_PER_ORIGIN, 100))),
    ),
    upstreamHttpKeepAliveTimeoutMs: Math.max(
      1_000,
      Math.trunc(parseNumber(env.UPSTREAM_HTTP_KEEP_ALIVE_TIMEOUT_MS, 90_000)),
    ),
    upstreamHttpKeepAliveMaxTimeoutMs: Math.max(
      1_000,
      Math.trunc(parseNumber(env.UPSTREAM_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS, 600_000)),
    ),
    upstreamHttpAutoSelectFamily: parseBoolean(env.UPSTREAM_HTTP_AUTO_SELECT_FAMILY, true),
    upstreamHttpAutoSelectFamilyAttemptTimeoutMs: Math.max(
      10,
      Math.trunc(parseNumber(env.UPSTREAM_HTTP_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS, 250)),
    ),
    routingFallbackUnitCost: Math.max(1e-6, parseNumber(env.ROUTING_FALLBACK_UNIT_COST, 1)),
    proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(parseNumber(env.PROXY_FIRST_BYTE_TIMEOUT_SEC, 0))),
    firstByteRoutingPolicy: normalizeFirstByteRoutingPolicy({
      enabled: env.FIRST_BYTE_ROUTING_ENABLED === undefined
        ? undefined
        : parseBoolean(env.FIRST_BYTE_ROUTING_ENABLED, true),
      baselineMs: parseNumber(env.FIRST_BYTE_ROUTING_BASELINE_MS, 2_500),
      penaltyWindowMs: parseNumber(env.FIRST_BYTE_ROUTING_PENALTY_WINDOW_MS, 10_000),
      maxPenaltyRatio: parseNumber(env.FIRST_BYTE_ROUTING_MAX_PENALTY_RATIO, 0.65),
      minSamples: parseNumber(env.FIRST_BYTE_ROUTING_MIN_SAMPLES, 5),
    }),
    tokenRouterFailureCooldownMaxSec: normalizeTokenRouterFailureCooldownMaxSec(
      parseNumber(env.TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC, TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING),
    ) ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    tokenRouterCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.TOKEN_ROUTER_CACHE_TTL_MS, 1_500))),
    proxyMaxChannelAttempts: Math.max(1, Math.trunc(parseNumber(env.PROXY_MAX_CHANNEL_ATTEMPTS, 3))),
    proxyStickySessionEnabled: parseBoolean(env.PROXY_STICKY_SESSION_ENABLED, true),
    proxyStickySessionTtlMs: Math.max(30_000, Math.trunc(parseNumber(env.PROXY_STICKY_SESSION_TTL_MS, 30 * 60 * 1000))),
    proxySessionChannelConcurrencyLimit: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_CONCURRENCY_LIMIT, 2))),
    proxySessionChannelQueueWaitMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_QUEUE_WAIT_MS, 1_500))),
    proxySessionChannelLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_TTL_MS, 90_000))),
    proxySessionChannelLeaseKeepaliveMs: Math.max(1_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_KEEPALIVE_MS, 15_000))),
    oauthRefreshLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.OAUTH_REFRESH_LEASE_TTL_MS, 60_000))),
    oauthRefreshLeaseHeartbeatMs: Math.max(1_000, Math.trunc(parseNumber(env.OAUTH_REFRESH_LEASE_HEARTBEAT_MS, 15_000))),
    oauthRefreshLeaseWaitMs: Math.max(0, Math.trunc(parseNumber(env.OAUTH_REFRESH_LEASE_WAIT_MS, 10_000))),
    oauthRefreshProviderMinIntervalMs: Math.max(0, Math.trunc(parseNumber(env.OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS, 250))),
    oauthRefreshProviderDefaultConcurrency: Math.max(1, Math.min(32, Math.trunc(parseNumber(env.OAUTH_REFRESH_PROVIDER_DEFAULT_CONCURRENCY, 1)))),
    oauthRefreshProviderConcurrency: parsePositiveIntegerRecord(env.OAUTH_REFRESH_PROVIDER_CONCURRENCY_JSON),
    oauthRefreshTransientBackoffBaseMs: Math.max(1_000, Math.trunc(parseNumber(env.OAUTH_REFRESH_TRANSIENT_BACKOFF_BASE_MS, 30_000))),
    codexUpstreamWebsocketEnabled: parseBoolean(env.CODEX_UPSTREAM_WEBSOCKET_ENABLED, false),
    responsesCompactFallbackToResponsesEnabled: parseBoolean(env.RESPONSES_COMPACT_FALLBACK_TO_RESPONSES_ENABLED, false),
    disableCrossProtocolFallback: parseBoolean(env.DISABLE_CROSS_PROTOCOL_FALLBACK, false),
    proxyDebugTraceEnabled: parseBoolean(env.PROXY_DEBUG_TRACE_ENABLED, false),
    proxyDebugCaptureHeaders: parseBoolean(env.PROXY_DEBUG_CAPTURE_HEADERS, true),
    proxyDebugCaptureBodies: parseBoolean(env.PROXY_DEBUG_CAPTURE_BODIES, false),
    proxyDebugCaptureStreamChunks: parseBoolean(env.PROXY_DEBUG_CAPTURE_STREAM_CHUNKS, false),
    proxyDebugTargetSessionId: (env.PROXY_DEBUG_TARGET_SESSION_ID || '').trim(),
    proxyDebugTargetClientKind: (env.PROXY_DEBUG_TARGET_CLIENT_KIND || '').trim(),
    proxyDebugTargetModel: (env.PROXY_DEBUG_TARGET_MODEL || '').trim(),
    proxyDebugRetentionHours: Math.max(1, Math.trunc(parseNumber(env.PROXY_DEBUG_RETENTION_HOURS, 24))),
    proxyDebugMaxBodyBytes: Math.max(1024, Math.trunc(parseNumber(env.PROXY_DEBUG_MAX_BODY_BYTES, 262_144))),
    openAiServiceTierRules: parseJsonValue(env.OPENAI_SERVICE_TIER_RULES_JSON || env.OPENAI_SERVICE_TIER_RULES),
    modelAvailabilityProbeEnabled: parseBoolean(env.MODEL_AVAILABILITY_PROBE_ENABLED, false),
    modelAvailabilityProbeIntervalMs: Math.max(60_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_INTERVAL_MS, 30 * 60 * 1000))),
    modelAvailabilityProbeTimeoutMs: Math.max(3_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_TIMEOUT_MS, 15_000))),
    modelAvailabilityProbeConcurrency: Math.max(1, Math.min(16, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_CONCURRENCY, 1)))),
    channelRecoveryProbeEnabled: parseBoolean(env.CHANNEL_RECOVERY_PROBE_ENABLED, false),
    proxyLogRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_DAYS, 30))),
    proxyLogRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES, 30))),
    proxyFileRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_DAYS, 30))),
    proxyFileRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_PRUNE_INTERVAL_MINUTES, 60))),
    proxyErrorKeywords: parseCsvList(env.PROXY_ERROR_KEYWORDS),
    proxyEmptyContentFailEnabled: parseBoolean(env.PROXY_EMPTY_CONTENT_FAIL, false),
    globalBlockedBrands: [] as string[],
    globalAllowedModels: [] as string[],
    codexResponsesWebsocketBeta: parseOptionalSecret(env.CODEX_RESPONSES_WEBSOCKET_BETA) || 'responses_websockets=2026-02-06',
    codexHeaderDefaults: {
      userAgent: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_USER_AGENT),
      betaFeatures: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_BETA_FEATURES),
    },
    payloadRules: normalizePayloadRulesConfig(parseJsonValue(env.PAYLOAD_RULES_JSON || env.PAYLOAD_RULES)),
    routingWeights: {
      baseWeightFactor: parseNumber(env.BASE_WEIGHT_FACTOR, 0.5),
      valueScoreFactor: parseNumber(env.VALUE_SCORE_FACTOR, 0.5),
      costWeight: parseNumber(env.COST_WEIGHT, 0.4),
      balanceWeight: parseNumber(env.BALANCE_WEIGHT, 0.3),
      usageWeight: parseNumber(env.USAGE_WEIGHT, 0.3),
    },
    balanceRoutingPolicy: normalizeBalanceRoutingPolicy({
      mode: env.BALANCE_ROUTING_POLICY,
      threshold: env.BALANCE_ROUTING_THRESHOLD,
      softAvoidMultiplier: env.BALANCE_ROUTING_SOFT_AVOID_MULTIPLIER,
    }) satisfies BalanceRoutingPolicy,
  };
}

export const config = buildConfig(process.env);

export function buildFastifyOptions(
  appConfig: ReturnType<typeof buildConfig>,
): FastifyServerOptions {
  return {
    logger: true,
    trustProxy: appConfig.trustProxy,
    bodyLimit: appConfig.requestBodyLimit,
  };
}
