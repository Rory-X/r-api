import {
  evaluateBridgeContinuation,
  isBridgeWriterContentionFailure,
  resolveBridgeTurnSubmission,
  type BridgeContinuationPolicySnapshot,
  type BridgeContinuationWaitReason,
  type BridgeRouteAction,
  type ClassifiedBridgeFailure,
  type CodexThreadActiveFlag,
  type CodexThreadStatus,
} from './bridgeContinuationContract.js';
import type { BridgeContinuationLease } from './bridgeContinuationLease.js';

const DEFAULT_WRITER_CONTENTION_RETRY_MS = 5_000;

export type BridgeContinuationTaskStatus =
  | 'waiting'
  | 'backoff'
  | 'running'
  | 'stopped'
  | 'superseded'
  | 'dead';

export type BridgeContinuationTaskKind = 'automatic' | 'manual_prompt';
export type BridgeManualPromptSubmissionMode = 'auto' | 'steer_current' | 'start_next';
export type BridgeTurnSubmissionMethod = 'turn/start' | 'turn/steer';

export type BridgeContinuationTaskReason =
  | 'awaiting_failure'
  | 'awaiting_final_failure'
  | 'backoff'
  | 'running'
  | 'connector_queued'
  | 'turn_active'
  | 'dispatch_outcome_unknown'
  | 'interaction_response_required'
  | 'active_turn_id_unknown'
  | 'active_turn_not_steerable'
  | BridgeContinuationWaitReason
  | 'policy_disabled'
  | 'policy_stop'
  | 'unrecoverable_failure'
  | 'attempt_limit'
  | 'elapsed_limit'
  | 'turn_completed'
  | 'turn_interrupted'
  | 'manual_stop'
  | 'manual_prompt'
  | 'approval_denied'
  | 'thread_archived'
  | 'device_revoked';

export type BridgeContinuationTaskState = Readonly<{
  taskId: string;
  sessionKey: string;
  threadId: string;
  taskKind: BridgeContinuationTaskKind;
  submissionMode: BridgeManualPromptSubmissionMode | null;
  status: BridgeContinuationTaskStatus;
  reason: BridgeContinuationTaskReason;
  policy: BridgeContinuationPolicySnapshot;
  continuationCount: number;
  startedAtMs: number;
  updatedAtMs: number;
  nextRunAtMs: number | null;
  threadStatus: CodexThreadStatus;
  activeFlags: readonly CodexThreadActiveFlag[];
  activeTurnId: string | null;
  lastFailure: ClassifiedBridgeFailure | null;
  lastFailureTurnTerminal: boolean;
  retryAfterMs: number | null;
  pendingRouteAction: BridgeRouteAction | null;
  pendingPrompt: string | null;
  pendingMethod: BridgeTurnSubmissionMethod | null;
  lease: BridgeContinuationLease | null;
}>;

export type BridgeContinuationTaskEvent =
  | {
    type: 'failure_observed';
    failure: ClassifiedBridgeFailure;
    threadStatus?: CodexThreadStatus;
    activeFlags?: readonly CodexThreadActiveFlag[];
    turnTerminal?: boolean;
    retryAfterMs?: number | null;
    jitterUnit?: number;
    nowMs?: number;
  }
  | {
    type: 'thread_state_changed';
    threadStatus: CodexThreadStatus;
    activeFlags?: readonly CodexThreadActiveFlag[];
    activeTurnId?: string | null;
    jitterUnit?: number;
    nowMs?: number;
  }
  | { type: 'lease_acquired'; lease: BridgeContinuationLease; nowMs?: number }
  | { type: 'dispatch_queued'; leaseToken: string; nowMs?: number }
  | { type: 'continuation_dispatched'; leaseToken: string; turnId: string; nowMs?: number }
  | { type: 'turn_started_observed'; turnId: string; nowMs?: number }
  | {
    type: 'dispatch_rejected';
    leaseToken: string;
    failure: ClassifiedBridgeFailure;
    threadStatus?: CodexThreadStatus;
    activeFlags?: readonly CodexThreadActiveFlag[];
    retryAfterMs?: number | null;
    jitterUnit?: number;
    nowMs?: number;
  }
  | { type: 'dispatch_outcome_unknown'; leaseToken: string; nowMs?: number }
  | { type: 'lease_expired'; nowMs?: number }
  | {
    type: 'turn_completed';
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
    failure?: ClassifiedBridgeFailure;
    retryAfterMs?: number | null;
    jitterUnit?: number;
    nowMs?: number;
  }
  | { type: 'manual_prompt'; nowMs?: number }
  | { type: 'manual_stop'; nowMs?: number }
  | { type: 'approval_denied'; nowMs?: number }
  | { type: 'thread_archived'; nowMs?: number }
  | { type: 'device_revoked'; nowMs?: number };

