import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, runtimeDbDialect, schema } from '../../db/index.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import {
  buildOauthCredentialPayload,
  buildOauthInfoFromAccount,
  buildStoredOauthStateFromAccount,
  getOauthInfoFromAccount,
} from './oauthAccount.js';
import { OAuthProviderHttpError, sanitizeOauthProviderErrorMessage } from './providerError.js';
import { getOAuthProviderDefinition, type OAuthProviderRefreshResult } from './providers.js';
import { resolveOauthAccountProxyUrl } from './requestProxy.js';
import { publishTokenRouterCacheInvalidation } from '../tokenRouterCacheInvalidation.js';

export const OAUTH_REFRESH_STATES = {
  Idle: 'idle',
  Ready: 'ready',
  TransientError: 'transient_error',
  ReauthorizationRequired: 'reauthorization_required',
  RefreshUnknown: 'refresh_unknown',
} as const;

export type OauthRefreshState = typeof OAUTH_REFRESH_STATES[keyof typeof OAUTH_REFRESH_STATES];
export type OauthRefreshReason = 'unauthorized' | 'scheduled' | 'model_discovery' | 'manual' | 'unknown';

export type RefreshOauthAccessTokenOptions = {
  reason?: OauthRefreshReason;
  failedAccessToken?: string | null;
  force?: boolean;
  leaseWaitMs?: number;
};

type AccountRow = typeof schema.accounts.$inferSelect;

export type RefreshOauthAccessTokenResult = {
  accountId: number;
  accessToken: string;
  accountKey?: string;
  extraConfig: string | null;
  credentialVersion: number;
  refreshed: boolean;
  reused: boolean;
  account: AccountRow;
};

export type OAuthRefreshCoordinatorErrorCode =
  | 'account_not_found'
  | 'refresh_token_missing'
  | 'unsupported_provider'
  | 'lease_busy'
  | 'provider_rate_limited'
  | 'refresh_deferred'
  | 'reauthorization_required'
  | 'refresh_unknown'
  | 'provider_failure';

export class OAuthRefreshCoordinatorError extends Error {
  readonly code: OAuthRefreshCoordinatorErrorCode;
  readonly retryAfterMs: number | null;
  readonly refreshState: OauthRefreshState | null;
  readonly transient: boolean;

  constructor(input: {
    code: OAuthRefreshCoordinatorErrorCode;
    message: string;
    retryAfterMs?: number | null;
    refreshState?: OauthRefreshState | null;
    transient?: boolean;
    cause?: unknown;
  }) {
    super(sanitizeOauthProviderErrorMessage(input.message), input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'OAuthRefreshCoordinatorError';
    this.code = input.code;
    this.retryAfterMs = input.retryAfterMs ?? null;
    this.refreshState = input.refreshState ?? null;
    this.transient = input.transient === true;
  }
}

export function isOauthRefreshDeferredError(error: unknown): error is OAuthRefreshCoordinatorError {
  return error instanceof OAuthRefreshCoordinatorError && (
    error.code === 'lease_busy'
    || error.code === 'provider_rate_limited'
    || error.code === 'refresh_deferred'
  );
}

export function isOauthRefreshStateRoutable(
  input: Pick<AccountRow, 'oauthProvider' | 'oauthRefreshState'> | string | null | undefined,
): boolean {
  const state = typeof input === 'string' || input == null
    ? normalizeRefreshState(input)
    : normalizeRefreshState(input.oauthRefreshState);
  return state !== OAUTH_REFRESH_STATES.ReauthorizationRequired
    && state !== OAUTH_REFRESH_STATES.RefreshUnknown;
}

const MAX_PROVIDER_CONCURRENCY = 32;
const MAX_REFRESH_BACKOFF_MS = 30 * 60 * 1000;
const LEASE_POLL_INTERVAL_MS = 100;
const PERSIST_CAS_ATTEMPTS = 5;

type RefreshLease = {
  token: string;
  expiresAt: string;
  release(): Promise<void>;
};

type RefreshLeaseAttempt =
  | { ok: true; lease: RefreshLease }
  | { ok: false; kind: 'account_busy' | 'provider_busy' | 'provider_rate_limited'; retryAfterMs: number };

type RefreshFailureClassification = {
  state: OauthRefreshState;
  code: OAuthRefreshCoordinatorErrorCode;
  message: string;
  retryAfterMs: number | null;
  providerCooldownMs: number;
  transient: boolean;
};

function normalizeRefreshState(value: unknown): OauthRefreshState {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === OAUTH_REFRESH_STATES.Ready) return OAUTH_REFRESH_STATES.Ready;
  if (normalized === OAUTH_REFRESH_STATES.TransientError) return OAUTH_REFRESH_STATES.TransientError;
  if (normalized === OAUTH_REFRESH_STATES.ReauthorizationRequired) return OAUTH_REFRESH_STATES.ReauthorizationRequired;
  if (normalized === OAUTH_REFRESH_STATES.RefreshUnknown) return OAUTH_REFRESH_STATES.RefreshUnknown;
  return OAUTH_REFRESH_STATES.Idle;
}

