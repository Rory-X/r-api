import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  executeCredentialLifecycleBatch,
  listCredentialLifecycle,
  type CredentialLifecycleAction,
  type CredentialLifecycleActionResult,
  type CredentialLifecycleEntityType,
  type CredentialLifecycleRecord,
} from './credentialLifecycleService.js';
import {
  getCredentialLifecyclePolicy,
  getCredentialRefreshLeadMs,
  setCredentialLifecyclePolicy,
  type CredentialLifecyclePolicyInput,
} from './credentialLifecyclePolicyService.js';
import {
  listCredentialLifecycleAudits,
  recordCredentialLifecycleAudit,
} from './credentialLifecycleAuditService.js';
import {
  getManagedCredentialRefreshDescriptor,
  refreshManagedAccountCredential,
  type ManagedCredentialRefreshOwner,
} from './managedCredentialRefreshService.js';
import { OAuthRefreshCoordinatorError } from './oauth/refreshCoordinator.js';
import { sendNotification } from './notifyService.js';
import { publishTokenRouterCacheInvalidation } from './tokenRouterCacheInvalidation.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';
import {
  classifyOperationalFailure,
  type OperationalFailureClassification,
} from './operationalFailureContract.js';

export type CredentialRefreshJobStatus =
  | 'pending'
  | 'retry_wait'
  | 'running'
  | 'succeeded'
  | 'failed_terminal'
  | 'owner_conflict'
  | 'cancelled';

export type CredentialRefreshFailureClass =
  | 'rate_limited'
  | 'provider_unavailable'
  | 'owner_conflict'
  | 'auth_invalid'
  | 'transient'
  | 'unknown';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;
type RefreshJobRow = typeof schema.credentialRefreshJobs.$inferSelect;

const SCHEDULER_OPERATOR = 'system:credential-lifecycle';
const DEFAULT_BATCH_SIZE = 25;
const JOB_LEASE_MS = 2 * 60 * 1000;
const JOB_CONCURRENCY = 4;
const WORKER_NAME = 'credential-lifecycle';

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerPassInFlight: Promise<void> | null = null;

function normalizeText(value: unknown, fallback = ''): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function normalizeOwner(value: unknown): ManagedCredentialRefreshOwner {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'r_api' || normalized === 'external' || normalized === 'none') return normalized;
  throw new Error('refreshOwner 无效');
}

function normalizeLimit(value: unknown, fallback = 100): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(500, parsed)) : fallback;
}

