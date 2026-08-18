import { describe, expect, it } from 'vitest';

import { acquireBridgeContinuationLease } from './bridgeContinuationLease.js';
import {
  classifyBridgeFailure,
  snapshotBridgeContinuationPolicy,
} from './bridgeContinuationContract.js';
import {
  createBridgeContinuationTaskState,
  createManualBridgePromptTaskState,
  transitionBridgeContinuationTask,
} from './bridgeContinuationState.js';

function enabledPolicy() {
  return snapshotBridgeContinuationPolicy({
    enabled: true,
    backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, multiplier: 2, jitterRatio: 0 },
    rules: {
      rate_limited: { action: 'continue_same_route', limit: 'unlimited' },
      retry_exhausted: { action: 'continue_rotate_credential', maxContinuations: 3 },
    },
  }, 1_000);
}

function createTask() {
  return createBridgeContinuationTaskState({
    taskId: 'task-a',
    sessionKey: 'device-a:thread-a',
    threadId: 'thread-a',
    policy: enabledPolicy(),
    nowMs: 1_000,
  });
}

describe('bridge continuation task state', () => {
  it('waits for Codex internal retry to finish before acquiring a continuation lease', () => {
    let state = createTask();
    state = transitionBridgeContinuationTask(state, {
      type: 'failure_observed',
      failure: classifyBridgeFailure({
        source: 'error_notification',
        httpStatusCode: 429,
        willRetry: true,
      }),
      threadStatus: 'active',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({ status: 'waiting', reason: 'codex_internal_retry' });

    state = transitionBridgeContinuationTask(state, {
      type: 'failure_observed',
      failure: classifyBridgeFailure({
        source: 'error_notification',
        httpStatusCode: 429,
        willRetry: false,
      }),
      threadStatus: 'active',
      retryAfterMs: 5_000,
      nowMs: 3_000,
    });
    expect(state).toMatchObject({ status: 'waiting', reason: 'thread_active' });

    state = transitionBridgeContinuationTask(state, {
      type: 'thread_state_changed',
      threadStatus: 'idle',
      nowMs: 4_000,
    });
    expect(state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      nextRunAtMs: 9_000,
      pendingRouteAction: 'preserve',
    });

    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 10_000,
      nowMs: 9_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, {
      type: 'lease_acquired',
      lease: acquired.lease,
      nowMs: 9_000,
    });
    expect(state).toMatchObject({ status: 'running', reason: 'running' });

    state = transitionBridgeContinuationTask(state, {
      type: 'continuation_dispatched',
      leaseToken: 'lease-a',
      turnId: 'turn-b',
      nowMs: 9_100,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      continuationCount: 1,
      activeTurnId: 'turn-b',
      lease: null,
    });
  });

  it('pauses on approval and schedules only after the interaction flag clears', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'active',
      activeFlags: ['waitingOnApproval'],
      turnTerminal: true,
      nowMs: 2_000,
    });
    expect(state).toMatchObject({ status: 'waiting', reason: 'waiting_on_approval' });
    state = transitionBridgeContinuationTask(state, {
      type: 'thread_state_changed',
      threadStatus: 'idle',
      activeFlags: [],
      nowMs: 3_000,
    });
    expect(state).toMatchObject({ status: 'backoff', nextRunAtMs: 4_000 });
  });

  it('lets a manual prompt supersede pending automation and never resurrects it', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      turnTerminal: true,
      nowMs: 2_000,
    });
    expect(state.status).toBe('backoff');
    state = transitionBridgeContinuationTask(state, { type: 'manual_prompt', nowMs: 2_100 });
    expect(state).toMatchObject({
      status: 'superseded',
      reason: 'manual_prompt',
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
    const unchanged = transitionBridgeContinuationTask(state, {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      nowMs: 3_000,
    });
    expect(unchanged).toBe(state);
  });

  it('gives manual stop priority and leaves ambiguous dispatch for reconciliation', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      turnTerminal: true,
      nowMs: 2_000,
    });
    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 10_000,
      nowMs: 3_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, { type: 'lease_acquired', lease: acquired.lease, nowMs: 3_000 });
    state = transitionBridgeContinuationTask(state, {
      type: 'dispatch_outcome_unknown',
      leaseToken: 'lease-a',
      nowMs: 3_100,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'dispatch_outcome_unknown',
      continuationCount: 0,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
    state = transitionBridgeContinuationTask(state, { type: 'manual_stop', nowMs: 3_200 });
    expect(state).toMatchObject({ status: 'stopped', reason: 'manual_stop' });
  });

  it('does not replay automatically after a running lease expires', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      turnTerminal: true,
      nowMs: 2_000,
    });
    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 10_000,
      nowMs: 3_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, { type: 'lease_acquired', lease: acquired.lease, nowMs: 3_000 });
    state = transitionBridgeContinuationTask(state, { type: 'lease_expired', nowMs: 13_000 });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'dispatch_outcome_unknown',
      continuationCount: 0,
      nextRunAtMs: null,
      pendingRouteAction: null,
      pendingPrompt: null,
      pendingMethod: null,
      lease: null,
    });
  });

  it('can safely reschedule a known rejected dispatch under the failure policy', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      turnTerminal: true,
      nowMs: 2_000,
    });
    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 10_000,
      nowMs: 3_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, { type: 'lease_acquired', lease: acquired.lease, nowMs: 3_000 });
    state = transitionBridgeContinuationTask(state, {
      type: 'dispatch_rejected',
      leaseToken: 'lease-a',
      failure: classifyBridgeFailure({ source: 'control_error', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      nowMs: 3_100,
    });
    expect(state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      continuationCount: 0,
      nextRunAtMs: 4_100,
      pendingRouteAction: 'preserve',
    });
  });

  it('defers a queued manual prompt when another App Server writer is active', () => {
    let state = createManualBridgePromptTaskState({
      taskId: 'manual-writer-contention',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'start_next',
      prompt: '当前会话结束后继续',
      threadStatus: 'idle',
      nowMs: 2_000,
    });
    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'connector-a',
      leaseToken: 'lease-writer-contention',
      ttlMs: 10_000,
      nowMs: 2_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, {
      type: 'lease_acquired',
      lease: acquired.lease,
      nowMs: 2_000,
    });
    state = transitionBridgeContinuationTask(state, {
      type: 'dispatch_rejected',
      leaseToken: 'lease-writer-contention',
      failure: classifyBridgeFailure({
        source: 'control_error',
        message: 'thread thread-a already has an active writer',
        willRetry: false,
      }),
      nowMs: 2_100,
    });
    expect(state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      continuationCount: 0,
      nextRunAtMs: 7_100,
      pendingRouteAction: 'preserve',
      pendingPrompt: '当前会话结束后继续',
      pendingMethod: 'turn/start',
      lease: null,
    });
  });

  it('keeps a locally queued Prompt leased without scheduling repeated server dispatches', () => {
    let state = createManualBridgePromptTaskState({
      taskId: 'manual-local-queue',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'auto',
      prompt: '继续处理当前会话',
      threadStatus: 'idle',
      nowMs: 2_000,
    });
    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'connector-a',
      leaseToken: 'lease-local-queue',
      ttlMs: 10_000,
      nowMs: 2_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, {
      type: 'lease_acquired',
      lease: acquired.lease,
      nowMs: 2_000,
    });
    state = transitionBridgeContinuationTask(state, {
      type: 'dispatch_queued',
      leaseToken: 'lease-local-queue',
      nowMs: 2_100,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'connector_queued',
      nextRunAtMs: null,
      pendingPrompt: '继续处理当前会话',
      lease: { leaseToken: 'lease-local-queue' },
    });

    state = transitionBridgeContinuationTask(state, {
      type: 'thread_state_changed',
      threadStatus: 'active',
      activeTurnId: 'turn-current',
      nowMs: 3_000,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'connector_queued',
      activeTurnId: 'turn-current',
    });

    state = transitionBridgeContinuationTask(state, { type: 'lease_expired', nowMs: 12_000 });
    expect(state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      nextRunAtMs: 12_000,
      continuationCount: 0,
      pendingPrompt: '继续处理当前会话',
      lease: null,
    });
  });

  it('reconciles a lost dispatch result from the authoritative turn/started event', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'idle',
      turnTerminal: true,
      nowMs: 2_000,
    });
    const acquired = acquireBridgeContinuationLease(null, {
      sessionKey: state.sessionKey,
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 10_000,
      nowMs: 3_000,
    });
    if (!acquired.acquired) return;
    state = transitionBridgeContinuationTask(state, { type: 'lease_acquired', lease: acquired.lease, nowMs: 3_000 });
    state = transitionBridgeContinuationTask(state, { type: 'lease_expired', nowMs: 13_000 });
    state = transitionBridgeContinuationTask(state, {
      type: 'turn_started_observed',
      turnId: 'turn-b',
      nowMs: 13_100,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      continuationCount: 1,
      activeTurnId: 'turn-b',
    });
    expect(transitionBridgeContinuationTask(state, {
      type: 'turn_started_observed',
      turnId: 'turn-b',
      nowMs: 13_200,
    })).toBe(state);
  });

  it('uses the final non-retrying error when failed turn completion has no embedded error', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'error_notification', httpStatusCode: 429, willRetry: false }),
      threadStatus: 'active',
      nowMs: 2_000,
    });
    expect(state.reason).toBe('thread_active');
    state = transitionBridgeContinuationTask(state, {
      type: 'turn_completed',
      turnId: 'turn-a',
      status: 'failed',
      nowMs: 2_100,
    });
    expect(state).toMatchObject({ status: 'backoff', nextRunAtMs: 3_100 });
  });

  it('stops after a successful continuation and marks terminal policy failures dead', () => {
    let state = transitionBridgeContinuationTask(createTask(), {
      type: 'turn_completed',
      turnId: 'turn-b',
      status: 'completed',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({ status: 'stopped', reason: 'turn_completed' });

    state = transitionBridgeContinuationTask(createTask(), {
      type: 'failure_observed',
      failure: classifyBridgeFailure({ source: 'turn_completed', codexErrorInfo: 'badRequest', willRetry: false }),
      threadStatus: 'idle',
      turnTerminal: true,
      nowMs: 2_000,
    });
    expect(state).toMatchObject({ status: 'dead', reason: 'unrecoverable_failure' });
  });

  it('routes an immediate manual prompt to the active turn with turn/steer', () => {
    const state = createManualBridgePromptTaskState({
      taskId: 'manual-a',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'auto',
      prompt: '先处理失败测试',
      threadStatus: 'active',
      activeTurnId: 'turn-a',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({
      taskKind: 'manual_prompt',
      submissionMode: 'auto',
      status: 'backoff',
      nextRunAtMs: 2_000,
      pendingMethod: 'turn/steer',
      activeTurnId: 'turn-a',
      pendingPrompt: '先处理失败测试',
    });
  });

  it('queues a next-turn prompt until the active turn completes', () => {
    let state = createManualBridgePromptTaskState({
      taskId: 'manual-next',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'start_next',
      prompt: '完成后继续整理文档',
      threadStatus: 'active',
      activeTurnId: 'turn-a',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      pendingMethod: 'turn/start',
    });
    state = transitionBridgeContinuationTask(state, {
      type: 'turn_completed',
      turnId: 'turn-a',
      status: 'completed',
      nowMs: 3_000,
    });
    expect(state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      nextRunAtMs: 3_000,
      pendingMethod: 'turn/start',
      activeTurnId: null,
    });
  });

  it('queues a next-turn prompt for a resumable unloaded thread', () => {
    const state = createManualBridgePromptTaskState({
      taskId: 'manual-resume',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'start_next',
      prompt: '恢复会话后继续',
      threadStatus: 'not_loaded',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({
      status: 'backoff',
      reason: 'backoff',
      nextRunAtMs: 2_000,
      pendingMethod: 'turn/start',
    });
  });

  it('keeps a queued manual prompt when an in-flight turn is observed after supersede', () => {
    let state = createManualBridgePromptTaskState({
      taskId: 'manual-inflight',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'start_next',
      prompt: '当前派发结束后继续',
      threadStatus: 'unknown',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'thread_not_ready',
      pendingPrompt: '当前派发结束后继续',
    });
    state = transitionBridgeContinuationTask(state, {
      type: 'turn_started_observed',
      turnId: 'turn-inflight',
      nowMs: 3_000,
    });
    expect(state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      activeTurnId: 'turn-inflight',
      pendingPrompt: '当前派发结束后继续',
      pendingMethod: 'turn/start',
    });
  });

  it('holds a manual prompt until an outstanding interaction clears', () => {
    let state = createManualBridgePromptTaskState({
      taskId: 'manual-wait',
      sessionKey: 'device-a:thread-a',
      threadId: 'thread-a',
      policy: snapshotBridgeContinuationPolicy({ enabled: false }, 1_000),
      submissionMode: 'auto',
      prompt: '补充当前实现说明',
      threadStatus: 'active',
      activeFlags: ['waitingOnApproval'],
      activeTurnId: 'turn-a',
      nowMs: 2_000,
    });
    expect(state).toMatchObject({ status: 'waiting', reason: 'interaction_response_required' });
    state = transitionBridgeContinuationTask(state, {
      type: 'thread_state_changed',
      threadStatus: 'active',
      activeFlags: [],
      activeTurnId: 'turn-a',
      nowMs: 3_000,
    });
    expect(state).toMatchObject({
      status: 'backoff',
      pendingMethod: 'turn/steer',
      nextRunAtMs: 3_000,
    });
  });
});