function normalizeCredentialVersion(value: unknown): number {
  const normalized = Math.trunc(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 1;
}

function normalizePositiveMs(value: unknown, fallback: number): number {
  const normalized = Math.trunc(Number(value));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : fallback;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function resolveProviderConcurrency(provider: string): number {
  const configured = config.oauthRefreshProviderConcurrency[normalizeProvider(provider)]
    ?? config.oauthRefreshProviderDefaultConcurrency;
  return Math.max(1, Math.min(MAX_PROVIDER_CONCURRENCY, Math.trunc(configured || 1)));
}

function resolveLeaseWaitMs(options: RefreshOauthAccessTokenOptions): number {
  if (options.leaseWaitMs !== undefined) {
    return normalizePositiveMs(options.leaseWaitMs, 0);
  }
  if (options.reason === 'scheduled') return 0;
  return normalizePositiveMs(config.oauthRefreshLeaseWaitMs, 10_000);
}

function buildLeaseOwner(): string {
  const host = String(hostname() || process.env.HOSTNAME || 'local').trim() || 'local';
  return `${host}:${process.pid}`;
}

function tokenFingerprint(value: string | null | undefined): string {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function nullableEq(column: any, value: string | null | undefined) {
  return value === null || value === undefined ? isNull(column) : eq(column, value);
}

function hasCredentialIdentityChanged(baseline: AccountRow, current: AccountRow): boolean {
  return normalizeCredentialVersion(current.oauthCredentialVersion) !== normalizeCredentialVersion(baseline.oauthCredentialVersion)
    || current.accessToken !== baseline.accessToken
    || current.oauthCredentialPayload !== baseline.oauthCredentialPayload
    || current.oauthProvider !== baseline.oauthProvider
    || current.oauthAccountKey !== baseline.oauthAccountKey
    || current.oauthProjectId !== baseline.oauthProjectId;
}

function hasFailedAccessTokenAlreadyBeenReplaced(account: AccountRow, failedAccessToken?: string | null): boolean {
  const failed = String(failedAccessToken || '').trim();
  if (!failed) return false;
  return tokenFingerprint(account.accessToken) !== tokenFingerprint(failed);
}

function buildResult(account: AccountRow, input: { refreshed: boolean; reused: boolean }): RefreshOauthAccessTokenResult {
  const oauth = getOauthInfoFromAccount(account);
  publishTokenRouterCacheInvalidation();
  return {
    accountId: account.id,
    accessToken: account.accessToken,
    accountKey: oauth?.accountKey || oauth?.accountId,
    extraConfig: account.extraConfig ?? null,
    credentialVersion: normalizeCredentialVersion(account.oauthCredentialVersion),
    refreshed: input.refreshed,
    reused: input.reused,
    account,
  };
}

async function loadAccount(accountId: number): Promise<AccountRow | null> {
  return await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get() || null;
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const entry = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const code = String(entry.code ?? entry.errno ?? '').toUpperCase();
    const message = String(entry.message || '').toLowerCase();
    if (
      code === '23505'
      || code === '1062'
      || code === 'ER_DUP_ENTRY'
      || code === 'SQLITE_CONSTRAINT'
      || code === 'SQLITE_CONSTRAINT_UNIQUE'
      || message.includes('unique constraint')
      || message.includes('duplicate entry')
      || message.includes('duplicate key')
    ) {
      return true;
    }
    current = entry.cause;
  }
  return false;
}

async function ensureProviderState(provider: string): Promise<void> {
  const nowIso = new Date().toISOString();
  const values = {
    provider,
    consecutiveFailureCount: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.oauthRefreshProviderStates).values(values) as any)
      .onDuplicateKeyUpdate({
        set: { provider: sql`${schema.oauthRefreshProviderStates.provider}` },
      })
      .run();
    return;
  }
  await (db.insert(schema.oauthRefreshProviderStates).values(values) as any)
    .onConflictDoNothing({ target: schema.oauthRefreshProviderStates.provider })
    .run();
}

