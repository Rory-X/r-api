import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { and, asc, desc, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  BRIDGE_FAILURE_CLASSES,
  classifyBridgeFailure,
  isBridgeWriterContentionFailure,
  snapshotBridgeContinuationPolicy,
  type BridgeContinuationPolicyInput,
  type BridgeContinuationPolicySnapshot,
  type BridgeFailureInput,
  type BridgeFailureRecoverability,
  type BridgeFailureSource,
  type BridgeRouteAction,
  type ClassifiedBridgeFailure,
  type CodexThreadActiveFlag,
  type CodexThreadStatus,
} from './bridgeContinuationContract.js';
import {
  assertSingleBridgeContinuationCreationAllowed,
  GLOBAL_BRIDGE_CONTINUATION_REQUESTED_BY,
} from './globalBridgeContinuationConfigService.js';
import type { BridgeContinuationLease } from './bridgeContinuationLease.js';
import { recordLocalConnectorThreadEvent } from './localConnectorThreadService.js';
import {
  createBridgeContinuationTaskState,
  createManualBridgePromptTaskState,
  transitionBridgeContinuationTask,
  type BridgeContinuationTaskKind,
  type BridgeContinuationTaskEvent,
  type BridgeManualPromptSubmissionMode,
  type BridgeContinuationTaskReason,
  type BridgeContinuationTaskState,
  type BridgeContinuationTaskStatus,
  type BridgeTurnSubmissionMethod,
} from './bridgeContinuationState.js';

type DbExecutor = typeof db;
type BridgeTaskRow = typeof schema.bridgeContinuationTasks.$inferSelect;
type BridgeLeaseRow = typeof schema.bridgeContinuationLeases.$inferSelect;

export type BridgeContinuationTaskRecord = Readonly<{
  state: BridgeContinuationTaskState;
  deviceId: string | null;
  stateVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
  stoppedAt: string | null;
  lease: Readonly<{ ownerId: string; expiresAt: string }> | null;
  requestSource: 'webui' | 'im' | null;
  requestedBy: string | null;
  sourceAdapterId: string | null;
  promptFingerprint: string | null;
}>;

export type BridgeContinuationTaskClaim = Readonly<{
  task: BridgeContinuationTaskRecord;
  leaseToken: string;
  leaseExpiresAt: string;
  command: Readonly<{
    method: BridgeTurnSubmissionMethod;
    threadId: string;
    expectedTurnId?: string;
    prompt: string;
    routeAction: BridgeRouteAction;
    continuationNumber: number;
  }>;
}>;

export type BridgeContinuationAppServerEvent =
  | Readonly<{
    kind: 'thread_status';
    threadId: string;
    status: CodexThreadStatus;
    activeFlags: readonly CodexThreadActiveFlag[];
  }>
  | Readonly<{ kind: 'turn_started'; threadId: string; turnId: string }>
  | Readonly<{
    kind: 'turn_completed';
    threadId: string;
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
    failure: BridgeFailureInput | null;
  }>
  | Readonly<{
    kind: 'error';
    threadId: string;
    turnId: string;
    failure: BridgeFailureInput;
  }>;

const ACTIVE_TASK_STATUSES = new Set<BridgeContinuationTaskStatus>(['waiting', 'backoff', 'running']);
const TASK_STATUSES = new Set<BridgeContinuationTaskStatus>([
  'waiting',
  'backoff',
  'running',
  'stopped',
  'superseded',
  'dead',
]);
const THREAD_STATUSES = new Set<CodexThreadStatus>(['unknown', 'not_loaded', 'idle', 'active', 'system_error']);
const FAILURE_SOURCES = new Set<BridgeFailureSource>([
  'error_notification',
  'turn_completed',
  'control_error',
  'gateway_observation',
]);
const FAILURE_RECOVERABILITY = new Set<BridgeFailureRecoverability>(['transient', 'conditional', 'terminal']);
const LEASE_TOKEN_NAMESPACE = 'bridge-continuation-lease';
const MANUAL_PROMPT_IDEMPOTENCY_NAMESPACE = 'bridge-manual-prompt-idempotency';
const MANUAL_PROMPT_FINGERPRINT_NAMESPACE = 'bridge-manual-prompt';
const DEFAULT_LEASE_TTL_MS = 30_000;

function normalizedId(value: unknown, label: string, maxLength = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function normalizedDeliveryId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizedId(value, 'Bridge Delivery ID', 128);
}

function normalizedNow(value: Date | number | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(Math.max(0, Math.trunc(value)));
  return new Date();
}

function normalizedPositiveMs(value: unknown, fallback: number, maximum = 24 * 60 * 60 * 1_000): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1_000, parsed));
}

function parseTimestamp(value: string | null | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hashLeaseToken(token: string): string {
  return createHash('sha256').update(LEASE_TOKEN_NAMESPACE).update('\0').update(token).digest('hex');
}

function hashNamespaced(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex');
}

function normalizedManualPrompt(value: unknown): string {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt || prompt.length > 4_000 || prompt.includes('\0')) throw new Error('人工 Prompt 无效');
  return prompt;
}

function normalizedManualPromptMode(value: unknown): BridgeManualPromptSubmissionMode {
  if (value === 'auto' || value === 'steer_current' || value === 'start_next') return value;
  throw new Error('人工 Prompt 提交模式无效');
}

function normalizedRequestSource(value: unknown): 'webui' | 'im' {
  if (value === 'webui' || value === 'im') return value;
  throw new Error('人工 Prompt 来源无效');
}

function assertManualPromptIdempotencyMatch(
  row: BridgeTaskRow,
  input: {
    sessionKey: string;
    threadId: string;
    deviceId: string | null;
    submissionMode: BridgeManualPromptSubmissionMode;
    source: 'webui' | 'im';
    operatorId: string;
    sourceAdapterId: string | null;
    promptFingerprint: string;
  },
): void {
  if (
    row.taskKind !== 'manual_prompt'
    || row.sessionKey !== input.sessionKey
    || row.threadId !== input.threadId
    || row.deviceId !== input.deviceId
    || row.submissionMode !== input.submissionMode
    || row.requestSource !== input.source
    || row.requestedBy !== input.operatorId
    || row.sourceAdapterId !== input.sourceAdapterId
    || row.promptFingerprint !== input.promptFingerprint
  ) {
    throw new Error('人工 Prompt 幂等键已用于不同请求');
  }
}

function buildLeaseOwner(): string {
  return `${String(hostname() || 'local').trim() || 'local'}:${process.pid}`;
}

function affectedRows(result: any): number {
  return Number(result?.changes ?? result?.rowCount ?? result?.affectedRows ?? 0);
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
    ) return true;
    current = entry.cause;
  }
  return false;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // A damaged policy snapshot must fail closed instead of silently changing behavior.
  }
  throw new Error('Bridge continuation policy snapshot is damaged');
}

