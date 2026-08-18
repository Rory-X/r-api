import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { insertAndGetById } from '../../db/insertHelpers.js';
import {
  getProxyUrlFromExtraConfig,
  getUseSystemProxyFromExtraConfig,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
} from '../accountExtraConfig.js';
import { refreshModelsForAccount } from '../modelService.js';
import * as routeRefreshWorkflow from '../routeRefreshWorkflow.js';
import {
  createOauthSession,
  getOauthSession,
  markOauthSessionError,
  markOauthSessionSuccess,
} from './sessionStore.js';
import { getOAuthLoopbackCallbackServerState } from './localCallbackServer.js';
import {
  getOAuthProviderDefinition,
  listOAuthProviderDefinitions,
  type OAuthProviderId,
  type OAuthProviderDefinition,
} from './providers.js';
import { clearOauthProviderSiteDeletion, ensureOauthProviderSite } from './oauthSiteRegistry.js';
import {
  buildOauthCredentialPayload,
  buildOauthInfo,
  buildStoredOauthState,
  getOauthInfoFromAccount,
  type OauthInfo,
} from './oauthAccount.js';
import {
  buildCodexOauthInfo,
  type OauthExtraConfigInput,
  type OauthIdentityCarrierLike,
} from './codexAccount.js';
import { resolveOauthProviderProxyUrl } from './requestProxy.js';
import { ensureOauthIdentityBackfill } from './oauthIdentityBackfill.js';
import { buildQuotaSnapshotFromOauthInfo, refreshOauthQuotaSnapshot } from './quota.js';
import {
  refreshOauthAccessTokenCoordinated,
  type RefreshOauthAccessTokenOptions,
} from './refreshCoordinator.js';
import {
  listOauthRouteUnitsByAccountIds,
} from './routeUnitService.js';
import { publishTokenRouterCacheInvalidation } from '../tokenRouterCacheInvalidation.js';
import {
  normalizeOauthCredentialImport,
  OauthCredentialImportFormatError,
} from '../../../shared/oauthCredentialImport.js';

type OAuthProviderMetadata = ReturnType<typeof listOauthProviders>[number];
const MANUAL_CALLBACK_DELAY_MS = 15_000;
const OAUTH_QUOTA_BATCH_REFRESH_CONCURRENCY = 4;
const OAUTH_PROXY_BATCH_UPDATE_CONCURRENCY = 3;
const MAX_OAUTH_IMPORT_BATCH_SIZE = 100;
type OauthProviderHeaderAccountInput = OauthIdentityCarrierLike & {
  extraConfig?: OauthExtraConfigInput;
};

type OAuthStartInstructions = {
  redirectUri: string;
  callbackPort: number;
  callbackPath: string;
  manualCallbackDelayMs: number;
  sshTunnelCommand?: string;
  sshTunnelKeyCommand?: string;
};

type ImportedNativeOauthJson = {
  type?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  email?: unknown;
  account_id?: unknown;
  account_key?: unknown;
  expired?: unknown;
  disabled?: unknown;
  last_refresh?: unknown;
};

export class OauthImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OauthImportValidationError';
  }
}