function normalizedId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes('\0')) {
    throw new Error(`Invalid bridge continuation ${label}`);
  }
  return normalized;
}

function normalizedNow(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : Date.now();
}

function normalizeFlags(flags: readonly CodexThreadActiveFlag[] | undefined): readonly CodexThreadActiveFlag[] {
  return Object.freeze([...new Set(flags || [])]);
}

function freezeState(state: BridgeContinuationTaskState): BridgeContinuationTaskState {
  return Object.freeze({ ...state, activeFlags: normalizeFlags(state.activeFlags) });
}

function isTerminal(status: BridgeContinuationTaskStatus): boolean {
  return status === 'stopped' || status === 'superseded' || status === 'dead';
}

export function createBridgeContinuationTaskState(input: {
  taskId: string;
  sessionKey: string;
  threadId: string;
  policy: BridgeContinuationPolicySnapshot;
  continuationCount?: number;
  nowMs?: number;
}): BridgeContinuationTaskState {
  const nowMs = normalizedNow(input.nowMs);
  return freezeState({
    taskId: normalizedId(input.taskId, 'task id'),
    sessionKey: normalizedId(input.sessionKey, 'session key'),
    threadId: normalizedId(input.threadId, 'thread id'),
    taskKind: 'automatic',
    submissionMode: null,
    status: 'waiting',
    reason: 'awaiting_failure',
    policy: input.policy,
    continuationCount: Math.max(0, Math.trunc(input.continuationCount || 0)),
    startedAtMs: nowMs,
    updatedAtMs: nowMs,
    nextRunAtMs: null,
    threadStatus: 'unknown',
    activeFlags: Object.freeze([]),
    activeTurnId: null,
    lastFailure: null,
    lastFailureTurnTerminal: false,
    retryAfterMs: null,
    pendingRouteAction: null,
    pendingPrompt: null,
    pendingMethod: null,
    lease: null,
  });
}

function normalizedPrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || prompt.length > 4_000 || prompt.includes('\0')) throw new Error('Invalid bridge manual prompt');
  return prompt;
}