async function readProviderRetryAfterMs(provider: string, nowMs = Date.now()): Promise<number> {
  const state = await db.select().from(schema.oauthRefreshProviderStates)
    .where(eq(schema.oauthRefreshProviderStates.provider, provider))
    .get();
  const retryAtMs = state?.nextAllowedAt ? Date.parse(state.nextAllowedAt) : NaN;
  return Number.isFinite(retryAtMs) ? Math.max(1, retryAtMs - nowMs) : LEASE_POLL_INTERVAL_MS;
}

async function reserveProviderStartWindow(provider: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  await ensureProviderState(provider);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nextAllowedAt = new Date(nowMs + normalizePositiveMs(config.oauthRefreshProviderMinIntervalMs, 250)).toISOString();
  const updated = await db.update(schema.oauthRefreshProviderStates).set({
    lastStartedAt: nowIso,
    nextAllowedAt,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.oauthRefreshProviderStates.provider, provider),
    or(
      isNull(schema.oauthRefreshProviderStates.nextAllowedAt),
      lte(schema.oauthRefreshProviderStates.nextAllowedAt, nowIso),
    ),
  )).run();
  if (updated.changes > 0) return { ok: true };
  return { ok: false, retryAfterMs: await readProviderRetryAfterMs(provider, nowMs) };
}

class DatabaseRefreshLease implements RefreshLease {
  private released = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private currentExpiresAt: string;

  constructor(
    readonly token: string,
    initialExpiresAt: string,
    private readonly ttlMs: number,
    heartbeatMs: number,
  ) {
    this.currentExpiresAt = initialExpiresAt;
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        void this.renew().catch((error) => {
          console.warn(`[oauth-refresh] lease heartbeat failed: ${sanitizeOauthProviderErrorMessage(error)}`);
        });
      }, heartbeatMs);
      this.heartbeat.unref?.();
    }
  }

  get expiresAt(): string {
    return this.currentExpiresAt;
  }

  private async renew(): Promise<void> {
    if (this.released) return;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    await db.update(schema.oauthRefreshLeases).set({
      expiresAt,
      updatedAt: nowIso,
    }).where(eq(schema.oauthRefreshLeases.leaseToken, this.token)).run();
    this.currentExpiresAt = expiresAt;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    await db.delete(schema.oauthRefreshLeases)
      .where(eq(schema.oauthRefreshLeases.leaseToken, this.token))
      .run();
  }
}

