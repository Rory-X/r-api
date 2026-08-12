import { describe, expect, it } from 'vitest';

import {
  advanceAttemptCommitState,
  canRetryLocally,
  classifyRetryErrorScope,
  createRetryBudget,
  shouldRetryPreOutputStreamFailure,
  spendRetryBudget,
} from './proxyRetryContract.js';

describe('proxyRetryContract', () => {
  it('shares one total budget across attempts, rotations, and channel switches', () => {
    const budget = createRetryBudget({
      nowMs: 1_000,
      maxElapsedMs: 500,
      maxAttempts: 2,
      maxCredentialRotations: 1,
      maxChannelSwitches: 1,
    });

    const firstAttempt = spendRetryBudget(budget, { nowMs: 1_050, attempt: true });
    expect(firstAttempt.allowed).toBe(true);
    if (!firstAttempt.allowed) return;

    const rotation = spendRetryBudget(firstAttempt.state, {
      nowMs: 1_100,
      credentialRotation: true,
    });
    expect(rotation.allowed).toBe(true);
    if (!rotation.allowed) return;

    const secondAttempt = spendRetryBudget(rotation.state, { nowMs: 1_200, attempt: true });
    expect(secondAttempt.allowed).toBe(true);
    if (!secondAttempt.allowed) return;

    expect(
      spendRetryBudget(secondAttempt.state, { nowMs: 1_201, attempt: true }),
    ).toMatchObject({ allowed: false, reason: 'attempts' });
    expect(
      spendRetryBudget(secondAttempt.state, { nowMs: 1_201, channelSwitch: true, attempt: false }),
    ).toMatchObject({ allowed: true });
  });

  it('denies a spend after the wall-clock budget expires without mutating the snapshot', () => {
    const budget = createRetryBudget({ nowMs: 10_000, maxElapsedMs: 100 });
    const decision = spendRetryBudget(budget, { nowMs: 10_101, attempt: true });

    expect(decision).toMatchObject({ allowed: false, reason: 'elapsed', elapsedMs: 101 });
    expect(decision.state).toEqual(budget);
  });

  it('keeps ambiguous delivery opaque unless the route explicitly opts into replay', () => {
    const base = {
      replaySafety: 'safe_only' as const,
      commitState: 'sent_unknown' as const,
      errorScope: 'transport' as const,
    };

    expect(canRetryLocally({ ...base, retryOwner: 'local_proxy' })).toBe(false);
    expect(canRetryLocally({
      ...base,
      retryOwner: 'local_proxy',
      replaySafety: 'allow_explicit',
      explicitReplay: true,
    })).toBe(true);
    expect(canRetryLocally({
      ...base,
      retryOwner: 'cooperative',
      upstreamRetryable: true,
      replaySafety: 'allow_explicit',
      explicitReplay: true,
    })).toBe(false);
  });

  it('keeps request errors local-terminal while allowing model capability failover', () => {
    expect(canRetryLocally({
      retryOwner: 'local_proxy',
      replaySafety: 'safe_only',
      commitState: 'not_started',
      errorScope: 'request',
    })).toBe(false);
    expect(canRetryLocally({
      retryOwner: 'cooperative',
      replaySafety: 'safe_only',
      commitState: 'not_started',
      errorScope: 'model_capability',
    })).toBe(true);
  });

  it('makes commit state sticky after an ambiguous transport failure', () => {
    expect(advanceAttemptCommitState('not_started', 'request_sent')).toBe('request_sent');
    expect(advanceAttemptCommitState('request_sent', 'transport_unknown')).toBe('sent_unknown');
    expect(advanceAttemptCommitState('sent_unknown', 'response_started')).toBe('sent_unknown');
    expect(advanceAttemptCommitState('response_started', 'completed')).toBe('completed');
  });

  it('classifies common failures into the shared health vocabulary', () => {
    expect(classifyRetryErrorScope({ status: 401, rawErrorText: 'expired token' })).toBe('credential');
    expect(classifyRetryErrorScope({ status: 400, rawErrorText: 'unsupported model' })).toBe('model_capability');
    expect(classifyRetryErrorScope({ status: 429, rawErrorText: 'rate limit' })).toBe('upstream_gateway');
    expect(classifyRetryErrorScope({ status: 422, rawErrorText: 'invalid request body' })).toBe('request');
    expect(classifyRetryErrorScope({ status: 400, rawErrorText: '400 Bad Request' })).toBe('unknown');
    expect(classifyRetryErrorScope({
      status: 400,
      rawErrorText: '{"error":{"message":"Bad Request","type":"upstream_error"}}',
    })).toBe('unknown');
    expect(classifyRetryErrorScope({
      status: 400,
      rawErrorText: 'unsupported endpoint: /v1/responses',
    })).toBe('upstream_gateway');
    expect(classifyRetryErrorScope({
      status: 400,
      rawErrorText: 'invalid timeout parameter',
    })).toBe('request');
  });

  it('only replays pre-output stream failures for explicit transient capacity errors', () => {
    expect(
      shouldRetryPreOutputStreamFailure('Our servers are currently overloaded. Please try again later.'),
    ).toBe(true);
    expect(shouldRetryPreOutputStreamFailure('rate limit exceeded')).toBe(true);
    expect(shouldRetryPreOutputStreamFailure('tool execution failed')).toBe(false);
    expect(shouldRetryPreOutputStreamFailure('stream closed before response.completed')).toBe(false);
  });
});
