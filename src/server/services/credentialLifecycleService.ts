import { and, asc, desc, eq, gt, inArray, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getCredentialModeFromExtraConfig,
  getPlatformUserIdFromExtraConfig,
  getSub2ApiAuthFromExtraConfig,
} from './accountExtraConfig.js';
import { buildRuntimeHealthForAccount } from './accountHealthService.js';
import { applyAccountUpdateWorkflow } from './accountUpdateWorkflow.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { getAdapter } from './platforms/index.js';
import { rebuildRoutesBestEffort } from './routeRefreshWorkflow.js';
import { publishTokenRouterCacheInvalidation } from './tokenRouterCacheInvalidation.js';
import {
  getManagedCredentialRefreshDescriptor,
  refreshManagedAccountCredential,
} from './managedCredentialRefreshService.js';
import {
  credentialVaultInternals,
  revokeCredentialVaultItem,
  setCredentialVaultItemEnabled,
} from './credentialVaultService.js';

const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_BATCH_ITEMS = 200;

export type CredentialLifecycleStatus =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'refreshing'
  | 'refresh_failed'
  | 'revoked'
  | 'invalid'
  | 'disabled'
  | 'metadata_only';

export type CredentialRefreshOwner = 'r_api' | 'external' | 'none';
export type CredentialLifecycleEntityType = 'account' | 'vault_item';
export type CredentialLifecycleAction = 'validate' | 'refresh' | 'enable' | 'disable' | 'revoke';

export type CredentialLifecycleRecord = {
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
  refreshOwner: CredentialRefreshOwner;
  expiresAt?: string;
  fingerprint?: string;
  lastRefreshAttemptAt?: string;
  lastRefreshSuccessAt?: string;
  lastRefreshError?: string;
  actions: {
    validate: boolean;
    refresh: boolean;
    enable: boolean;
    disable: boolean;
    revoke: boolean;
  };
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

export class CredentialLifecycleError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'CredentialLifecycleError';
  }
}

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;
type VaultRow = typeof schema.credentialVaultItems.$inferSelect;
type ProvenanceRow = typeof schema.credentialImportProvenance.$inferSelect;

function normalizePositiveId(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new CredentialLifecycleError(`${label} 无效`);
  return Math.trunc(parsed);
}

function normalizeOptionalPositiveId(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return normalizePositiveId(value, label);
}

function normalizeEntityType(value: unknown): CredentialLifecycleEntityType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized !== 'account' && normalized !== 'vault_item') {
    throw new CredentialLifecycleError('entityType 无效');
  }
  return normalized;
}

function normalizeAction(value: unknown): CredentialLifecycleAction {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!['validate', 'refresh', 'enable', 'disable', 'revoke'].includes(normalized)) {
    throw new CredentialLifecycleError('action 无效');
  }
  return normalized as CredentialLifecycleAction;
}

function normalizeLifecycleStatus(value: unknown): CredentialLifecycleStatus | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (![
    'active', 'expiring', 'expired', 'refreshing', 'refresh_failed',
    'revoked', 'invalid', 'disabled', 'metadata_only',
  ].includes(normalized)) throw new CredentialLifecycleError('status 无效');
  return normalized as CredentialLifecycleStatus;
}

function isoFromMs(value?: number): string | undefined {
  return value && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
}

function expiryStatus(
  expiresAt: string | undefined,
  nowMs: number,
  expiringWindowMs = EXPIRING_WINDOW_MS,
): CredentialLifecycleStatus | null {
  if (!expiresAt) return null;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return null;
  if (expiresAtMs <= nowMs) return 'expired';
  if (expiresAtMs - nowMs <= expiringWindowMs) return 'expiring';
  return null;
}

function accountKind(account: AccountRow, site: SiteRow): string {
  if (getOauthInfoFromAccount(account)) return 'oauth_token_set';
  if (site.platform.toLowerCase() === 'sub2api' && getSub2ApiAuthFromExtraConfig(account.extraConfig)) {
    return 'oauth_token_set';
  }
  return getCredentialModeFromExtraConfig(account.extraConfig) === 'apikey'
    || (!!account.apiToken && !account.accessToken)
    ? 'api_key'
    : 'session_token';
}

