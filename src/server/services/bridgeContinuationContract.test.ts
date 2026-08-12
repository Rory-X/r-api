import { describe, expect, it } from 'vitest';

import {
  classifyBridgeFailure,
  computeBridgeContinuationDelay,
  evaluateBridgeContinuation,
  isBridgeWriterContentionFailure,
  parseRetryAfterMs,
  resolveBridgeTurnSubmission,
  snapshotBridgeContinuationPolicy,
} from './bridgeContinuationContract.js';

describe('bridge continuation contract', () => {
  it('classifies final Codex failures without treating an internal retry as bridge-owned', () => {
    const internalRetry = classifyBridgeFailure({
      source: 'error_notification',
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      message: 'too many requests',
      willRetry: true,
    });
    expect(internalRetry).toMatchObject({
      failureClass: 'rate_limited',
      httpStatusCode: 429,
      willRetry: true,
    });

    const policy = snapshotBridgeContinuationPolicy({ enabled: true }, 1_000);
    expect(evaluateBridgeContinuation({
      policy,
      failure: internalRetry,
      continuationCount: 0,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'idle',
    })).toEqual({ kind: 'wait', reason: 'codex_internal_retry' });
  });

  it('separates 429, concurrency, temporary service, and exhausted internal retries', () => {
    expect(classifyBridgeFailure({ httpStatusCode: 429, message: 'rate limit' }).failureClass).toBe('rate_limited');
    expect(classifyBridgeFailure({ httpStatusCode: 429, message: 'concurrency limit reached' }).failureClass)
      .toBe('concurrency_limited');
    expect(classifyBridgeFailure({ codexErrorInfo: 'serverOverloaded' }).failureClass).toBe('service_temporary');
    expect(classifyBridgeFailure({
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: null } },
      message: 'Reached the retry limit for responses',
    }).failureClass).toBe('retry_exhausted');
    const writerContention = classifyBridgeFailure({
      source: 'control_error',
      message: 'thread thread-a already has an active writer',
      willRetry: false,
    });
    expect(writerContention.failureClass).toBe('turn_conflict');
    expect(isBridgeWriterContentionFailure(writerContention)).toBe(true);
  });

  it('keeps the policy disabled by default and snapshots immutable per-failure rules', () => {
    const policy = snapshotBridgeContinuationPolicy({
      policyVersion: 7,
      enabled: true,
      continuePrompt: '  继续执行当前任务  ',
      rules: {
        rate_limited: { action: 'continue_same_route', limit: 'unlimited' },
        concurrency_limited: { action: 'continue_same_route', limit: { mode: 'unlimited' } },
        service_temporary: { action: 'continue_switch_channel', maxContinuations: 9 },
      },
    }, 10_000);

    expect(policy).toMatchObject({
      policyVersion: 7,
      enabled: true,
      continuePrompt: '继续执行当前任务',
      capturedAt: '1970-01-01T00:00:10.000Z',
    });
    expect(policy.rules.rate_limited.limit).toEqual({ mode: 'unlimited' });
    expect(policy.rules.concurrency_limited.limit).toEqual({ mode: 'unlimited' });
    expect(policy.rules.service_temporary).toEqual({
      action: 'continue_switch_channel',
      limit: { mode: 'bounded', maxContinuations: 9 },
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.rules)).toBe(true);
    expect(Object.isFrozen(policy.rules.rate_limited.limit)).toBe(true);
    expect(snapshotBridgeContinuationPolicy({}, 10_000).enabled).toBe(false);
  });

  it('uses Retry-After as a floor over exponential backoff and jitter', () => {
    const backoff = { initialDelayMs: 1_000, maxDelayMs: 8_000, multiplier: 2, jitterRatio: 0.25 };
    expect(computeBridgeContinuationDelay({ backoff, continuationNumber: 3, jitterUnit: 0.5 })).toBe(4_000);
    expect(computeBridgeContinuationDelay({
      backoff,
      continuationNumber: 3,
      retryAfterMs: 9_000,
      jitterUnit: 0,
    })).toBe(9_000);
    expect(parseRetryAfterMs('12')).toBe(12_000);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:20 GMT', 5_000)).toBe(15_000);
  });

  it('supports infinite same-route retry and explicit credential/channel rotation choices', () => {
    const policy = snapshotBridgeContinuationPolicy({
      enabled: true,
      backoff: { initialDelayMs: 1_000, maxDelayMs: 10_000, multiplier: 2, jitterRatio: 0 },
      rules: {
        rate_limited: { action: 'continue_same_route', limit: 'unlimited' },
        retry_exhausted: { action: 'continue_rotate_credential', maxContinuations: 2 },
        service_temporary: { action: 'continue_switch_channel', maxContinuations: 2 },
      },
    }, 1_000);
    const rateLimited = classifyBridgeFailure({ httpStatusCode: 429, willRetry: false });
    expect(evaluateBridgeContinuation({
      policy,
      failure: rateLimited,
      continuationCount: 20_000,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'idle',
    })).toMatchObject({ kind: 'schedule', routeAction: 'preserve', continuationNumber: 20_001 });

    const exhausted = classifyBridgeFailure({
      codexErrorInfo: { responseTooManyFailedAttempts: {} },
      willRetry: false,
    });
    expect(evaluateBridgeContinuation({
      policy,
      failure: exhausted,
      continuationCount: 0,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'idle',
    })).toMatchObject({ kind: 'schedule', routeAction: 'rotate_credential' });

    const temporary = classifyBridgeFailure({ codexErrorInfo: 'serverOverloaded', willRetry: false });
    expect(evaluateBridgeContinuation({
      policy,
      failure: temporary,
      continuationCount: 0,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'idle',
    })).toMatchObject({ kind: 'schedule', routeAction: 'switch_channel' });
  });

  it('pauses for App Server interaction flags and stops terminal or exhausted policies', () => {
    const policy = snapshotBridgeContinuationPolicy({
      enabled: true,
      rules: { service_temporary: { action: 'continue_same_route', maxContinuations: 1 } },
    }, 1_000);
    const temporary = classifyBridgeFailure({ codexErrorInfo: 'serverOverloaded', willRetry: false });
    expect(evaluateBridgeContinuation({
      policy,
      failure: temporary,
      continuationCount: 0,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'active',
      activeFlags: ['waitingOnApproval'],
    })).toEqual({ kind: 'wait', reason: 'waiting_on_approval' });
    expect(evaluateBridgeContinuation({
      policy,
      failure: temporary,
      continuationCount: 1,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'idle',
    })).toEqual({ kind: 'dead', reason: 'attempt_limit' });

    const invalid = classifyBridgeFailure({ codexErrorInfo: 'badRequest', willRetry: false });
    expect(evaluateBridgeContinuation({
      policy,
      failure: invalid,
      continuationCount: 0,
      taskStartedAtMs: 1_000,
      nowMs: 2_000,
      threadStatus: 'idle',
    })).toEqual({ kind: 'dead', reason: 'unrecoverable_failure' });
  });

  it('uses turn/start for automatic continuation and turn/steer only for a manual active-turn prompt', () => {
    expect(resolveBridgeTurnSubmission({
      source: 'automatic',
      threadId: 'thread-a',
      prompt: '继续',
      threadStatus: 'idle',
    })).toMatchObject({ kind: 'request', method: 'turn/start', threadId: 'thread-a' });
    expect(resolveBridgeTurnSubmission({
      source: 'automatic',
      threadId: 'thread-a',
      prompt: '继续',
      threadStatus: 'active',
      activeTurnId: 'turn-a',
    })).toEqual({ kind: 'wait', reason: 'thread_active' });
    expect(resolveBridgeTurnSubmission({
      source: 'manual',
      threadId: 'thread-a',
      prompt: '补充要求',
      threadStatus: 'active',
      activeTurnId: 'turn-a',
    })).toMatchObject({
      kind: 'request',
      method: 'turn/steer',
      expectedTurnId: 'turn-a',
    });
    expect(resolveBridgeTurnSubmission({
      source: 'manual',
      threadId: 'thread-a',
      prompt: '批准后继续',
      threadStatus: 'active',
      activeTurnId: 'turn-a',
      activeFlags: ['waitingOnApproval'],
    })).toEqual({ kind: 'wait', reason: 'interaction_response_required' });
    expect(resolveBridgeTurnSubmission({
      source: 'manual',
      threadId: 'thread-a',
      prompt: '恢复后继续',
      threadStatus: 'not_loaded',
    })).toMatchObject({ kind: 'request', method: 'turn/start', threadId: 'thread-a' });
  });
});
