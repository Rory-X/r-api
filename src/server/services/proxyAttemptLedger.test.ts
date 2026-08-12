import { describe, expect, it } from 'vitest';

import { createRetryBudget } from './proxyRetryContract.js';
import { createProxyAttemptLedger } from './proxyAttemptLedger.js';

function policy() {
  return {
    retryOwner: 'cooperative' as const,
    replaySafety: 'safe_only' as const,
    retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 3 }),
  };
}

describe('proxyAttemptLedger', () => {
  it('snapshots policy and records sequential attempts with commit state', () => {
    const ledger = createProxyAttemptLedger({ now: () => 1_000 });
    const request = ledger.beginRequest({
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      policy: policy(),
      nowMs: 1_010,
    });
    const first = ledger.beginAttempt({
      requestId: request.requestId,
      attemptIndex: 0,
      channelId: 11,
      credentialId: 101,
      nowMs: 1_020,
    });

    expect(ledger.markCommit({
      requestId: request.requestId,
      attemptId: first.attemptId,
      event: 'request_sent',
    })).toMatchObject({ commitState: 'request_sent' });
    expect(ledger.finishAttempt({
      requestId: request.requestId,
      attemptId: first.attemptId,
      status: 'failed',
      statusCode: 429,
      errorScope: 'upstream_gateway',
      nowMs: 1_030,
    })).toMatchObject({
      status: 'failed',
      commitState: 'request_sent',
      statusCode: 429,
    });

    const second = ledger.beginAttempt({
      requestId: request.requestId,
      attemptIndex: 1,
      channelId: 12,
      credentialId: 102,
      nowMs: 1_040,
    });
    ledger.finishAttempt({
      requestId: request.requestId,
      attemptId: second.attemptId,
      status: 'succeeded',
      statusCode: 200,
      nowMs: 1_050,
    });
    const finished = ledger.finishRequest({
      requestId: request.requestId,
      status: 'succeeded',
      nowMs: 1_060,
    });

    expect(finished).toMatchObject({ status: 'succeeded', finishedAtMs: 1_060 });
    expect(finished.attempts).toHaveLength(2);
    expect(finished.policy.retryBudget.limits.maxAttempts).toBe(3);
  });

  it('keeps sent_unknown sticky and rejects concurrent attempts', () => {
    const ledger = createProxyAttemptLedger({ now: () => 2_000 });
    const request = ledger.beginRequest({
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      policy: policy(),
    });
    const attempt = ledger.beginAttempt({
      requestId: request.requestId,
      attemptIndex: 0,
      channelId: 11,
    });

    expect(() => ledger.beginAttempt({
      requestId: request.requestId,
      attemptIndex: 1,
      channelId: 12,
    })).toThrow(/in-flight attempt/);

    ledger.markCommit({
      requestId: request.requestId,
      attemptId: attempt.attemptId,
      event: 'transport_unknown',
    });
    const finishedAttempt = ledger.finishAttempt({
      requestId: request.requestId,
      attemptId: attempt.attemptId,
      status: 'unknown',
      errorScope: 'transport',
    });
    expect(finishedAttempt).toMatchObject({ status: 'unknown', commitState: 'sent_unknown' });
    expect(ledger.finishRequest({ requestId: request.requestId, status: 'unknown' }).status).toBe('unknown');
  });

  it('returns defensive snapshots instead of mutable internal records', () => {
    const ledger = createProxyAttemptLedger();
    const created = ledger.beginRequest({
      requestId: 'req-defensive',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      policy: policy(),
    });
    created.policy.retryBudget.attempts = 99;
    created.attempts.push({
      attemptId: 'fake',
      attemptIndex: 99,
      channelId: null,
      credentialId: null,
      status: 'failed',
      commitState: 'not_started',
      errorScope: null,
      statusCode: null,
      startedAtMs: 0,
      finishedAtMs: 0,
    });

    const stored = ledger.get('req-defensive');
    expect(stored?.policy.retryBudget.attempts).toBe(0);
    expect(stored?.attempts).toHaveLength(0);
  });
});