function lifecycleFromAccount(input: {
  account: AccountRow;
  site: SiteRow;
  refreshing: boolean;
  nowMs: number;
  expiringWindowMs?: number;
}): Omit<CredentialLifecycleRecord, 'entityType' | 'entityId' | 'site' | 'name' | 'kind' | 'actions'> {
  const { account, site, refreshing, nowMs } = input;
  const sourceStatus = (account.status || 'active').trim().toLowerCase();
  const oauth = getOauthInfoFromAccount(account);
  const sub2api = site.platform.toLowerCase() === 'sub2api'
    ? getSub2ApiAuthFromExtraConfig(account.extraConfig)
    : null;
  const expiresAt = isoFromMs(oauth?.tokenExpiresAt || sub2api?.tokenExpiresAt);
  const refreshOwner = getManagedCredentialRefreshDescriptor(account, site).owner;
  let status: CredentialLifecycleStatus = 'active';
  let statusReason = '凭证可用';

  if (sourceStatus === 'revoked') {
    status = 'revoked';
    statusReason = '凭证已在本地控制面撤销';
  } else if (sourceStatus === 'disabled' || site.status === 'disabled') {
    status = 'disabled';
    statusReason = sourceStatus === 'disabled' ? '账号已停用' : '所属站点已停用';
  } else if (refreshing) {
    status = 'refreshing';
    statusReason = '凭证正在刷新';
  } else if (oauth?.provider && account.oauthRefreshState === 'transient_error') {
    status = 'refresh_failed';
    statusReason = account.oauthRefreshLastError || '最近一次 OAuth 刷新失败';
  } else if (oauth?.provider && ['reauthorization_required', 'refresh_unknown'].includes(account.oauthRefreshState)) {
    status = 'invalid';
    statusReason = account.oauthRefreshLastError || 'OAuth 凭证需要重新授权';
  } else if (sourceStatus === 'expired') {
    status = 'expired';
    statusReason = '账号凭证已过期';
  } else {
    const expiry = expiryStatus(expiresAt, nowMs, input.expiringWindowMs);
    if (expiry) {
      status = expiry;
      statusReason = expiry === 'expired' ? '凭证已超过到期时间' : '凭证已进入到期提醒窗口';
    } else {
      const health = buildRuntimeHealthForAccount({
        accountStatus: account.status,
        siteStatus: site.status,
        extraConfig: account.extraConfig,
      });
      if (health.state === 'unhealthy' && health.source === 'auth') {
        status = 'invalid';
        statusReason = health.reason;
      } else if (health.state === 'degraded') {
        status = 'refresh_failed';
        statusReason = health.reason;
      }
    }
  }

  return {
    siteId: site.id,
    accountId: account.id,
    ...(oauth?.provider ? { provider: oauth.provider } : { provider: site.platform }),
    status,
    sourceStatus,
    statusReason,
    refreshOwner,
    ...(expiresAt ? { expiresAt } : {}),
    ...(account.oauthRefreshLastAttemptAt ? { lastRefreshAttemptAt: account.oauthRefreshLastAttemptAt } : {}),
    ...(account.oauthRefreshLastSuccessAt ? { lastRefreshSuccessAt: account.oauthRefreshLastSuccessAt } : {}),
    ...(account.oauthRefreshLastError ? { lastRefreshError: account.oauthRefreshLastError } : {}),
  };
}

