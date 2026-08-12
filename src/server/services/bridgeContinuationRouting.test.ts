import { describe, expect, it, vi } from 'vitest';

import { resolveBridgeProxyRoutePlan } from './bridgeContinuationRouting.js';

const selection = {
  requestId: 'request-1',
  attemptId: 'attempt-1',
  channelId: 11,
  routeId: 7,
  siteId: 3,
  accountId: 5,
  tokenId: 13,
  startedAt: '2026-08-04T00:00:00.000Z',
};

function task(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      taskId: 'task-1',
      sessionKey: 'session-1',
      threadId: 'thread-1',
      status: 'running',
      continuationCount: 1,
      pendingRouteAction: 'rotate_credential',
      ...overrides,
    },
  } as any;
}

describe('resolveBridgeProxyRoutePlan', () => {
  it('validates the active task and resolves its previous real route', async () => {
    const findLatestSelection = vi.fn().mockResolvedValue(selection);
    const result = await resolveBridgeProxyRoutePlan({
      directive: {
        taskId: 'task-1',
        routeAction: 'rotate_credential',
        continuationNumber: 2,
      },
      identity: {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'turn-2',
        requestKind: 'turn',
      },
      downstreamApiKeyId: 17,
    }, {
      getTask: vi.fn().mockResolvedValue(task()),
      findLatestSelection,
    });

    expect(result).toEqual({
      plan: {
        taskId: 'task-1',
        requestedAction: 'rotate_credential',
        effectiveAction: 'rotate_credential',
        continuationNumber: 2,
        previousSelection: selection,
        reason: 'directive_applied',
      },
      ignoredReason: null,
    });
    expect(findLatestSelection).toHaveBeenCalledWith({
      clientThreadId: 'thread-1',
      sessionId: 'session-1',
      downstreamApiKeyId: 17,
    });
  });

  it('forces hard-continuity requests to preserve the exact route', async () => {
    const result = await resolveBridgeProxyRoutePlan({
      directive: {
        taskId: 'task-1',
        routeAction: 'switch_channel',
        continuationNumber: 2,
      },
      identity: {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'turn-2',
        requestKind: 'turn',
      },
      hardContinuity: true,
    }, {
      getTask: vi.fn().mockResolvedValue(task({ pendingRouteAction: 'switch_channel' })),
      findLatestSelection: vi.fn().mockResolvedValue(selection),
    });

    expect(result.plan).toMatchObject({
      requestedAction: 'switch_channel',
      effectiveAction: 'preserve',
      reason: 'hard_continuity_preserved',
    });
  });

  it('ignores forged or stale directives before changing routing', async () => {
    const result = await resolveBridgeProxyRoutePlan({
      directive: {
        taskId: 'task-1',
        routeAction: 'rotate_credential',
        continuationNumber: 9,
      },
      identity: {
        sessionId: 'session-1',
        threadId: 'other-thread',
        turnId: 'turn-9',
        requestKind: 'turn',
      },
    }, {
      getTask: vi.fn().mockResolvedValue(task()),
      findLatestSelection: vi.fn(),
    });

    expect(result).toEqual({ plan: null, ignoredReason: 'thread_mismatch' });
  });
});