function throwOauthImportValidationError(message: string): never {
  throw new OauthImportValidationError(message);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

function resolveSshTunnelHost(requestOrigin?: string): string | undefined {
  if (!requestOrigin) return undefined;
  try {
    const parsed = new URL(requestOrigin);
    if (!parsed.hostname || isLoopbackHost(parsed.hostname)) {
      return undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function buildLoopbackInstructions(
  definition: OAuthProviderDefinition,
  requestOrigin?: string,
): OAuthStartInstructions {
  const sshHost = resolveSshTunnelHost(requestOrigin);
  return {
    redirectUri: definition.loopback.redirectUri,
    callbackPort: definition.loopback.port,
    callbackPath: definition.loopback.path,
    manualCallbackDelayMs: MANUAL_CALLBACK_DELAY_MS,
    sshTunnelCommand: sshHost
      ? `ssh -L ${definition.loopback.port}:127.0.0.1:${definition.loopback.port} root@${sshHost} -p 22`
      : undefined,
    sshTunnelKeyCommand: sshHost
      ? `ssh -i <path_to_your_key> -L ${definition.loopback.port}:127.0.0.1:${definition.loopback.port} root@${sshHost} -p 22`
      : undefined,
  };
}

function parseManualCallbackUrl(input: {
  callbackUrl: string;
  provider: string;
}) {
  const raw = asNonEmptyString(input.callbackUrl);
  if (!raw) {
    throw new Error('invalid oauth callback url');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('invalid oauth callback url');
  }

  const state = asNonEmptyString(parsed.searchParams.get('state'));
  const code = asNonEmptyString(parsed.searchParams.get('code'));
  const error = asNonEmptyString(parsed.searchParams.get('error'));
  const errorDescription = asNonEmptyString(parsed.searchParams.get('error_description'));
  if (!state || (!code && !error)) {
    throw new Error('invalid oauth callback url');
  }

  return {
    state,
    code,
    error: error
      ? (errorDescription ? `${error}: ${errorDescription}` : error)
      : undefined,
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  const raw = asNonEmptyString(token);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mapImportedOauthProvider(platform: string): OAuthProviderId | null {
  const normalized = platform.trim().toLowerCase();
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude') return 'claude';
  if (normalized === 'gemini-cli') return 'gemini-cli';
  if (normalized === 'antigravity') return 'antigravity';
  if (normalized === 'openai') return 'codex';
  if (normalized === 'anthropic' || normalized === 'claude') return 'claude';
  if (normalized === 'gemini' || normalized === 'gemini-cli') return 'gemini-cli';
  if (normalized === 'antigravity') return 'antigravity';
  return null;
}

function resolveImportedOauthIdentity(
  provider: OAuthProviderId,
  credentials: Record<string, unknown>,
): {
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  idToken?: string;
  email?: string;
  accountKey?: string;
  accountId?: string;
  planType?: string;
  projectId?: string;
  providerData?: Record<string, unknown>;
} {
  const idToken = asNonEmptyString(credentials.id_token);
  const claims = decodeJwtPayload(idToken);
  const openAiAuth = isRecord(claims?.['https://api.openai.com/auth'])
    ? claims?.['https://api.openai.com/auth'] as Record<string, unknown>
    : null;
  const accessToken = asNonEmptyString(credentials.access_token)
    || asNonEmptyString(credentials.session_token);
  if (!accessToken) {
    throwOauthImportValidationError('oauth credentials missing access_token/session_token');
  }

  const email = asNonEmptyString(credentials.email)
    || asNonEmptyString(claims?.email);
  const accountKey = asNonEmptyString(credentials.chatgpt_account_id)
    || asNonEmptyString(credentials.account_key)
    || asNonEmptyString(credentials.account_id)
    || asNonEmptyString(openAiAuth?.chatgpt_account_id)
    || email;
  const planType = asNonEmptyString(credentials.plan_type)
    || asNonEmptyString(openAiAuth?.chatgpt_plan_type);
  const tokenExpiresAt = asPositiveInteger(credentials.expires_at)
    || asPositiveInteger(credentials.token_expires_at);
  const providerData = isRecord(credentials.provider_data)
    ? credentials.provider_data as Record<string, unknown>
    : undefined;
  const projectId = asNonEmptyString(credentials.project_id)
    || asNonEmptyString(credentials.cloudaicompanionProject);

  return {
    accessToken,
    ...(asNonEmptyString(credentials.refresh_token) ? { refreshToken: asNonEmptyString(credentials.refresh_token) } : {}),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(accountKey ? { accountKey, accountId: accountKey } : {}),
    ...(planType ? { planType } : {}),
    ...(projectId ? { projectId } : {}),
    ...(providerData ? { providerData } : {}),
  };
}

function parseImportedOauthExpiry(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const normalized = Math.trunc(value);
    return normalized < 1_000_000_000_000 ? normalized * 1000 : normalized;
  }
  if (typeof value !== 'string') {
    throwOauthImportValidationError('invalid oauth expired timestamp');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const parsedNumeric = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsedNumeric) && parsedNumeric > 0) {
      return parsedNumeric < 1_000_000_000_000 ? parsedNumeric * 1000 : parsedNumeric;
    }
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throwOauthImportValidationError('invalid oauth expired timestamp');
  }
  return parsed;
}

function resolveImportedNativeOauthIdentity(
  payload: ImportedNativeOauthJson,
): {
  provider: OAuthProviderId;
  disabled: boolean;
  exchange: {
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    email?: string;
    accountKey?: string;
    accountId?: string;
    planType?: string;
    idToken?: string;
    providerData?: Record<string, unknown>;
  };
  name: string;
} {
  const rawType = asNonEmptyString(payload.type);
  const provider = rawType ? mapImportedOauthProvider(rawType) : null;
  if (!provider) {
    throwOauthImportValidationError(`unsupported oauth import type: ${rawType || 'unknown'}`);
  }

  const accessToken = asNonEmptyString(payload.access_token);
  if (!accessToken) {
    throwOauthImportValidationError('oauth credentials missing access_token');
  }

  const derived = resolveImportedOauthIdentity(provider, payload as Record<string, unknown>);
  const explicitEmail = asNonEmptyString(payload.email);
  const explicitAccountId = asNonEmptyString(payload.account_id);
  const explicitAccountKey = asNonEmptyString(payload.account_key);
  const tokenExpiresAt = parseImportedOauthExpiry(payload.expired);

  const exchange = {
    ...derived,
    accessToken,
    ...(asNonEmptyString(payload.refresh_token) ? { refreshToken: asNonEmptyString(payload.refresh_token) } : {}),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    ...(explicitEmail ? { email: explicitEmail } : {}),
    ...(explicitAccountId ? { accountId: explicitAccountId } : {}),
    ...(explicitAccountKey ? { accountKey: explicitAccountKey } : {}),
  };

  if (!exchange.accountKey && exchange.accountId) {
    exchange.accountKey = exchange.accountId;
  }
  if (!exchange.accountId && exchange.accountKey) {
    exchange.accountId = exchange.accountKey;
  }

  return {
    provider,
    disabled: payload.disabled === true,
    exchange,
    name: explicitEmail || explicitAccountKey || explicitAccountId || derived.email || derived.accountKey || derived.accountId || provider,
  };
}

function buildUsername(input: {
  email?: string;
  accountKey?: string;
  provider: string;
}) {
  return input.email || input.accountKey || `${input.provider}-user`;
}

async function getNextAccountSortOrder(): Promise<number> {
  const row = await db.select({
    maxSortOrder: sql<number>`COALESCE(MAX(${schema.accounts.sortOrder}), -1)`,
  }).from(schema.accounts).get();
  return (row?.maxSortOrder ?? -1) + 1;
}

async function revertPersistedOauthAccount(input: {
  accountId: number;
  created: boolean;
  previousAccount: typeof schema.accounts.$inferSelect | null;
  previousModelAvailability?: Array<typeof schema.modelAvailability.$inferSelect>;
}) {
  if (input.created) {
    await db.delete(schema.accounts).where(eq(schema.accounts.id, input.accountId)).run();
    return;
  }

  if (!input.previousAccount) return;
  await db.transaction(async (tx) => {
    await tx.update(schema.accounts).set({
      siteId: input.previousAccount!.siteId,
      username: input.previousAccount!.username,
      accessToken: input.previousAccount!.accessToken,
      apiToken: input.previousAccount!.apiToken,
      checkinEnabled: input.previousAccount!.checkinEnabled,
      status: input.previousAccount!.status,
      oauthProvider: input.previousAccount!.oauthProvider,
      oauthAccountKey: input.previousAccount!.oauthAccountKey,
      oauthProjectId: input.previousAccount!.oauthProjectId,
      oauthCredentialPayload: input.previousAccount!.oauthCredentialPayload,
      oauthCredentialVersion: input.previousAccount!.oauthCredentialVersion,
      oauthRefreshState: input.previousAccount!.oauthRefreshState,
      oauthRefreshFailureCount: input.previousAccount!.oauthRefreshFailureCount,
      oauthRefreshRetryAt: input.previousAccount!.oauthRefreshRetryAt,
      oauthRefreshLastAttemptAt: input.previousAccount!.oauthRefreshLastAttemptAt,
      oauthRefreshLastSuccessAt: input.previousAccount!.oauthRefreshLastSuccessAt,
      oauthRefreshLastError: input.previousAccount!.oauthRefreshLastError,
      extraConfig: input.previousAccount!.extraConfig,
      updatedAt: input.previousAccount!.updatedAt,
    }).where(eq(schema.accounts.id, input.previousAccount!.id)).run();

    if (input.previousModelAvailability) {
      await tx.delete(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, input.accountId))
        .run();
      if (input.previousModelAvailability.length > 0) {
        await tx.insert(schema.modelAvailability).values(input.previousModelAvailability.map((row) => ({
          accountId: input.previousAccount!.id,
          modelName: row.modelName,
          available: row.available,
          isManual: row.isManual,
          latencyMs: row.latencyMs,
          checkedAt: row.checkedAt,
        }))).run();
      }
    }
  });
}

async function mapWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) return [];

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(Math.trunc(concurrency), items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
    }
  }));

  return results;
}