function lifecycleFromVault(
  row: VaultRow,
  nowMs: number,
  expiringWindowMs = EXPIRING_WINDOW_MS,
): Omit<CredentialLifecycleRecord, 'entityType' | 'entityId' | 'site' | 'name' | 'actions'> {
  const sourceStatus = row.status.toLowerCase();
  const expiresAt = row.expiresAt || undefined;
  let status: CredentialLifecycleStatus = 'active';
  let statusReason = 'Vault 凭证可用';
  if (sourceStatus === 'revoked') {
    status = 'revoked';
    statusReason = 'Vault 凭证已撤销';
  } else if (sourceStatus === 'disabled') {
    status = 'disabled';
    statusReason = 'Vault 凭证已停用';
  } else if (sourceStatus === 'expired') {
    status = 'expired';
    statusReason = 'Vault 凭证已过期';
  } else {
    const expiry = expiryStatus(expiresAt, nowMs, expiringWindowMs);
    if (expiry) {
      status = expiry;
      statusReason = expiry === 'expired' ? 'Vault 凭证已超过到期时间' : 'Vault 凭证已进入到期提醒窗口';
    }
  }
  const metadata = credentialVaultInternals.parseMetadata(row.metadata);
  return {
    ...(row.siteId ? { siteId: row.siteId } : {}),
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(metadata?.adapterPlatform ? { provider: metadata.adapterPlatform } : {}),
    kind: row.kind,
    status,
    sourceStatus,
    statusReason,
    refreshOwner: 'none',
    ...(expiresAt ? { expiresAt } : {}),
    fingerprint: row.fingerprint,
  };
}

function actionsFor(record: Pick<CredentialLifecycleRecord, 'entityType' | 'status' | 'refreshOwner' | 'kind'>) {
  const terminal = record.status === 'revoked';
  return {
    validate: !terminal && record.status !== 'metadata_only',
    refresh: !terminal && record.entityType === 'account' && record.refreshOwner === 'r_api',
    enable: record.status === 'disabled',
    disable: !terminal && record.status !== 'disabled' && record.status !== 'metadata_only',
    revoke: !terminal && record.status !== 'metadata_only',
  };
}

function provenanceKey(type: CredentialLifecycleEntityType, id: number): string {
  return `${type}:${id}`;
}

function toProvenance(row: ProvenanceRow) {
  return {
    importJobId: row.jobId,
    sourceFormat: row.sourceFormat,
    ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
    operatorId: row.operatorId,
    conflictPolicy: row.conflictPolicy,
    importAction: row.importAction,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
  };
}

export async function listCredentialLifecycle(input: {
  siteId?: unknown;
  status?: unknown;
  entityType?: unknown;
  nowMs?: number;
  expiringWindowMs?: number;
} = {}): Promise<CredentialLifecycleRecord[]> {
  const siteId = normalizeOptionalPositiveId(input.siteId, 'siteId');
  const status = normalizeLifecycleStatus(input.status);
  const entityType = input.entityType === undefined || input.entityType === null || input.entityType === ''
    ? undefined
    : normalizeEntityType(input.entityType);
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const expiringWindowMs = typeof input.expiringWindowMs === 'number' && Number.isFinite(input.expiringWindowMs)
    ? Math.max(0, input.expiringWindowMs)
    : EXPIRING_WINDOW_MS;

  const provenanceRows = await db.select().from(schema.credentialImportProvenance)
    .orderBy(desc(schema.credentialImportProvenance.createdAt), desc(schema.credentialImportProvenance.id)).all() as ProvenanceRow[];
  const provenanceByEntity = new Map<string, ProvenanceRow>();
  for (const row of provenanceRows) {
    const type = row.targetEntityType === 'vault_item' ? 'vault_item' : 'account';
    const key = provenanceKey(type, row.targetEntityId);
    if (!provenanceByEntity.has(key)) provenanceByEntity.set(key, row);
  }

  const siteRows = await db.select().from(schema.sites).all() as SiteRow[];
  const siteById = new Map(siteRows.map((site) => [site.id, site] as const));
  const records: CredentialLifecycleRecord[] = [];

  if (!entityType || entityType === 'account') {
    const accountConditions: SQL[] = [];
    if (siteId) accountConditions.push(eq(schema.accounts.siteId, siteId));
    const accountRows = await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(accountConditions.length > 0 ? and(...accountConditions) : undefined)
      .orderBy(asc(schema.accounts.id)).all() as Array<{ accounts: AccountRow; sites: SiteRow }>;
    const leases = await db.select().from(schema.oauthRefreshLeases)
      .where(gt(schema.oauthRefreshLeases.expiresAt, new Date(nowMs).toISOString())).all() as Array<typeof schema.oauthRefreshLeases.$inferSelect>;
    const refreshingIds = new Set(leases.map((lease) => lease.accountId));
    for (const row of accountRows) {
      const base = lifecycleFromAccount({
        account: row.accounts,
        site: row.sites,
        refreshing: refreshingIds.has(row.accounts.id),
        nowMs,
        expiringWindowMs,
      });
      const record: CredentialLifecycleRecord = {
        entityType: 'account',
        entityId: row.accounts.id,
        name: row.accounts.username || `账号 #${row.accounts.id}`,
        site: { id: row.sites.id, name: row.sites.name, platform: row.sites.platform, url: row.sites.url },
        kind: accountKind(row.accounts, row.sites),
        ...base,
        actions: undefined as never,
        ...(provenanceByEntity.get(provenanceKey('account', row.accounts.id))
          ? { provenance: toProvenance(provenanceByEntity.get(provenanceKey('account', row.accounts.id))!) }
          : {}),
      };
      record.actions = actionsFor(record);
      records.push(record);
    }
  }

  if (!entityType || entityType === 'vault_item') {
    const vaultConditions: SQL[] = [];
    if (siteId) vaultConditions.push(eq(schema.credentialVaultItems.siteId, siteId));
    const vaultRows = await db.select().from(schema.credentialVaultItems)
      .where(vaultConditions.length > 0 ? and(...vaultConditions) : undefined)
      .orderBy(asc(schema.credentialVaultItems.id)).all() as VaultRow[];
    for (const row of vaultRows) {
      const base = lifecycleFromVault(row, nowMs, expiringWindowMs);
      const site = row.siteId ? siteById.get(row.siteId) : undefined;
      const record: CredentialLifecycleRecord = {
        entityType: 'vault_item',
        entityId: row.id,
        name: row.name,
        ...(site ? { site: { id: site.id, name: site.name, platform: site.platform, url: site.url } } : {}),
        ...base,
        actions: undefined as never,
        ...(provenanceByEntity.get(provenanceKey('vault_item', row.id))
          ? { provenance: toProvenance(provenanceByEntity.get(provenanceKey('vault_item', row.id))!) }
          : {}),
      };
      record.actions = actionsFor(record);
      records.push(record);
    }
  }

  return records.filter((record) => !status || record.status === status);
}

