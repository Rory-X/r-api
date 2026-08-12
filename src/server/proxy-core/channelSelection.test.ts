import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/tokenRouter.js', () => ({
  tokenRouter: {},
}));

vi.mock('../services/routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: vi.fn(),
}));

import {
  buildBridgeTokenRouterSelectionConstraints,
  canRetryChannelSelectionForFailure,
  getTesterForcedChannelId,
  normalizeForcedChannelId,
  TESTER_FORCED_CHANNEL_HEADER,
  TESTER_REQUEST_HEADER,
} from './channelSelection.js';

const bridgePlan = {
  taskId: 'task-1',
  requestedAction: 'rotate_credential' as const,
  effectiveAction: 'rotate_credential' as const,
  continuationNumber: 2,
  previousSelection: {
    requestId: 'request-1',
    attemptId: 'attempt-1',
    channelId: 11,
    routeId: 7,
    siteId: 3,
    accountId: 5,
    tokenId: 13,
    startedAt: '2026-08-04T00:00:00.000Z',
  },
  reason: 'directive_applied' as const,
};

describe('buildBridgeTokenRouterSelectionConstraints', () => {
  it('keeps credential rotation inside the previous API Channel', () => {
    expect(buildBridgeTokenRouterSelectionConstraints({ plan: bridgePlan })).toEqual({
      allowedSiteIds: [3],
      excludedCredentials: [{ accountId: 5, tokenId: 13 }],
    });
  });

  it('preserves the exact route or excludes the previous API Channel', () => {
    expect(buildBridgeTokenRouterSelectionConstraints({
      plan: { ...bridgePlan, effectiveAction: 'preserve' },
    })).toEqual({
      allowedSiteIds: [3],
      preferredCredential: { accountId: 5, tokenId: 13 },
    });
    expect(buildBridgeTokenRouterSelectionConstraints({
      plan: { ...bridgePlan, effectiveAction: 'switch_channel' },
    })).toEqual({
      excludedSiteIds: [3],
      excludedCredentials: [],
    });
  });
});

describe('normalizeForcedChannelId', () => {
  it('accepts positive integer ids and rejects fractional or unsafe values', () => {
    expect(normalizeForcedChannelId(77)).toBe(77);
    expect(normalizeForcedChannelId('78')).toBe(78);
    expect(normalizeForcedChannelId(77.9)).toBeNull();
    expect(normalizeForcedChannelId('78.5')).toBeNull();
    expect(normalizeForcedChannelId('9007199254740993')).toBeNull();
    expect(normalizeForcedChannelId(0)).toBeNull();
    expect(normalizeForcedChannelId(-1)).toBeNull();
  });
});

describe('getTesterForcedChannelId', () => {
  it('ignores forged forced-channel headers without the trusted tester bridge marker', () => {
    expect(getTesterForcedChannelId({
      headers: {
        [TESTER_FORCED_CHANNEL_HEADER]: '77',
      },
      clientIp: '127.0.0.1',
    })).toBeNull();

    expect(getTesterForcedChannelId({
      headers: {
        [TESTER_REQUEST_HEADER]: '1',
        [TESTER_FORCED_CHANNEL_HEADER]: '77',
      },
      clientIp: '203.0.113.10',
    })).toBeNull();
  });

  it('accepts the forced channel id only for loopback tester bridge traffic', () => {
    expect(getTesterForcedChannelId({
      headers: {
        [TESTER_REQUEST_HEADER]: '1',
        [TESTER_FORCED_CHANNEL_HEADER]: '77',
      },
      clientIp: '::1',
    })).toBe(77);

    expect(getTesterForcedChannelId({
      headers: {
        [TESTER_REQUEST_HEADER]: '1',
        [TESTER_FORCED_CHANNEL_HEADER]: '78',
      },
      clientIp: '::ffff:127.0.0.1',
    })).toBe(78);
  });
});

describe('canRetryChannelSelectionForFailure', () => {
  it('suppresses local failover for cooperative channels backed by upstream internal retry', () => {
    expect(canRetryChannelSelectionForFailure({
      retryCount: 0,
      selected: {
        channel: {
          retryOwner: 'cooperative',
          upstreamRetryMode: 'internal_retry',
        },
      },
      status: 503,
      errorText: 'service unavailable',
    })).toBe(false);
  });

  it('keeps transport recovery local and honors forced-channel pinning', () => {
    const selected = {
      channel: {
        retryOwner: 'cooperative',
        upstreamRetryMode: 'internal_retry',
      },
    };
    expect(canRetryChannelSelectionForFailure({
      retryCount: 0,
      selected,
      errorScope: 'transport',
    })).toBe(true);
    expect(canRetryChannelSelectionForFailure({
      retryCount: 0,
      forcedChannelId: 77,
      selected,
      errorScope: 'transport',
    })).toBe(false);
  });
});
