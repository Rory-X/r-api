import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import type {
  ProxyAttemptPolicySnapshot,
  ProxyAttemptRecord,
  ProxyRequestRecord,
  ProxyAttemptStatus,
  ProxyRequestStatus,
} from './proxyAttemptLedger.js';
import type {
  AttemptCommitState,
  RetryBudgetState,
  RetryErrorScope,
  RetryOwner,
} from './proxyRetryContract.js';
import {
  classifyOperationalFailure,
  type OperationalAlertCategory,
  type OperationalAlertSeverity,
  type OperationalFailureCode,
  type OperationalHealthDomain,
} from './operationalFailureContract.js';
import {
  buildProxyRoutingExplanation,
  parseProxyRoutingExplanationSnapshot,
  type ProxyRoutingExplanation,
  type ProxyRoutingExplanationSnapshot,
} from './proxyRoutingExplanation.js';

const PROXY_REQUEST_STATUSES = new Set<ProxyRequestStatus>([
  'active',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
]);

const ATTEMPT_COMMIT_STATES = new Set<AttemptCommitState>([
  'not_started',
  'request_sent',
  'response_started',
  'completed',
  'sent_unknown',
]);

const DEFAULT_RETRY_BUDGET: RetryBudgetState = {
  startedAtMs: 0,
  limits: {
    maxElapsedMs: null,
    maxAttempts: null,
    maxCredentialRotations: null,
    maxChannelSwitches: null,
  },
  attempts: 0,
  credentialRotations: 0,
  channelSwitches: 0,
};

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseRetryBudget(value: string | null | undefined): RetryBudgetState {
  return parseJson(value, DEFAULT_RETRY_BUDGET);
}

function parsePublicPolicySnapshot(value: string | null | undefined): Record<string, unknown> {
  const snapshot = parseJson<Record<string, unknown>>(value, {});
  const { routingExplanation: _routingExplanation, ...policySnapshot } = snapshot;
  return policySnapshot;
}

function redactSensitiveUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const sensitiveKey = /^(?:api[-_]?key|access[-_]?token|auth|authorization|key|secret|token)$/i;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = 'redacted';
    if (parsed.password) parsed.password = 'redacted';
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveKey.test(key)) parsed.searchParams.set(key, 'redacted');
    }
    return parsed.toString();
  } catch {
    return value.replace(
      /([?&](?:api[-_]?key|access[-_]?token|auth|authorization|key|secret|token)=)[^&#]*/gi,
      '$1redacted',
    );
  }
}

function hasProxyAttemptLedgerSchema(): boolean {
  const runtimeSchema = schema as typeof schema & {
    proxyRequests?: unknown;
    proxyRequestAttempts?: unknown;
  };
  return !!runtimeSchema.proxyRequests && !!runtimeSchema.proxyRequestAttempts;
}

function toAttemptRecord(row: typeof schema.proxyRequestAttempts.$inferSelect): ProxyAttemptRecord {
  return {
    attemptId: row.attemptId,
    attemptIndex: row.attemptIndex,
    channelId: row.channelId ?? null,
    credentialId: row.tokenId ?? null,
    status: row.status as ProxyAttemptStatus,
    commitState: row.commitState as AttemptCommitState,
    errorScope: (row.errorScope as RetryErrorScope | null) ?? null,
    statusCode: row.statusCode ?? null,
    startedAtMs: Date.parse(row.startedAt || '') || 0,
    finishedAtMs: row.finishedAt ? (Date.parse(row.finishedAt) || null) : null,
  };
}

function toRequestRecord(
  row: typeof schema.proxyRequests.$inferSelect,
  attempts: Array<typeof schema.proxyRequestAttempts.$inferSelect>,
): ProxyRequestRecord {
  return {
    requestId: row.requestId,
    requestedModel: row.requestedModel,
    downstreamPath: row.downstreamPath,
    status: row.status as ProxyRequestStatus,
    createdAtMs: Date.parse(row.createdAt || '') || 0,
    finishedAtMs: row.finishedAt ? (Date.parse(row.finishedAt) || null) : null,
    policy: {
      retryOwner: row.retryOwner as ProxyAttemptPolicySnapshot['retryOwner'],
      replaySafety: row.replaySafety as ProxyAttemptPolicySnapshot['replaySafety'],
      retryBudget: parseRetryBudget(row.retryBudgetJson),
    },
    attempts: attempts.map(toAttemptRecord),
  };
}