async function loadAccountWithSite(id: number): Promise<{ account: AccountRow; site: SiteRow } | null> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, id)).get();
  return row ? { account: row.accounts, site: row.sites } : null;
}

async function validateAccountCredential(row: { account: AccountRow; site: SiteRow }): Promise<string> {
  const adapter = getAdapter(row.site.platform);
  if (!adapter) throw new CredentialLifecycleError('目标站点没有可用适配器');
  const mode = getCredentialModeFromExtraConfig(row.account.extraConfig);
  const token = mode === 'apikey'
    ? row.account.apiToken || row.account.accessToken
    : row.account.accessToken || row.account.apiToken || '';
  if (!token) throw new CredentialLifecycleError('账号没有可验证的凭证');
  const result = await adapter.verifyToken(
    row.site.url,
    token,
    getPlatformUserIdFromExtraConfig(row.account.extraConfig),
  );
  if (result.tokenType === 'unknown') throw new CredentialLifecycleError('上游未接受该凭证');
  return `验证通过：${result.tokenType}`;
}

async function validateVaultCredential(id: number): Promise<string> {
  const row = await db.select().from(schema.credentialVaultItems)
    .where(eq(schema.credentialVaultItems.id, id)).get();
  if (!row) throw new CredentialLifecycleError('Vault 凭证不存在', 404);
  if (row.status !== 'active') throw new CredentialLifecycleError('只有 active Vault 凭证可以验证');
  const secret = credentialVaultInternals.decryptSecret(row.kind as any, row.ciphertext);
  if (!secret) throw new CredentialLifecycleError('Vault 凭证无法解密');
  if (!row.siteId || ['cookie', 'browser_storage', 'oauth_refresh_token', 'integration_secret'].includes(row.kind)) {
    return '本地完整性验证通过；该类型不支持远端探测';
  }
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, row.siteId)).get();
  const adapter = site ? getAdapter(site.platform) : undefined;
  if (!site || !adapter) throw new CredentialLifecycleError('Vault 凭证的目标站点不可用');
  const result = await adapter.verifyToken(site.url, secret);
  if (result.tokenType === 'unknown') throw new CredentialLifecycleError('上游未接受该 Vault 凭证');
  return `远端验证通过：${result.tokenType}`;
}