async function tryAcquireRefreshLease(account: AccountRow, provider: string): Promise<RefreshLeaseAttempt> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  await db.delete(schema.oauthRefreshLeases)
    .where(lte(schema.oauthRefreshLeases.expiresAt, nowIso))
    .run();

  const existingAccountLease = await db.select().from(schema.oauthRefreshLeases)
    .where(eq(schema.oauthRefreshLeases.accountId, account.id))
    .get();
  if (existingAccountLease) {
    const expiresAtMs = Date.parse(existingAccountLease.expiresAt);
    return {
      ok: false,
      kind: 'account_busy',
      retryAfterMs: Number.isFinite(expiresAtMs) ? Math.max(1, expiresAtMs - nowMs) : LEASE_POLL_INTERVAL_MS,
    };
  }

  const providerState = await db.select().from(schema.oauthRefreshProviderStates)
    .where(eq(schema.oauthRefreshProviderStates.provider, provider))
    .get();
  const providerRetryAtMs = providerState?.nextAllowedAt ? Date.parse(providerState.nextAllowedAt) : NaN;
  if (Number.isFinite(providerRetryAtMs) && providerRetryAtMs > nowMs) {
    return { ok: false, kind: 'provider_rate_limited', retryAfterMs: providerRetryAtMs - nowMs };
  }

  const ttlMs = Math.max(5_000, normalizePositiveMs(config.oauthRefreshLeaseTtlMs, 60_000));
  const heartbeatMs = Math.max(1_000, normalizePositiveMs(config.oauthRefreshLeaseHeartbeatMs, 15_000));
  const providerConcurrency = resolveProviderConcurrency(provider);

  for (let providerSlot = 1; providerSlot <= providerConcurrency; providerSlot += 1) {
    const leaseToken = randomUUID();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    try {
      await db.insert(schema.oauthRefreshLeases).values({
        accountId: account.id,
        provider,
        providerSlot,
        leaseToken,
        leaseOwner: buildLeaseOwner(),
        credentialVersion: normalizeCredentialVersion(account.oauthCredentialVersion),
        expiresAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();

      const providerWindow = await reserveProviderStartWindow(provider);
      if (!providerWindow.ok) {
        await db.delete(schema.oauthRefreshLeases)
          .where(eq(schema.oauthRefreshLeases.leaseToken, leaseToken))
          .run();
        return { ok: false, kind: 'provider_rate_limited', retryAfterMs: providerWindow.retryAfterMs };
      }

      return {
        ok: true,
        lease: new DatabaseRefreshLease(leaseToken, expiresAt, ttlMs, heartbeatMs),
      };
    } catch (error) {
      if (looksLikeUniqueCollision(error)) continue;
      throw error;
    }
  }

  const accountLease = await db.select().from(schema.oauthRefreshLeases)
    .where(eq(schema.oauthRefreshLeases.accountId, account.id))
    .get();
  if (accountLease) {
    const expiresAtMs = Date.parse(accountLease.expiresAt);
    return {
      ok: false,
      kind: 'account_busy',
      retryAfterMs: Number.isFinite(expiresAtMs) ? Math.max(1, expiresAtMs - Date.now()) : LEASE_POLL_INTERVAL_MS,
    };
  }

  const providerLease = await db.select().from(schema.oauthRefreshLeases)
    .where(eq(schema.oauthRefreshLeases.provider, provider))
    .orderBy(asc(schema.oauthRefreshLeases.expiresAt))
    .get();
  const expiresAtMs = providerLease ? Date.parse(providerLease.expiresAt) : NaN;
  return {
    ok: false,
    kind: 'provider_busy',
    retryAfterMs: Number.isFinite(expiresAtMs) ? Math.max(1, expiresAtMs - Date.now()) : LEASE_POLL_INTERVAL_MS,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function acquireRefreshLeaseOrReuse(
  initialAccount: AccountRow,
  provider: string,
  options: RefreshOauthAccessTokenOptions,
): Promise<{ lease: RefreshLease; account: AccountRow } | { reusedAccount: AccountRow }> {
  const waitMs = resolveLeaseWaitMs(options);
  const deadline = Date.now() + waitMs;
  let baseline = initialAccount;

  while (true) {
    const attempt = await tryAcquireRefreshLease(baseline, provider);
    if (attempt.ok) {
      const latest = await loadAccount(baseline.id);
      if (!latest) {
        await attempt.lease.release();
        throw new OAuthRefreshCoordinatorError({ code: 'account_not_found', message: 'oauth account not found' });
      }
      if (hasCredentialIdentityChanged(baseline, latest) || hasFailedAccessTokenAlreadyBeenReplaced(latest, options.failedAccessToken)) {
        await attempt.lease.release();
        return { reusedAccount: latest };
      }
      return { lease: attempt.lease, account: latest };
    }

    if (attempt.kind === 'provider_rate_limited') {
      throw new OAuthRefreshCoordinatorError({
        code: 'provider_rate_limited',
        message: 'OAuth provider refresh is rate limited',
        retryAfterMs: attempt.retryAfterMs,
        refreshState: OAUTH_REFRESH_STATES.TransientError,
        transient: true,
      });
    }
    if (Date.now() >= deadline) {
      throw new OAuthRefreshCoordinatorError({
        code: 'lease_busy',
        message: attempt.kind === 'account_busy'
          ? 'OAuth credential refresh is already running for this account'
          : 'OAuth provider refresh capacity is busy',
        retryAfterMs: attempt.retryAfterMs,
        transient: true,
      });
    }

    await sleep(Math.min(LEASE_POLL_INTERVAL_MS, Math.max(1, attempt.retryAfterMs)));
    const latest = await loadAccount(baseline.id);
    if (!latest) {
      throw new OAuthRefreshCoordinatorError({ code: 'account_not_found', message: 'oauth account not found' });
    }
    if (hasCredentialIdentityChanged(initialAccount, latest) || hasFailedAccessTokenAlreadyBeenReplaced(latest, options.failedAccessToken)) {
      return { reusedAccount: latest };
    }
    baseline = latest;
  }
}

function resolveStatusCode(error: unknown): number | null {
  if (error instanceof OAuthProviderHttpError) return error.statusCode;
  const message = String((error as { message?: unknown })?.message || error || '');
  const matched = message.match(/(?:http|status)\s*[:=]?\s*(\d{3})/i);
  const status = Number(matched?.[1]);
  return Number.isFinite(status) ? status : null;
}

function isInvalidRefreshCredentialError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  return [
    'invalid_grant',
    'invalid_refresh_token',
    'refresh_token_reused',
    'refresh token reused',
    'refresh_token_invalidated',
    'token_expired',
    'app_session_terminated',
    'refresh token expired',
    'refresh token is invalid',
  ].some((pattern) => message.includes(pattern));
}

function computeTransientBackoffMs(failureCount: number): number {
  const base = Math.max(1_000, normalizePositiveMs(config.oauthRefreshTransientBackoffBaseMs, 30_000));
  return Math.min(MAX_REFRESH_BACKOFF_MS, base * (2 ** Math.min(6, Math.max(0, failureCount))));
}

function classifyRefreshFailure(error: unknown, account: AccountRow): RefreshFailureClassification {
  const message = sanitizeOauthProviderErrorMessage((error as { message?: unknown })?.message || error);
  if (isInvalidRefreshCredentialError(error)) {
    return {
      state: OAUTH_REFRESH_STATES.ReauthorizationRequired,
      code: 'reauthorization_required',
      message,
      retryAfterMs: null,
      providerCooldownMs: 0,
      transient: false,
    };
  }

  const statusCode = resolveStatusCode(error);
  const failureCount = Math.max(0, Math.trunc(account.oauthRefreshFailureCount || 0));
  const backoffMs = computeTransientBackoffMs(failureCount);
  const explicitRetryAfterMs = error instanceof OAuthProviderHttpError ? error.retryAfterMs : null;
  const retryAfterMs = Math.max(backoffMs, explicitRetryAfterMs ?? 0);
  const isRateLimited = statusCode === 429;
  return {
    state: OAUTH_REFRESH_STATES.TransientError,
    code: 'provider_failure',
    message,
    retryAfterMs,
    providerCooldownMs: isRateLimited || statusCode === 503 ? retryAfterMs : 0,
    transient: true,
  };
}

async function markProviderRefreshSuccess(provider: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await ensureProviderState(provider);
  await db.update(schema.oauthRefreshProviderStates).set({
    lastCompletedAt: nowIso,
    consecutiveFailureCount: 0,
    lastError: null,
    updatedAt: nowIso,
  }).where(eq(schema.oauthRefreshProviderStates.provider, provider)).run();
}

async function markProviderRefreshFailure(
  provider: string,
  classification: RefreshFailureClassification,
): Promise<void> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  await ensureProviderState(provider);
  const current = await db.select().from(schema.oauthRefreshProviderStates)
    .where(eq(schema.oauthRefreshProviderStates.provider, provider))
    .get();
  const existingNextAllowedAtMs = current?.nextAllowedAt ? Date.parse(current.nextAllowedAt) : NaN;
  const failureNextAllowedAtMs = classification.providerCooldownMs > 0
    ? nowMs + classification.providerCooldownMs
    : NaN;
  const nextAllowedAtMs = Math.max(
    Number.isFinite(existingNextAllowedAtMs) ? existingNextAllowedAtMs : 0,
    Number.isFinite(failureNextAllowedAtMs) ? failureNextAllowedAtMs : 0,
  );
  await db.update(schema.oauthRefreshProviderStates).set({
    lastCompletedAt: nowIso,
    consecutiveFailureCount: sql`coalesce(${schema.oauthRefreshProviderStates.consecutiveFailureCount}, 0) + 1`,
    lastError: classification.message,
    ...(nextAllowedAtMs > 0 ? { nextAllowedAt: new Date(nextAllowedAtMs).toISOString() } : {}),
    updatedAt: nowIso,
  }).where(eq(schema.oauthRefreshProviderStates.provider, provider)).run();
}

async function markAccountRefreshFailure(
  account: AccountRow,
  classification: RefreshFailureClassification,
): Promise<AccountRow | null> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const retryAt = classification.retryAfterMs === null
    ? null
    : new Date(nowMs + classification.retryAfterMs).toISOString();
  const updated = await db.update(schema.accounts).set({
    oauthRefreshState: classification.state,
    oauthRefreshFailureCount: sql`coalesce(${schema.accounts.oauthRefreshFailureCount}, 0) + 1`,
    oauthRefreshRetryAt: retryAt,
    oauthRefreshLastAttemptAt: nowIso,
    oauthRefreshLastError: classification.message,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.accounts.id, account.id),
    eq(schema.accounts.oauthCredentialVersion, normalizeCredentialVersion(account.oauthCredentialVersion)),
    eq(schema.accounts.accessToken, account.accessToken),
    nullableEq(schema.accounts.oauthCredentialPayload, account.oauthCredentialPayload),
  )).run();
  if (updated.changes > 0) publishTokenRouterCacheInvalidation();
  if (updated.changes <= 0) return await loadAccount(account.id);
  return await loadAccount(account.id);
}