function normalizeOffset(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function refreshJobStatus(value: string): CredentialRefreshJobStatus {
  return value as CredentialRefreshJobStatus;
}

function classifyRefreshJobFailure(item: RefreshJobRow): OperationalFailureClassification | null {
  if (!item.failureClass && !item.lastError) return null;
  const hint = item.failureClass === 'owner_conflict'
    ? 'lease_conflict'
    : item.failureClass === 'rate_limited'
      ? 'rate_limited'
      : item.failureClass === 'auth_invalid'
        ? 'credential_invalid'
        : item.failureClass === 'provider_unavailable'
          ? 'provider_unavailable'
          : item.failureClass === 'transient'
            ? 'transient'
            : null;
  return classifyOperationalFailure({ rawErrorText: item.lastError, hint });
}

function credentialSource(record: CredentialLifecycleRecord | undefined): string {
  if (record?.provenance?.sourceFormat) return record.provenance.sourceFormat;
  return record?.entityType === 'vault_item' ? 'vault' : 'native';
}

function lifecycleRecordMap(records: CredentialLifecycleRecord[]): Map<string, CredentialLifecycleRecord> {
  return new Map(records.map((record) => [`${record.entityType}:${record.entityId}`, record]));
}

async function writeOperationalEvent(input: {
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  entityType: string;
  entityId: number;
}) {
  await db.insert(schema.events).values({
    type: 'credential_lifecycle',
    title: input.title,
    message: input.message.slice(0, 4_000),
    level: input.level,
    relatedId: input.entityId,
    relatedType: input.entityType,
    createdAt: new Date().toISOString(),
  }).run();
}

export async function executeCredentialLifecycleBatchWithAudit(input: {
  action: unknown;
  items: unknown;
  operatorId?: unknown;
  source?: unknown;
}) {
  const result = await executeCredentialLifecycleBatch({ action: input.action, items: input.items });
  const records = lifecycleRecordMap(await listCredentialLifecycle());
  const operatorId = normalizeText(input.operatorId, 'webui:admin');
  const executionSource = normalizeText(input.source, 'webui');
  await Promise.all(result.items.map(async (item) => {
    const record = records.get(`${item.entityType}:${item.entityId}`);
    await recordCredentialLifecycleAudit({
      entityType: item.entityType,
      entityId: item.entityId,
      siteId: record?.siteId,
      provider: record?.provider,
      credentialSource: credentialSource(record),
      operatorId,
      action: item.action,
      status: item.status || record?.status || 'unknown',
      outcome: item.success ? 'succeeded' : 'failed',
      message: item.message,
      metadata: { executionSource },
    });
  }));
  return result;
}

export async function updateCredentialLifecyclePolicy(input: {
  policy: CredentialLifecyclePolicyInput;
  operatorId?: unknown;
}) {
  const policy = await setCredentialLifecyclePolicy(input.policy);
  await db.update(schema.credentialRefreshJobs).set({
    maxAttempts: policy.retryMaxAttempts,
    updatedAt: new Date().toISOString(),
  }).where(inArray(schema.credentialRefreshJobs.status, ['pending', 'retry_wait', 'running'])).run();
  await recordCredentialLifecycleAudit({
    entityType: 'system',
    entityId: 0,
    credentialSource: 'policy',
    operatorId: normalizeText(input.operatorId, 'webui:admin'),
    action: 'policy_update',
    status: 'configured',
    outcome: 'succeeded',
    message: '凭证生命周期运营策略已更新',
    metadata: { policy },
  });
  await restartCredentialLifecycleScheduler();
  return policy;
}

function mergeRefreshOwner(extraConfig: string | null, owner: ManagedCredentialRefreshOwner): string {
  let parsed: Record<string, unknown> = {};
  try {
    const candidate = JSON.parse(extraConfig || '{}') as unknown;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const current = parsed.credentialLifecycle;
  parsed.credentialLifecycle = {
    ...(current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {}),
    refreshOwner: owner,
  };
  return JSON.stringify(parsed);
}

export async function setCredentialRefreshOwner(input: {
  accountId: unknown;
  refreshOwner: unknown;
  operatorId?: unknown;
}) {
  const accountId = Math.trunc(Number(input.accountId));
  if (!Number.isFinite(accountId) || accountId <= 0) throw new Error('accountId 无效');
  const owner = normalizeOwner(input.refreshOwner);
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId)).get();
  if (!row) throw new Error('账号凭证不存在');
  const nowIso = new Date().toISOString();
  await db.update(schema.accounts).set({
    extraConfig: mergeRefreshOwner(row.accounts.extraConfig, owner),
    updatedAt: nowIso,
  }).where(eq(schema.accounts.id, accountId)).run();
  if (owner === 'r_api') {
    await upsertRefreshJob({
      account: { ...row.accounts, extraConfig: mergeRefreshOwner(row.accounts.extraConfig, owner) },
      site: row.sites,
      status: 'pending',
      nextAttemptAt: nowIso,
      resetAttempts: true,
    });
  } else {
    await db.update(schema.credentialRefreshJobs).set({
      refreshOwner: owner,
      status: owner === 'external' ? 'owner_conflict' : 'cancelled',
      failureClass: owner === 'external' ? 'owner_conflict' : null,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: owner === 'external' ? '刷新归属已切换到外部执行者' : '该凭证不允许刷新',
      updatedAt: nowIso,
    }).where(and(
      eq(schema.credentialRefreshJobs.entityType, 'account'),
      eq(schema.credentialRefreshJobs.entityId, accountId),
    )).run();
  }
  publishTokenRouterCacheInvalidation();
  await recordCredentialLifecycleAudit({
    entityType: 'account',
    entityId: accountId,
    siteId: row.sites.id,
    provider: getManagedCredentialRefreshDescriptor(row.accounts, row.sites).provider,
    credentialSource: 'native',
    operatorId: normalizeText(input.operatorId, 'webui:admin'),
    action: 'refresh_owner_change',
    status: owner,
    outcome: 'succeeded',
    message: `Refresh Owner 已设置为 ${owner}`,
  });
  return { accountId, refreshOwner: owner };
}