function normalizeImportedOauthJsonItems(input: {
  data?: unknown;
  items?: unknown[];
}): {
  payloadItems: ImportedNativeOauthJson[];
  isBatch: boolean;
  skippedItems: Array<{ name: string; message: string }>;
} {
  const batchItems = Array.isArray(input.items) ? input.items : [];
  const sources = batchItems.length > 0
    ? batchItems
    : (input.data === undefined ? [] : [input.data]);
  const payloadItems: ImportedNativeOauthJson[] = [];
  const skippedItems: Array<{ name: string; message: string }> = [];
  let isBatch = batchItems.length > 0;

  for (const [sourceIndex, source] of sources.entries()) {
    try {
      const normalized = normalizeOauthCredentialImport(source);
      payloadItems.push(...normalized.records);
      isBatch = isBatch || normalized.format !== 'native' || normalized.records.length > 1;
      skippedItems.push(...normalized.issues.map((issue) => ({
        name: batchItems.length > 0 ? `items[${sourceIndex}]${issue.path.slice(1)}` : issue.path,
        message: issue.message,
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法识别 OAuth 凭证格式';
      if (sources.length === 1 || !(error instanceof OauthCredentialImportFormatError)) {
        throwOauthImportValidationError(message);
      }
      skippedItems.push({ name: `items[${sourceIndex}]`, message });
    }
  }

  return { payloadItems, isBatch, skippedItems };
}

async function activatePersistedOauthAccount(input: {
  definition: OAuthProviderDefinition;
  exchange: {
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    email?: string;
    accountKey?: string;
    accountId?: string;
    planType?: string;
    projectId?: string;
    idToken?: string;
    providerData?: Record<string, unknown>;
  };
  rebindAccountId?: number;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  persistedStatus?: 'active' | 'disabled';
  activateExistingAfterRefresh?: boolean;
  retainOnModelDiscoveryFailure?: boolean;
}) {
  const rollbackSnapshotByRebindAccountId = typeof input.rebindAccountId === 'number' && input.rebindAccountId > 0
    ? await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, input.rebindAccountId))
      .all()
    : [];
  const persisted = await upsertOauthAccount({
    definition: input.definition,
    exchange: input.exchange,
    rebindAccountId: input.rebindAccountId,
    proxyUrl: input.proxyUrl,
    useSystemProxy: input.useSystemProxy,
    persistedStatus: input.persistedStatus,
  });

  if (!persisted.account) {
    throw new Error('failed to persist oauth account');
  }

  const previousModelAvailability = rollbackSnapshotByRebindAccountId.length > 0
    ? rollbackSnapshotByRebindAccountId
    : persisted.created
      ? []
      : await db.select().from(schema.modelAvailability)
        .where(eq(schema.modelAvailability.accountId, persisted.previousAccount?.id ?? persisted.account.id))
        .all();

  const shouldRefreshModels = input.activateExistingAfterRefresh === true
    || (persisted.account.status || 'active') === 'active';
  let modelDiscoveryWarning: string | undefined;
  if (shouldRefreshModels) {
    const refreshResult = await refreshModelsForAccount(
      persisted.account.id,
      persisted.previousAccount ? { allowInactive: true } : undefined,
    );
    if (refreshResult.status !== 'success') {
      modelDiscoveryWarning = refreshResult.errorMessage
        || `${input.definition.metadata.provider} model discovery failed`;
      if (!input.retainOnModelDiscoveryFailure) {
        await revertPersistedOauthAccount({
          accountId: persisted.account.id,
          created: persisted.created,
          previousAccount: persisted.previousAccount,
          previousModelAvailability,
        });
        await routeRefreshWorkflow.rebuildRoutesOnly();
        throw new Error(modelDiscoveryWarning);
      }
    }
  }

  try {
    if (input.activateExistingAfterRefresh && persisted.previousAccount) {
      await db.update(schema.accounts).set({
        status: 'active',
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.accounts.id, persisted.account.id)).run();
      persisted.account = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, persisted.account.id))
        .get();
    }

    await routeRefreshWorkflow.rebuildRoutesOnly();
    return { ...persisted, modelDiscoveryWarning };
  } catch (error) {
    await revertPersistedOauthAccount({
      accountId: persisted.account.id,
      created: persisted.created,
      previousAccount: persisted.previousAccount,
      previousModelAvailability,
    });
    await routeRefreshWorkflow.rebuildRoutesOnly();
    throw error;
  }
}