function parsePolicySnapshot(row: BridgeTaskRow): BridgeContinuationPolicySnapshot {
  const parsed = parseJsonRecord(row.policySnapshot);
  const capturedAtMs = typeof parsed.capturedAt === 'string' ? Date.parse(parsed.capturedAt) : NaN;
  const normalized = snapshotBridgeContinuationPolicy({
    policyVersion: parsed.policyVersion,
    enabled: parsed.enabled,
    continuePrompt: parsed.continuePrompt,
    maxElapsedMs: parsed.maxElapsedMs,
    backoff: parsed.backoff && typeof parsed.backoff === 'object'
      ? parsed.backoff as BridgeContinuationPolicyInput['backoff']
      : null,
    rules: parsed.rules && typeof parsed.rules === 'object'
      ? parsed.rules as BridgeContinuationPolicyInput['rules']
      : null,
  }, Number.isFinite(capturedAtMs) ? capturedAtMs : parseTimestamp(row.createdAt, Date.now()));
  if (normalized.fingerprint !== row.policyFingerprint || normalized.fingerprint !== parsed.fingerprint) {
    throw new Error('Bridge continuation policy fingerprint mismatch');
  }
  return normalized;
}

function parseActiveFlags(value: string): readonly CodexThreadActiveFlag[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return Object.freeze([]);
    return Object.freeze([...new Set(parsed.filter(
      (item): item is CodexThreadActiveFlag => item === 'waitingOnApproval' || item === 'waitingOnUserInput',
    ))]);
  } catch {
    return Object.freeze([]);
  }
}

function normalizedTaskStatus(value: string): BridgeContinuationTaskStatus {
  if (!TASK_STATUSES.has(value as BridgeContinuationTaskStatus)) {
    throw new Error(`Unknown bridge continuation task status: ${value}`);
  }
  return value as BridgeContinuationTaskStatus;
}

function normalizedThreadStatus(value: string): CodexThreadStatus {
  return THREAD_STATUSES.has(value as CodexThreadStatus) ? value as CodexThreadStatus : 'unknown';
}

function restoreFailure(row: BridgeTaskRow): ClassifiedBridgeFailure | null {
  if (!row.lastFailureClass || !BRIDGE_FAILURE_CLASSES.includes(row.lastFailureClass as any)) return null;
  const source = FAILURE_SOURCES.has(row.lastFailureSource as BridgeFailureSource)
    ? row.lastFailureSource as BridgeFailureSource
    : 'control_error';
  const recoverability = FAILURE_RECOVERABILITY.has(row.lastFailureRecoverability as BridgeFailureRecoverability)
    ? row.lastFailureRecoverability as BridgeFailureRecoverability
    : 'conditional';
  return Object.freeze({
    failureClass: row.lastFailureClass as ClassifiedBridgeFailure['failureClass'],
    source,
    recoverability,
    codexErrorCode: row.lastCodexErrorCode,
    httpStatusCode: row.lastHttpStatusCode,
    messageSummary: row.lastMessageSummary || '',
    messageFingerprint: row.lastMessageFingerprint || '',
    willRetry: row.lastWillRetry == null ? null : Boolean(row.lastWillRetry),
  });
}

function stateFromRow(row: BridgeTaskRow, lease: BridgeContinuationLease | null = null): BridgeContinuationTaskState {
  const status = normalizedTaskStatus(row.status);
  const startedAtMs = parseTimestamp(row.startedAt, parseTimestamp(row.createdAt, Date.now()));
  const updatedAtMs = parseTimestamp(row.updatedAt, startedAtMs);
  return Object.freeze({
    taskId: row.id,
    sessionKey: row.sessionKey,
    threadId: row.threadId,
    taskKind: row.taskKind === 'manual_prompt' ? 'manual_prompt' : 'automatic',
    submissionMode: row.submissionMode === 'auto'
      || row.submissionMode === 'steer_current'
      || row.submissionMode === 'start_next'
      ? row.submissionMode
      : null,
    status,
    reason: row.reason as BridgeContinuationTaskReason,
    policy: parsePolicySnapshot(row),
    continuationCount: Math.max(0, Math.trunc(row.continuationCount)),
    startedAtMs,
    updatedAtMs,
    nextRunAtMs: row.nextRunAt ? parseTimestamp(row.nextRunAt, updatedAtMs) : null,
    threadStatus: normalizedThreadStatus(row.threadStatus),
    activeFlags: parseActiveFlags(row.activeFlags),
    activeTurnId: row.activeTurnId,
    lastFailure: restoreFailure(row),
    lastFailureTurnTerminal: Boolean(row.lastFailureTurnTerminal),
    retryAfterMs: row.retryAfterMs == null ? null : Math.max(0, Math.trunc(row.retryAfterMs)),
    pendingRouteAction: row.pendingRouteAction as BridgeRouteAction | null,
    pendingPrompt: row.pendingPrompt,
    pendingMethod: row.pendingMethod === 'turn/steer'
      ? 'turn/steer'
      : row.pendingMethod === 'turn/start'
        ? 'turn/start'
        : null,
    lease,
  });
}

function publicLease(row: BridgeLeaseRow | null): BridgeContinuationTaskRecord['lease'] {
  return row ? Object.freeze({ ownerId: row.ownerId, expiresAt: row.expiresAt }) : null;
}

function recordFromRows(row: BridgeTaskRow, lease: BridgeLeaseRow | null = null): BridgeContinuationTaskRecord {
  return Object.freeze({
    state: stateFromRow(row),
    deviceId: row.deviceId,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    stoppedAt: row.stoppedAt,
    lease: publicLease(lease),
    requestSource: row.requestSource === 'webui' || row.requestSource === 'im' ? row.requestSource : null,
    requestedBy: row.requestedBy,
    sourceAdapterId: row.sourceAdapterId,
    promptFingerprint: row.promptFingerprint,
  });
}

async function loadTaskRow(executor: DbExecutor, taskId: string): Promise<BridgeTaskRow | null> {
  return await executor.select().from(schema.bridgeContinuationTasks)
    .where(eq(schema.bridgeContinuationTasks.id, taskId))
    .get() || null;
}

async function loadLeaseForTask(executor: DbExecutor, taskId: string): Promise<BridgeLeaseRow | null> {
  return await executor.select().from(schema.bridgeContinuationLeases)
    .where(eq(schema.bridgeContinuationLeases.taskId, taskId))
    .get() || null;
}

function safeMetadata(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, 'utf8') <= 16 * 1_024 ? serialized : null;
}

async function insertAuditEvent(
  executor: DbExecutor,
  input: {
    taskId: string;
    deliveryId?: string | null;
    eventType: string;
    fromStatus: BridgeContinuationTaskStatus | null;
    toStatus: BridgeContinuationTaskStatus;
    reason: BridgeContinuationTaskReason;
    metadata?: Record<string, unknown> | null;
    createdAt: string;
  },
): Promise<void> {
  await executor.insert(schema.bridgeContinuationEvents).values({
    taskId: input.taskId,
    deliveryId: input.deliveryId || null,
    eventType: input.eventType,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason,
    metadata: safeMetadata(input.metadata),
    createdAt: input.createdAt,
  }).run();
}