export async function retryCredentialRefreshJob(input: {
  jobId: unknown;
  operatorId?: unknown;
}) {
  const jobId = Math.trunc(Number(input.jobId));
  if (!Number.isFinite(jobId) || jobId <= 0) throw new Error('jobId 无效');
  const job = await db.select().from(schema.credentialRefreshJobs)
    .where(eq(schema.credentialRefreshJobs.id, jobId)).get();
  if (!job) throw new Error('刷新任务不存在');
  if (job.refreshOwner !== 'r_api') throw new Error('只有 Refresh Owner 为 r-api 的任务可以重新入队');
  const nowIso = new Date().toISOString();
  await db.update(schema.credentialRefreshJobs).set({
    status: 'pending',
    failureClass: null,
    attemptCount: 0,
    nextAttemptAt: nowIso,
    lastError: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(eq(schema.credentialRefreshJobs.id, jobId)).run();
  await recordCredentialLifecycleAudit({
    entityType: job.entityType,
    entityId: job.entityId,
    siteId: job.siteId,
    provider: job.provider,
    credentialSource: 'native',
    operatorId: normalizeText(input.operatorId, 'webui:admin'),
    action: 'refresh_retry_enqueue',
    status: 'pending',
    outcome: 'succeeded',
    message: '刷新任务已重置并重新入队',
    metadata: { jobId },
  });
  return { jobId, status: 'pending' as const, nextAttemptAt: nowIso };
}

function isActive(value?: string | null): boolean {
  return normalizeText(value, 'active').toLowerCase() === 'active';
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  return message.includes('unique constraint')
    || message.includes('duplicate entry')
    || message.includes('duplicate key');
}

async function upsertRefreshJob(input: {
  account: AccountRow;
  site: SiteRow;
  status: CredentialRefreshJobStatus;
  nextAttemptAt: string | null;
  failureClass?: CredentialRefreshFailureClass | null;
  lastError?: string | null;
  resetAttempts?: boolean;
}): Promise<void> {
  const descriptor = getManagedCredentialRefreshDescriptor(input.account, input.site);
  const nowIso = new Date().toISOString();
  const existing = await db.select().from(schema.credentialRefreshJobs).where(and(
    eq(schema.credentialRefreshJobs.entityType, 'account'),
    eq(schema.credentialRefreshJobs.entityId, input.account.id),
  )).get();
  const values = {
    siteId: input.site.id,
    provider: descriptor.provider,
    refreshOwner: descriptor.owner,
    status: input.status,
    failureClass: input.failureClass ?? null,
    maxAttempts: (await getCredentialLifecyclePolicy()).retryMaxAttempts,
    nextAttemptAt: input.nextAttemptAt,
    lastError: input.lastError ?? null,
    leaseOwner: null,
    leaseExpiresAt: null,
    ...(input.resetAttempts ? { attemptCount: 0 } : {}),
    updatedAt: nowIso,
  };
  if (existing) {
    await db.update(schema.credentialRefreshJobs).set(values)
      .where(eq(schema.credentialRefreshJobs.id, existing.id)).run();
    return;
  }
  try {
    await db.insert(schema.credentialRefreshJobs).values({
      entityType: 'account',
      entityId: input.account.id,
      attemptCount: 0,
      createdAt: nowIso,
      ...values,
    }).run();
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    await db.update(schema.credentialRefreshJobs).set(values).where(and(
      eq(schema.credentialRefreshJobs.entityType, 'account'),
      eq(schema.credentialRefreshJobs.entityId, input.account.id),
    )).run();
  }
}

async function synchronizeRefreshQueue(nowMs: number): Promise<number> {
  const policy = await getCredentialLifecyclePolicy();
  const rows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id)).all();
  let queued = 0;
  for (const row of rows) {
    const descriptor = getManagedCredentialRefreshDescriptor(row.accounts, row.sites);
    const existing = await db.select().from(schema.credentialRefreshJobs).where(and(
      eq(schema.credentialRefreshJobs.entityType, 'account'),
      eq(schema.credentialRefreshJobs.entityId, row.accounts.id),
    )).get();
    if (!isActive(row.accounts.status) || !isActive(row.sites.status) || !descriptor.hasManagedSecret) {
      if (existing && !['succeeded', 'cancelled'].includes(existing.status)) {
        await upsertRefreshJob({
          account: row.accounts,
          site: row.sites,
          status: 'cancelled',
          nextAttemptAt: null,
          lastError: '账号、站点或托管 refresh token 已不可用',
        });
      }
      continue;
    }
    if (descriptor.owner !== 'r_api') {
      if (descriptor.explicitOwner) {
        await upsertRefreshJob({
          account: row.accounts,
          site: row.sites,
          status: 'owner_conflict',
          nextAttemptAt: null,
          failureClass: 'owner_conflict',
          lastError: '本地保存了 refresh token，但 Refresh Owner 不是 r-api',
        });
      }
      continue;
    }
    const leadMs = getCredentialRefreshLeadMs(policy, descriptor.provider);
    const expiryDue = descriptor.expiresAtMs !== null && descriptor.expiresAtMs - nowMs <= leadMs;
    const retryAtMs = row.accounts.oauthRefreshRetryAt ? Date.parse(row.accounts.oauthRefreshRetryAt) : NaN;
    const retryPending = row.accounts.oauthRefreshState === 'transient_error';
    if (!expiryDue && !retryPending) continue;
    if (existing && ['running', 'retry_wait', 'pending', 'failed_terminal'].includes(existing.status)) continue;
    const nextAttemptAt = retryPending && Number.isFinite(retryAtMs) && retryAtMs > nowMs
      ? new Date(retryAtMs).toISOString()
      : new Date(nowMs).toISOString();
    await upsertRefreshJob({
      account: row.accounts,
      site: row.sites,
      status: Number.isFinite(retryAtMs) && retryAtMs > nowMs ? 'retry_wait' : 'pending',
      nextAttemptAt,
      resetAttempts: existing?.status === 'succeeded',
    });
    queued += 1;
  }
  return queued;
}

