import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRetryBudget } from './proxyRetryContract.js';

const storeMocks = vi.hoisted(() => ({
  insertProxyRequestLedger: vi.fn(),
  insertProxyRequestAttempt: vi.fn(),
  updateProxyRequestRetryOwner: vi.fn(),
  updateProxyRequestAttemptCommit: vi.fn(),
  finishProxyRequestAttempt: vi.fn(),
  finishProxyRequest: vi.fn(),
}));

vi.mock('./proxyAttemptLedgerStore.js', () => storeMocks);

import { startProxyAttemptLedgerSession } from './proxyAttemptLedgerRuntime.js';

function policy() {
  return {
    retryOwner: 'cooperative' as const,
    replaySafety: 'safe_only' as const,
    retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 3 }),
  };
}

const builtRequest = {
  endpoint: 'responses' as const,
  path: '/v1/responses',
  headers: { authorization: 'Bearer test' },
  body: { model: 'gpt-5.4' },
};

describe('proxyAttemptLedgerRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.insertProxyRequestLedger.mockResolvedValue({
      requestRowId: 9,
      requestId: 'req-runtime',
    });
    storeMocks.insertProxyRequestAttempt.mockResolvedValue(10);
    storeMocks.updateProxyRequestRetryOwner.mockResolvedValue(undefined);
    storeMocks.updateProxyRequestAttemptCommit.mockResolvedValue(undefined);
    storeMocks.finishProxyRequestAttempt.mockResolvedValue(undefined);
    storeMocks.finishProxyRequest.mockResolvedValue(undefined);
  });

  it('keeps response_started until the whole request completes', async () => {
    const session = await startProxyAttemptLedgerSession({
      requestId: 'req-runtime',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      channelId: 11,
      accountId: 21,
      tokenId: 31,
      policy: policy(),
    });
    expect(session).not.toBeNull();

    const identity = session!.createAttemptIdentity({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
    });
    await session!.onAttemptStart({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      ...identity,
    });
    const response = new Response('{}', { status: 200 });
    await session!.onAttemptCommitState({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      response,
      event: 'request_sent',
      commitState: 'request_sent',
      ...identity,
    });
    await session!.onAttemptCommitState({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      response,
      event: 'response_started',
      commitState: 'response_started',
      ...identity,
    });
    await session!.onAttemptSuccess({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      response,
      commitState: 'response_started',
      ...identity,
    });

    expect(storeMocks.finishProxyRequestAttempt).toHaveBeenCalledWith(expect.objectContaining({
      status: 'succeeded',
      commitState: 'response_started',
    }));

    await session!.finishRequest('succeeded');
    expect(storeMocks.updateProxyRequestAttemptCommit).toHaveBeenLastCalledWith(expect.objectContaining({
      attemptId: identity.attemptId,
      commitState: 'completed',
    }));
    expect(storeMocks.finishProxyRequest).toHaveBeenCalledWith(expect.objectContaining({
      status: 'succeeded',
    }));
  });

  it('snapshots the selected channel retry owner before the first attempt and then locks it', async () => {
    const session = await startProxyAttemptLedgerSession({
      requestId: 'req-runtime-owner',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      policy: policy(),
    });

    await session!.setRetryOwner('local_proxy');
    expect(storeMocks.updateProxyRequestRetryOwner).toHaveBeenCalledWith({
      requestRowId: 9,
      retryOwner: 'local_proxy',
      replaySafety: 'safe_only',
    });

    await session!.beginAttempt({
      endpoint: 'responses',
      requestPath: '/v1/responses',
      targetUrl: 'https://upstream.example/v1/responses',
    });
    await session!.setRetryOwner('upstream_gateway');

    expect(storeMocks.updateProxyRequestRetryOwner).toHaveBeenCalledTimes(1);
  });

  it('finishes an ambiguous transport attempt as unknown exactly once', async () => {
    const session = await startProxyAttemptLedgerSession({
      requestId: 'req-runtime-unknown',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      policy: policy(),
    });
    const identity = session!.createAttemptIdentity({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
    });
    await session!.onAttemptStart({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      ...identity,
    });
    await session!.onAttemptCommitState({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      event: 'transport_unknown',
      commitState: 'sent_unknown',
      ...identity,
    });
    await session!.onAttemptFailure({
      endpointIndex: 0,
      endpointCount: 1,
      request: builtRequest,
      targetUrl: 'https://upstream.example/v1/responses',
      response: new Response('{}', { status: 408 }),
      rawErrText: 'first byte timeout',
      errText: 'first byte timeout',
      commitState: 'sent_unknown',
      ...identity,
    });

    expect(storeMocks.finishProxyRequestAttempt).toHaveBeenCalledTimes(1);
    expect(storeMocks.finishProxyRequestAttempt).toHaveBeenCalledWith(expect.objectContaining({
      status: 'unknown',
      commitState: 'sent_unknown',
      errorScope: 'transport',
    }));
  });

  it('supports manual transports without pretending a closed stream completed', async () => {
    const session = await startProxyAttemptLedgerSession({
      requestId: 'req-manual',
      requestedModel: 'gemini-2.5-flash',
      downstreamPath: '/v1beta/models/gemini-2.5-flash:generateContent',
      policy: policy(),
    });
    const identity = await session!.beginAttempt({
      endpoint: 'gemini-native',
      requestPath: '/v1beta/models/gemini-2.5-flash:generateContent',
      targetUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    });

    await session!.markAttemptCommit({ attemptId: identity.attemptId, event: 'request_sent' });
    await session!.markAttemptCommit({ attemptId: identity.attemptId, event: 'response_started' });
    await session!.finishAttempt({
      attemptId: identity.attemptId,
      status: 'failed',
      commitState: 'response_started',
      errorScope: 'stream',
      statusCode: 502,
      errorSummary: 'stream closed before terminal payload',
    });
    await session!.finishRequest('failed');

    expect(storeMocks.finishProxyRequestAttempt).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: identity.attemptId,
      status: 'failed',
      commitState: 'response_started',
      errorScope: 'stream',
    }));
    expect(storeMocks.finishProxyRequest).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
    }));
  });
});