type ProxyRequestRow = typeof schema.proxyRequests.$inferSelect;
type ProxyAttemptRow = typeof schema.proxyRequestAttempts.$inferSelect;

export type ProxyRequestLedgerListFilters = {
  limit?: number;
  offset?: number;
  status?: ProxyRequestStatus | 'all';
  commitState?: AttemptCommitState | 'all';
  search?: string;
};

export type ProxyRequestLedgerListItem = {
  id: number;
  requestId: string;
  requestedModel: string;
  downstreamPath: string;
  clientKind: string | null;
  sessionId: string | null;
  clientThreadId: string | null;
  clientTurnId: string | null;
  bridgeTaskId: string | null;
  bridgeRouteAction: string | null;
  bridgeContinuationNumber: number | null;
  downstreamApiKeyId: number | null;
  downstreamApiKeyName: string | null;
  status: ProxyRequestStatus;
  retryOwner: RetryOwner;
  replaySafety: ProxyAttemptPolicySnapshot['replaySafety'];
  policySnapshot: Record<string, unknown>;
  retryBudget: RetryBudgetState;
  attemptCount: number;
  latestCommitState: AttemptCommitState | null;
  hasSentUnknown: boolean;
  createdAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
};

export type ProxyRequestLedgerAttemptDetail = {
  id: number;
  attemptId: string;
  attemptIndex: number;
  channelId: number | null;
  routeId: number | null;
  routeModelPattern: string | null;
  accountId: number | null;
  accountUsername: string | null;
  siteId: number | null;
  siteName: string | null;
  credentialId: number | null;
  credentialName: string | null;
  endpoint: string | null;
  requestPath: string | null;
  targetUrl: string | null;
  status: ProxyAttemptStatus;
  commitState: AttemptCommitState;
  errorScope: RetryErrorScope | null;
  statusCode: number | null;
  failureCode: OperationalFailureCode | null;
  healthDomain: OperationalHealthDomain | null;
  alertCategory: OperationalAlertCategory | null;
  alertSeverity: OperationalAlertSeverity | null;
  retryable: boolean | null;
  errorSummary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
};

export type ProxyRequestLedgerDetail = ProxyRequestLedgerListItem & {
  attempts: ProxyRequestLedgerAttemptDetail[];
  routingExplanation: ProxyRoutingExplanation | null;
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

export type ProxyRequestLedgerListResult = {
  items: ProxyRequestLedgerListItem[];
  total: number;
  limit: number;
  offset: number;
  summary: ProxyRequestLedgerSummary;
};

function normalizeRequestStatus(value: unknown): ProxyRequestStatus | 'all' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROXY_REQUEST_STATUSES.has(normalized as ProxyRequestStatus)
    ? normalized as ProxyRequestStatus
    : 'all';
}

function normalizeCommitState(value: unknown): AttemptCommitState | 'all' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ATTEMPT_COMMIT_STATES.has(normalized as AttemptCommitState)
    ? normalized as AttemptCommitState
    : 'all';
}