async function ensureOauthSite(definition: OAuthProviderDefinition) {
  return ensureOauthProviderSite(definition);
}

async function findExistingOauthAccount(input: {
  provider: string;
  accountKey?: string;
  email?: string;
  projectId?: string;
  rebindAccountId?: number;
}) {
  if (typeof input.rebindAccountId === 'number' && input.rebindAccountId > 0) {
    return db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, input.rebindAccountId))
      .get();
  }

  const accountKey = asNonEmptyString(input.accountKey);
  const email = asNonEmptyString(input.email);
  const projectId = asNonEmptyString(input.projectId);

  if (accountKey) {
    const byKey = await db.select().from(schema.accounts).where(and(
      eq(schema.accounts.oauthProvider, input.provider),
      eq(schema.accounts.oauthAccountKey, accountKey),
      projectId
        ? eq(schema.accounts.oauthProjectId, projectId)
        : or(isNull(schema.accounts.oauthProjectId), eq(schema.accounts.oauthProjectId, '')),
    )).get();
    if (byKey) return byKey;
  }

  if (!accountKey && email && input.provider !== 'codex') {
    const byEmail = await db.select().from(schema.accounts).where(and(
      eq(schema.accounts.oauthProvider, input.provider),
      eq(schema.accounts.username, email),
    )).get();
    if (byEmail) return byEmail;
  }

  return null;
}

async function upsertOauthAccount(input: {
  definition: OAuthProviderDefinition;
  exchange: {
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    email?: string;
    accountKey?: string;
    accountId?: string;
    planType?: string;
    projectId?: string;
    idToken?: string;
    providerData?: Record<string, unknown>;
  };
  rebindAccountId?: number;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  persistedStatus?: 'active' | 'disabled';
}) {
  const site = await ensureOauthSite(input.definition);
  const existing = await findExistingOauthAccount({
    provider: input.definition.metadata.provider,
    accountKey: input.exchange.accountKey || input.exchange.accountId,
    email: input.exchange.email,
    projectId: input.exchange.projectId,
    rebindAccountId: input.rebindAccountId,
  });
  const username = buildUsername({
    email: input.exchange.email,
    accountKey: input.exchange.accountKey || input.exchange.accountId,
    provider: input.definition.metadata.provider,
  });
  const oauth = buildOauthInfo(existing?.extraConfig, {
    provider: input.definition.metadata.provider,
    accountId: input.exchange.accountId || input.exchange.accountKey,
    accountKey: input.exchange.accountKey || input.exchange.accountId,
    email: input.exchange.email,
    planType: input.exchange.planType,
    projectId: input.exchange.projectId,
    refreshToken: input.exchange.refreshToken,
    tokenExpiresAt: input.exchange.tokenExpiresAt,
    idToken: input.exchange.idToken,
    providerData: input.exchange.providerData,
  });
  const extraConfig = mergeAccountExtraConfig(existing?.extraConfig, {
    credentialMode: 'session',
    ...(input.proxyUrl !== undefined ? { proxyUrl: input.proxyUrl } : {}),
    ...(input.useSystemProxy !== undefined ? { useSystemProxy: input.useSystemProxy } : {}),
    oauth: buildStoredOauthState(oauth),
  });
  const oauthCredentialPayload = buildOauthCredentialPayload(oauth);

  if (existing) {
    await db.update(schema.accounts).set({
      siteId: site.id,
      username,
      accessToken: input.exchange.accessToken,
      apiToken: null,
      checkinEnabled: false,
      status: input.persistedStatus ?? 'disabled',
      oauthProvider: input.definition.metadata.provider,
      oauthAccountKey: oauth.accountKey || oauth.accountId || null,
      oauthProjectId: oauth.projectId || null,
      oauthCredentialPayload,
      oauthCredentialVersion: sql`coalesce(${schema.accounts.oauthCredentialVersion}, 0) + 1`,
      oauthRefreshState: 'ready',
      oauthRefreshFailureCount: 0,
      oauthRefreshRetryAt: null,
      oauthRefreshLastAttemptAt: null,
      oauthRefreshLastSuccessAt: new Date().toISOString(),
      oauthRefreshLastError: null,
      extraConfig,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accounts.id, existing.id)).run();
    publishTokenRouterCacheInvalidation();
    return {
      account: await db.select().from(schema.accounts).where(eq(schema.accounts.id, existing.id)).get(),
      site,
      created: false,
      previousAccount: existing,
    };
  }

  const created = await insertAndGetById<typeof schema.accounts.$inferSelect>({
    table: schema.accounts,
    idColumn: schema.accounts.id,
    values: {
      siteId: site.id,
      username,
      accessToken: input.exchange.accessToken,
      apiToken: null,
      checkinEnabled: false,
      status: input.persistedStatus ?? 'active',
      oauthProvider: input.definition.metadata.provider,
      oauthAccountKey: oauth.accountKey || oauth.accountId || null,
      oauthProjectId: oauth.projectId || null,
      oauthCredentialPayload,
      oauthCredentialVersion: 1,
      oauthRefreshState: 'ready',
      oauthRefreshFailureCount: 0,
      oauthRefreshLastSuccessAt: new Date().toISOString(),
      extraConfig,
      isPinned: false,
      sortOrder: await getNextAccountSortOrder(),
    },
    insertErrorMessage: `failed to create oauth account: ${input.definition.metadata.provider}`,
    loadErrorMessage: `failed to load created oauth account: ${input.definition.metadata.provider}`,
  });
  publishTokenRouterCacheInvalidation();
  return { account: created, site, created: true, previousAccount: null };
}