function buildLeaseOwner(): string {
  return `${hostname() || 'local'}:${process.pid}:${randomUUID()}`;
}

async function claimDueRefreshJobs(nowMs: number, limit = DEFAULT_BATCH_SIZE): Promise<RefreshJobRow[]> {
  const nowIso = new Date(nowMs).toISOString();
  const candidates = await db.select().from(schema.credentialRefreshJobs).where(and(
    inArray(schema.credentialRefreshJobs.status, ['pending', 'retry_wait']),
    or(
      isNull(schema.credentialRefreshJobs.nextAttemptAt),
      lte(schema.credentialRefreshJobs.nextAttemptAt, nowIso),
    ),
    or(
      isNull(schema.credentialRefreshJobs.leaseExpiresAt),
      lte(schema.credentialRefreshJobs.leaseExpiresAt, nowIso),
    ),
  )).orderBy(asc(schema.credentialRefreshJobs.nextAttemptAt), asc(schema.credentialRefreshJobs.id))
    .limit(limit).all();
  const claimed: RefreshJobRow[] = [];
  for (const candidate of candidates) {
    const leaseOwner = buildLeaseOwner();
    const leaseExpiresAt = new Date(nowMs + JOB_LEASE_MS).toISOString();
    const updated = await db.update(schema.credentialRefreshJobs).set({
      status: 'running',
      leaseOwner,
      leaseExpiresAt,
      lastAttemptAt: nowIso,
      attemptCount: sql`${schema.credentialRefreshJobs.attemptCount} + 1`,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.credentialRefreshJobs.id, candidate.id),
      inArray(schema.credentialRefreshJobs.status, ['pending', 'retry_wait']),
      or(
        isNull(schema.credentialRefreshJobs.leaseExpiresAt),
        lte(schema.credentialRefreshJobs.leaseExpiresAt, nowIso),
      ),
    )).run();
    if (updated.changes <= 0) continue;
    const row = await db.select().from(schema.credentialRefreshJobs)
      .where(eq(schema.credentialRefreshJobs.id, candidate.id)).get();
    if (row) claimed.push(row);
  }
  return claimed;
}

function classifyRefreshFailure(error: unknown): {
  failureClass: CredentialRefreshFailureClass;
  retryAfterMs: number | null;
  terminal: boolean;
  message: string;
} {
  const message = String((error as { message?: unknown })?.message || error || 'credential refresh failed').slice(0, 2_000);
  const normalized = message.toLowerCase();
  if (error instanceof OAuthRefreshCoordinatorError) {
    if (error.code === 'lease_busy') {
      return { failureClass: 'owner_conflict', retryAfterMs: error.retryAfterMs, terminal: false, message };
    }
    if (error.code === 'provider_rate_limited') {
      return { failureClass: 'rate_limited', retryAfterMs: error.retryAfterMs, terminal: false, message };
    }
    if (['reauthorization_required', 'refresh_unknown', 'refresh_token_missing'].includes(error.code)) {
      return { failureClass: 'auth_invalid', retryAfterMs: null, terminal: true, message };
    }
  }
  if (/\b429\b|rate.?limit|too many requests|限流|请求过多/.test(normalized)) {
    return { failureClass: 'rate_limited', retryAfterMs: null, terminal: false, message };
  }
  if (/invalid_grant|invalid.refresh|refresh token.*(?:expired|invalid)|重新授权/.test(normalized)) {
    return { failureClass: 'auth_invalid', retryAfterMs: null, terminal: true, message };
  }
  if (/\b50[234]\b|timeout|timed out|temporar|unavailable|connection reset/.test(normalized)) {
    return { failureClass: 'provider_unavailable', retryAfterMs: null, terminal: false, message };
  }
  return { failureClass: 'transient', retryAfterMs: null, terminal: false, message };
}