async function markRefreshUnknown(account: AccountRow, error: unknown): Promise<AccountRow | null> {
  const message = sanitizeOauthProviderErrorMessage(
    `OAuth refresh provider succeeded but credential persistence is unknown: ${(error as Error)?.message || error}`,
  );
  const nowIso = new Date().toISOString();
  const updated = await db.update(schema.accounts).set({
    oauthRefreshState: OAUTH_REFRESH_STATES.RefreshUnknown,
    oauthRefreshFailureCount: sql`coalesce(${schema.accounts.oauthRefreshFailureCount}, 0) + 1`,
    oauthRefreshRetryAt: null,
    oauthRefreshLastAttemptAt: nowIso,
    oauthRefreshLastError: message,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.accounts.id, account.id),
    eq(schema.accounts.oauthCredentialVersion, normalizeCredentialVersion(account.oauthCredentialVersion)),
    eq(schema.accounts.accessToken, account.accessToken),
    nullableEq(schema.accounts.oauthCredentialPayload, account.oauthCredentialPayload),
  )).run();
  if (updated.changes > 0) publishTokenRouterCacheInvalidation();
  if (updated.changes <= 0) return await loadAccount(account.id);
  return await loadAccount(account.id);
}

async function persistRefreshedCredentials(
  attemptedAccount: AccountRow,
  refreshed: OAuthProviderRefreshResult,
): Promise<{ account: AccountRow; reused: boolean }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < PERSIST_CAS_ATTEMPTS; attempt += 1) {
    const current = await loadAccount(attemptedAccount.id);
    if (!current) {
      throw new Error('oauth account not found after provider refresh');
    }
    if (hasCredentialIdentityChanged(attemptedAccount, current)) {
      return { account: current, reused: true };
    }

    const oauth = getOauthInfoFromAccount(current);
    if (!oauth) {
      throw new Error('account is no longer managed by oauth');
    }
    const nextOauth = buildOauthInfoFromAccount(current, {
      provider: oauth.provider,
      accountId: refreshed.accountId || oauth.accountId,
      accountKey: refreshed.accountKey || oauth.accountKey || refreshed.accountId || oauth.accountId,
      email: refreshed.email || oauth.email,
      planType: refreshed.planType || oauth.planType,
      projectId: refreshed.projectId || oauth.projectId,
      refreshToken: refreshed.refreshToken || oauth.refreshToken,
      tokenExpiresAt: refreshed.tokenExpiresAt || oauth.tokenExpiresAt,
      idToken: refreshed.idToken || oauth.idToken,
      providerData: {
        ...(oauth.providerData || {}),
        ...(refreshed.providerData || {}),
      },
    });
    const extraConfig = mergeAccountExtraConfig(current.extraConfig, {
      credentialMode: 'session',
      oauth: buildStoredOauthStateFromAccount(current, nextOauth),
    });
    const nowIso = new Date().toISOString();
    const currentVersion = normalizeCredentialVersion(current.oauthCredentialVersion);

    try {
      const updated = await db.update(schema.accounts).set({
        accessToken: refreshed.accessToken,
        oauthProvider: oauth.provider,
        oauthAccountKey: nextOauth.accountKey || nextOauth.accountId || null,
        oauthProjectId: nextOauth.projectId || null,
        oauthCredentialPayload: buildOauthCredentialPayload(nextOauth),
        oauthCredentialVersion: currentVersion + 1,
        oauthRefreshState: OAUTH_REFRESH_STATES.Ready,
        oauthRefreshFailureCount: 0,
        oauthRefreshRetryAt: null,
        oauthRefreshLastAttemptAt: nowIso,
        oauthRefreshLastSuccessAt: nowIso,
        oauthRefreshLastError: null,
        extraConfig,
        status: 'active',
        updatedAt: nowIso,
      }).where(and(
        eq(schema.accounts.id, current.id),
        eq(schema.accounts.oauthCredentialVersion, currentVersion),
        eq(schema.accounts.accessToken, current.accessToken),
        nullableEq(schema.accounts.oauthCredentialPayload, current.oauthCredentialPayload),
        nullableEq(schema.accounts.oauthProvider, current.oauthProvider),
        nullableEq(schema.accounts.oauthAccountKey, current.oauthAccountKey),
        nullableEq(schema.accounts.oauthProjectId, current.oauthProjectId),
        nullableEq(schema.accounts.extraConfig, current.extraConfig),
      )).run();
      if (updated.changes > 0) {
        const durable = await loadAccount(current.id);
        if (!durable) throw new Error('oauth account missing after credential CAS');
        return { account: durable, reused: false };
      }
    } catch (error) {
      lastError = error;
      const durable = await loadAccount(current.id).catch(() => null);
      if (durable && hasCredentialIdentityChanged(attemptedAccount, durable)) {
        return { account: durable, reused: true };
      }
      break;
    }
  }

  throw lastError || new Error('oauth credential CAS did not converge');
}