export function listOauthProviders() {
  return listOAuthProviderDefinitions().map((definition) => {
    const state = getOAuthLoopbackCallbackServerState(definition.metadata.provider);
    return {
      ...definition.metadata,
      enabled: state.ready || !state.attempted,
    };
  });
}

export function getOauthProviderDefaults() {
  return {
    systemProxyConfigured: !!resolveProxyUrlFromExtraConfig({ useSystemProxy: true }),
  };
}

export async function startOauthProviderFlow(input: {
  provider: string;
  rebindAccountId?: number;
  projectId?: string;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  requestOrigin?: string;
}) {
  const definition = getOAuthProviderDefinition(input.provider);
  if (!definition) {
    throw new Error(`unsupported oauth provider: ${input.provider}`);
  }
  const redirectUri = definition.loopback.redirectUri;
  const callbackServerState = getOAuthLoopbackCallbackServerState(input.provider);
  if (callbackServerState.attempted && !callbackServerState.ready) {
    throw new Error(`${input.provider} oauth callback listener is unavailable: ${callbackServerState.error || 'unknown error'}`);
  }
  await clearOauthProviderSiteDeletion(definition.metadata.provider);
  const session = createOauthSession({
    provider: input.provider,
    redirectUri,
    rebindAccountId: input.rebindAccountId,
    projectId: input.projectId,
    proxyUrl: input.proxyUrl,
    useSystemProxy: input.useSystemProxy,
  });
  return {
    provider: input.provider,
    state: session.state,
    authorizationUrl: await definition.buildAuthorizationUrl({
      state: session.state,
      redirectUri: session.redirectUri,
      codeVerifier: session.codeVerifier,
      projectId: session.projectId,
    }),
    instructions: buildLoopbackInstructions(definition, input.requestOrigin),
  };
}