function stateStorageValues(state: BridgeContinuationTaskState, nowIso: string) {
  const terminal = !ACTIVE_TASK_STATUSES.has(state.status);
  return {
    activeSlot: terminal ? null : 1,
    status: state.status,
    reason: state.reason,
    continuationCount: state.continuationCount,
    nextRunAt: state.nextRunAtMs === null ? null : new Date(state.nextRunAtMs).toISOString(),
    threadStatus: state.threadStatus,
    activeFlags: JSON.stringify(state.activeFlags),
    activeTurnId: state.activeTurnId,
    lastFailureClass: state.lastFailure?.failureClass ?? null,
    lastFailureSource: state.lastFailure?.source ?? null,
    lastFailureRecoverability: state.lastFailure?.recoverability ?? null,
    lastCodexErrorCode: state.lastFailure?.codexErrorCode ?? null,
    lastHttpStatusCode: state.lastFailure?.httpStatusCode ?? null,
    lastMessageSummary: state.lastFailure?.messageSummary ?? null,
    lastMessageFingerprint: state.lastFailure?.messageFingerprint ?? null,
    lastWillRetry: state.lastFailure?.willRetry ?? null,
    lastFailureTurnTerminal: state.lastFailureTurnTerminal,
    retryAfterMs: state.retryAfterMs,
    pendingRouteAction: state.pendingRouteAction,
    pendingPrompt: state.pendingPrompt,
    pendingMethod: state.pendingMethod,
    stoppedAt: terminal ? nowIso : null,
    updatedAt: nowIso,
    stateVersion: sql`${schema.bridgeContinuationTasks.stateVersion} + 1`,
  };
}

async function persistTransition(
  executor: DbExecutor,
  row: BridgeTaskRow,
  next: BridgeContinuationTaskState,
  input: {
    deliveryId?: string | null;
    eventType: string;
    metadata?: Record<string, unknown> | null;
    now: Date;
  },
): Promise<BridgeTaskRow> {
  const nowIso = input.now.toISOString();
  const updated = await executor.update(schema.bridgeContinuationTasks).set(
    stateStorageValues(next, nowIso),
  ).where(and(
    eq(schema.bridgeContinuationTasks.id, row.id),
    eq(schema.bridgeContinuationTasks.stateVersion, row.stateVersion),
  )).run();
  if (affectedRows(updated) <= 0) throw new Error('Bridge continuation task changed concurrently');
  await insertAuditEvent(executor, {
    taskId: row.id,
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    fromStatus: normalizedTaskStatus(row.status),
    toStatus: next.status,
    reason: next.reason,
    metadata: input.metadata,
    createdAt: nowIso,
  });
  const refreshed = await loadTaskRow(executor, row.id);
  if (!refreshed) throw new Error('Bridge continuation task disappeared after transition');
  return refreshed;
}

async function loadTaskForDelivery(
  executor: DbExecutor,
  deliveryId: string,
  expectedTaskId: string,
): Promise<BridgeContinuationTaskRecord | null> {
  const event = await executor.select({ taskId: schema.bridgeContinuationEvents.taskId })
    .from(schema.bridgeContinuationEvents)
    .where(eq(schema.bridgeContinuationEvents.deliveryId, deliveryId))
    .get();
  if (!event) return null;
  if (event.taskId !== expectedTaskId) throw new Error('Bridge Delivery ID 已被其他任务使用');
  const row = await loadTaskRow(executor, expectedTaskId);
  if (!row) throw new Error('Bridge Delivery ID 对应任务不存在');
  return recordFromRows(row, await loadLeaseForTask(executor, expectedTaskId));
}

