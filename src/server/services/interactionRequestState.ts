export const INTERACTION_REQUEST_KINDS = [
  'command_approval',
  'file_change_approval',
  'permissions_approval',
  'user_input',
  'mcp_elicitation',
] as const;

export type InteractionRequestKind = typeof INTERACTION_REQUEST_KINDS[number];

export type InteractionRequestStatus =
  | 'pending'
  | 'response_pending'
  | 'resolved'
  | 'cancelled'
  | 'expired';

export type InteractionRequestReason =
  | 'awaiting_operator'
  | 'response_committed'
  | 'source_resolved'
  | 'source_cleared'
  | 'manual_cancel'
  | 'device_revoked'
  | 'expired';

export type InteractionResponseSource = 'webui' | 'im' | 'signed_link';

export type InteractionRequestState = Readonly<{
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
  reason: InteractionRequestReason;
  responsePayload: Readonly<Record<string, unknown>> | null;
  responseSource: InteractionResponseSource | null;
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
}>;

export type InteractionRequestEvent =
  | Readonly<{
    type: 'operator_response';
    responsePayload: Record<string, unknown>;
    source: InteractionResponseSource;
    operatorId: string;
    idempotencyKeyHash: string;
    nowMs?: number;
  }>
  | Readonly<{ type: 'response_delivered'; nowMs?: number }>
  | Readonly<{ type: 'source_resolved'; nowMs?: number }>
  | Readonly<{ type: 'manual_cancel'; nowMs?: number }>
  | Readonly<{ type: 'device_revoked'; nowMs?: number }>
  | Readonly<{ type: 'expire'; nowMs?: number }>;

function normalizedId(value: unknown, label: string, maximum = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`Invalid interaction ${label}`);
  }
  return normalized;
}

function normalizedOptionalId(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  return normalizedId(value, label);
}

function normalizedNow(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : Date.now();
}

function frozenPayload(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid interaction response payload');
  }
  return Object.freeze({ ...value });
}

function freezeState(state: InteractionRequestState): InteractionRequestState {
  return Object.freeze({ ...state });
}

function isTerminal(status: InteractionRequestStatus): boolean {
  return status === 'resolved' || status === 'cancelled' || status === 'expired';
}

function expireState(state: InteractionRequestState, nowMs: number): InteractionRequestState {
  return freezeState({
    ...state,
    status: 'expired',
    reason: 'expired',
    updatedAtMs: nowMs,
    cancelledAtMs: nowMs,
  });
}

export function createInteractionRequestState(input: {
  requestId: string;
  sourceRequestKey: string;
  kind: InteractionRequestKind;
  method: string;
  deviceId: string;
  connectionId: string;
  sourceRequestId: string;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  expiresAtMs: number;
  nowMs?: number;
}): InteractionRequestState {
  const nowMs = normalizedNow(input.nowMs);
  const expiresAtMs = Math.trunc(Number(input.expiresAtMs));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error('Invalid interaction expiry');
  }
  if (!INTERACTION_REQUEST_KINDS.includes(input.kind)) {
    throw new Error('Invalid interaction kind');
  }
  return freezeState({
    requestId: normalizedId(input.requestId, 'request id'),
    sourceRequestKey: normalizedId(input.sourceRequestKey, 'source request key', 128),
    kind: input.kind,
    method: normalizedId(input.method, 'method', 160),
    deviceId: normalizedId(input.deviceId, 'device id'),
    connectionId: normalizedId(input.connectionId, 'connection id'),
    sourceRequestId: normalizedId(input.sourceRequestId, 'source request id'),
    threadId: normalizedOptionalId(input.threadId, 'thread id'),
    turnId: normalizedOptionalId(input.turnId, 'turn id'),
    itemId: normalizedOptionalId(input.itemId, 'item id'),
    status: 'pending',
    reason: 'awaiting_operator',
    responsePayload: null,
    responseSource: null,
    responseOperatorId: null,
    responseIdempotencyKeyHash: null,
    responseCommittedAtMs: null,
    responseDeliveryCount: 0,
    responseDeliveredAtMs: null,
    resolvedAtMs: null,
    cancelledAtMs: null,
    expiresAtMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

export function transitionInteractionRequest(
  state: InteractionRequestState,
  event: InteractionRequestEvent,
): InteractionRequestState {
  if (isTerminal(state.status)) return state;
  const nowMs = normalizedNow(event.nowMs);
  if (event.type === 'expire' || nowMs >= state.expiresAtMs) return expireState(state, nowMs);

  if (event.type === 'operator_response') {
    if (state.status !== 'pending') throw new Error('Interaction request already has a response');
    return freezeState({
      ...state,
      status: 'response_pending',
      reason: 'response_committed',
      responsePayload: frozenPayload(event.responsePayload),
      responseSource: event.source,
      responseOperatorId: normalizedId(event.operatorId, 'operator id'),
      responseIdempotencyKeyHash: normalizedId(event.idempotencyKeyHash, 'idempotency key hash', 128),
      responseCommittedAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (event.type === 'response_delivered') {
    if (state.status !== 'response_pending') {
      throw new Error('Interaction response is not ready for delivery');
    }
    return freezeState({
      ...state,
      responseDeliveryCount: state.responseDeliveryCount + 1,
      responseDeliveredAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  if (event.type === 'source_resolved') {
    if (state.status === 'response_pending') {
      return freezeState({
        ...state,
        status: 'resolved',
        reason: 'source_resolved',
        resolvedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    return freezeState({
      ...state,
      status: 'cancelled',
      reason: 'source_cleared',
      cancelledAtMs: nowMs,
      updatedAtMs: nowMs,
    });
  }

  const reason: InteractionRequestReason = event.type === 'device_revoked'
    ? 'device_revoked'
    : 'manual_cancel';
  return freezeState({
    ...state,
    status: 'cancelled',
    reason,
    cancelledAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

