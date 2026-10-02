import { beforeEach, describe, expect, it, vi } from 'vitest';

const tokenRouterMocks = vi.hoisted(() => ({
  selectChannel: vi.fn(),
  selectNextChannel: vi.fn(),
  selectPreferredChannel: vi.fn(),
  explainSelection: vi.fn(),
}));
const coordinatorMocks = vi.hoisted(() => ({
  getStickyChannelId: vi.fn(),
  clearStickyChannel: vi.fn(),
}));
vi.mock('../services/tokenRouter.js', () => ({
  tokenRouter: tokenRouterMocks,
}));

vi.mock('../services/proxyChannelCoordinator.js', () => ({
  proxyChannelCoordinator: coordinatorMocks,
}));

vi.mock('../services/routeRefreshWorkflow.js', () => ({
  refreshModelsAndRebuildRoutes: vi.fn(),
}));

import {
  buildBridgeTokenRouterSelectionConstraints,
  canRetryChannelSelectionForFailure,
  getTesterForcedChannelId,
  normalizeForcedChannelId,
  selectProxyChannelForAttempt,
  TESTER_FORCED_CHANNEL_HEADER,
  TESTER_REQUEST_HEADER,
} from './channelSelection.js';

beforeEach(() => {
  vi.clearAllMocks();
  coordinatorMocks.getStickyChannelId.mockReturnValue(null);
});

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

describe('selectProxyChannelForAttempt', () => {
  it('records the actual selected channel in the request routing explanation', async () => {
    tokenRouterMocks.explainSelection.mockResolvedValue({
      requestedModel: 'claude-opus',
      actualModel: 'claude-opus',
      matched: true,
      routeId: 7,
      routeName: 'Claude 高质量',
      modelPattern: 'claude-opus',
      selectedChannelId: 99,
      selectedAccountId: 199,
      selectedLabel: 'preview selection',
      summary: [],
      candidates: [{
        channelId: 13,
        accountId: 23,
        username: 'channel-c',
        siteName: 'Site C',
        tokenName: 'default',
        priority: 0,
        sortOrder: 0,
        weight: 10,
        eligible: true,
        recentlyFailed: false,
        avoidedByRecentFailure: false,
        probability: 62,
        reason: '当前概率 62%',
      }],
    });
    tokenRouterMocks.selectChannel.mockResolvedValue({
      channel: { id: 13, routeId: 7 },
      account: { id: 23, username: 'channel-c' },
      site: { id: 3, name: 'Site C' },
      token: null,
      tokenName: 'default',
      tokenValue: 'secret',
      actualModel: 'claude-opus-4-1',
    });
    const onRoutingDecision = vi.fn();

    const selected = await selectProxyChannelForAttempt({
      requestedModel: 'claude-opus',
      downstreamPolicy: {
        allowedRouteIds: [],
        allowedSiteIds: [],
        blockedSiteIds: [],
        supportedModels: [],
      },
      excludeChannelIds: [],
      retryCount: 0,
      onRoutingDecision,
    });

    expect(selected?.channel.id).toBe(13);
    expect(tokenRouterMocks.explainSelection).toHaveBeenCalledTimes(1);
    expect(onRoutingDecision).toHaveBeenCalledWith(expect.objectContaining({
      selectionMode: 'initial',
      decision: expect.objectContaining({
        selectedChannelId: 13,
        selectedAccountId: 23,
        actualModel: 'claude-opus-4-1',
        selectedLabel: 'channel-c @ Site C / default',
      }),
    }));
  });

  it('records ordinary selection when a sticky preference cannot be reused', async () => {
    coordinatorMocks.getStickyChannelId.mockReturnValue(77);
    tokenRouterMocks.selectPreferredChannel.mockResolvedValue(null);
    tokenRouterMocks.selectChannel.mockResolvedValue({
      channel: { id: 13, routeId: 7 },
      account: { id: 23, username: 'channel-c' },
      site: { id: 3, name: 'Site C' },
      token: null,
      tokenName: 'default',
      tokenValue: 'secret',
      actualModel: 'claude-opus-4-1',
    });
    tokenRouterMocks.explainSelection.mockResolvedValue({
      requestedModel: 'claude-opus',
      actualModel: 'claude-opus-4-1',
      matched: true,
      routeId: 7,
      routeName: 'Claude 高质量',
      modelPattern: 'claude-opus',
      selectedChannelId: 13,
      selectedAccountId: 23,
      selectedLabel: 'channel-c @ Site C / default',
      summary: [],
      candidates: [],
    });
    const onRoutingDecision = vi.fn();

    await selectProxyChannelForAttempt({
      requestedModel: 'claude-opus',
      downstreamPolicy: {
        allowedRouteIds: [],
        allowedSiteIds: [],
        blockedSiteIds: [],
        supportedModels: [],
      },
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey: 'session-1',
      onRoutingDecision,
    });

    expect(onRoutingDecision).toHaveBeenCalledWith(expect.objectContaining({
      selectionMode: 'initial',
    }));
  });
});