function advanceManualPrompt(
  state: BridgeContinuationTaskState,
  nowMs: number,
): BridgeContinuationTaskState {
  if (state.taskKind !== 'manual_prompt' || !state.pendingPrompt || !state.submissionMode) return state;
  if (state.activeFlags.length > 0) {
    return freezeState({
      ...state,
      status: 'waiting',
      reason: 'interaction_response_required',
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      pendingMethod: null,
      lease: null,
    });
  }
  if (state.submissionMode === 'start_next') {
    if (state.threadStatus === 'active') {
      return freezeState({
        ...state,
        status: 'waiting',
        reason: 'turn_active',
        updatedAtMs: nowMs,
        nextRunAtMs: null,
        pendingMethod: 'turn/start',
        lease: null,
      });
    }
    if (state.threadStatus !== 'idle' && state.threadStatus !== 'not_loaded') {
      return freezeState({
        ...state,
        status: 'waiting',
        reason: 'thread_not_ready',
        updatedAtMs: nowMs,
        nextRunAtMs: null,
        pendingMethod: 'turn/start',
        lease: null,
      });
    }
    return freezeState({
      ...state,
      status: 'backoff',
      reason: 'backoff',
      updatedAtMs: nowMs,
      nextRunAtMs: nowMs,
      pendingRouteAction: 'preserve',
      pendingMethod: 'turn/start',
      lease: null,
    });
  }
  if (state.submissionMode === 'steer_current') {
    if (state.threadStatus !== 'active') {
      return freezeState({
        ...state,
        status: 'waiting',
        reason: state.threadStatus === 'idle' ? 'active_turn_not_steerable' : 'thread_not_ready',
        updatedAtMs: nowMs,
        nextRunAtMs: null,
        pendingMethod: 'turn/steer',
        lease: null,
      });
    }
    if (!state.activeTurnId) {
      return freezeState({
        ...state,
        status: 'waiting',
        reason: 'active_turn_id_unknown',
        updatedAtMs: nowMs,
        nextRunAtMs: null,
        pendingMethod: 'turn/steer',
        lease: null,
      });
    }
    return freezeState({
      ...state,
      status: 'backoff',
      reason: 'backoff',
      updatedAtMs: nowMs,
      nextRunAtMs: nowMs,
      pendingRouteAction: 'preserve',
      pendingMethod: 'turn/steer',
      lease: null,
    });
  }
  const decision = resolveBridgeTurnSubmission({
    source: 'manual',
    threadId: state.threadId,
    prompt: state.pendingPrompt,
    threadStatus: state.threadStatus,
    activeFlags: state.activeFlags,
    activeTurnId: state.activeTurnId,
    activeTurnSteerable: true,
  });
  if (decision.kind === 'wait') {
    return freezeState({
      ...state,
      status: 'waiting',
      reason: decision.reason,
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      pendingMethod: null,
      lease: null,
    });
  }
  return freezeState({
    ...state,
    status: 'backoff',
    reason: 'backoff',
    updatedAtMs: nowMs,
    nextRunAtMs: nowMs,
    pendingRouteAction: 'preserve',
    pendingMethod: decision.method,
    activeTurnId: decision.expectedTurnId || state.activeTurnId,
    lease: null,
  });
}

export function createManualBridgePromptTaskState(input: {
  taskId: string;
  sessionKey: string;
  threadId: string;
  policy: BridgeContinuationPolicySnapshot;
  submissionMode: BridgeManualPromptSubmissionMode;
  prompt: string;
  threadStatus: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  activeTurnId?: string | null;
  nowMs?: number;
}): BridgeContinuationTaskState {
  const nowMs = normalizedNow(input.nowMs);
  const state = freezeState({
    ...createBridgeContinuationTaskState({
      taskId: input.taskId,
      sessionKey: input.sessionKey,
      threadId: input.threadId,
      policy: input.policy,
      nowMs,
    }),
    taskKind: 'manual_prompt' as const,
    submissionMode: input.submissionMode,
    threadStatus: input.threadStatus,
    activeFlags: normalizeFlags(input.activeFlags),
    activeTurnId: input.activeTurnId?.trim() || null,
    pendingRouteAction: 'preserve' as const,
    pendingPrompt: normalizedPrompt(input.prompt),
  });
  return advanceManualPrompt(state, nowMs);
}