async function refreshAccountCredential(row: { account: AccountRow; site: SiteRow }): Promise<string> {
  try {
    return await refreshManagedAccountCredential({ ...row, reason: 'manual' });
  } catch (error) {
    throw new CredentialLifecycleError((error as Error)?.message || '凭证刷新失败');
  }
}

function stripSecretExtraConfig(value: string | null): string | null {
  if (!value) return value;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    delete parsed.autoRelogin;
    delete parsed.sub2apiAuth;
    if (parsed.oauth && typeof parsed.oauth === 'object' && !Array.isArray(parsed.oauth)) {
      const oauth = { ...(parsed.oauth as Record<string, unknown>) };
      delete oauth.refreshToken;
      delete oauth.idToken;
      parsed.oauth = oauth;
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

async function revokeAccountCredential(row: { account: AccountRow; site: SiteRow }): Promise<string> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.delete(schema.accountTokens).where(eq(schema.accountTokens.accountId, row.account.id)).run();
    await tx.update(schema.accounts).set({
      status: 'revoked',
      accessToken: '',
      apiToken: null,
      oauthCredentialPayload: null,
      oauthRefreshState: row.account.oauthProvider ? 'reauthorization_required' : row.account.oauthRefreshState,
      oauthRefreshRetryAt: null,
      oauthRefreshLastError: row.account.oauthProvider ? 'Credential revoked locally' : row.account.oauthRefreshLastError,
      extraConfig: stripSecretExtraConfig(row.account.extraConfig),
      updatedAt: now,
    }).where(eq(schema.accounts.id, row.account.id)).run();
  });
  publishTokenRouterCacheInvalidation();
  await rebuildRoutesBestEffort();
  return '凭证已在本地撤销并清除托管秘密；未声明执行上游 provider revoke';
}

async function writeLifecycleEvent(result: CredentialLifecycleActionResult) {
  await db.insert(schema.events).values({
    type: 'credential_lifecycle',
    title: `凭证${result.action}操作${result.success ? '完成' : '失败'}`,
    message: JSON.stringify({
      entityType: result.entityType,
      entityId: result.entityId,
      action: result.action,
      success: result.success,
      status: result.status,
      message: result.message,
    }),
    level: result.success ? 'info' : 'warning',
    relatedId: result.entityId,
    relatedType: result.entityType,
    createdAt: new Date().toISOString(),
  }).run();
}

async function redactLifecycleError(
  entityType: CredentialLifecycleEntityType,
  entityId: number,
  error: unknown,
): Promise<string> {
  let message = error instanceof Error ? error.message : '凭证生命周期操作失败';
  const secrets: string[] = [];
  if (entityType === 'account') {
    const account = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, entityId)).get();
    if (account) {
      if (account.accessToken) secrets.push(account.accessToken);
      if (account.apiToken) secrets.push(account.apiToken);
      const oauth = getOauthInfoFromAccount(account);
      if (oauth?.refreshToken) secrets.push(oauth.refreshToken);
      if (oauth?.idToken) secrets.push(oauth.idToken);
      const sub2api = getSub2ApiAuthFromExtraConfig(account.extraConfig);
      if (sub2api?.refreshToken) secrets.push(sub2api.refreshToken);
    }
  } else {
    const row = await db.select().from(schema.credentialVaultItems)
      .where(eq(schema.credentialVaultItems.id, entityId)).get();
    if (row) {
      const secret = credentialVaultInternals.decryptSecret(row.kind as any, row.ciphertext);
      if (secret) secrets.push(secret);
    }
  }
  for (const secret of secrets) {
    if (secret.length >= 3) message = message.split(secret).join('[REDACTED]');
  }
  return message.slice(0, 2_000);
}