function assertRefreshableAccount(account: AccountRow, options: RefreshOauthAccessTokenOptions) {
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth?.refreshToken) {
    throw new OAuthRefreshCoordinatorError({
      code: 'refresh_token_missing',
      message: 'oauth refresh token missing',
      refreshState: OAUTH_REFRESH_STATES.ReauthorizationRequired,
    });
  }
  const definition = getOAuthProviderDefinition(oauth.provider);
  if (!definition) {
    throw new OAuthRefreshCoordinatorError({
      code: 'unsupported_provider',
      message: `unsupported oauth provider: ${oauth.provider}`,
    });
  }

  const state = normalizeRefreshState(account.oauthRefreshState);
  if (state === OAUTH_REFRESH_STATES.ReauthorizationRequired) {
    throw new OAuthRefreshCoordinatorError({
      code: 'reauthorization_required',
      message: 'OAuth account requires reauthorization',
      refreshState: state,
    });
  }
  if (state === OAUTH_REFRESH_STATES.RefreshUnknown) {
    throw new OAuthRefreshCoordinatorError({
      code: 'refresh_unknown',
      message: 'OAuth credential persistence is unknown; reauthorization is required before retrying',
      refreshState: state,
    });
  }

  const retryAtMs = account.oauthRefreshRetryAt ? Date.parse(account.oauthRefreshRetryAt) : NaN;
  if (!options.force && Number.isFinite(retryAtMs) && retryAtMs > Date.now()) {
    throw new OAuthRefreshCoordinatorError({
      code: 'refresh_deferred',
      message: 'OAuth refresh is in backoff',
      retryAfterMs: retryAtMs - Date.now(),
      refreshState: OAUTH_REFRESH_STATES.TransientError,
      transient: true,
    });
  }

  return { oauth, definition };
}