function computeRetryDelayMs(input: {
  attemptCount: number;
  failureClass: CredentialRefreshFailureClass;
  retryAfterMs: number | null;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  ownerConflictRetrySeconds: number;
}): number {
  const baseMs = input.failureClass === 'owner_conflict'
    ? input.ownerConflictRetrySeconds * 1_000
    : input.retryBaseSeconds * 1_000;
  const exponentialMs = baseMs * (2 ** Math.min(12, Math.max(0, input.attemptCount - 1)));
  return Math.min(
    input.retryMaxSeconds * 1_000,
    Math.max(exponentialMs, input.retryAfterMs ?? 0),
  );
}

async function loadCredentialRecord(entityId: number): Promise<CredentialLifecycleRecord | undefined> {
  const records = await listCredentialLifecycle({ entityType: 'account' });
  return records.find((record) => record.entityId === entityId);
}

async function executeClaimedRefreshJob(job: RefreshJobRow): Promise<'succeeded' | 'failed' | 'deferred'> {
  const joined = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, job.entityId)).get();
  if (!joined) {
    await db.update(schema.credentialRefreshJobs).set({
      status: 'cancelled',
      failureClass: 'unknown',
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: '账号凭证不存在',
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.credentialRefreshJobs.id, job.id)).run();
    return 'failed';
  }
  const descriptor = getManagedCredentialRefreshDescriptor(joined.accounts, joined.sites);
  if (descriptor.owner !== 'r_api') {
    await db.update(schema.credentialRefreshJobs).set({
      refreshOwner: descriptor.owner,
      status: 'owner_conflict',
      failureClass: 'owner_conflict',
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: `Refresh Owner 为 ${descriptor.owner}，r-api 未执行刷新`,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.credentialRefreshJobs.id, job.id)).run();
    return 'deferred';
  }
  try {
    const message = await refreshManagedAccountCredential({
      account: joined.accounts,
      site: joined.sites,
      reason: 'scheduled',
    });
    const nowIso = new Date().toISOString();
    await db.update(schema.credentialRefreshJobs).set({
      status: 'succeeded',
      failureClass: null,
      nextAttemptAt: null,
      lastSuccessAt: nowIso,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    }).where(eq(schema.credentialRefreshJobs.id, job.id)).run();
    const record = await loadCredentialRecord(job.entityId);
    await recordCredentialLifecycleAudit({
      entityType: 'account',
      entityId: job.entityId,
      siteId: joined.sites.id,
      provider: descriptor.provider,
      credentialSource: credentialSource(record),
      operatorId: SCHEDULER_OPERATOR,
      action: 'refresh',
      status: record?.status || 'active',
      outcome: 'succeeded',
      message,
      metadata: { jobId: job.id, attemptCount: job.attemptCount },
    });
    await writeOperationalEvent({
      title: '凭证自动刷新完成',
      message: `${record?.name || `账号 #${job.entityId}`}：${message}`,
      level: 'info',
      entityType: 'account',
      entityId: job.entityId,
    });
    return 'succeeded';
  } catch (error) {
    const policy = await getCredentialLifecyclePolicy();
    const classified = classifyRefreshFailure(error);
    const terminal = classified.terminal || job.attemptCount >= job.maxAttempts;
    const delayMs = terminal ? null : computeRetryDelayMs({
      attemptCount: job.attemptCount,
      failureClass: classified.failureClass,
      retryAfterMs: classified.retryAfterMs,
      retryBaseSeconds: policy.retryBaseSeconds,
      retryMaxSeconds: policy.retryMaxSeconds,
      ownerConflictRetrySeconds: policy.ownerConflictRetrySeconds,
    });
    const nextAttemptAt = delayMs === null ? null : new Date(Date.now() + delayMs).toISOString();
    await db.update(schema.credentialRefreshJobs).set({
      status: terminal ? 'failed_terminal' : 'retry_wait',
      failureClass: classified.failureClass,
      nextAttemptAt,
      lastError: classified.message,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.credentialRefreshJobs.id, job.id)).run();
    const record = await loadCredentialRecord(job.entityId);
    await recordCredentialLifecycleAudit({
      entityType: 'account',
      entityId: job.entityId,
      siteId: joined.sites.id,
      provider: descriptor.provider,
      credentialSource: credentialSource(record),
      operatorId: SCHEDULER_OPERATOR,
      action: 'refresh',
      status: 'refresh_failed',
      outcome: terminal ? 'failed' : 'deferred',
      message: classified.message,
      metadata: {
        jobId: job.id,
        attemptCount: job.attemptCount,
        failureClass: classified.failureClass,
        nextAttemptAt,
      },
    });
    await writeOperationalEvent({
      title: terminal ? '凭证自动刷新失败' : '凭证刷新已进入重试队列',
      message: `${record?.name || `账号 #${job.entityId}`}：${classified.message}${nextAttemptAt ? `；下次重试 ${nextAttemptAt}` : ''}`,
      level: terminal ? 'error' : 'warning',
      entityType: 'account',
      entityId: job.entityId,
    });
    return terminal ? 'failed' : 'deferred';
  }
}

