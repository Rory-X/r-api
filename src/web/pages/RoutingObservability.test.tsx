import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast.js';
import RoutingObservability from './RoutingObservability.js';

const { apiMock, isMobileMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutingObservability: vi.fn(),
  },
  isMobileMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));
vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: isMobileMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('RoutingObservability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.mockReturnValue(false);
    apiMock.getRoutingObservability.mockResolvedValue({
      generatedAt: '2026-08-14T08:30:00.000Z',
      range: {
        hours: 24,
        from: '2026-08-13T08:30:00.000Z',
        to: '2026-08-14T08:30:00.000Z',
      },
      caveats: [
        '策略字段读取当前路由配置；历史请求尚未保存策略快照，因此不能据此还原请求发生时的策略。',
      ],
      totals: {
        requests: 100,
        finalSuccessCount: 96,
        finalFailureCount: 4,
        finalSuccessRate: 96,
        firstAttemptSuccessCount: 82,
        firstAttemptFailureCount: 18,
        firstAttemptSuccessRate: 82,
        failoverRecoveredCount: 14,
        failoverRecoveredRate: 77.8,
        averageAttempts: 1.22,
        p95LatencyMs: 2_400,
        p95FirstByteLatencyMs: 680,
        totalCost: 1.25,
        successfulRequestCost: 0.01302083,
        status503Count: 7,
      },
      routes: [
        {
          routeId: 8,
          routeName: 'GPT 主路由',
          modelPattern: 'gpt-*',
          routingStrategy: 'stable_first',
          enabled: true,
          requests: 100,
          finalSuccessCount: 96,
          finalSuccessRate: 96,
          firstAttemptSuccessCount: 82,
          firstAttemptSuccessRate: 82,
          failoverRecoveredCount: 14,
          failoverRecoveredRate: 77.8,
          averageAttempts: 1.22,
          p95LatencyMs: 2_400,
          p95FirstByteLatencyMs: 680,
          totalCost: 1.25,
          successfulRequestCost: 0.01302083,
          status503Count: 7,
          channels: [
            {
              channelId: 21,
              label: '主站 · account-a',
              siteName: '主站',
              accountName: 'account-a',
              selectedRequests: 70,
              selectedAttempts: 72,
              selectionShare: 59,
              successfulAttempts: 68,
              failedAttempts: 4,
              currentFailCount: 5,
              currentConsecutiveFailCount: 1,
              currentCooldownUntil: null,
              enabled: true,
            },
            {
              channelId: 22,
              label: '备用站 · account-b',
              siteName: '备用站',
              accountName: 'account-b',
              selectedRequests: 48,
              selectedAttempts: 50,
              selectionShare: 41,
              successfulAttempts: 28,
              failedAttempts: 22,
              currentFailCount: 12,
              currentConsecutiveFailCount: 0,
              currentCooldownUntil: null,
              enabled: true,
            },
          ],
        },
      ],
      sampledLogRows: 122,
      truncated: false,
    });
  });

  it('renders request-level metrics, the current-strategy caveat, and expandable channel distribution', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <RoutingObservability />
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getRoutingObservability).toHaveBeenCalledWith(24);
      const initialText = collectText(root.root);
      expect(initialText).toContain('调度观测');
      expect(initialText).toContain('最终成功率96.0%');
      expect(initialText).toContain('故障转移挽救率77.8%');
      expect(initialText).toContain('策略字段读取当前路由配置');
      expect(initialText).toContain('GPT 主路由');
      expect(initialText).toContain('当前：稳定优先');
      expect(initialText).not.toContain('主站 · account-a');

      const expandButton = root.root.find((node) => (
        node.type === 'button'
        && node.props['aria-label'] === '展开 GPT 主路由 通道详情'
      ));
      await act(async () => {
        expandButton.props.onClick();
      });

      const expandedText = collectText(root.root);
      expect(expandedText).toContain('主站 · account-a');
      expect(expandedText).toContain('备用站 · account-b');
      expect(expandedText).toContain('59.0%');
      expect(expandedText).toContain('累计失败 5');
    } finally {
      root?.unmount();
    }
  });

  it('renders route metrics as expandable cards on mobile', async () => {
    isMobileMock.mockReturnValue(true);
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <RoutingObservability />
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      expect(root.root.findAllByProps({ 'data-testid': 'routing-observability-mobile-list' })).toHaveLength(1);
      expect(root.root.findAllByType('table')).toHaveLength(0);
      expect(collectText(root.root)).toContain('最终成功96.0%');
      expect(collectText(root.root)).toContain('查看 2 个通道');

      const expandButton = root.root.findByProps({ 'aria-label': '展开 GPT 主路由 通道详情' });
      await act(async () => {
        expandButton.props.onClick();
      });

      expect(collectText(root.root)).toContain('主站 · account-a');
      expect(collectText(root.root)).toContain('收起通道');
    } finally {
      root?.unmount();
    }
  });
});