export function getOauthSessionStatus(state: string) {
  const session = getOauthSession(state);
  if (!session) return null;
  return {
    provider: session.provider,
    state: session.state,
    status: session.status,
    accountId: session.accountId,
    siteId: session.siteId,
    error: session.error,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export async function handleOauthCallback(input: {
  provider: string;
  state: string;
  code?: string;
  error?: string;
}) {
  const session = getOauthSession(input.state);
  if (!session || session.provider !== input.provider) {
    throw new Error('oauth session not found or provider mismatch');
  }
  const definition = getOAuthProviderDefinition(input.provider);
  if (!definition) {
    markOauthSessionError(input.state, `unsupported oauth provider: ${input.provider}`);
    throw new Error(`unsupported oauth provider: ${input.provider}`);
  }
  if (input.error) {
    markOauthSessionError(input.state, input.error);
    throw new Error(input.error);
  }
  const code = asNonEmptyString(input.code);
  if (!code) {
    markOauthSessionError(input.state, 'missing oauth code');
    throw new Error('missing oauth code');
  }

  try {
    const resolvedProxyUrl = session.proxyUrl
      ? session.proxyUrl
      : session.useSystemProxy
        ? resolveProxyUrlFromExtraConfig({ useSystemProxy: true })
        : await resolveOauthProviderProxyUrl(input.provider);
    const exchange = await definition.exchangeAuthorizationCode({
      code,
      state: input.state,
      redirectUri: session.redirectUri,
      codeVerifier: session.codeVerifier,
      projectId: session.projectId,
      proxyUrl: resolvedProxyUrl,
    });
    const { account, site } = await activatePersistedOauthAccount({
      definition,
      exchange,
      rebindAccountId: session.rebindAccountId,
      proxyUrl: session.proxyUrl,
      useSystemProxy: session.useSystemProxy,
      activateExistingAfterRefresh: true,
    });
    if (!account) {
      markOauthSessionError(input.state, 'failed to persist oauth account');
      throw new Error('failed to persist oauth account');
    }
    markOauthSessionSuccess(input.state, {
      accountId: account.id,
      siteId: site.id,
    });
    return { accountId: account.id, siteId: site.id };
  } catch (error) {
    const message = (
      error instanceof Error
        ? (error.message || error.name)
        : String(error || 'OAuth failed')
    ).trim() || 'OAuth failed';
    markOauthSessionError(input.state, message);
    throw error;
  }
}

export async function submitOauthManualCallback(input: {
  state: string;
  callbackUrl: string;
}) {
  const session = getOauthSession(input.state);
  if (!session) {
    throw new Error('oauth session not found');
  }
  const parsed = parseManualCallbackUrl({
    callbackUrl: input.callbackUrl,
    provider: session.provider,
  });
  if (parsed.state !== input.state) {
    throw new Error('oauth callback state mismatch');
  }

  await handleOauthCallback({
    provider: session.provider,
    state: parsed.state,
    code: parsed.code,
    error: parsed.error,
  });

  return { success: true };
}

export async function listOauthConnections(options: {
  limit?: number;
  offset?: number;
} = {}) {
  await ensureOauthIdentityBackfill();
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));

  const totalRow = await db.select({
    count: sql<number>`COUNT(*)`,
  }).from(schema.accounts)
    .where(sql`${schema.accounts.oauthProvider} IS NOT NULL`)
    .get();
  const total = totalRow?.count ?? 0;

  const rows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(sql`${schema.accounts.oauthProvider} IS NOT NULL`)
    .orderBy(desc(schema.accounts.id))
    .limit(limit)
    .offset(offset)
    .all();

  const accountIds = rows.map((row) => row.accounts.id);
  if (accountIds.length <= 0) {
    return { items: [], total, limit, offset };
  }

  const modelRows = await db.select({
    accountId: schema.modelAvailability.accountId,
    modelName: schema.modelAvailability.modelName,
  }).from(schema.modelAvailability)
    .where(and(
      inArray(schema.modelAvailability.accountId, accountIds),
      eq(schema.modelAvailability.available, true),
    ))
    .all();
  const modelMap = new Map<number, string[]>();
  for (const row of modelRows) {
    if (typeof row.accountId !== 'number') continue;
    const list = modelMap.get(row.accountId) || [];
    list.push(row.modelName);
    modelMap.set(row.accountId, list);
  }

  const routeParticipationByAccount = await listOauthRouteUnitsByAccountIds(accountIds);
  const routeUnitIds = Array.from(new Set(
    Array.from(routeParticipationByAccount.values())
      .map((item) => item.id)
      .filter((id): id is number => Number.isFinite(id) && id > 0),
  ));

  const routeChannelRows = await db.select({
    accountId: schema.routeChannels.accountId,
    oauthRouteUnitId: schema.routeChannels.oauthRouteUnitId,
    enabled: schema.routeChannels.enabled,
    cooldownUntil: schema.routeChannels.cooldownUntil,
    lastSelectedAt: schema.routeChannels.lastSelectedAt,
    lastUsedAt: schema.routeChannels.lastUsedAt,
    lastFailAt: schema.routeChannels.lastFailAt,
    successCount: schema.routeChannels.successCount,
    failCount: schema.routeChannels.failCount,
    consecutiveFailCount: schema.routeChannels.consecutiveFailCount,
    cooldownLevel: schema.routeChannels.cooldownLevel,
  }).from(schema.routeChannels)
    .where(routeUnitIds.length > 0
      ? or(
        inArray(schema.routeChannels.accountId, accountIds),
        inArray(schema.routeChannels.oauthRouteUnitId, routeUnitIds),
      )
      : inArray(schema.routeChannels.accountId, accountIds))
    .all();
  const routeChannelsByAccount = new Map<number, typeof routeChannelRows>();
  const routeChannelsByRouteUnit = new Map<number, typeof routeChannelRows>();
  for (const row of routeChannelRows) {
    if (typeof row.accountId === 'number' && row.accountId > 0) {
      const accountRows = routeChannelsByAccount.get(row.accountId) || [];
      accountRows.push(row);
      routeChannelsByAccount.set(row.accountId, accountRows);
    }
    if (typeof row.oauthRouteUnitId === 'number' && row.oauthRouteUnitId > 0) {
      const unitRows = routeChannelsByRouteUnit.get(row.oauthRouteUnitId) || [];
      unitRows.push(row);
      routeChannelsByRouteUnit.set(row.oauthRouteUnitId, unitRows);
    }
  }

  const routeUnitMemberRows = routeUnitIds.length > 0
    ? await db.select().from(schema.oauthRouteUnitMembers)
      .where(and(
        inArray(schema.oauthRouteUnitMembers.unitId, routeUnitIds),
        inArray(schema.oauthRouteUnitMembers.accountId, accountIds),
      ))
      .all()
    : [];
  const routeUnitMemberByAccount = new Map<
    number,
    typeof schema.oauthRouteUnitMembers.$inferSelect
  >(routeUnitMemberRows.map((member) => [member.accountId, member]));

  const newestTime = (values: Array<string | null | undefined>): string | null => (
    values.filter((value): value is string => !!value).sort().at(-1) || null
  );

  const items = rows.flatMap((row) => {
    const oauth = getOauthInfoFromAccount(row.accounts);
    if (!oauth) return [];
    const models = modelMap.get(row.accounts.id) || [];
    const status = (
      oauth.modelDiscoveryStatus === 'abnormal'
      || row.accounts.status !== 'active'
      || row.sites.status !== 'active'
    ) ? 'abnormal' : 'healthy';
    const routeUnit = routeParticipationByAccount.get(row.accounts.id) || null;
    const routeParticipation = routeUnit
      ? {
        kind: routeUnit.kind,
        id: routeUnit.id,
        routeUnitId: routeUnit.id,
        name: routeUnit.name,
        strategy: routeUnit.strategy,
        memberCount: routeUnit.memberCount,
      }
      : null;
    const schedulingChannels = routeUnit?.kind === 'route_unit'
      ? (routeChannelsByRouteUnit.get(routeUnit.id) || [])
      : (routeChannelsByAccount.get(row.accounts.id) || []).filter((channel) => !channel.oauthRouteUnitId);
    const routeUnitMember = routeUnitMemberByAccount.get(row.accounts.id) || null;
    const enabledRouteCount = schedulingChannels.filter((channel) => channel.enabled !== false).length;
    const routeChannelCount = schedulingChannels.length;
    const nowIso = new Date().toISOString();
    const cooldownUntil = routeUnitMember?.cooldownUntil && routeUnitMember.cooldownUntil > nowIso
      ? routeUnitMember.cooldownUntil
      : newestTime(schedulingChannels
        .map((channel) => channel.cooldownUntil)
        .filter((value) => !!value && value > nowIso));
    const schedulingState = status === 'abnormal'
      ? 'blocked'
      : enabledRouteCount <= 0
        ? 'unrouted'
        : cooldownUntil
          ? 'cooldown'
          : 'ready';
    const schedulingStats = routeUnitMember
      ? {
        successCount: routeUnitMember.successCount || 0,
        failCount: routeUnitMember.failCount || 0,
        consecutiveFailCount: routeUnitMember.consecutiveFailCount || 0,
        cooldownLevel: routeUnitMember.cooldownLevel || 0,
        lastSelectedAt: routeUnitMember.lastSelectedAt || routeUnitMember.lastUsedAt || null,
        lastFailAt: routeUnitMember.lastFailAt || null,
      }
      : {
        successCount: schedulingChannels.reduce((totalValue, channel) => totalValue + (channel.successCount || 0), 0),
        failCount: schedulingChannels.reduce((totalValue, channel) => totalValue + (channel.failCount || 0), 0),
        consecutiveFailCount: Math.max(0, ...schedulingChannels.map((channel) => channel.consecutiveFailCount || 0)),
        cooldownLevel: Math.max(0, ...schedulingChannels.map((channel) => channel.cooldownLevel || 0)),
        lastSelectedAt: newestTime(schedulingChannels.map((channel) => channel.lastSelectedAt || channel.lastUsedAt)),
        lastFailAt: newestTime(schedulingChannels.map((channel) => channel.lastFailAt)),
      };
    return [{
      accountId: row.accounts.id,
      siteId: row.sites.id,
      provider: oauth.provider,
      username: row.accounts.username,
      email: oauth.email,
      accountKey: oauth.accountKey || oauth.accountId,
      planType: oauth.planType,
      projectId: oauth.projectId,
      modelCount: models.length,
      modelsPreview: models.slice(0, 10),
      quota: buildQuotaSnapshotFromOauthInfo(oauth),
      status,
      routeChannelCount,
      scheduling: {
        state: schedulingState,
        eligible: schedulingState === 'ready',
        mode: routeUnit?.kind === 'route_unit' ? 'route_unit' : 'single',
        routeCount: routeChannelCount,
        enabledRouteCount,
        cooldownUntil,
        ...schedulingStats,
      },
      lastModelSyncAt: oauth.lastModelSyncAt,
      lastModelSyncError: oauth.lastModelSyncError,
      proxyUrl: getProxyUrlFromExtraConfig(row.accounts.extraConfig),
      useSystemProxy: getUseSystemProxyFromExtraConfig(row.accounts.extraConfig),
      routeParticipation,
      routeUnit,
      site: {
        id: row.sites.id,
        name: row.sites.name,
        url: row.sites.url,
        platform: row.sites.platform,
      },
    }];
  });

  return { items, total, limit, offset };
}