async function sendExpiryReminders(nowMs: number): Promise<number> {
  const policy = await getCredentialLifecyclePolicy();
  if (!policy.automaticRemindersEnabled) return 0;
  const leadMs = policy.expiryWarningLeadMinutes * 60 * 1_000;
  const records = await listCredentialLifecycle({ nowMs, expiringWindowMs: leadMs });
  let notified = 0;
  for (const record of records) {
    if (!record.expiresAt || ['revoked', 'disabled', 'metadata_only'].includes(record.status)) continue;
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs - nowMs > leadMs) continue;
    const dedupeKey = `credential-expiry:${record.entityType}:${record.entityId}:${record.expiresAt}:${policy.expiryWarningLeadMinutes}`;
    const auditId = await recordCredentialLifecycleAudit({
      entityType: record.entityType,
      entityId: record.entityId,
      siteId: record.siteId,
      provider: record.provider,
      credentialSource: credentialSource(record),
      operatorId: SCHEDULER_OPERATOR,
      action: 'expiry_reminder',
      status: 'expiring',
      outcome: 'notified',
      message: `${record.name} 将于 ${record.expiresAt} 到期`,
      metadata: { expiresAt: record.expiresAt, leadMinutes: policy.expiryWarningLeadMinutes },
      dedupeKey,
    });
    if (auditId === null) continue;
    notified += 1;
    await writeOperationalEvent({
      title: '凭证即将到期',
      message: `${record.name} 将于 ${record.expiresAt} 到期，当前 Refresh Owner：${record.refreshOwner}`,
      level: 'warning',
      entityType: record.entityType,
      entityId: record.entityId,
    });
    await sendNotification(
      '凭证即将到期',
      `${record.name} 将于 ${record.expiresAt} 到期。站点：${record.site?.name || '系统'}；Provider：${record.provider || '未知'}；Refresh Owner：${record.refreshOwner}`,
      'warning',
      { idempotencyKey: dedupeKey },
    ).catch((error) => {
      console.warn(`[credential-lifecycle] expiry notification failed: ${(error as Error)?.message || 'unknown error'}`);
    });
  }
  return notified;
}

export async function executeCredentialLifecycleOperationsPass(input: {
  nowMs?: number;
  maxJobs?: number;
  forceRefreshQueue?: boolean;
} = {}) {
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const policy = await getCredentialLifecyclePolicy();
  const reminders = await sendExpiryReminders(nowMs);
  let queued = 0;
  let claimed: RefreshJobRow[] = [];
  if (policy.automaticRefreshEnabled || input.forceRefreshQueue) {
    queued = await synchronizeRefreshQueue(nowMs);
    claimed = await claimDueRefreshJobs(nowMs, normalizeLimit(input.maxJobs, DEFAULT_BATCH_SIZE));
  }
  const outcomes: Array<'succeeded' | 'failed' | 'deferred'> = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(JOB_CONCURRENCY, claimed.length || 1) }, async () => {
    while (true) {
      const job = claimed[cursor];
      cursor += 1;
      if (!job) return;
      outcomes.push(await executeClaimedRefreshJob(job));
    }
  }));
  return {
    reminders,
    queued,
    claimed: claimed.length,
    succeeded: outcomes.filter((outcome) => outcome === 'succeeded').length,
    failed: outcomes.filter((outcome) => outcome === 'failed').length,
    deferred: outcomes.filter((outcome) => outcome === 'deferred').length,
  };
}

