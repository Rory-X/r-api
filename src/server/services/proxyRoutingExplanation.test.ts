import { describe, expect, it } from 'vitest';

import {
  appendProxyRoutingDecision,
  buildProxyRoutingExplanation,
  createProxyRoutingExplanationSnapshot,
} from './proxyRoutingExplanation.js';

function candidate(input: {
  channelId: number;
  accountId: number;
  siteName: string;
  username: string;
  eligible: boolean;
  probability: number;
  reason: string;
}) {
  return {
    ...input,
    tokenName: 'default',
    priority: 0,
    sortOrder: input.channelId,
    weight: 10,
    recentlyFailed: false,
    avoidedByRecentFailure: false,
  };
}

describe('proxyRoutingExplanation', () => {
  it('combines candidate filtering, failover trigger, and final success', () => {
    let snapshot = createProxyRoutingExplanationSnapshot('claude-opus');
    snapshot = appendProxyRoutingDecision(snapshot, {
      retryCount: 0,
      selectionMode: 'initial',
      recordedAt: new Date('2026-08-18T10:00:00.000Z'),
      decision: {
        requestedModel: 'claude-opus',
        actualModel: 'claude-opus-4-1',
        matched: true,
        routeId: 7,
        routeName: 'Claude 高质量',
        modelPattern: 'claude-opus',
        selectedChannelId: 13,
        selectedAccountId: 23,
        selectedLabel: 'C @ Site C / default',
        summary: ['命中路由：claude-opus'],
        candidates: [
          candidate({
            channelId: 11,
            accountId: 21,
            siteName: 'Site A',
            username: 'A',
            eligible: false,
            probability: 0,
            reason: '余额不足',
          }),
          candidate({
            channelId: 12,
            accountId: 22,
            siteName: 'Site B',
            username: 'B',
            eligible: false,
            probability: 0,
            reason: '站点熔断',
          }),
          candidate({
            channelId: 13,
            accountId: 23,
            siteName: 'Site C',
            username: 'C',
            eligible: true,
            probability: 62,
            reason: '当前权重命中概率 62%',
          }),
          candidate({
            channelId: 14,
            accountId: 24,
            siteName: 'Site D',
            username: 'D',
            eligible: true,
            probability: 28,
            reason: '当前权重命中概率 28%',
          }),
        ],
      },
    });
    snapshot = appendProxyRoutingDecision(snapshot, {
      retryCount: 1,
      selectionMode: 'failover',
      recordedAt: new Date('2026-08-18T10:00:02.000Z'),
      decision: {
        requestedModel: 'claude-opus',
        actualModel: 'claude-opus-4-1',
        matched: true,
        routeId: 7,
        routeName: 'Claude 高质量',
        modelPattern: 'claude-opus',
        selectedChannelId: 14,
        selectedAccountId: 24,
        selectedLabel: 'D @ Site D / default',
        summary: ['Channel C 已在本请求中尝试'],
        candidates: [],
      },
    });

    const explanation = buildProxyRoutingExplanation({
      snapshot,
      requestedModel: 'claude-opus',
      status: 'succeeded',
      attempts: [
        {
          attemptId: 'attempt-1',
          attemptIndex: 0,
          channelId: 13,
          siteName: 'Site C',
          accountUsername: 'C',
          credentialName: 'default',
          status: 'failed',
          commitState: 'request_sent',
          errorScope: 'transport',
          statusCode: 504,
          errorSummary: 'first byte timeout',
        },
        {
          attemptId: 'attempt-2',
          attemptIndex: 1,
          channelId: 14,
          siteName: 'Site D',
          accountUsername: 'D',
          credentialName: 'default',
          status: 'succeeded',
          commitState: 'completed',
          errorScope: null,
          statusCode: 200,
          errorSummary: null,
        },
      ],
    });

    expect(explanation).toMatchObject({
      requestedModel: 'claude-opus',
      route: { id: 7, name: 'Claude 高质量' },
      candidateCount: 4,
      failovers: [{
        fromChannelId: 13,
        toChannelId: 14,
        trigger: 'upstream_timeout',
      }],
      final: {
        status: 'succeeded',
        channelId: 14,
      },
    });
    expect(explanation?.candidates[0]).toMatchObject({ eligible: false, reason: '余额不足' });
    expect(explanation?.attempts[0]).toMatchObject({
      failureCode: 'upstream_timeout',
      healthDomain: 'gateway',
      alertCategory: 'availability',
      alertSeverity: 'warning',
      retryable: true,
    });
  });

  it('returns null for legacy request rows without routing snapshots', () => {
    expect(buildProxyRoutingExplanation({
      snapshot: null,
      requestedModel: 'gpt-5.4',
      status: 'succeeded',
      attempts: [],
    })).toBeNull();
  });
});
