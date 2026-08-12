import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import TokenRoutes from './TokenRoutes.js';

const { apiMock, getBrandMock } = vi.hoisted(() => ({
  apiMock: {
    getRoutesSummary: vi.fn(),
    getRouteChannels: vi.fn(),
    getModelTokenCandidates: vi.fn(),
    getRouteDecision: vi.fn(),
    getRouteDecisionsBatch: vi.fn(),
    getRouteWideDecisionsBatch: vi.fn(),
    getRuntimeSettings: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    updateRoute: vi.fn(),
  },
  getBrandMock: vi.fn(),
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: ({ brand, icon, model }: { brand?: { name?: string } | null; icon?: string | null; model?: string | null }) => (
    <span>{brand?.name || icon || model || ''}</span>
  ),
  InlineBrandIcon: ({ model }: { model: string }) => model ? <span>{model}</span> : null,
  getBrand: (...args: unknown[]) => getBrandMock(...args),
  hashColor: () => 'linear-gradient(135deg,#4f46e5,#818cf8)',
  normalizeBrandIconKey: (icon: string) => icon,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TokenRoutes routing strategy updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getBrandMock.mockReset();
    getBrandMock.mockReturnValue(null);
    apiMock.getRoutesSummary
      .mockResolvedValue([
        {
          id: 1,
          modelPattern: 'gpt-4o-mini',
          displayName: 'gpt-4o-mini',
          displayIcon: null,
          modelMapping: null,
          routingStrategy: 'weighted',
          enabled: true,
          channelCount: 0,
          enabledChannelCount: 0,
          siteNames: [],
          decisionSnapshot: null,
          decisionRefreshedAt: null,
        },
      ]);
    apiMock.getRouteChannels.mockResolvedValue([]);
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
    apiMock.getRouteDecision.mockResolvedValue({ decision: null });
    apiMock.getRouteDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRouteWideDecisionsBatch.mockResolvedValue({ decisions: {} });
    apiMock.getRuntimeSettings.mockResolvedValue({
      firstByteRoutingPolicy: {
        enabled: true,
        baselineMs: 2_500,
        penaltyWindowMs: 10_000,
        maxPenaltyRatio: 0.65,
        minSamples: 5,
      },
      routingWeights: {},
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    apiMock.updateRoute.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('promotes global scheduling policy to a first-level route workspace view', async () => {
    let root!: ReturnType<typeof create>;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes?view=strategy']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const pageText = collectText(root.root);
      expect(pageText).toContain('路由编排');
      expect(pageText).toContain('调度策略');
      expect(pageText).toContain('历史首字时间调度');
      expect(pageText).toContain('当前请求保护');
      expect(pageText).not.toContain('搜索模型路由...');
      expect(apiMock.getRuntimeSettings).toHaveBeenCalled();
    } finally {
      root?.unmount();
    }
  });

  it('keeps the optimistic routing strategy when refresh fails after a successful save', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const expandButton = root.root.find((node) => (
        node.type === 'div'
        && String(node.props.className || '').includes('route-card-collapsed')
      ));
      await act(async () => {
        expandButton.props.onClick();
      });
      await flushMicrotasks();

      apiMock.getRoutesSummary.mockRejectedValueOnce(new Error('refresh failed'));

      const roundRobinOption = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-strategy'] === 'round_robin'
      ));

      await act(async () => {
        roundRobinOption.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(1, { routingStrategy: 'round_robin' });
      expect(apiMock.getRoutesSummary).toHaveBeenCalledTimes(2);

      const selectedStrategy = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-strategy'] === 'round_robin'
      ));
      expect(collectText(selectedStrategy)).toBe('自动轮询');
      expect(selectedStrategy.props['aria-checked']).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('supports switching to stable_first and keeps the optimistic label when refresh fails', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const expandButton = root.root.find((node) => (
        node.type === 'div'
        && String(node.props.className || '').includes('route-card-collapsed')
      ));
      await act(async () => {
        expandButton.props.onClick();
      });
      await flushMicrotasks();

      apiMock.getRoutesSummary.mockRejectedValueOnce(new Error('refresh failed'));

      const stableFirstOption = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-strategy'] === 'stable_first'
      ));

      await act(async () => {
        stableFirstOption.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(1, { routingStrategy: 'stable_first' });

      const selectedStrategy = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-strategy'] === 'stable_first'
      ));
      expect(collectText(selectedStrategy)).toBe('自动稳定');
      expect(selectedStrategy.props['aria-checked']).toBe(true);
    } finally {
      root?.unmount();
    }
  });

  it('supports switching to manual scheduling mode', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/routes']}>
            <ToastProvider>
              <TokenRoutes />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const expandButton = root.root.find((node) => (
        node.type === 'div'
        && String(node.props.className || '').includes('route-card-collapsed')
      ));
      await act(async () => {
        expandButton.props.onClick();
      });
      await flushMicrotasks();

      apiMock.getRoutesSummary.mockRejectedValueOnce(new Error('refresh failed'));
      const manualOption = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-strategy'] === 'manual'
      ));

      await act(async () => {
        manualOption.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateRoute).toHaveBeenCalledWith(1, { routingStrategy: 'manual' });
      expect(apiMock.getRouteDecision).toHaveBeenCalledWith('gpt-4o-mini');
      const selectedStrategy = root.root.find((node) => (
        node.type === 'button'
        && node.props['data-strategy'] === 'manual'
      ));
      expect(collectText(selectedStrategy)).toBe('手动顺序');
      expect(selectedStrategy.props['aria-checked']).toBe(true);
    } finally {
      root?.unmount();
    }
  });
});