export async function listCredentialRefreshQueue(input: {
  status?: unknown;
  provider?: unknown;
  failureClass?: unknown;
  failureCode?: unknown;
  limit?: unknown;
  offset?: unknown;
} = {}) {
  const filters: SQL[] = [];
  const status = normalizeText(input.status);
  const provider = normalizeText(input.provider).toLowerCase();
  const failureClass = normalizeText(input.failureClass);
  const failureCode = normalizeText(input.failureCode);
  if (status) filters.push(eq(schema.credentialRefreshJobs.status, status));
  if (provider) filters.push(eq(schema.credentialRefreshJobs.provider, provider));
  if (failureClass) filters.push(eq(schema.credentialRefreshJobs.failureClass, failureClass));
  if (failureCode) {
    const legacyFailureClasses: Record<string, string[]> = {
      lease_conflict: ['owner_conflict'],
      rate_limited: ['rate_limited'],
      credential_unavailable: ['auth_invalid'],
      upstream_gateway_failure: ['provider_unavailable'],
      upstream_error: ['transient', 'unknown'],
    };
    const matching = legacyFailureClasses[failureCode] || [];
    filters.push(matching.length > 0
      ? inArray(schema.credentialRefreshJobs.failureClass, matching)
      : sql`1 = 0`);
  }
  const where = filters.length > 0 ? and(...filters) : undefined;
  const limit = normalizeLimit(input.limit);
  const offset = normalizeOffset(input.offset);
  const [items, count, providerStates] = await Promise.all([
    db.select().from(schema.credentialRefreshJobs).where(where)
      .orderBy(desc(schema.credentialRefreshJobs.updatedAt), desc(schema.credentialRefreshJobs.id))
      .limit(limit).offset(offset).all(),
    db.select({ count: sql<number>`count(*)` }).from(schema.credentialRefreshJobs).where(where).get(),
    db.select().from(schema.oauthRefreshProviderStates)
      .orderBy(asc(schema.oauthRefreshProviderStates.provider)).all(),
  ]);
  const mappedItems = items
    .map((item) => ({
      ...item,
      status: refreshJobStatus(item.status),
      failureClassification: classifyRefreshJobFailure(item),
    }));
  return {
    items: mappedItems,
    total: Number(count?.count || 0),
    providerStates,
  };
}

async function runScheduledPass(): Promise<void> {
  if (schedulerPassInFlight) return schedulerPassInFlight;
  schedulerPassInFlight = runObservedWorkerPass(
    WORKER_NAME,
    executeCredentialLifecycleOperationsPass,
  )
    .then(() => undefined)
    .catch((error) => {
      console.warn(`[credential-lifecycle] scheduled pass failed: ${(error as Error)?.message || 'unknown error'}`);
    })
    .finally(() => {
      schedulerPassInFlight = null;
    });
  return schedulerPassInFlight;
}

export async function startCredentialLifecycleScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  const policy = await getCredentialLifecyclePolicy();
  const intervalMs = Math.max(15_000, policy.schedulerIntervalSeconds * 1_000);
  startObservedWorker({ name: WORKER_NAME, intervalMs });
  void runScheduledPass();
  schedulerTimer = setInterval(() => void runScheduledPass(), intervalMs);
  schedulerTimer.unref?.();
  return { enabled: true, intervalMs };
}

export async function stopCredentialLifecycleScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (schedulerPassInFlight) await schedulerPassInFlight;
  stopObservedWorker(WORKER_NAME);
}

export async function restartCredentialLifecycleScheduler() {
  await stopCredentialLifecycleScheduler();
  return startCredentialLifecycleScheduler();
}

export {
  getCredentialLifecyclePolicy,
  listCredentialLifecycleAudits,
};

export const credentialLifecycleOperationsInternals = {
  classifyRefreshFailure,
  computeRetryDelayMs,
  mergeRefreshOwner,
  synchronizeRefreshQueue,
};