function applyFailureDecision(
  state: BridgeContinuationTaskState,
  input: { nowMs: number; jitterUnit?: number },
): BridgeContinuationTaskState {
  if (!state.lastFailure) return state;
  const decision = evaluateBridgeContinuation({
    policy: state.policy,
    failure: state.lastFailure,
    continuationCount: state.continuationCount,
    taskStartedAtMs: state.startedAtMs,
    nowMs: input.nowMs,
    retryAfterMs: state.retryAfterMs,
    jitterUnit: input.jitterUnit,
    threadStatus: state.threadStatus,
    activeFlags: state.activeFlags,
    turnTerminal: state.lastFailureTurnTerminal,
  });
  if (decision.kind === 'schedule') {
    return freezeState({
      ...state,
      status: 'backoff',
      reason: 'backoff',
      updatedAtMs: input.nowMs,
      nextRunAtMs: decision.nextRunAtMs,
      pendingRouteAction: decision.routeAction,
      pendingPrompt: decision.prompt,
      pendingMethod: 'turn/start',
      lease: null,
    });
  }
  if (decision.kind === 'wait') {
    return freezeState({
      ...state,
      status: 'waiting',
      reason: decision.reason,
      updatedAtMs: input.nowMs,
      nextRunAtMs: null,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  }
  if (decision.kind === 'stop') {
    return freezeState({
      ...state,
      status: 'stopped',
      reason: decision.reason,
      updatedAtMs: input.nowMs,
      nextRunAtMs: null,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  }
  return freezeState({
    ...state,
    status: 'dead',
    reason: decision.reason,
    updatedAtMs: input.nowMs,
    nextRunAtMs: null,
    pendingRouteAction: null,
    pendingPrompt: null,
    pendingMethod: null,
    lease: null,
  });
}

function stopState(
  state: BridgeContinuationTaskState,
  status: 'stopped' | 'superseded',
  reason: BridgeContinuationTaskReason,
  nowMs: number,
): BridgeContinuationTaskState {
  return freezeState({
    ...state,
    status,
    reason,
    updatedAtMs: nowMs,
    nextRunAtMs: null,
    pendingRouteAction: null,
    pendingPrompt: null,
    pendingMethod: null,
    lease: null,
  });
}

export function transitionBridgeContinuationTask(
  state: BridgeContinuationTaskState,
  event: BridgeContinuationTaskEvent,
): BridgeContinuationTaskState {
  if (isTerminal(state.status)) return state;
  const nowMs = normalizedNow(event.nowMs);

  if (event.type === 'manual_prompt') return stopState(state, 'superseded', 'manual_prompt', nowMs);
  if (event.type === 'manual_stop') return stopState(state, 'stopped', 'manual_stop', nowMs);
  if (event.type === 'approval_denied') return stopState(state, 'stopped', 'approval_denied', nowMs);
  if (event.type === 'thread_archived') return stopState(state, 'stopped', 'thread_archived', nowMs);
  if (event.type === 'device_revoked') return stopState(state, 'stopped', 'device_revoked', nowMs);

  if (event.type === 'failure_observed') {
    const withFailure = freezeState({
      ...state,
      lastFailure: event.failure,
      lastFailureTurnTerminal: event.turnTerminal === true || event.failure.source === 'turn_completed',
      retryAfterMs: Number.isFinite(event.retryAfterMs)
        ? Math.max(0, Math.trunc(event.retryAfterMs as number))
        : null,
      threadStatus: event.threadStatus || state.threadStatus,
      activeFlags: normalizeFlags(event.activeFlags ?? state.activeFlags),
      updatedAtMs: nowMs,
    });
    return applyFailureDecision(withFailure, { nowMs, jitterUnit: event.jitterUnit });
  }

  if (event.type === 'thread_state_changed') {
    const updated = freezeState({
      ...state,
      threadStatus: event.threadStatus,
      activeFlags: normalizeFlags(event.activeFlags),
      activeTurnId: event.activeTurnId === undefined ? state.activeTurnId : event.activeTurnId,
      updatedAtMs: nowMs,
    });
    if (updated.reason === 'connector_queued') return updated;
    if (updated.taskKind === 'manual_prompt' && updated.pendingPrompt) {
      return advanceManualPrompt(updated, nowMs);
    }
    if (
      state.status === 'running'
      || state.reason === 'dispatch_outcome_unknown'
      || state.reason === 'awaiting_final_failure'
      || !updated.lastFailure
    ) return updated;
    if (state.status === 'backoff' && updated.threadStatus === 'idle' && updated.activeFlags.length === 0) {
      return updated;
    }
    return applyFailureDecision(updated, { nowMs, jitterUnit: event.jitterUnit });
  }

  if (event.type === 'lease_acquired') {
    if (state.status !== 'backoff') throw new Error(`Cannot run bridge continuation task from ${state.status}`);
    if (state.nextRunAtMs === null || nowMs < state.nextRunAtMs) {
      throw new Error('Bridge continuation backoff has not elapsed');
    }
    if (event.lease.sessionKey !== state.sessionKey || event.lease.expiresAtMs <= nowMs) {
      throw new Error('Bridge continuation lease is invalid for this task');
    }
    return freezeState({
      ...state,
      status: 'running',
      reason: 'running',
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      lease: event.lease,
    });
  }

  if (event.type === 'dispatch_queued') {
    if (state.status !== 'running' || !state.lease || state.lease.leaseToken !== event.leaseToken) {
      throw new Error('Bridge queued dispatch requires the active lease');
    }
    return freezeState({
      ...state,
      status: 'waiting',
      reason: 'connector_queued',
      updatedAtMs: nowMs,
      nextRunAtMs: null,
    });
  }

  if (event.type === 'continuation_dispatched') {
    const dispatchable = state.status === 'running'
      || (state.status === 'waiting' && state.reason === 'connector_queued');
    if (!dispatchable || !state.lease || state.lease.leaseToken !== event.leaseToken) {
      throw new Error('Bridge continuation dispatch requires the active lease');
    }
    return freezeState({
      ...state,
      status: 'waiting',
      reason: 'turn_active',
      continuationCount: state.continuationCount + 1,
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      threadStatus: 'active',
      activeTurnId: normalizedId(event.turnId, 'turn id'),
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  }

  if (event.type === 'turn_started_observed') {
    const turnId = normalizedId(event.turnId, 'turn id');
    if (state.reason === 'connector_queued') {
      return freezeState({
        ...state,
        threadStatus: 'active',
        activeFlags: Object.freeze([]),
        activeTurnId: turnId,
        updatedAtMs: nowMs,
      });
    }
    if (state.taskKind === 'manual_prompt' && state.pendingPrompt && state.status !== 'running') {
      return advanceManualPrompt(freezeState({
        ...state,
        threadStatus: 'active',
        activeFlags: Object.freeze([]),
        activeTurnId: turnId,
        updatedAtMs: nowMs,
        nextRunAtMs: null,
        lease: null,
      }), nowMs);
    }
    if (state.status === 'waiting' && state.reason === 'turn_active' && state.activeTurnId === turnId) {
      return state;
    }
    if (state.status !== 'running' && state.reason !== 'dispatch_outcome_unknown') return state;
    return freezeState({
      ...state,
      status: 'waiting',
      reason: 'turn_active',
      continuationCount: state.continuationCount + 1,
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      threadStatus: 'active',
      activeTurnId: turnId,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  }

  if (event.type === 'dispatch_rejected') {
    const dispatchable = state.status === 'running'
      || (state.status === 'waiting' && state.reason === 'connector_queued');
    if (!dispatchable || !state.lease || state.lease.leaseToken !== event.leaseToken) {
      throw new Error('Bridge continuation rejected dispatch requires the active lease');
    }
    const writerContention = state.taskKind === 'manual_prompt'
      && Boolean(state.pendingPrompt)
      && isBridgeWriterContentionFailure(event.failure);
    const retryAfterMs = Number.isFinite(event.retryAfterMs)
      ? Math.max(0, Math.trunc(event.retryAfterMs as number))
      : writerContention
        ? DEFAULT_WRITER_CONTENTION_RETRY_MS
        : null;
    const withFailure = freezeState({
      ...state,
      lastFailure: event.failure,
      lastFailureTurnTerminal: !writerContention,
      retryAfterMs,
      threadStatus: event.threadStatus || state.threadStatus,
      activeFlags: normalizeFlags(event.activeFlags),
      updatedAtMs: nowMs,
      lease: null,
    });
    if (writerContention) {
      return freezeState({
        ...withFailure,
        status: 'backoff',
        reason: 'backoff',
        nextRunAtMs: nowMs + retryAfterMs!,
        pendingRouteAction: state.pendingRouteAction || 'preserve',
        pendingPrompt: state.pendingPrompt,
        pendingMethod: state.pendingMethod || 'turn/start',
      });
    }
    return applyFailureDecision(withFailure, { nowMs, jitterUnit: event.jitterUnit });
  }

  if (event.type === 'dispatch_outcome_unknown') {
    const dispatchable = state.status === 'running'
      || (state.status === 'waiting' && state.reason === 'connector_queued');
    if (!dispatchable || !state.lease || state.lease.leaseToken !== event.leaseToken) {
      throw new Error('Bridge continuation unknown dispatch requires the active lease');
    }
    return freezeState({
      ...state,
      status: 'waiting',
      reason: 'dispatch_outcome_unknown',
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  }

  if (event.type === 'lease_expired') {
    if (state.reason === 'connector_queued' && state.pendingPrompt && state.pendingMethod) {
      return freezeState({
        ...state,
        status: 'backoff',
        reason: 'backoff',
        updatedAtMs: nowMs,
        nextRunAtMs: nowMs,
        lease: null,
      });
    }
    if (state.status !== 'running') return state;
    return freezeState({
      ...state,
      status: 'waiting',
      reason: 'dispatch_outcome_unknown',
      updatedAtMs: nowMs,
      nextRunAtMs: null,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  }

  if (event.type === 'turn_completed') {
    if (state.reason === 'connector_queued') {
      if (state.submissionMode === 'steer_current') {
        return stopState(state, 'stopped', event.status === 'interrupted' ? 'turn_interrupted' : 'turn_completed', nowMs);
      }
      return freezeState({
        ...state,
        threadStatus: 'idle',
        activeFlags: Object.freeze([]),
        activeTurnId: null,
        updatedAtMs: nowMs,
      });
    }
    if (state.taskKind === 'manual_prompt' && state.pendingPrompt) {
      if (state.submissionMode === 'steer_current') {
        return stopState(state, 'stopped', event.status === 'interrupted' ? 'turn_interrupted' : 'turn_completed', nowMs);
      }
      return advanceManualPrompt(freezeState({
        ...state,
        threadStatus: 'idle',
        activeFlags: Object.freeze([]),
        activeTurnId: null,
        updatedAtMs: nowMs,
      }), nowMs);
    }
    if (event.status === 'completed') return stopState(state, 'stopped', 'turn_completed', nowMs);
    if (event.status === 'interrupted') return stopState(state, 'stopped', 'turn_interrupted', nowMs);
    if (!event.failure) {
      if (state.lastFailure && state.lastFailure.willRetry !== true) {
        const terminalFailure = freezeState({
          ...state,
          lastFailureTurnTerminal: true,
          threadStatus: 'idle',
          activeFlags: Object.freeze([]),
          activeTurnId: null,
          updatedAtMs: nowMs,
          lease: null,
        });
        return applyFailureDecision(terminalFailure, { nowMs, jitterUnit: event.jitterUnit });
      }
      return freezeState({
        ...state,
        status: 'waiting',
        reason: 'awaiting_final_failure',
        updatedAtMs: nowMs,
        threadStatus: 'idle',
        activeFlags: Object.freeze([]),
        activeTurnId: null,
        lease: null,
      });
    }
    return transitionBridgeContinuationTask(state, {
      type: 'failure_observed',
      failure: event.failure,
      threadStatus: 'idle',
      activeFlags: [],
      turnTerminal: true,
      retryAfterMs: event.retryAfterMs,
      jitterUnit: event.jitterUnit,
      nowMs,
    });
  }

  return state;
}
