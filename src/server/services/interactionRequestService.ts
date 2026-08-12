import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  INTERACTION_REQUEST_KINDS,
  createInteractionRequestState,
  transitionInteractionRequest,
  type InteractionRequestEvent,
  type InteractionRequestKind,
  type InteractionRequestReason,
  type InteractionRequestState,
  type InteractionRequestStatus,
  type InteractionResponseSource,
} from './interactionRequestState.js';

type DbExecutor = typeof db;
type InteractionRow = typeof schema.interactionRequests.$inferSelect;

const ACTIVE_STATUSES: InteractionRequestStatus[] = ['pending', 'response_pending'];
const REQUEST_STATUSES = new Set<InteractionRequestStatus>([
  'pending',
  'response_pending',
  'resolved',
  'cancelled',
  'expired',
]);
const RESPONSE_SOURCES = new Set<InteractionResponseSource>(['webui', 'im', 'signed_link']);
const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export type InteractionRequestRecord = Readonly<{
  state: InteractionRequestState;
  requestPayload: Readonly<Record<string, unknown>>;
  requestFingerprint: string;
  responseFingerprint: string | null;
  stateVersion: number;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export type InteractionEventActorKind = 'connector' | 'admin' | 'im_operator' | 'signed_link' | 'system';

function normalizedId(value: unknown, label: string, maximum = 256): string {
  const normalized = typeof value === 'number' && Number.isFinite(value)
    ? String(Math.trunc(value))
    : typeof value === 'string'
      ? value.trim()
      : '';
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) throw new Error(`${label}无效`);
  return normalized;
}

function normalizedOptionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizedId(value, label);
}

function normalizedNow(value: Date | number | undefined): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(Math.max(0, Math.trunc(value)));
  return new Date();
}

function normalizedTtl(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(1_000, parsed));
}

function hashValue(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex');
}

function sourceRequestKey(deviceId: string, connectionId: string, sourceRequestId: string): string {
  return hashValue('interaction-source', `${deviceId}\0${connectionId}\0${sourceRequestId}`);
}

function parseTimestamp(value: string | null | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
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

function normalizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error('Interaction payload 嵌套过深');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 2_000) throw new Error('Interaction payload 数组过大');
    return value.map((item) => normalizeJsonValue(item, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new Error('Interaction payload 包含不支持的值');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 500) throw new Error('Interaction payload 字段过多');
  const normalized: Record<string, unknown> = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!key || key.length > 256 || key.includes('\0') || item === undefined) continue;
    normalized[key] = normalizeJsonValue(item, depth + 1);
  }
  return normalized;
}