export async function deleteOauthConnection(accountId: number) {
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const normalizedOauth = getOauthInfoFromAccount(account);
  if (!normalizedOauth) {
    throw new Error('account is not managed by oauth');
  }
  await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId)).run();
  await routeRefreshWorkflow.rebuildRoutesOnly();
  return { success: true };
}

export async function refreshOauthConnectionQuota(accountId: number) {
  const quota = await refreshOauthQuotaSnapshot(accountId);
  return { success: true, quota };
}

export async function refreshOauthConnectionQuotaBatch(accountIds: number[]) {
  const uniqueIds = Array.from(new Set(accountIds.filter((id) => Number.isFinite(id) && id > 0)));
  const items = await mapWithConcurrency(uniqueIds, OAUTH_QUOTA_BATCH_REFRESH_CONCURRENCY, async (accountId) => {
    try {
      const { quota } = await refreshOauthConnectionQuota(accountId);
      return {
        accountId,
        success: true,
        quota,
      };
    } catch (error: any) {
      return {
        accountId,
        success: false,
        error: error?.message || 'oauth quota refresh failed',
      };
    }
  }) satisfies Array<{
    accountId: number;
    success: boolean;
    quota?: ReturnType<typeof buildQuotaSnapshotFromOauthInfo>;
    error?: string;
  }>;

  const refreshed = items.filter((item) => item.success).length;
  const failed = items.length - refreshed;
  return {
    success: failed === 0,
    refreshed,
    failed,
    items,
  };
}

export async function importOauthConnectionsFromNativeJson(input: {
  data?: unknown;
  items?: unknown[];
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
}) {
  const normalizedImport = normalizeImportedOauthJsonItems(input);
  const { payloadItems } = normalizedImport;
  const continueOnItemFailure = normalizedImport.isBatch;
  if (payloadItems.length <= 0) {
    throwOauthImportValidationError('data must be a native oauth json object');
  }
  if (payloadItems.length > MAX_OAUTH_IMPORT_BATCH_SIZE) {
    throwOauthImportValidationError(`oauth import supports at most ${MAX_OAUTH_IMPORT_BATCH_SIZE} items`);
  }
  const items: Array<{
    name: string;
    status: 'imported' | 'skipped' | 'failed';
    accountId?: number;
    provider?: string;
    message?: string;
  }> = normalizedImport.skippedItems.map((item) => ({
    name: item.name,
    status: 'skipped',
    message: item.message,
  }));
  let imported = 0;

  for (const rawPayload of payloadItems) {
    if (!isRecord(rawPayload)) {
      throwOauthImportValidationError('data must be a native oauth json object');
    }
    const payload = rawPayload as ImportedNativeOauthJson;
    let resolvedIdentity: ReturnType<typeof resolveImportedNativeOauthIdentity> | null = null;
    try {
      resolvedIdentity = resolveImportedNativeOauthIdentity(payload);
      const definition = getOAuthProviderDefinition(resolvedIdentity.provider);
      if (!definition) {
        throw new Error(`unsupported oauth provider: ${resolvedIdentity.provider}`);
      }
      await clearOauthProviderSiteDeletion(definition.metadata.provider);
      const persisted = await activatePersistedOauthAccount({
        definition,
        exchange: resolvedIdentity.exchange,
        proxyUrl: input.proxyUrl,
        useSystemProxy: input.useSystemProxy,
        persistedStatus: resolvedIdentity.disabled ? 'disabled' : 'active',
        retainOnModelDiscoveryFailure: true,
      });
      imported += 1;
      items.push({
        name: resolvedIdentity.name,
        status: 'imported',
        provider: resolvedIdentity.provider,
        accountId: persisted.account?.id,
        message: persisted.modelDiscoveryWarning,
      });
    } catch (error: any) {
      items.push({
        name: resolvedIdentity?.name
          || asNonEmptyString(payload.email)
          || asNonEmptyString(payload.account_key)
          || asNonEmptyString(payload.account_id)
          || asNonEmptyString(payload.type)
          || 'unknown',
        status: 'failed',
        provider: resolvedIdentity?.provider || asNonEmptyString(payload.type) || undefined,
        message: error?.message || 'oauth import failed',
      });
      if (!continueOnItemFailure) {
        throw error;
      }
    }
  }

  const failed = items.filter((item) => item.status === 'failed').length;
  const skipped = items.filter((item) => item.status === 'skipped').length;

  return {
    success: failed === 0,
    imported,
    skipped,
    failed,
    items,
  };
}