export async function refreshOauthAccessTokenCoordinated(
  accountId: number,
  options: RefreshOauthAccessTokenOptions = {},
): Promise<RefreshOauthAccessTokenResult> {
  const initialAccount = await loadAccount(accountId);
  if (!initialAccount) {
    throw new OAuthRefreshCoordinatorError({ code: 'account_not_found', message: 'oauth account not found' });
  }
  const initial = assertRefreshableAccount(initialAccount, options);
  if (hasFailedAccessTokenAlreadyBeenReplaced(initialAccount, options.failedAccessToken)) {
    return buildResult(initialAccount, { refreshed: false, reused: true });
  }

  const acquired = await acquireRefreshLeaseOrReuse(initialAccount, normalizeProvider(initial.oauth.provider), options);
  if ('reusedAccount' in acquired) {
    return buildResult(acquired.reusedAccount, { refreshed: false, reused: true });
  }

  const { lease } = acquired;
  const attemptedAccount = acquired.account;
  try {
    const { oauth, definition } = assertRefreshableAccount(attemptedAccount, options);
    let refreshed: OAuthProviderRefreshResult;
    try {
      refreshed = await definition.refreshAccessToken({
        refreshToken: oauth.refreshToken!,
        oauth: {
          projectId: oauth.projectId,
          providerData: oauth.providerData,
        },
        proxyUrl: await resolveOauthAccountProxyUrl({
          siteId: attemptedAccount.siteId,
          extraConfig: attemptedAccount.extraConfig,
        }),
      });
    } catch (error) {
      const latest = await loadAccount(attemptedAccount.id);
      if (latest && hasCredentialIdentityChanged(attemptedAccount, latest)) {
        await markProviderRefreshSuccess(normalizeProvider(oauth.provider));
        return buildResult(latest, { refreshed: false, reused: true });
      }

      const classification = classifyRefreshFailure(error, attemptedAccount);
      await Promise.allSettled([
        markProviderRefreshFailure(normalizeProvider(oauth.provider), classification),
        markAccountRefreshFailure(attemptedAccount, classification),
      ]);
      throw new OAuthRefreshCoordinatorError({
        code: classification.code,
        message: classification.message,
        retryAfterMs: classification.retryAfterMs,
        refreshState: classification.state,
        transient: classification.transient,
        cause: error,
      });
    }

    try {
      const persisted = await persistRefreshedCredentials(attemptedAccount, refreshed);
      await markProviderRefreshSuccess(normalizeProvider(oauth.provider));
      return buildResult(persisted.account, {
        refreshed: !persisted.reused,
        reused: persisted.reused,
      });
    } catch (error) {
      const latest = await loadAccount(attemptedAccount.id).catch(() => null);
      if (latest && hasCredentialIdentityChanged(attemptedAccount, latest)) {
        await markProviderRefreshSuccess(normalizeProvider(oauth.provider));
        return buildResult(latest, { refreshed: false, reused: true });
      }
      await Promise.allSettled([
        markProviderRefreshSuccess(normalizeProvider(oauth.provider)),
        markRefreshUnknown(attemptedAccount, error),
      ]);
      throw new OAuthRefreshCoordinatorError({
        code: 'refresh_unknown',
        message: 'OAuth refresh succeeded upstream but local credential persistence is unknown',
        refreshState: OAUTH_REFRESH_STATES.RefreshUnknown,
        cause: error,
      });
    }
  } finally {
    await lease.release().catch((error) => {
      console.warn(`[oauth-refresh] lease release failed: ${sanitizeOauthProviderErrorMessage(error)}`);
    });
  }
}