function normalizePayload(
  value: unknown,
  label: string,
  maximumBytes: number,
): { value: Readonly<Record<string, unknown>>; serialized: string; fingerprint: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON 对象`);
  const normalized = normalizeJsonValue(value) as Record<string, unknown>;
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw new Error(`${label}超过大小限制`);
  return {
    value: Object.freeze(normalized),
    serialized,
    fingerprint: hashValue('interaction-payload', serialized),
  };
}

function parseStoredPayload(value: string, label: string): Readonly<Record<string, unknown>> {
  try {
    return normalizePayload(JSON.parse(value), label, label === 'Interaction 请求' ? MAX_REQUEST_BYTES : MAX_RESPONSE_BYTES).value;
  } catch {
    throw new Error(`${label}快照损坏`);
  }
}

function normalizedStatus(value: string): InteractionRequestStatus {
  if (!REQUEST_STATUSES.has(value as InteractionRequestStatus)) throw new Error(`Unknown interaction status: ${value}`);
  return value as InteractionRequestStatus;
}

function stateFromRow(row: InteractionRow): InteractionRequestState {
  const createdAtMs = parseTimestamp(row.createdAt, Date.now());
  const updatedAtMs = parseTimestamp(row.updatedAt, createdAtMs);
  const responseSource = RESPONSE_SOURCES.has(row.responseSource as InteractionResponseSource)
    ? row.responseSource as InteractionResponseSource
    : null;
  return Object.freeze({
    requestId: row.id,
    sourceRequestKey: row.sourceRequestKey,
    kind: row.kind as InteractionRequestKind,
    method: row.method,
    deviceId: row.deviceId,
    connectionId: row.connectionId,
    sourceRequestId: row.sourceRequestId,
    threadId: row.threadId,
    turnId: row.turnId,
    itemId: row.itemId,
    status: normalizedStatus(row.status),
    reason: row.reason as InteractionRequestReason,
    responsePayload: row.responsePayload ? parseStoredPayload(row.responsePayload, 'Interaction 响应') : null,
    responseSource,
    responseOperatorId: row.responseOperatorId,
    responseIdempotencyKeyHash: row.responseIdempotencyKeyHash,
    responseCommittedAtMs: row.responseCommittedAt ? parseTimestamp(row.responseCommittedAt, updatedAtMs) : null,
    responseDeliveryCount: Math.max(0, Math.trunc(row.responseDeliveryCount)),
    responseDeliveredAtMs: row.responseDeliveredAt ? parseTimestamp(row.responseDeliveredAt, updatedAtMs) : null,
    resolvedAtMs: row.resolvedAt ? parseTimestamp(row.resolvedAt, updatedAtMs) : null,
    cancelledAtMs: row.cancelledAt ? parseTimestamp(row.cancelledAt, updatedAtMs) : null,
    expiresAtMs: parseTimestamp(row.expiresAt, updatedAtMs),
    createdAtMs,
    updatedAtMs,
  });
}

function recordFromRow(row: InteractionRow): InteractionRequestRecord {
  return Object.freeze({
    state: stateFromRow(row),
    requestPayload: parseStoredPayload(row.requestPayload, 'Interaction 请求'),
    requestFingerprint: row.requestFingerprint,
    responseFingerprint: row.responseFingerprint,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function safeMetadata(value: Record<string, unknown> | null | undefined): string | null {
  if (!value) return null;
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized, 'utf8') <= 16 * 1024 ? serialized : null;
}

async function insertEvent(executor: DbExecutor, input: {
  interactionId: string;
  deliveryId?: string | null;
  eventType: string;
  fromStatus: InteractionRequestStatus | null;
  toStatus: InteractionRequestStatus;
  actorKind: InteractionEventActorKind;
  actorId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}): Promise<void> {
  await executor.insert(schema.interactionEvents).values({
    interactionId: input.interactionId,
    deliveryId: input.deliveryId || null,
    eventType: input.eventType,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorKind: input.actorKind,
    actorId: input.actorId || null,
    metadata: safeMetadata(input.metadata),
    createdAt: input.createdAt,
  }).run();
}

function stateStorageValues(state: InteractionRequestState, nowIso: string) {
  const responseSerialized = state.responsePayload ? JSON.stringify(state.responsePayload) : null;
  return {
    status: state.status,
    reason: state.reason,
    responsePayload: responseSerialized,
    responseFingerprint: responseSerialized ? hashValue('interaction-payload', responseSerialized) : null,
    responseSource: state.responseSource,
    responseOperatorId: state.responseOperatorId,
    responseIdempotencyKeyHash: state.responseIdempotencyKeyHash,
    responseCommittedAt: state.responseCommittedAtMs === null ? null : new Date(state.responseCommittedAtMs).toISOString(),
    responseDeliveryCount: state.responseDeliveryCount,
    responseDeliveredAt: state.responseDeliveredAtMs === null ? null : new Date(state.responseDeliveredAtMs).toISOString(),
    resolvedAt: state.resolvedAtMs === null ? null : new Date(state.resolvedAtMs).toISOString(),
    cancelledAt: state.cancelledAtMs === null ? null : new Date(state.cancelledAtMs).toISOString(),
    updatedAt: nowIso,
    stateVersion: sql`${schema.interactionRequests.stateVersion} + 1`,
  };
}

async function loadRow(executor: DbExecutor, requestId: string): Promise<InteractionRow | null> {
  return await executor.select().from(schema.interactionRequests)
    .where(eq(schema.interactionRequests.id, requestId)).get() || null;
}

async function loadDeliveryRecord(
  executor: DbExecutor,
  deliveryId: string,
  expectedRequestId: string,
): Promise<InteractionRequestRecord | null> {
  const event = await executor.select({ interactionId: schema.interactionEvents.interactionId })
    .from(schema.interactionEvents)
    .where(eq(schema.interactionEvents.deliveryId, deliveryId))
    .get();
  if (!event) return null;
  if (event.interactionId !== expectedRequestId) throw new Error('Interaction deliveryId 已被其他请求使用');
  const row = await loadRow(executor, expectedRequestId);
  if (!row) throw new Error('Interaction deliveryId 对应请求不存在');
  return recordFromRow(row);
}

async function persistTransition(executor: DbExecutor, row: InteractionRow, next: InteractionRequestState, input: {
  eventType: string;
  actorKind: InteractionEventActorKind;
  actorId?: string | null;
  deliveryId?: string | null;
  metadata?: Record<string, unknown> | null;
  now: Date;
}): Promise<InteractionRow> {
  const nowIso = input.now.toISOString();
  const updated = await executor.update(schema.interactionRequests)
    .set(stateStorageValues(next, nowIso))
    .where(and(
      eq(schema.interactionRequests.id, row.id),
      eq(schema.interactionRequests.stateVersion, row.stateVersion),
    )).run();
  if (affectedRows(updated) <= 0) throw new Error('Interaction request changed concurrently');
  await insertEvent(executor, {
    interactionId: row.id,
    deliveryId: input.deliveryId,
    eventType: input.eventType,
    fromStatus: normalizedStatus(row.status),
    toStatus: next.status,
    actorKind: input.actorKind,
    actorId: input.actorId,
    metadata: input.metadata,
    createdAt: nowIso,
  });
  const refreshed = await loadRow(executor, row.id);
  if (!refreshed) throw new Error('Interaction request disappeared after transition');
  return refreshed;
}

async function validateDevice(deviceId: string): Promise<void> {
  const row = await db.select({ status: schema.localConnectorDevices.status, scopes: schema.localConnectorDevices.scopes })
    .from(schema.localConnectorDevices)
    .where(eq(schema.localConnectorDevices.id, deviceId))
    .get();
  if (!row || row.status !== 'active') throw new Error('Local Connector device is not active');
  let scopes: unknown = [];
  try {
    scopes = JSON.parse(row.scopes);
  } catch {
    scopes = [];
  }
  if (!Array.isArray(scopes) || !scopes.includes('app_server.control')) {
    throw new Error('Local Connector device lacks app_server.control scope');
  }
}

export async function createInteractionRequest(input: {
  deviceId: unknown;
  connectionId: unknown;
  sourceRequestId: unknown;
  kind: InteractionRequestKind;
  method: unknown;
  threadId?: unknown;
  turnId?: unknown;
  itemId?: unknown;
  requestPayload: unknown;
  ttlMs?: number;
  now?: Date | number;
}): Promise<Readonly<{ created: boolean; request: InteractionRequestRecord }>> {
  const deviceId = normalizedId(input.deviceId, 'Connector 设备 ID');
  const connectionId = normalizedId(input.connectionId, 'App Server 连接 ID');
  const sourceRequestId = normalizedId(input.sourceRequestId, 'App Server Request ID');
  const method = normalizedId(input.method, 'App Server 方法', 160);
  if (!INTERACTION_REQUEST_KINDS.includes(input.kind)) throw new Error('Interaction kind 无效');
  await validateDevice(deviceId);
  const payload = normalizePayload(input.requestPayload, 'Interaction 请求', MAX_REQUEST_BYTES);
  const requestFingerprint = hashValue('interaction-request', `${input.kind}\0${method}\0${payload.serialized}`);
  const key = sourceRequestKey(deviceId, connectionId, sourceRequestId);
  const existing = await db.select().from(schema.interactionRequests)
    .where(eq(schema.interactionRequests.sourceRequestKey, key)).get();
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new Error('App Server Request ID 发生内容冲突');
    return Object.freeze({ created: false, request: recordFromRow(existing) });
  }
  const now = normalizedNow(input.now);
  const expiresAt = new Date(now.getTime() + normalizedTtl(input.ttlMs));
  const state = createInteractionRequestState({
    requestId: randomUUID(),
    sourceRequestKey: key,
    kind: input.kind,
    method,
    deviceId,
    connectionId,
    sourceRequestId,
    threadId: normalizedOptionalId(input.threadId, 'Codex Thread ID'),
    turnId: normalizedOptionalId(input.turnId, 'Codex Turn ID'),
    itemId: normalizedOptionalId(input.itemId, 'Codex Item ID'),
    expiresAtMs: expiresAt.getTime(),
    nowMs: now.getTime(),
  });
  const nowIso = now.toISOString();

  try {
    const row = await db.transaction(async (tx: DbExecutor) => {
      await tx.insert(schema.interactionRequests).values({
        id: state.requestId,
        deviceId,
        sourceRequestKey: key,
        connectionId,
        sourceRequestId,
        kind: state.kind,
        method,
        threadId: state.threadId,
        turnId: state.turnId,
        itemId: state.itemId,
        requestPayload: payload.serialized,
        requestFingerprint,
        status: state.status,
        reason: state.reason,
        responseDeliveryCount: 0,
        expiresAt: expiresAt.toISOString(),
        stateVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      await insertEvent(tx, {
        interactionId: state.requestId,
        eventType: 'request_created',
        fromStatus: null,
        toStatus: state.status,
        actorKind: 'connector',
        actorId: deviceId,
        metadata: { method, kind: state.kind, requestFingerprint },
        createdAt: nowIso,
      });
      const inserted = await loadRow(tx, state.requestId);
      if (!inserted) throw new Error('Interaction request was not inserted');
      return inserted;
    });
    return Object.freeze({ created: true, request: recordFromRow(row) });
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    const raced = await db.select().from(schema.interactionRequests)
      .where(eq(schema.interactionRequests.sourceRequestKey, key)).get();
    if (!raced || raced.requestFingerprint !== requestFingerprint) throw error;
    return Object.freeze({ created: false, request: recordFromRow(raced) });
  }
}

export async function getInteractionRequest(requestIdInput: unknown): Promise<InteractionRequestRecord | null> {
  const requestId = normalizedId(requestIdInput, 'Interaction Request ID');
  const row = await loadRow(db, requestId);
  return row ? recordFromRow(row) : null;
}

export async function listInteractionRequests(input: {
  deviceId?: unknown;
  threadId?: unknown;
  kind?: InteractionRequestKind;
  status?: InteractionRequestStatus;
  limit?: number;
} = {}): Promise<InteractionRequestRecord[]> {
  await expireInteractionRequests();
  const filters: SQL<unknown>[] = [];
  if (input.deviceId != null) filters.push(eq(schema.interactionRequests.deviceId, normalizedId(input.deviceId, 'Connector 设备 ID')));
  if (input.threadId != null) filters.push(eq(schema.interactionRequests.threadId, normalizedId(input.threadId, 'Codex Thread ID')));
  if (input.kind) {
    if (!INTERACTION_REQUEST_KINDS.includes(input.kind)) throw new Error('Interaction kind 无效');
    filters.push(eq(schema.interactionRequests.kind, input.kind));
  }
  if (input.status) {
    if (!REQUEST_STATUSES.has(input.status)) throw new Error('Interaction status 无效');
    filters.push(eq(schema.interactionRequests.status, input.status));
  }
  const rows = await db.select().from(schema.interactionRequests)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(schema.interactionRequests.createdAt), desc(schema.interactionRequests.id))
    .limit(Math.min(200, Math.max(1, Math.trunc(input.limit || 50))))
    .all();
  return rows.map(recordFromRow);
}

export type CommitInteractionResponseInput = {
  requestId: unknown;
  responsePayload: unknown;
  source: InteractionResponseSource;
  operatorId: unknown;
  idempotencyKey: unknown;
  now?: Date | number;
};

export async function commitInteractionResponseWithExecutor(
  executor: DbExecutor,
  input: CommitInteractionResponseInput,
): Promise<Readonly<{
  deduplicated: boolean;
  request: InteractionRequestRecord;
  expired: boolean;
}>> {
  const requestId = normalizedId(input.requestId, 'Interaction Request ID');
  if (!RESPONSE_SOURCES.has(input.source)) throw new Error('Interaction response source 无效');
  const operatorId = normalizedId(input.operatorId, 'Interaction Operator ID');
  const idempotencyKey = normalizedId(input.idempotencyKey, 'Interaction 幂等键', 256);
  const idempotencyKeyHash = hashValue('interaction-response-idempotency', idempotencyKey);
  const payload = normalizePayload(input.responsePayload, 'Interaction 响应', MAX_RESPONSE_BYTES);
  const now = normalizedNow(input.now);

  const row = await loadRow(executor, requestId);
  if (!row) throw new Error('Interaction request 不存在');
  if (row.responseIdempotencyKeyHash) {
    if (row.responseIdempotencyKeyHash !== idempotencyKeyHash || row.responseFingerprint !== payload.fingerprint) {
      throw new Error('Interaction response 已由其他响应占用');
    }
    return Object.freeze({ deduplicated: true, request: recordFromRow(row), expired: false });
  }
  const current = stateFromRow(row);
  const next = transitionInteractionRequest(current, {
    type: 'operator_response',
    responsePayload: payload.value,
    source: input.source,
    operatorId,
    idempotencyKeyHash,
    nowMs: now.getTime(),
  });
  const expired = next.status === 'expired';
  const updated = await persistTransition(executor, row, next, {
    eventType: expired ? 'request_expired' : 'response_committed',
    actorKind: input.source === 'webui' ? 'admin' : input.source === 'im' ? 'im_operator' : 'signed_link',
    actorId: operatorId,
    metadata: expired
      ? null
      : { responseFingerprint: payload.fingerprint, responseSource: input.source },
    now,
  });
  return Object.freeze({ deduplicated: false, request: recordFromRow(updated), expired });
}

export async function commitInteractionResponse(
  input: CommitInteractionResponseInput,
): Promise<Readonly<{ deduplicated: boolean; request: InteractionRequestRecord }>> {
  const result = await db.transaction(async (tx: DbExecutor) => {
    return await commitInteractionResponseWithExecutor(tx, input);
  });
  if (result.expired) throw new Error('Interaction request 已过期');
  return Object.freeze({ deduplicated: result.deduplicated, request: result.request });
}

export async function claimInteractionResponse(input: {
  requestId: unknown;
  deviceId: unknown;
  deliveryId: unknown;
  now?: Date | number;
}): Promise<Readonly<{
  ready: boolean;
  responsePayload: Readonly<Record<string, unknown>> | null;
  request: InteractionRequestRecord;
}>> {
  const requestId = normalizedId(input.requestId, 'Interaction Request ID');
  const deviceId = normalizedId(input.deviceId, 'Connector 设备 ID');
  const deliveryId = normalizedId(input.deliveryId, 'Interaction Delivery ID', 128);
  const now = normalizedNow(input.now);
  try {
    return await db.transaction(async (tx: DbExecutor) => {
      const duplicate = await loadDeliveryRecord(tx, deliveryId, requestId);
      if (duplicate) {
        const ready = duplicate.state.status === 'response_pending' && duplicate.state.responsePayload !== null;
        return Object.freeze({ ready, responsePayload: ready ? duplicate.state.responsePayload : null, request: duplicate });
      }
      const row = await loadRow(tx, requestId);
      if (!row || row.deviceId !== deviceId) throw new Error('Interaction request 不属于此设备');
      const current = stateFromRow(row);
      if (current.status !== 'response_pending') {
        if (ACTIVE_STATUSES.includes(current.status) && now.getTime() >= current.expiresAtMs) {
          const expired = transitionInteractionRequest(current, { type: 'expire', nowMs: now.getTime() });
          const updated = await persistTransition(tx, row, expired, {
            eventType: 'request_expired',
            actorKind: 'system',
            now,
          });
          return Object.freeze({ ready: false, responsePayload: null, request: recordFromRow(updated) });
        }
        return Object.freeze({ ready: false, responsePayload: null, request: recordFromRow(row) });
      }
      const next = transitionInteractionRequest(current, { type: 'response_delivered', nowMs: now.getTime() });
      const updated = await persistTransition(tx, row, next, {
        eventType: 'response_delivered',
        actorKind: 'connector',
        actorId: deviceId,
        deliveryId,
        metadata: { deliveryCount: next.responseDeliveryCount },
        now,
      });
      return Object.freeze({ ready: true, responsePayload: next.responsePayload, request: recordFromRow(updated) });
    });
  } catch (error) {
    if (looksLikeUniqueCollision(error)) {
      const duplicate = await loadDeliveryRecord(db, deliveryId, requestId);
      if (duplicate) {
        const ready = duplicate.state.status === 'response_pending' && duplicate.state.responsePayload !== null;
        return Object.freeze({ ready, responsePayload: ready ? duplicate.state.responsePayload : null, request: duplicate });
      }
    }
    throw error;
  }
}

export async function resolveInteractionSource(input: {
  requestId: unknown;
  deviceId: unknown;
  deliveryId: unknown;
  now?: Date | number;
}): Promise<InteractionRequestRecord> {
  const requestId = normalizedId(input.requestId, 'Interaction Request ID');
  const deviceId = normalizedId(input.deviceId, 'Connector 设备 ID');
  const deliveryId = normalizedId(input.deliveryId, 'Interaction Delivery ID', 128);
  const now = normalizedNow(input.now);
  try {
    return await db.transaction(async (tx: DbExecutor) => {
      const duplicate = await loadDeliveryRecord(tx, deliveryId, requestId);
      if (duplicate) return duplicate;
      const row = await loadRow(tx, requestId);
      if (!row || row.deviceId !== deviceId) throw new Error('Interaction request 不属于此设备');
      const current = stateFromRow(row);
      const next = transitionInteractionRequest(current, { type: 'source_resolved', nowMs: now.getTime() });
      if (next === current) {
        await insertEvent(tx, {
          interactionId: requestId,
          deliveryId,
          eventType: 'source_resolved',
          fromStatus: current.status,
          toStatus: current.status,
          actorKind: 'connector',
          actorId: deviceId,
          metadata: { ignoredAsTerminal: true },
          createdAt: now.toISOString(),
        });
        return recordFromRow(row);
      }
      const updated = await persistTransition(tx, row, next, {
        eventType: 'source_resolved',
        actorKind: 'connector',
        actorId: deviceId,
        deliveryId,
        now,
      });
      return recordFromRow(updated);
    });
  } catch (error) {
    if (looksLikeUniqueCollision(error)) {
      const duplicate = await loadDeliveryRecord(db, deliveryId, requestId);
      if (duplicate) return duplicate;
    }
    throw error;
  }
}

export async function cancelInteractionRequest(
  requestIdInput: unknown,
  operatorIdInput: unknown,
  nowInput?: Date | number,
): Promise<InteractionRequestRecord> {
  const requestId = normalizedId(requestIdInput, 'Interaction Request ID');
  const operatorId = normalizedId(operatorIdInput, 'Interaction Operator ID');
  const now = normalizedNow(nowInput);
  return await db.transaction(async (tx: DbExecutor) => {
    const row = await loadRow(tx, requestId);
    if (!row) throw new Error('Interaction request 不存在');
    const current = stateFromRow(row);
    const next = transitionInteractionRequest(current, { type: 'manual_cancel', nowMs: now.getTime() });
    if (next === current) return recordFromRow(row);
    return recordFromRow(await persistTransition(tx, row, next, {
      eventType: 'manual_cancel',
      actorKind: 'admin',
      actorId: operatorId,
      now,
    }));
  });
}

export async function expireInteractionRequests(nowInput?: Date | number): Promise<number> {
  const now = normalizedNow(nowInput);
  const rows = await db.select({ id: schema.interactionRequests.id })
    .from(schema.interactionRequests)
    .where(and(
      inArray(schema.interactionRequests.status, ACTIVE_STATUSES),
      lte(schema.interactionRequests.expiresAt, now.toISOString()),
    ))
    .orderBy(asc(schema.interactionRequests.expiresAt))
    .limit(100)
    .all();
  let expired = 0;
  for (const candidate of rows) {
    const changed = await db.transaction(async (tx: DbExecutor) => {
      const row = await loadRow(tx, candidate.id);
      if (!row || !ACTIVE_STATUSES.includes(normalizedStatus(row.status)) || row.expiresAt > now.toISOString()) return false;
      const current = stateFromRow(row);
      const next = transitionInteractionRequest(current, { type: 'expire', nowMs: now.getTime() });
      await persistTransition(tx, row, next, { eventType: 'request_expired', actorKind: 'system', now });
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

export async function cancelInteractionRequestsForDevice(
  deviceIdInput: unknown,
  nowInput?: Date | number,
): Promise<number> {
  const deviceId = normalizedId(deviceIdInput, 'Connector 设备 ID');
  const now = normalizedNow(nowInput);
  const rows = await db.select({ id: schema.interactionRequests.id })
    .from(schema.interactionRequests)
    .where(and(
      eq(schema.interactionRequests.deviceId, deviceId),
      inArray(schema.interactionRequests.status, ACTIVE_STATUSES),
    )).all();
  let cancelled = 0;
  for (const candidate of rows) {
    const changed = await db.transaction(async (tx: DbExecutor) => {
      const row = await loadRow(tx, candidate.id);
      if (!row || !ACTIVE_STATUSES.includes(normalizedStatus(row.status))) return false;
      const next = transitionInteractionRequest(stateFromRow(row), { type: 'device_revoked', nowMs: now.getTime() });
      await persistTransition(tx, row, next, {
        eventType: 'device_revoked',
        actorKind: 'system',
        actorId: deviceId,
        now,
      });
      return true;
    });
    if (changed) cancelled += 1;
  }
  return cancelled;
}

export async function listInteractionEvents(requestIdInput: unknown, limit = 100) {
  const requestId = normalizedId(requestIdInput, 'Interaction Request ID');
  return await db.select().from(schema.interactionEvents)
    .where(eq(schema.interactionEvents.interactionId, requestId))
    .orderBy(desc(schema.interactionEvents.id))
    .limit(Math.min(500, Math.max(1, Math.trunc(limit))))
    .all();
}