type OauthConnectionProxySettingsInput = {
  accountId: number;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
};

async function updateOauthConnectionProxySettingsWithoutRouteRebuild(
  input: OauthConnectionProxySettingsInput,
) {
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, input.accountId))
    .get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth) {
    throw new Error('account is not managed by oauth');
  }

  const extraConfig = mergeAccountExtraConfig(account.extraConfig, {
    ...(input.proxyUrl !== undefined ? { proxyUrl: input.proxyUrl } : {}),
    ...(input.useSystemProxy !== undefined ? { useSystemProxy: input.useSystemProxy } : {}),
  });
  const updatedAt = new Date().toISOString();

  await db.update(schema.accounts).set({
    extraConfig,
    updatedAt,
  }).where(eq(schema.accounts.id, input.accountId)).run();

  const refreshResult = await refreshModelsForAccount(input.accountId, { allowInactive: true });

  return {
    success: true as const,
    accountId: input.accountId,
    proxyUrl: getProxyUrlFromExtraConfig(extraConfig),
    useSystemProxy: getUseSystemProxyFromExtraConfig(extraConfig),
    refreshedRoutes: true,
    modelRefresh: {
      success: refreshResult.status === 'success',
      status: refreshResult.status,
      errorCode: refreshResult.errorCode,
      errorMessage: refreshResult.status === 'success'
        ? null
        : (refreshResult.errorMessage || '模型刷新失败'),
      modelCount: refreshResult.modelCount,
      modelsPreview: refreshResult.modelsPreview,
    },
  };
}

export async function updateOauthConnectionProxySettings(input: OauthConnectionProxySettingsInput) {
  const result = await updateOauthConnectionProxySettingsWithoutRouteRebuild(input);
  await routeRefreshWorkflow.rebuildRoutesOnly();
  return result;
}

export async function updateOauthConnectionProxySettingsBatch(input: {
  accountIds: number[];
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
}) {
  const uniqueIds = Array.from(new Set(input.accountIds.filter((id) => Number.isFinite(id) && id > 0)));
  const items = await mapWithConcurrency(uniqueIds, OAUTH_PROXY_BATCH_UPDATE_CONCURRENCY, async (accountId) => {
    try {
      const result = await updateOauthConnectionProxySettingsWithoutRouteRebuild({
        accountId,
        proxyUrl: input.proxyUrl,
        useSystemProxy: input.useSystemProxy,
      });
      return {
        accountId,
        success: true as const,
        proxyUrl: result.proxyUrl,
        useSystemProxy: result.useSystemProxy,
        modelRefresh: result.modelRefresh,
      };
    } catch (error: any) {
      return {
        accountId,
        success: false as const,
        error: error?.message || 'oauth proxy update failed',
      };
    }
  });

  await routeRefreshWorkflow.rebuildRoutesOnly();
  const updated = items.filter((item) => item.success).length;
  return {
    success: items.every((item) => item.success),
    requested: uniqueIds.length,
    updated,
    failed: items.length - updated,
    refreshedRoutes: true as const,
    items,
  };
}

export async function startOauthRebindFlow(
  accountId: number,
  options?: { requestOrigin?: string; proxyUrl?: string | null; useSystemProxy?: boolean },
) {
  const { requestOrigin, proxyUrl, useSystemProxy } = options ?? {};
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth) {
    throw new Error('account is not managed by oauth');
  }
  return startOauthProviderFlow({
    provider: oauth.provider,
    rebindAccountId: accountId,
    projectId: oauth.projectId,
    proxyUrl: proxyUrl !== undefined
      ? proxyUrl
      : (getProxyUrlFromExtraConfig(account.extraConfig) ?? undefined),
    useSystemProxy: useSystemProxy !== undefined
      ? useSystemProxy
      : (getUseSystemProxyFromExtraConfig(account.extraConfig) || undefined),
    requestOrigin,
  });
}

export function buildOauthProviderHeaders(input: {
  account?: OauthProviderHeaderAccountInput | null;
  extraConfig?: OauthExtraConfigInput;
  downstreamHeaders?: Record<string, unknown>;
}) {
  const oauth = getOauthInfoFromAccount(input.account || {
    extraConfig: input.extraConfig,
  });
  if (!oauth) return {};
  const definition = getOAuthProviderDefinition(oauth.provider);
  if (!definition?.buildProxyHeaders) return {};
  return definition.buildProxyHeaders({
    oauth,
    downstreamHeaders: input.downstreamHeaders,
  });
}

export function buildCodexOauthProviderHeaders(input: {
  extraConfig?: OauthExtraConfigInput;
  downstreamHeaders?: Record<string, unknown>;
}) {
  const oauth = buildCodexOauthInfo(input.extraConfig);
  const definition = getOAuthProviderDefinition('codex');
  return definition?.buildProxyHeaders?.({
    oauth,
    downstreamHeaders: input.downstreamHeaders,
  }) || {};
}

export async function refreshOauthAccessToken(
  accountId: number,
  options: RefreshOauthAccessTokenOptions = {},
) {
  return refreshOauthAccessTokenCoordinated(accountId, options);
}

export async function refreshCodexOauthAccessToken(
  accountId: number,
  options: RefreshOauthAccessTokenOptions = {},
) {
  return refreshOauthAccessToken(accountId, options);
}

export type { OAuthProviderMetadata };