async function currentStatus(entityType: CredentialLifecycleEntityType, entityId: number): Promise<CredentialLifecycleStatus | undefined> {
  const records = await listCredentialLifecycle({ entityType });
  return records.find((record) => record.entityId === entityId)?.status;
}

async function executeOneAction(input: {
  entityType: CredentialLifecycleEntityType;
  entityId: number;
  action: CredentialLifecycleAction;
}): Promise<CredentialLifecycleActionResult> {
  const resultBase = { entityType: input.entityType, entityId: input.entityId, action: input.action };
  try {
    let message = '';
    if (input.entityType === 'account') {
      const row = await loadAccountWithSite(input.entityId);
      if (!row) throw new CredentialLifecycleError('账号凭证不存在', 404);
      if (input.action === 'validate') message = await validateAccountCredential(row);
      if (input.action === 'refresh') message = await refreshAccountCredential(row);
      if (input.action === 'disable' || input.action === 'enable') {
        if (row.account.status === 'revoked') throw new CredentialLifecycleError('已撤销凭证不能重新启用');
        const nextStatus = input.action === 'enable' ? 'active' : 'disabled';
        await applyAccountUpdateWorkflow({
          accountId: row.account.id,
          updates: { status: nextStatus },
          refreshModels: false,
        });
        message = input.action === 'enable' ? '账号凭证已启用' : '账号凭证已停用';
      }
      if (input.action === 'revoke') message = await revokeAccountCredential(row);
    } else {
      if (input.action === 'refresh') throw new CredentialLifecycleError('Vault 凭证不支持 refresh');
      if (input.action === 'validate') message = await validateVaultCredential(input.entityId);
      if (input.action === 'disable' || input.action === 'enable') {
        const changed = await setCredentialVaultItemEnabled(input.entityId, input.action === 'enable');
        if (!changed) throw new CredentialLifecycleError('Vault 凭证状态不允许该操作', 409);
        message = input.action === 'enable' ? 'Vault 凭证已启用' : 'Vault 凭证已停用';
      }
      if (input.action === 'revoke') {
        const revoked = await revokeCredentialVaultItem(input.entityId);
        if (!revoked) throw new CredentialLifecycleError('Vault 凭证不存在或已失效', 404);
        message = 'Vault 凭证已在本地撤销';
      }
    }
    const result: CredentialLifecycleActionResult = {
      ...resultBase,
      success: true,
      status: await currentStatus(input.entityType, input.entityId),
      message,
    };
    await writeLifecycleEvent(result);
    return result;
  } catch (error) {
    const result: CredentialLifecycleActionResult = {
      ...resultBase,
      success: false,
      status: await currentStatus(input.entityType, input.entityId),
      message: await redactLifecycleError(input.entityType, input.entityId, error),
    };
    await writeLifecycleEvent(result);
    return result;
  }
}

export async function executeCredentialLifecycleBatch(input: {
  action: unknown;
  items: unknown;
}): Promise<{
  action: CredentialLifecycleAction;
  succeeded: number;
  failed: number;
  items: CredentialLifecycleActionResult[];
}> {
  const action = normalizeAction(input.action);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new CredentialLifecycleError('items 不能为空');
  }
  if (input.items.length > MAX_BATCH_ITEMS) {
    throw new CredentialLifecycleError(`单次最多操作 ${MAX_BATCH_ITEMS} 条凭证`);
  }
  const normalized = input.items.map((item) => {
    const record = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    return {
      entityType: normalizeEntityType(record.entityType),
      entityId: normalizePositiveId(record.entityId, 'entityId'),
      action,
    };
  });
  const unique = [...new Map(normalized.map((item) => [`${item.entityType}:${item.entityId}`, item])).values()];
  const results: CredentialLifecycleActionResult[] = [];
  for (const item of unique) results.push(await executeOneAction(item));
  return {
    action,
    succeeded: results.filter((item) => item.success).length,
    failed: results.filter((item) => !item.success).length,
    items: results,
  };
}

export const credentialLifecycleInternals = {
  EXPIRING_WINDOW_MS,
  expiryStatus,
  lifecycleFromAccount,
  lifecycleFromVault,
  stripSecretExtraConfig,
};