function buildProxyRequestLedgerWhere(filters: ProxyRequestLedgerListFilters): SQL | undefined {
  const conditions: SQL[] = [];
  const status = normalizeRequestStatus(filters.status);
  if (status !== 'all') conditions.push(eq(schema.proxyRequests.status, status));

  const commitState = normalizeCommitState(filters.commitState);
  if (commitState !== 'all') {
    const matchingRequestRows = db.select({
      requestRowId: schema.proxyRequestAttempts.requestRowId,
    }).from(schema.proxyRequestAttempts)
      .where(eq(schema.proxyRequestAttempts.commitState, commitState));
    conditions.push(inArray(schema.proxyRequests.id, matchingRequestRows));
  }

  const search = filters.search?.trim().toLowerCase();
  if (search) {
    const likeTerm = `%${search}%`;
    const searchCondition = or(
      sql<boolean>`lower(coalesce(${schema.proxyRequests.requestId}, '')) like ${likeTerm}`,
      sql<boolean>`lower(coalesce(${schema.proxyRequests.requestedModel}, '')) like ${likeTerm}`,
      sql<boolean>`lower(coalesce(${schema.proxyRequests.downstreamPath}, '')) like ${likeTerm}`,
      sql<boolean>`lower(coalesce(${schema.proxyRequests.clientKind}, '')) like ${likeTerm}`,
      sql<boolean>`lower(coalesce(${schema.proxyRequests.sessionId}, '')) like ${likeTerm}`,
      sql<boolean>`lower(coalesce(${schema.proxyRequests.clientThreadId}, '')) like ${likeTerm}`,
      sql<boolean>`lower(coalesce(${schema.proxyRequests.bridgeTaskId}, '')) like ${likeTerm}`,
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function mapProxyRequestLedgerListItem(input: {
  request: ProxyRequestRow;
  downstreamApiKeyName?: string | null;
  attempts: ProxyAttemptRow[];
}): ProxyRequestLedgerListItem {
  const latestAttempt = input.attempts.at(-1);
  return {
    id: input.request.id,
    requestId: input.request.requestId,
    requestedModel: input.request.requestedModel,
    downstreamPath: input.request.downstreamPath,
    clientKind: input.request.clientKind ?? null,
    sessionId: input.request.sessionId ?? null,
    clientThreadId: input.request.clientThreadId ?? null,
    clientTurnId: input.request.clientTurnId ?? null,
    bridgeTaskId: input.request.bridgeTaskId ?? null,
    bridgeRouteAction: input.request.bridgeRouteAction ?? null,
    bridgeContinuationNumber: input.request.bridgeContinuationNumber ?? null,
    downstreamApiKeyId: input.request.downstreamApiKeyId ?? null,
    downstreamApiKeyName: input.downstreamApiKeyName ?? null,
    status: input.request.status as ProxyRequestStatus,
    retryOwner: input.request.retryOwner as RetryOwner,
    replaySafety: input.request.replaySafety as ProxyAttemptPolicySnapshot['replaySafety'],
    policySnapshot: parsePublicPolicySnapshot(input.request.policySnapshotJson),
    retryBudget: parseRetryBudget(input.request.retryBudgetJson),
    attemptCount: input.attempts.length,
    latestCommitState: (latestAttempt?.commitState as AttemptCommitState | undefined) ?? null,
    hasSentUnknown: input.attempts.some((attempt) => attempt.commitState === 'sent_unknown'),
    createdAt: input.request.createdAt ?? null,
    finishedAt: input.request.finishedAt ?? null,
    updatedAt: input.request.updatedAt ?? null,
  };
}

async function getProxyRequestLedgerSummary(): Promise<ProxyRequestLedgerSummary> {
  const [requestSummary, sentUnknownSummary] = await Promise.all([
    db.select({
      total: count(),
      active: sql<number>`coalesce(sum(case when ${schema.proxyRequests.status} = 'active' then 1 else 0 end), 0)`,
      succeeded: sql<number>`coalesce(sum(case when ${schema.proxyRequests.status} = 'succeeded' then 1 else 0 end), 0)`,
      failed: sql<number>`coalesce(sum(case when ${schema.proxyRequests.status} = 'failed' then 1 else 0 end), 0)`,
      cancelled: sql<number>`coalesce(sum(case when ${schema.proxyRequests.status} = 'cancelled' then 1 else 0 end), 0)`,
      unknown: sql<number>`coalesce(sum(case when ${schema.proxyRequests.status} = 'unknown' then 1 else 0 end), 0)`,
    }).from(schema.proxyRequests).get(),
    db.select({
      total: countDistinct(schema.proxyRequestAttempts.requestRowId),
    }).from(schema.proxyRequestAttempts)
      .where(eq(schema.proxyRequestAttempts.commitState, 'sent_unknown'))
      .get(),
  ]);
  return {
    total: Number(requestSummary?.total || 0),
    active: Number(requestSummary?.active || 0),
    succeeded: Number(requestSummary?.succeeded || 0),
    failed: Number(requestSummary?.failed || 0),
    cancelled: Number(requestSummary?.cancelled || 0),
    unknown: Number(requestSummary?.unknown || 0),
    sentUnknown: Number(sentUnknownSummary?.total || 0),
  };
}

export type CreateProxyRequestLedgerInput = {
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
  policy: ProxyAttemptPolicySnapshot;
  now?: Date;
};

export async function insertProxyRequestLedger(input: CreateProxyRequestLedgerInput): Promise<{
  requestRowId: number;
  requestId: string;
}> {
  if (!hasProxyAttemptLedgerSchema()) {
    throw new Error('proxy attempt ledger schema unavailable');
  }
  const now = formatUtcSqlDateTime(input.now ?? new Date());
  const inserted = await db.insert(schema.proxyRequests).values({
    requestId: input.requestId,
    requestedModel: input.requestedModel,
    downstreamPath: input.downstreamPath,
    clientKind: input.clientKind ?? null,
    sessionId: input.sessionId ?? null,
    clientThreadId: input.clientThreadId ?? null,
    clientTurnId: input.clientTurnId ?? null,
    bridgeTaskId: input.bridgeTaskId ?? null,
    bridgeRouteAction: input.bridgeRouteAction ?? null,
    bridgeContinuationNumber: input.bridgeContinuationNumber ?? null,
    downstreamApiKeyId: input.downstreamApiKeyId ?? null,
    status: 'active',
    retryOwner: input.policy.retryOwner,
    replaySafety: input.policy.replaySafety,
    policySnapshotJson: serializeJson({
      retryOwner: input.policy.retryOwner,
      replaySafety: input.policy.replaySafety,
    }),
    retryBudgetJson: serializeJson(input.policy.retryBudget),
    createdAt: now,
    updatedAt: now,
  }).run();

  return {
    requestRowId: requireInsertedRowId(inserted, 'failed to create proxy request ledger'),
    requestId: input.requestId,
  };
}

export async function updateProxyRequestPolicySnapshot(input: {
  requestRowId: number;
  retryOwner: RetryOwner;
  replaySafety: ProxyAttemptPolicySnapshot['replaySafety'];
  routingExplanation?: ProxyRoutingExplanationSnapshot | null;
  now?: Date;
}): Promise<void> {
  await db.update(schema.proxyRequests).set({
    retryOwner: input.retryOwner,
    policySnapshotJson: serializeJson({
      retryOwner: input.retryOwner,
      replaySafety: input.replaySafety,
      ...(input.routingExplanation ? { routingExplanation: input.routingExplanation } : {}),
    }),
    updatedAt: formatUtcSqlDateTime(input.now ?? new Date()),
  }).where(eq(schema.proxyRequests.id, input.requestRowId)).run();
}

export async function updateProxyRequestRetryOwner(input: {
  requestRowId: number;
  retryOwner: RetryOwner;
  replaySafety: ProxyAttemptPolicySnapshot['replaySafety'];
  now?: Date;
}): Promise<void> {
  await updateProxyRequestPolicySnapshot(input);
}

export type InsertProxyRequestAttemptInput = {
  requestRowId: number;
  attemptId: string;
  attemptIndex: number;
  channelId?: number | null;
  accountId?: number | null;
  tokenId?: number | null;
  endpoint?: string | null;
  requestPath?: string | null;
  targetUrl?: string | null;
  commitState?: AttemptCommitState;
  now?: Date;
};

export async function insertProxyRequestAttempt(input: InsertProxyRequestAttemptInput): Promise<number> {
  const now = formatUtcSqlDateTime(input.now ?? new Date());
  const inserted = await db.insert(schema.proxyRequestAttempts).values({
    requestRowId: input.requestRowId,
    attemptId: input.attemptId,
    attemptIndex: Math.max(0, Math.trunc(input.attemptIndex)),
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    tokenId: input.tokenId ?? null,
    endpoint: input.endpoint ?? null,
    requestPath: input.requestPath ?? null,
    targetUrl: input.targetUrl ?? null,
    status: 'in_flight',
    commitState: input.commitState ?? 'not_started',
    startedAt: now,
    updatedAt: now,
  }).run();
  return requireInsertedRowId(inserted, 'failed to create proxy request attempt');
}

export async function updateProxyRequestAttemptCommit(input: {
  requestRowId: number;
  attemptId: string;
  commitState: AttemptCommitState;
  now?: Date;
}): Promise<void> {
  await db.update(schema.proxyRequestAttempts).set({
    commitState: input.commitState,
    updatedAt: formatUtcSqlDateTime(input.now ?? new Date()),
  }).where(and(
    eq(schema.proxyRequestAttempts.requestRowId, input.requestRowId),
    eq(schema.proxyRequestAttempts.attemptId, input.attemptId),
  )).run();
}

export async function finishProxyRequestAttempt(input: {
  requestRowId: number;
  attemptId: string;
  status: Exclude<ProxyAttemptStatus, 'in_flight'>;
  commitState?: AttemptCommitState;
  errorScope?: RetryErrorScope | null;
  statusCode?: number | null;
  errorSummary?: string | null;
  now?: Date;
}): Promise<void> {
  const now = formatUtcSqlDateTime(input.now ?? new Date());
  await db.update(schema.proxyRequestAttempts).set({
    status: input.status,
    ...(input.commitState !== undefined ? { commitState: input.commitState } : {}),
    errorScope: input.errorScope ?? null,
    statusCode: input.statusCode ?? null,
    errorSummary: input.errorSummary ?? null,
    finishedAt: now,
    updatedAt: now,
  }).where(and(
    eq(schema.proxyRequestAttempts.requestRowId, input.requestRowId),
    eq(schema.proxyRequestAttempts.attemptId, input.attemptId),
  )).run();
}

export async function finishProxyRequest(input: {
  requestRowId: number;
  status: Exclude<ProxyRequestStatus, 'active'>;
  now?: Date;
}): Promise<void> {
  const now = formatUtcSqlDateTime(input.now ?? new Date());
  await db.update(schema.proxyRequests).set({
    status: input.status,
    finishedAt: now,
    updatedAt: now,
  }).where(eq(schema.proxyRequests.id, input.requestRowId)).run();
}

export async function getProxyRequestLedger(requestId: string): Promise<ProxyRequestRecord | null> {
  const request = await db.select().from(schema.proxyRequests)
    .where(eq(schema.proxyRequests.requestId, requestId))
    .get();
  if (!request) return null;

  const attempts = await db.select().from(schema.proxyRequestAttempts)
    .where(eq(schema.proxyRequestAttempts.requestRowId, request.id))
    .orderBy(asc(schema.proxyRequestAttempts.attemptIndex), asc(schema.proxyRequestAttempts.id))
    .all();
  return toRequestRecord(request, attempts);
}

export type ProxySessionRouteSelection = Readonly<{
  requestId: string;
  attemptId: string;
  channelId: number;
  routeId: number | null;
  siteId: number;
  accountId: number;
  tokenId: number | null;
  startedAt: string | null;
}>;

export async function findLatestProxySessionRouteSelection(input: {
  clientThreadId?: string | null;
  sessionId?: string | null;
  downstreamApiKeyId?: number | null;
}): Promise<ProxySessionRouteSelection | null> {
  const clientThreadId = input.clientThreadId?.trim() || null;
  const sessionId = input.sessionId?.trim() || null;
  if (!clientThreadId && !sessionId) return null;

  const downstreamKeyFilter = input.downstreamApiKeyId == null
    ? isNull(schema.proxyRequests.downstreamApiKeyId)
    : eq(schema.proxyRequests.downstreamApiKeyId, input.downstreamApiKeyId);
  const findByIdentity = async (identityFilter: ReturnType<typeof eq>) => await db.select({
      requestId: schema.proxyRequests.requestId,
      attemptId: schema.proxyRequestAttempts.attemptId,
      channelId: schema.proxyRequestAttempts.channelId,
      routeId: schema.routeChannels.routeId,
      siteId: schema.accounts.siteId,
      accountId: schema.proxyRequestAttempts.accountId,
      tokenId: schema.proxyRequestAttempts.tokenId,
      startedAt: schema.proxyRequestAttempts.startedAt,
    })
      .from(schema.proxyRequestAttempts)
      .innerJoin(schema.proxyRequests, eq(schema.proxyRequestAttempts.requestRowId, schema.proxyRequests.id))
      .innerJoin(schema.accounts, eq(schema.proxyRequestAttempts.accountId, schema.accounts.id))
      .leftJoin(schema.routeChannels, eq(schema.proxyRequestAttempts.channelId, schema.routeChannels.id))
      .where(and(identityFilter, downstreamKeyFilter))
      .orderBy(desc(schema.proxyRequestAttempts.startedAt), desc(schema.proxyRequestAttempts.id))
      .limit(1)
      .get();

  const row = clientThreadId
    ? await findByIdentity(eq(schema.proxyRequests.clientThreadId, clientThreadId))
    : null;
  const resolvedRow = row || (sessionId
    ? await findByIdentity(eq(schema.proxyRequests.sessionId, sessionId))
    : null);

  if (
    !resolvedRow
    || resolvedRow.channelId == null
    || resolvedRow.siteId == null
    || resolvedRow.accountId == null
  ) return null;

  return Object.freeze({
    requestId: resolvedRow.requestId,
    attemptId: resolvedRow.attemptId,
    channelId: resolvedRow.channelId,
    routeId: resolvedRow.routeId ?? null,
    siteId: resolvedRow.siteId,
    accountId: resolvedRow.accountId,
    tokenId: resolvedRow.tokenId ?? null,
    startedAt: resolvedRow.startedAt ?? null,
  });
}

export async function listActiveProxyRequestLedgers(limit = 100): Promise<ProxyRequestRecord[]> {
  const normalizedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const requests = await db.select().from(schema.proxyRequests)
    .where(eq(schema.proxyRequests.status, 'active'))
    .orderBy(desc(schema.proxyRequests.updatedAt), desc(schema.proxyRequests.id))
    .limit(normalizedLimit)
    .all();
  if (requests.length === 0) return [];

  const requestIds = requests.map((request) => request.id);
  const attempts = await db.select().from(schema.proxyRequestAttempts)
    .where(inArray(schema.proxyRequestAttempts.requestRowId, requestIds))
    .orderBy(asc(schema.proxyRequestAttempts.attemptIndex), asc(schema.proxyRequestAttempts.id))
    .all();
  const attemptsByRequestId = new Map<number, Array<typeof schema.proxyRequestAttempts.$inferSelect>>();
  for (const attempt of attempts) {
    const bucket = attemptsByRequestId.get(attempt.requestRowId) ?? [];
    bucket.push(attempt);
    attemptsByRequestId.set(attempt.requestRowId, bucket);
  }
  return requests.map((request) => toRequestRecord(request, attemptsByRequestId.get(request.id) ?? []));
}

export async function listProxyRequestLedgers(
  filters: ProxyRequestLedgerListFilters = {},
): Promise<ProxyRequestLedgerListResult> {
  const limit = Math.max(1, Math.min(100, Math.trunc(filters.limit ?? 20)));
  const offset = Math.max(0, Math.trunc(filters.offset ?? 0));
  const where = buildProxyRequestLedgerWhere(filters);

  const listBase = db.select({
    request: schema.proxyRequests,
    downstreamApiKeyName: schema.downstreamApiKeys.name,
  }).from(schema.proxyRequests)
    .leftJoin(
      schema.downstreamApiKeys,
      eq(schema.proxyRequests.downstreamApiKeyId, schema.downstreamApiKeys.id),
    );
  const countBase = db.select({ total: count() }).from(schema.proxyRequests);

  const [rows, totalRow, summary] = await Promise.all([
    (where ? listBase.where(where) : listBase)
      .orderBy(desc(schema.proxyRequests.updatedAt), desc(schema.proxyRequests.id))
      .limit(limit)
      .offset(offset)
      .all(),
    (where ? countBase.where(where) : countBase).get(),
    getProxyRequestLedgerSummary(),
  ]);

  if (rows.length === 0) {
    return {
      items: [],
      total: Number(totalRow?.total || 0),
      limit,
      offset,
      summary,
    };
  }

  const requestRowIds = rows.map(({ request }) => request.id);
  const attempts = await db.select().from(schema.proxyRequestAttempts)
    .where(inArray(schema.proxyRequestAttempts.requestRowId, requestRowIds))
    .orderBy(
      asc(schema.proxyRequestAttempts.requestRowId),
      asc(schema.proxyRequestAttempts.attemptIndex),
      asc(schema.proxyRequestAttempts.id),
    )
    .all();
  const attemptsByRequestId = new Map<number, ProxyAttemptRow[]>();
  for (const attempt of attempts) {
    const bucket = attemptsByRequestId.get(attempt.requestRowId) ?? [];
    bucket.push(attempt);
    attemptsByRequestId.set(attempt.requestRowId, bucket);
  }

  return {
    items: rows.map(({ request, downstreamApiKeyName }) => mapProxyRequestLedgerListItem({
      request,
      downstreamApiKeyName,
      attempts: attemptsByRequestId.get(request.id) ?? [],
    })),
    total: Number(totalRow?.total || 0),
    limit,
    offset,
    summary,
  };
}

export async function getProxyRequestLedgerDetail(
  requestId: string,
): Promise<ProxyRequestLedgerDetail | null> {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId) return null;

  const row = await db.select({
    request: schema.proxyRequests,
    downstreamApiKeyName: schema.downstreamApiKeys.name,
  }).from(schema.proxyRequests)
    .leftJoin(
      schema.downstreamApiKeys,
      eq(schema.proxyRequests.downstreamApiKeyId, schema.downstreamApiKeys.id),
    )
    .where(eq(schema.proxyRequests.requestId, normalizedRequestId))
    .get();
  if (!row) return null;

  const attemptRows = await db.select({
    attempt: schema.proxyRequestAttempts,
    routeId: schema.routeChannels.routeId,
    routeModelPattern: schema.tokenRoutes.modelPattern,
    accountUsername: schema.accounts.username,
    siteId: schema.sites.id,
    siteName: schema.sites.name,
    credentialName: schema.accountTokens.name,
  }).from(schema.proxyRequestAttempts)
    .leftJoin(
      schema.routeChannels,
      eq(schema.proxyRequestAttempts.channelId, schema.routeChannels.id),
    )
    .leftJoin(
      schema.tokenRoutes,
      eq(schema.routeChannels.routeId, schema.tokenRoutes.id),
    )
    .leftJoin(
      schema.accounts,
      eq(schema.proxyRequestAttempts.accountId, schema.accounts.id),
    )
    .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(
      schema.accountTokens,
      eq(schema.proxyRequestAttempts.tokenId, schema.accountTokens.id),
    )
    .where(eq(schema.proxyRequestAttempts.requestRowId, row.request.id))
    .orderBy(
      asc(schema.proxyRequestAttempts.attemptIndex),
      asc(schema.proxyRequestAttempts.id),
    )
    .all();

  const base = mapProxyRequestLedgerListItem({
    request: row.request,
    downstreamApiKeyName: row.downstreamApiKeyName,
    attempts: attemptRows.map(({ attempt }) => attempt),
  });
  const attempts = attemptRows.map((attemptRow) => {
    const errorScope = (attemptRow.attempt.errorScope as RetryErrorScope | null) ?? null;
    const statusCode = attemptRow.attempt.statusCode ?? null;
    const errorSummary = attemptRow.attempt.errorSummary ?? null;
    const classification = attemptRow.attempt.status === 'succeeded'
      ? null
      : classifyOperationalFailure({
        status: statusCode ?? undefined,
        rawErrorText: errorSummary,
        errorScope,
      });
    return {
      id: attemptRow.attempt.id,
      attemptId: attemptRow.attempt.attemptId,
      attemptIndex: attemptRow.attempt.attemptIndex,
      channelId: attemptRow.attempt.channelId ?? null,
      routeId: attemptRow.routeId ?? null,
      routeModelPattern: attemptRow.routeModelPattern ?? null,
      accountId: attemptRow.attempt.accountId ?? null,
      accountUsername: attemptRow.accountUsername ?? null,
      siteId: attemptRow.siteId ?? null,
      siteName: attemptRow.siteName ?? null,
      credentialId: attemptRow.attempt.tokenId ?? null,
      credentialName: attemptRow.credentialName ?? null,
      endpoint: attemptRow.attempt.endpoint ?? null,
      requestPath: redactSensitiveUrl(attemptRow.attempt.requestPath),
      targetUrl: redactSensitiveUrl(attemptRow.attempt.targetUrl),
      status: attemptRow.attempt.status as ProxyAttemptStatus,
      commitState: attemptRow.attempt.commitState as AttemptCommitState,
      errorScope,
      statusCode,
      failureCode: classification?.code ?? null,
      healthDomain: classification?.healthDomain ?? null,
      alertCategory: classification?.alertCategory ?? null,
      alertSeverity: classification?.alertSeverity ?? null,
      retryable: classification?.retryable ?? null,
      errorSummary,
      startedAt: attemptRow.attempt.startedAt ?? null,
      finishedAt: attemptRow.attempt.finishedAt ?? null,
      updatedAt: attemptRow.attempt.updatedAt ?? null,
    };
  });
  const routingSnapshot = parseProxyRoutingExplanationSnapshot(
    parseJson<Record<string, unknown>>(row.request.policySnapshotJson, {}).routingExplanation,
  );
  return {
    ...base,
    attempts,
    routingExplanation: buildProxyRoutingExplanation({
      snapshot: routingSnapshot,
      requestedModel: base.requestedModel,
      status: base.status,
      attempts,
    }),
  };
}

export async function recoverAbandonedProxyRequestLedgers(input: {
  now?: Date;
  reason?: string;
} = {}): Promise<{ recoveredRequests: number; recoveredAttempts: number }> {
  const activeRequests = await db.select({ id: schema.proxyRequests.id })
    .from(schema.proxyRequests)
    .where(eq(schema.proxyRequests.status, 'active'))
    .all();
  if (activeRequests.length === 0) {
    return { recoveredRequests: 0, recoveredAttempts: 0 };
  }

  const requestRowIds = activeRequests.map((request) => request.id);
  const activeAttempts = await db.select({ id: schema.proxyRequestAttempts.id })
    .from(schema.proxyRequestAttempts)
    .where(and(
      inArray(schema.proxyRequestAttempts.requestRowId, requestRowIds),
      eq(schema.proxyRequestAttempts.status, 'in_flight'),
    ))
    .all();
  const now = formatUtcSqlDateTime(input.now ?? new Date());
  const reason = input.reason?.trim() || 'gateway restarted before the upstream outcome was known';

  await db.transaction(async (tx: typeof db) => {
    if (activeAttempts.length > 0) {
      await tx.update(schema.proxyRequestAttempts).set({
        status: 'unknown',
        commitState: 'sent_unknown',
        errorScope: 'transport',
        errorSummary: reason,
        finishedAt: now,
        updatedAt: now,
      }).where(and(
        inArray(schema.proxyRequestAttempts.requestRowId, requestRowIds),
        eq(schema.proxyRequestAttempts.status, 'in_flight'),
      )).run();
    }

    await tx.update(schema.proxyRequests).set({
      status: 'unknown',
      finishedAt: now,
      updatedAt: now,
    }).where(and(
      inArray(schema.proxyRequests.id, requestRowIds),
      eq(schema.proxyRequests.status, 'active'),
    )).run();
  });

  return {
    recoveredRequests: activeRequests.length,
    recoveredAttempts: activeAttempts.length,
  };
}