async function transitionById(
  taskIdInput: unknown,
  event: BridgeContinuationTaskEvent,
  input: {
    deliveryId?: unknown;
    eventType: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<BridgeContinuationTaskRecord> {
  const taskId = normalizedId(taskIdInput, 'Bridge 任务 ID');
  const deliveryId = normalizedDeliveryId(input.deliveryId);
  const now = normalizedNow(event.nowMs);
  try {
    return await db.transaction(async (tx: DbExecutor) => {
      if (deliveryId) {
        const existing = await loadTaskForDelivery(tx, deliveryId, taskId);
        if (existing) return existing;
      }
      const row = await loadTaskRow(tx, taskId);
      if (!row) throw new Error('Bridge continuation task not found');
      const current = stateFromRow(row);
      const next = transitionBridgeContinuationTask(current, { ...event, nowMs: now.getTime() } as BridgeContinuationTaskEvent);
      if (next === current) {
        if (deliveryId) {
          await insertAuditEvent(tx, {
            taskId,
            deliveryId,
            eventType: input.eventType,
            fromStatus: current.status,
            toStatus: current.status,
            reason: current.reason,
            metadata: { ...(input.metadata || {}), ignoredAsDuplicateState: true },
            createdAt: now.toISOString(),
          });
        }
        return recordFromRows(row, await loadLeaseForTask(tx, taskId));
      }
      const updated = await persistTransition(tx, row, next, { ...input, deliveryId, now });
      if (next.status !== 'running') {
        await tx.delete(schema.bridgeContinuationLeases)
          .where(eq(schema.bridgeContinuationLeases.taskId, taskId))
          .run();
      }
      return recordFromRows(updated, await loadLeaseForTask(tx, taskId));
    });
  } catch (error) {
    if (deliveryId && looksLikeUniqueCollision(error)) {
      const existing = await loadTaskForDelivery(db, deliveryId, taskId);
      if (existing) return existing;
    }
    throw error;
  }
}

async function validateDevice(deviceId: string | null): Promise<void> {
  if (!deviceId) return;
  const device = await db.select({
    id: schema.localConnectorDevices.id,
    scopes: schema.localConnectorDevices.scopes,
  })
    .from(schema.localConnectorDevices)
    .where(and(
      eq(schema.localConnectorDevices.id, deviceId),
      eq(schema.localConnectorDevices.status, 'active'),
    )).get();
  if (!device) throw new Error('Local Connector device is not active');
  let scopes: unknown = [];
  try {
    scopes = JSON.parse(device.scopes);
  } catch {
    scopes = [];
  }
  if (!Array.isArray(scopes) || !scopes.includes('app_server.control')) {
    throw new Error('Local Connector device lacks app_server.control scope');
  }
}

export async function getActiveBridgeContinuationTask(sessionKeyInput: unknown): Promise<BridgeContinuationTaskRecord | null> {
  const sessionKey = normalizedId(sessionKeyInput, 'Bridge 会话标识');
  const row = await db.select().from(schema.bridgeContinuationTasks).where(and(
    eq(schema.bridgeContinuationTasks.sessionKey, sessionKey),
    eq(schema.bridgeContinuationTasks.activeSlot, 1),
  )).get();
  if (!row) return null;
  return recordFromRows(row, await loadLeaseForTask(db, row.id));
}

export async function createBridgeContinuationTask(input: {
  sessionKey: unknown;
  threadId: unknown;
  deviceId?: unknown;
  policy?: BridgeContinuationPolicyInput;
  creationSource?: 'single' | 'global';
  now?: Date | number;
}): Promise<Readonly<{ created: boolean; task: BridgeContinuationTaskRecord }>> {
  const creationSource = input.creationSource === 'global' ? 'global' : 'single';
  if (creationSource === 'single') await assertSingleBridgeContinuationCreationAllowed();
  const sessionKey = normalizedId(input.sessionKey, 'Bridge 会话标识');
  const threadId = normalizedId(input.threadId, 'Codex Thread ID');
  const deviceId = input.deviceId == null ? null : normalizedId(input.deviceId, 'Connector 设备 ID');
  const existing = await getActiveBridgeContinuationTask(sessionKey);
  if (existing) return Object.freeze({ created: false, task: existing });
  await validateDevice(deviceId);
  const now = normalizedNow(input.now);
  const nowIso = now.toISOString();
  const policy = snapshotBridgeContinuationPolicy(input.policy || {}, now.getTime());
  const state = createBridgeContinuationTaskState({
    taskId: randomUUID(),
    sessionKey,
    threadId,
    policy,
    nowMs: now.getTime(),
  });

  try {
    const row = await db.transaction(async (tx: DbExecutor) => {
      if (creationSource === 'single') await assertSingleBridgeContinuationCreationAllowed(tx);
      await tx.insert(schema.bridgeContinuationTasks).values({
        id: state.taskId,
        deviceId,
        sessionKey,
        activeSlot: 1,
        threadId,
        taskKind: 'automatic',
        submissionMode: null,
        pendingMethod: null,
        requestedBy: creationSource === 'global' ? GLOBAL_BRIDGE_CONTINUATION_REQUESTED_BY : null,
        status: state.status,
        reason: state.reason,
        policySnapshot: JSON.stringify(policy),
        policyFingerprint: policy.fingerprint,
        continuationCount: 0,
        startedAt: nowIso,
        nextRunAt: null,
        threadStatus: state.threadStatus,
        activeFlags: '[]',
        lastFailureTurnTerminal: false,
        stateVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      await insertAuditEvent(tx, {
        taskId: state.taskId,
        eventType: 'task_created',
        fromStatus: null,
        toStatus: state.status,
        reason: state.reason,
        metadata: { policyFingerprint: policy.fingerprint, deviceId, creationSource },
        createdAt: nowIso,
      });
      const inserted = await loadTaskRow(tx, state.taskId);
      if (!inserted) throw new Error('Bridge continuation task was not inserted');
      return inserted;
    });
    return Object.freeze({ created: true, task: recordFromRows(row) });
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    const raced = await getActiveBridgeContinuationTask(sessionKey);
    if (!raced) throw error;
    return Object.freeze({ created: false, task: raced });
  }
}

export async function getBridgeContinuationTask(taskIdInput: unknown): Promise<BridgeContinuationTaskRecord | null> {
  const taskId = normalizedId(taskIdInput, 'Bridge 任务 ID');
  const row = await loadTaskRow(db, taskId);
  return row ? recordFromRows(row, await loadLeaseForTask(db, taskId)) : null;
}

async function requireTaskOwnedByDevice(taskId: string, deviceId: string): Promise<BridgeContinuationTaskRecord> {
  const task = await getBridgeContinuationTask(taskId);
  if (!task || task.deviceId !== deviceId) throw new Error('Bridge continuation task does not belong to this device');
  return task;
}

async function findActiveTaskForDeviceThread(
  deviceId: string,
  threadId: string,
): Promise<BridgeContinuationTaskRecord | null> {
  const row = await db.select().from(schema.bridgeContinuationTasks).where(and(
    eq(schema.bridgeContinuationTasks.deviceId, deviceId),
    eq(schema.bridgeContinuationTasks.threadId, threadId),
    eq(schema.bridgeContinuationTasks.activeSlot, 1),
  )).get();
  return row ? recordFromRows(row, await loadLeaseForTask(db, row.id)) : null;
}

async function loadLatestTaskForDeviceThread(deviceId: string, threadId: string): Promise<BridgeTaskRow | null> {
  return await db.select().from(schema.bridgeContinuationTasks).where(and(
    eq(schema.bridgeContinuationTasks.deviceId, deviceId),
    eq(schema.bridgeContinuationTasks.threadId, threadId),
  )).orderBy(desc(schema.bridgeContinuationTasks.updatedAt), desc(schema.bridgeContinuationTasks.createdAt)).get() || null;
}

export async function createManualBridgePromptTask(input: {
  contextTaskId?: unknown;
  deviceId?: unknown;
  threadId?: unknown;
  threadStatus?: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  activeTurnId?: unknown;
  prompt: unknown;
  submissionMode?: unknown;
  source: unknown;
  operatorId: unknown;
  sourceAdapterId?: unknown;
  idempotencyKey: unknown;
  now?: Date | number;
}): Promise<Readonly<{
  created: boolean;
  deduplicated: boolean;
  supersededTaskId: string | null;
  task: BridgeContinuationTaskRecord;
}>> {
  const prompt = normalizedManualPrompt(input.prompt);
  const submissionMode = normalizedManualPromptMode(input.submissionMode || 'auto');
  const source = normalizedRequestSource(input.source);
  const operatorId = normalizedId(input.operatorId, '人工 Prompt 操作者', 300);
  const sourceAdapterId = input.sourceAdapterId == null || input.sourceAdapterId === ''
    ? null
    : normalizedId(input.sourceAdapterId, 'Interaction Adapter ID', 128);
  const idempotencyKey = normalizedId(input.idempotencyKey, '人工 Prompt 幂等键', 256);
  const idempotencyKeyHash = hashNamespaced(MANUAL_PROMPT_IDEMPOTENCY_NAMESPACE, idempotencyKey);
  const promptFingerprint = hashNamespaced(MANUAL_PROMPT_FINGERPRINT_NAMESPACE, prompt);
  const explicitTaskId = input.contextTaskId == null || input.contextTaskId === ''
    ? null
    : normalizedId(input.contextTaskId, 'Bridge 上下文任务 ID');
  const explicitDeviceId = input.deviceId == null || input.deviceId === ''
    ? null
    : normalizedId(input.deviceId, 'Connector 设备 ID');
  const explicitThreadId = input.threadId == null || input.threadId === ''
    ? null
    : normalizedId(input.threadId, 'Codex Thread ID');
  const explicitSnapshot = input.threadStatus === undefined
    ? null
    : {
      threadStatus: THREAD_STATUSES.has(input.threadStatus)
        ? input.threadStatus
        : (() => { throw new Error('Codex 会话状态无效'); })(),
      activeFlags: Object.freeze([...(input.activeFlags || [])].filter(
        (flag): flag is CodexThreadActiveFlag => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
      )),
      activeTurnId: input.activeTurnId == null || input.activeTurnId === ''
        ? null
        : normalizedId(input.activeTurnId, 'Codex 活动 Turn ID'),
    };
  let contextRow = explicitTaskId ? await loadTaskRow(db, explicitTaskId) : null;
  if (explicitTaskId && !contextRow) throw new Error('Bridge 上下文任务不存在');
  if (!contextRow && explicitDeviceId && explicitThreadId) {
    contextRow = await loadLatestTaskForDeviceThread(explicitDeviceId, explicitThreadId);
  }
  if (contextRow && explicitDeviceId && contextRow.deviceId !== explicitDeviceId) throw new Error('Bridge 上下文设备不匹配');
  if (contextRow && explicitThreadId && contextRow.threadId !== explicitThreadId) throw new Error('Bridge 上下文 Thread 不匹配');
  if (!contextRow && (!explicitDeviceId || !explicitThreadId)) {
    throw new Error('没有可用于人工 Prompt 的 Bridge 上下文任务');
  }
  const context = contextRow
    ? {
      taskId: contextRow.id,
      deviceId: contextRow.deviceId,
      sessionKey: contextRow.sessionKey,
      threadId: contextRow.threadId,
      threadStatus: explicitSnapshot?.threadStatus || normalizedThreadStatus(contextRow.threadStatus),
      activeFlags: explicitSnapshot?.activeFlags || parseActiveFlags(contextRow.activeFlags),
      activeTurnId: explicitSnapshot ? explicitSnapshot.activeTurnId : contextRow.activeTurnId,
    }
    : {
      taskId: null,
      deviceId: explicitDeviceId,
      sessionKey: `${explicitDeviceId}:${explicitThreadId}`,
      threadId: explicitThreadId!,
      threadStatus: explicitSnapshot?.threadStatus || 'unknown' as const,
      activeFlags: explicitSnapshot?.activeFlags || Object.freeze([]),
      activeTurnId: explicitSnapshot?.activeTurnId || null,
    };
  await validateDevice(context.deviceId);
  const now = normalizedNow(input.now);
  const nowIso = now.toISOString();
  const policy = snapshotBridgeContinuationPolicy({ enabled: false, continuePrompt: '继续' }, now.getTime());
  const taskId = randomUUID();

  try {
    return await db.transaction(async (tx: DbExecutor) => {
      const existing = await tx.select().from(schema.bridgeContinuationTasks)
        .where(eq(schema.bridgeContinuationTasks.requestIdempotencyKeyHash, idempotencyKeyHash)).get();
      if (existing) {
        assertManualPromptIdempotencyMatch(existing, {
          sessionKey: context.sessionKey,
          threadId: context.threadId,
          deviceId: context.deviceId,
          submissionMode,
          source,
          operatorId,
          sourceAdapterId,
          promptFingerprint,
        });
        return Object.freeze({
          created: false,
          deduplicated: true,
          supersededTaskId: null,
          task: recordFromRows(existing, await loadLeaseForTask(tx, existing.id)),
        });
      }
      const active = await tx.select().from(schema.bridgeContinuationTasks).where(and(
        eq(schema.bridgeContinuationTasks.sessionKey, context.sessionKey),
        eq(schema.bridgeContinuationTasks.activeSlot, 1),
      )).get();
      const snapshotRow = active || (context.taskId ? await loadTaskRow(tx, context.taskId) : null) || contextRow;
      if (snapshotRow && (snapshotRow.threadId !== context.threadId || snapshotRow.deviceId !== context.deviceId)) {
        throw new Error('Bridge 会话的活动任务上下文不一致');
      }
      const supersededDispatchInFlight = active?.status === 'running';
      let supersededTaskId: string | null = null;
      if (active) {
        const current = stateFromRow(active);
        const superseded = transitionBridgeContinuationTask(current, {
          type: 'manual_prompt',
          nowMs: now.getTime(),
        });
        await persistTransition(tx, active, superseded, {
          eventType: 'manual_prompt_superseded',
          metadata: {
            source,
            operatorId,
            promptFingerprint,
            replacementTaskId: taskId,
            supersededDispatchInFlight,
          },
          now,
        });
        if (!supersededDispatchInFlight) {
          await tx.delete(schema.bridgeContinuationLeases)
            .where(eq(schema.bridgeContinuationLeases.taskId, active.id)).run();
        }
        supersededTaskId = active.id;
      }
      const snapshot = supersededDispatchInFlight
        ? { threadStatus: 'unknown' as const, activeFlags: Object.freeze([]), activeTurnId: null }
        : explicitSnapshot
          || (snapshotRow
          ? stateFromRow(snapshotRow)
          : {
            threadStatus: context.threadStatus,
            activeFlags: context.activeFlags,
            activeTurnId: context.activeTurnId,
          });
      const state = createManualBridgePromptTaskState({
        taskId,
        sessionKey: context.sessionKey,
        threadId: context.threadId,
        policy,
        submissionMode,
        prompt,
        threadStatus: snapshot.threadStatus,
        activeFlags: snapshot.activeFlags,
        activeTurnId: snapshot.activeTurnId,
        nowMs: now.getTime(),
      });
      await tx.insert(schema.bridgeContinuationTasks).values({
        id: state.taskId,
        deviceId: context.deviceId,
        sessionKey: state.sessionKey,
        activeSlot: 1,
        threadId: state.threadId,
        taskKind: 'manual_prompt',
        submissionMode,
        pendingMethod: state.pendingMethod,
        requestSource: source,
        requestedBy: operatorId,
        sourceAdapterId,
        requestIdempotencyKeyHash: idempotencyKeyHash,
        promptFingerprint,
        status: state.status,
        reason: state.reason,
        policySnapshot: JSON.stringify(policy),
        policyFingerprint: policy.fingerprint,
        continuationCount: 0,
        startedAt: nowIso,
        nextRunAt: state.nextRunAtMs === null ? null : new Date(state.nextRunAtMs).toISOString(),
        threadStatus: state.threadStatus,
        activeFlags: JSON.stringify(state.activeFlags),
        activeTurnId: state.activeTurnId,
        pendingRouteAction: state.pendingRouteAction,
        pendingPrompt: state.pendingPrompt,
        lastFailureTurnTerminal: false,
        stateVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      await insertAuditEvent(tx, {
        taskId: state.taskId,
        eventType: 'manual_prompt_created',
        fromStatus: null,
        toStatus: state.status,
        reason: state.reason,
        metadata: {
          source,
          operatorId,
          sourceAdapterId,
          submissionMode,
          promptFingerprint,
          supersededTaskId,
          supersededDispatchInFlight,
        },
        createdAt: nowIso,
      });
      const inserted = await loadTaskRow(tx, state.taskId);
      if (!inserted) throw new Error('人工 Prompt Bridge 任务创建失败');
      return Object.freeze({
        created: true,
        deduplicated: false,
        supersededTaskId,
        task: recordFromRows(inserted),
      });
    });
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    const existing = await db.select().from(schema.bridgeContinuationTasks)
      .where(eq(schema.bridgeContinuationTasks.requestIdempotencyKeyHash, idempotencyKeyHash)).get();
    if (!existing) throw error;
    assertManualPromptIdempotencyMatch(existing, {
      sessionKey: context.sessionKey,
      threadId: context.threadId,
      deviceId: context.deviceId,
      submissionMode,
      source,
      operatorId,
      sourceAdapterId,
      promptFingerprint,
    });
    return Object.freeze({
      created: false,
      deduplicated: true,
      supersededTaskId: null,
      task: recordFromRows(existing, await loadLeaseForTask(db, existing.id)),
    });
  }
}

export async function listBridgeContinuationTasks(input: {
  deviceId?: unknown;
  sessionKey?: unknown;
  status?: BridgeContinuationTaskStatus;
  limit?: number;
} = {}): Promise<BridgeContinuationTaskRecord[]> {
  const filters: SQL<unknown>[] = [];
  if (input.deviceId != null && input.deviceId !== '') {
    filters.push(eq(schema.bridgeContinuationTasks.deviceId, normalizedId(input.deviceId, 'Connector 设备 ID')));
  }
  if (input.sessionKey != null) {
    filters.push(eq(schema.bridgeContinuationTasks.sessionKey, normalizedId(input.sessionKey, 'Bridge 会话标识')));
  }
  if (input.status) {
    if (!TASK_STATUSES.has(input.status)) throw new Error('Bridge continuation status is invalid');
    filters.push(eq(schema.bridgeContinuationTasks.status, input.status));
  }
  const rows = await db.select().from(schema.bridgeContinuationTasks)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.bridgeContinuationTasks.createdAt), desc(schema.bridgeContinuationTasks.id))
    .limit(Math.min(200, Math.max(1, Math.trunc(input.limit || 50))))
    .all();
  return await Promise.all(rows.map(async (row) => recordFromRows(row, await loadLeaseForTask(db, row.id))));
}

export async function recordBridgeContinuationFailure(input: {
  taskId: unknown;
  deliveryId?: unknown;
  failure: BridgeFailureInput;
  threadStatus?: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  turnTerminal?: boolean;
  retryAfterMs?: number | null;
  jitterUnit?: number;
  now?: Date | number;
}): Promise<BridgeContinuationTaskRecord> {
  const failure = classifyBridgeFailure(input.failure);
  return transitionById(input.taskId, {
    type: 'failure_observed',
    failure,
    threadStatus: input.threadStatus,
    activeFlags: input.activeFlags,
    turnTerminal: input.turnTerminal,
    retryAfterMs: input.retryAfterMs,
    jitterUnit: input.jitterUnit,
    nowMs: normalizedNow(input.now).getTime(),
  }, {
    deliveryId: input.deliveryId,
    eventType: 'failure_observed',
    metadata: {
      failureClass: failure.failureClass,
      source: failure.source,
      codexErrorCode: failure.codexErrorCode,
      httpStatusCode: failure.httpStatusCode,
      messageFingerprint: failure.messageFingerprint,
      willRetry: failure.willRetry,
    },
  });
}

export async function recordBridgeThreadState(input: {
  taskId: unknown;
  deliveryId?: unknown;
  threadStatus: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  activeTurnId?: string | null;
  jitterUnit?: number;
  now?: Date | number;
}): Promise<BridgeContinuationTaskRecord> {
  return transitionById(input.taskId, {
    type: 'thread_state_changed',
    threadStatus: input.threadStatus,
    activeFlags: input.activeFlags,
    activeTurnId: input.activeTurnId,
    jitterUnit: input.jitterUnit,
    nowMs: normalizedNow(input.now).getTime(),
  }, {
    deliveryId: input.deliveryId,
    eventType: 'thread_state_changed',
    metadata: { threadStatus: input.threadStatus, activeFlags: input.activeFlags || [] },
  });
}

export async function recordBridgeTurnCompleted(input: {
  taskId: unknown;
  deliveryId?: unknown;
  turnId: unknown;
  status: 'completed' | 'interrupted' | 'failed';
  failure?: BridgeFailureInput;
  retryAfterMs?: number | null;
  jitterUnit?: number;
  now?: Date | number;
}): Promise<BridgeContinuationTaskRecord> {
  const failure = input.failure ? classifyBridgeFailure({ ...input.failure, source: 'turn_completed' }) : undefined;
  return transitionById(input.taskId, {
    type: 'turn_completed',
    turnId: normalizedId(input.turnId, 'Codex Turn ID'),
    status: input.status,
    failure,
    retryAfterMs: input.retryAfterMs,
    jitterUnit: input.jitterUnit,
    nowMs: normalizedNow(input.now).getTime(),
  }, {
    deliveryId: input.deliveryId,
    eventType: 'turn_completed',
    metadata: {
      turnId: normalizedId(input.turnId, 'Codex Turn ID'),
      status: input.status,
      failureClass: failure?.failureClass || null,
    },
  });
}

export async function recordBridgeTurnStarted(input: {
  taskId: unknown;
  deliveryId?: unknown;
  turnId: unknown;
  now?: Date | number;
}): Promise<BridgeContinuationTaskRecord> {
  const turnId = normalizedId(input.turnId, 'Codex Turn ID');
  return transitionById(input.taskId, {
    type: 'turn_started_observed',
    turnId,
    nowMs: normalizedNow(input.now).getTime(),
  }, {
    deliveryId: input.deliveryId,
    eventType: 'turn_started',
    metadata: { turnId },
  });
}

export async function stopBridgeContinuationTask(
  taskId: unknown,
  now?: Date | number,
): Promise<BridgeContinuationTaskRecord> {
  return transitionById(taskId, { type: 'manual_stop', nowMs: normalizedNow(now).getTime() }, { eventType: 'manual_stop' });
}

export async function supersedeBridgeContinuationTask(
  taskId: unknown,
  now?: Date | number,
): Promise<BridgeContinuationTaskRecord> {
  return transitionById(taskId, { type: 'manual_prompt', nowMs: normalizedNow(now).getTime() }, { eventType: 'manual_prompt' });
}

export async function stopBridgeContinuationTasksForDevice(
  deviceIdInput: unknown,
  now?: Date | number,
): Promise<number> {
  const deviceId = normalizedId(deviceIdInput, 'Connector 设备 ID');
  const rows = await db.select({ id: schema.bridgeContinuationTasks.id })
    .from(schema.bridgeContinuationTasks)
    .where(and(
      eq(schema.bridgeContinuationTasks.deviceId, deviceId),
      eq(schema.bridgeContinuationTasks.activeSlot, 1),
    )).all();
  let stopped = 0;
  for (const row of rows) {
    const result = await transitionById(row.id, {
      type: 'device_revoked',
      nowMs: normalizedNow(now).getTime(),
    }, { eventType: 'device_revoked' });
    if (result.state.reason === 'device_revoked') stopped += 1;
  }
  return stopped;
}

export async function recoverExpiredBridgeContinuationLeases(nowInput?: Date | number): Promise<number> {
  const now = normalizedNow(nowInput);
  const nowIso = now.toISOString();
  const expired = await db.select().from(schema.bridgeContinuationLeases)
    .where(lte(schema.bridgeContinuationLeases.expiresAt, nowIso))
    .orderBy(asc(schema.bridgeContinuationLeases.expiresAt))
    .limit(100)
    .all();
  let recovered = 0;
  for (const candidate of expired) {
    const didRecover = await db.transaction(async (tx: DbExecutor) => {
      const lease = await tx.select().from(schema.bridgeContinuationLeases).where(and(
        eq(schema.bridgeContinuationLeases.sessionKey, candidate.sessionKey),
        eq(schema.bridgeContinuationLeases.leaseTokenHash, candidate.leaseTokenHash),
        lte(schema.bridgeContinuationLeases.expiresAt, nowIso),
      )).get();
      if (!lease) return false;
      const row = await loadTaskRow(tx, lease.taskId);
      if (row && row.status === 'running') {
        const current = stateFromRow(row);
        const next = transitionBridgeContinuationTask(current, { type: 'lease_expired', nowMs: now.getTime() });
        await persistTransition(tx, row, next, {
          eventType: 'lease_expired',
          metadata: { outcome: 'dispatch_unknown', ownerId: lease.ownerId },
          now,
        });
      }
      await tx.delete(schema.bridgeContinuationLeases)
        .where(eq(schema.bridgeContinuationLeases.sessionKey, lease.sessionKey))
        .run();
      return true;
    });
    if (didRecover) recovered += 1;
  }
  return recovered;
}

export async function claimNextBridgeContinuationTask(input: {
  ownerId?: unknown;
  deviceId?: unknown;
  leaseTtlMs?: number;
  now?: Date | number;
} = {}): Promise<BridgeContinuationTaskClaim | null> {
  const now = normalizedNow(input.now);
  const nowIso = now.toISOString();
  const ownerId = input.ownerId == null
    ? buildLeaseOwner()
    : normalizedId(input.ownerId, 'Bridge Lease Owner');
  const deviceId = input.deviceId == null ? null : normalizedId(input.deviceId, 'Connector 设备 ID');
  const ttlMs = normalizedPositiveMs(input.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
  await recoverExpiredBridgeContinuationLeases(now);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = await db.select().from(schema.bridgeContinuationTasks).where(and(
      eq(schema.bridgeContinuationTasks.status, 'backoff'),
      eq(schema.bridgeContinuationTasks.activeSlot, 1),
      lte(schema.bridgeContinuationTasks.nextRunAt, nowIso),
      ...(deviceId ? [eq(schema.bridgeContinuationTasks.deviceId, deviceId)] : []),
    )).orderBy(asc(schema.bridgeContinuationTasks.nextRunAt), asc(schema.bridgeContinuationTasks.createdAt)).get();
    if (!candidate) return null;

    try {
      const claim = await db.transaction(async (tx: DbExecutor) => {
        const row = await loadTaskRow(tx, candidate.id);
        if (
          !row
          || row.status !== 'backoff'
          || row.activeSlot !== 1
          || !row.nextRunAt
          || row.nextRunAt > nowIso
          || (deviceId !== null && row.deviceId !== deviceId)
        ) {
          return null;
        }
        const leaseToken = `bcl_${randomBytes(32).toString('base64url')}`;
        const leaseTokenHash = hashLeaseToken(leaseToken);
        const expiresAtMs = now.getTime() + ttlMs;
        const expiresAt = new Date(expiresAtMs).toISOString();
        await tx.insert(schema.bridgeContinuationLeases).values({
          sessionKey: row.sessionKey,
          taskId: row.id,
          ownerId,
          leaseTokenHash,
          expiresAt,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).run();
        const lease: BridgeContinuationLease = Object.freeze({
          sessionKey: row.sessionKey,
          ownerId,
          leaseToken,
          acquiredAtMs: now.getTime(),
          expiresAtMs,
        });
        const current = stateFromRow(row);
        const next = transitionBridgeContinuationTask(current, {
          type: 'lease_acquired',
          lease,
          nowMs: now.getTime(),
        });
        const updated = await persistTransition(tx, row, next, {
          eventType: 'lease_acquired',
          metadata: { ownerId, expiresAt },
          now,
        });
        const task = recordFromRows(updated, {
          sessionKey: row.sessionKey,
          taskId: row.id,
          ownerId,
          leaseTokenHash,
          expiresAt,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
        return Object.freeze({
          task,
          leaseToken,
          leaseExpiresAt: expiresAt,
          command: Object.freeze({
            method: next.pendingMethod || 'turn/start',
            threadId: row.threadId,
            ...(next.pendingMethod === 'turn/steer' && next.activeTurnId
              ? { expectedTurnId: next.activeTurnId }
              : {}),
            prompt: next.pendingPrompt || next.policy.continuePrompt,
            routeAction: next.pendingRouteAction || 'preserve',
            continuationNumber: next.continuationCount + 1,
          }),
        });
      });
      if (claim) return claim;
    } catch (error) {
      if (!looksLikeUniqueCollision(error)) throw error;
    }
  }
  return null;
}

export async function renewBridgeContinuationTaskLease(input: {
  taskId: unknown;
  leaseToken: unknown;
  deviceId?: unknown;
  leaseTtlMs?: number;
  now?: Date | number;
}): Promise<Readonly<{ renewed: boolean; expiresAt: string | null }>> {
  const taskId = normalizedId(input.taskId, 'Bridge 任务 ID');
  const leaseToken = normalizedId(input.leaseToken, 'Bridge Lease Token');
  const deviceId = input.deviceId == null ? null : normalizedId(input.deviceId, 'Connector 设备 ID');
  if (deviceId) await requireTaskOwnedByDevice(taskId, deviceId);
  const now = normalizedNow(input.now);
  const expiresAt = new Date(
    now.getTime() + normalizedPositiveMs(input.leaseTtlMs, DEFAULT_LEASE_TTL_MS),
  ).toISOString();
  const updated = await db.update(schema.bridgeContinuationLeases).set({
    expiresAt,
    updatedAt: now.toISOString(),
  }).where(and(
    eq(schema.bridgeContinuationLeases.taskId, taskId),
    eq(schema.bridgeContinuationLeases.leaseTokenHash, hashLeaseToken(leaseToken)),
    gt(schema.bridgeContinuationLeases.expiresAt, now.toISOString()),
  )).run();
  return Object.freeze({ renewed: affectedRows(updated) > 0, expiresAt: affectedRows(updated) > 0 ? expiresAt : null });
}

export async function completeBridgeContinuationDispatch(input: {
  taskId: unknown;
  deliveryId?: unknown;
  leaseToken: unknown;
  deviceId?: unknown;
  outcome: 'accepted' | 'rejected' | 'unknown';
  turnId?: unknown;
  failure?: BridgeFailureInput;
  threadStatus?: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  retryAfterMs?: number | null;
  jitterUnit?: number;
  now?: Date | number;
}): Promise<Readonly<{
  updated: boolean;
  reason: 'accepted' | 'rejected' | 'unknown' | 'missing_or_expired';
  task: BridgeContinuationTaskRecord | null;
}>> {
  const taskId = normalizedId(input.taskId, 'Bridge 任务 ID');
  const deliveryId = normalizedDeliveryId(input.deliveryId);
  const leaseToken = normalizedId(input.leaseToken, 'Bridge Lease Token');
  const deviceId = input.deviceId == null ? null : normalizedId(input.deviceId, 'Connector 设备 ID');
  if (deviceId) await requireTaskOwnedByDevice(taskId, deviceId);
  const leaseTokenHash = hashLeaseToken(leaseToken);
  const now = normalizedNow(input.now);
  const nowIso = now.toISOString();
  const turnId = input.outcome === 'accepted' ? normalizedId(input.turnId, 'Codex Turn ID') : null;
  const rejectedFailure = input.outcome === 'rejected'
    ? classifyBridgeFailure({ ...(input.failure || {}), source: 'control_error', willRetry: false })
    : null;

  try {
    return await db.transaction(async (tx: DbExecutor) => {
      if (deliveryId) {
        const existing = await loadTaskForDelivery(tx, deliveryId, taskId);
        if (existing) {
          return Object.freeze({ updated: true, reason: input.outcome, task: existing });
        }
      }
      const leaseRow = await tx.select().from(schema.bridgeContinuationLeases).where(and(
      eq(schema.bridgeContinuationLeases.taskId, taskId),
      eq(schema.bridgeContinuationLeases.leaseTokenHash, leaseTokenHash),
      )).get();
      if (!leaseRow || leaseRow.expiresAt <= nowIso) {
        const currentRow = await loadTaskRow(tx, taskId);
        const currentTask = currentRow ? recordFromRows(currentRow, leaseRow || null) : null;
        if (
          currentTask
          && input.outcome === 'accepted'
          && currentTask.state.reason === 'turn_active'
          && currentTask.state.activeTurnId === turnId
        ) {
          return Object.freeze({ updated: true, reason: 'accepted' as const, task: currentTask });
        }
        if (currentTask && input.outcome === 'unknown' && currentTask.state.reason === 'dispatch_outcome_unknown') {
          return Object.freeze({ updated: true, reason: 'unknown' as const, task: currentTask });
        }
        return Object.freeze({
          updated: false,
          reason: 'missing_or_expired' as const,
          task: currentTask,
        });
      }
      const row = await loadTaskRow(tx, taskId);
      if (!row) return Object.freeze({ updated: false, reason: 'missing_or_expired' as const, task: null });
      const lease: BridgeContinuationLease = Object.freeze({
        sessionKey: leaseRow.sessionKey,
        ownerId: leaseRow.ownerId,
        leaseToken,
        acquiredAtMs: parseTimestamp(leaseRow.createdAt, now.getTime()),
        expiresAtMs: parseTimestamp(leaseRow.expiresAt, now.getTime()),
      });
      const current = stateFromRow(row, lease);
      const writerContentionDeferred = input.outcome === 'rejected'
        && current.taskKind === 'manual_prompt'
        && Boolean(current.pendingPrompt)
        && isBridgeWriterContentionFailure(rejectedFailure!);
      const event: BridgeContinuationTaskEvent = input.outcome === 'accepted'
        ? { type: 'continuation_dispatched', leaseToken, turnId: turnId!, nowMs: now.getTime() }
        : input.outcome === 'rejected'
          ? {
            type: 'dispatch_rejected',
            leaseToken,
            failure: rejectedFailure!,
            threadStatus: input.threadStatus,
            activeFlags: input.activeFlags,
            retryAfterMs: input.retryAfterMs,
            jitterUnit: input.jitterUnit,
            nowMs: now.getTime(),
          }
          : { type: 'dispatch_outcome_unknown', leaseToken, nowMs: now.getTime() };
      const next = transitionBridgeContinuationTask(current, event);
      const updated = await persistTransition(tx, row, next, {
        deliveryId,
        eventType: input.outcome === 'accepted'
          ? 'continuation_dispatched'
          : input.outcome === 'rejected'
            ? writerContentionDeferred ? 'dispatch_deferred' : 'dispatch_rejected'
            : 'dispatch_outcome_unknown',
        metadata: input.outcome === 'accepted'
          ? { turnId, method: current.pendingMethod || 'turn/start', taskKind: current.taskKind }
          : input.outcome === 'rejected'
            ? {
              failureClass: rejectedFailure?.failureClass,
              codexErrorCode: rejectedFailure?.codexErrorCode,
              httpStatusCode: rejectedFailure?.httpStatusCode,
              deferred: writerContentionDeferred,
              nextRunAt: writerContentionDeferred && next.nextRunAtMs !== null
                ? new Date(next.nextRunAtMs).toISOString()
                : null,
            }
            : { outcome: 'dispatch_unknown' },
        now,
      });
      await tx.delete(schema.bridgeContinuationLeases)
        .where(and(
          eq(schema.bridgeContinuationLeases.taskId, taskId),
          eq(schema.bridgeContinuationLeases.leaseTokenHash, leaseTokenHash),
        )).run();
      return Object.freeze({
        updated: true,
        reason: input.outcome,
        task: recordFromRows(updated),
      });
    });
  } catch (error) {
    if (deliveryId && looksLikeUniqueCollision(error)) {
      const existing = await loadTaskForDelivery(db, deliveryId, taskId);
      if (existing) return Object.freeze({ updated: true, reason: input.outcome, task: existing });
    }
    throw error;
  }
}

export async function recordBridgeContinuationAppServerEvent(input: {
  taskId?: unknown;
  deliveryId?: unknown;
  deviceId: unknown;
  event: BridgeContinuationAppServerEvent;
  now?: Date | number;
}): Promise<BridgeContinuationTaskRecord> {
  const deviceId = normalizedId(input.deviceId, 'Connector 设备 ID');
  const threadId = normalizedId(input.event.threadId, 'Codex Thread ID');
  await recordLocalConnectorThreadEvent({
    deviceId,
    event: input.event,
    now: input.now,
  });
  const task = input.taskId == null
    ? await findActiveTaskForDeviceThread(deviceId, threadId)
    : await requireTaskOwnedByDevice(normalizedId(input.taskId, 'Bridge 任务 ID'), deviceId);
  if (!task) throw new Error('No active bridge continuation task for this App Server thread');
  const taskId = task.state.taskId;
  if (threadId !== task.state.threadId) {
    throw new Error('App Server event thread does not match the bridge task');
  }
  if (input.event.kind === 'thread_status') {
    return recordBridgeThreadState({
      taskId,
      deliveryId: input.deliveryId,
      threadStatus: input.event.status,
      activeFlags: input.event.activeFlags,
      now: input.now,
    });
  }
  if (input.event.kind === 'turn_started') {
    const pendingManualPrompt = task.state.taskKind === 'manual_prompt' && Boolean(task.state.pendingPrompt);
    if (
      !pendingManualPrompt
      && task.state.status !== 'running'
      && task.state.reason !== 'dispatch_outcome_unknown'
      && task.state.reason !== 'turn_active'
    ) {
      return supersedeBridgeContinuationTask(taskId, input.now);
    }
    return recordBridgeTurnStarted({
      taskId,
      deliveryId: input.deliveryId,
      turnId: input.event.turnId,
      now: input.now,
    });
  }
  if (input.event.kind === 'turn_completed') {
    return recordBridgeTurnCompleted({
      taskId,
      deliveryId: input.deliveryId,
      turnId: input.event.turnId,
      status: input.event.status,
      failure: input.event.failure || undefined,
      now: input.now,
    });
  }
  return recordBridgeContinuationFailure({
    taskId,
    deliveryId: input.deliveryId,
    failure: input.event.failure,
    threadStatus: task.state.threadStatus,
    activeFlags: task.state.activeFlags,
    now: input.now,
  });
}

export async function listBridgeContinuationEvents(taskIdInput: unknown, limit = 100) {
  const taskId = normalizedId(taskIdInput, 'Bridge 任务 ID');
  return await db.select().from(schema.bridgeContinuationEvents)
    .where(eq(schema.bridgeContinuationEvents.taskId, taskId))
    .orderBy(desc(schema.bridgeContinuationEvents.id))
    .limit(Math.min(500, Math.max(1, Math.trunc(limit))))
    .all();
}
