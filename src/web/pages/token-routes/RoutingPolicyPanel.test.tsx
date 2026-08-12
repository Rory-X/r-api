import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ToastProvider } from '../../components/Toast.js';
import ModernSelect from '../../components/ModernSelect.js';
import RoutingPolicyPanel from './RoutingPolicyPanel.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRuntimeSettings: vi.fn(),
    updateRuntimeSettings: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({ api: apiMock }));

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

describe('RoutingPolicyPanel', () => {
  let root: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getRuntimeSettings.mockResolvedValue({
      firstByteRoutingPolicy: {
        enabled: true,
        baselineMs: 2_500,
        penaltyWindowMs: 10_000,
        maxPenaltyRatio: 0.65,
        minSamples: 5,
      },
      proxyFirstByteTimeoutSec: 0,
      tokenRouterFailureCooldownMaxSec: 30 * 24 * 60 * 60,
      disableCrossProtocolFallback: false,
      routingFallbackUnitCost: 1,
      routingWeights: {
        baseWeightFactor: 0.5,
        valueScoreFactor: 0.5,
        costWeight: 0.4,
        balanceWeight: 0.3,
        usageWeight: 0.3,
      },
      balanceRoutingPolicy: {
        mode: 'observe_only',
        threshold: 0,
        softAvoidMultiplier: 0.1,
      },
    });
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
  });

  it('saves first-byte learning and current-request protection as one routing policy', async () => {
    await act(async () => {
      root = create(
        <ToastProvider>
          <RoutingPolicyPanel />
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const findNumberInput = (ariaLabel: string) => root!.root.find((node) => (
      node.type === 'input'
      && node.props.type === 'number'
      && node.props['aria-label'] === ariaLabel
    ));

    await act(async () => {
      findNumberInput('首字调度基线毫秒').props.onChange({ target: { value: '3200' } });
      findNumberInput('首字调度最低样本数').props.onChange({ target: { value: '7' } });
      findNumberInput('首字超时秒数').props.onChange({ target: { value: '8' } });
      findNumberInput('路由失败冷却上限数值').props.onChange({ target: { value: '10' } });
    });

    const cooldownUnitSelect = root!.root.find((node) => (
      node.type === ModernSelect
      && Array.isArray(node.props.options)
      && node.props.options.some((option: { value?: string }) => option.value === 'day')
      && node.props.options.some((option: { value?: string }) => option.value === 'second')
    ));
    await act(async () => {
      cooldownUnitSelect.props.onChange('second');
    });

    const saveButton = root!.root.find((node) => (
      node.type === 'button'
      && collectText(node).trim() === '保存调度策略'
    ));
    await act(async () => {
      saveButton.props.onClick();
    });
    await flushMicrotasks();

    expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({
      firstByteRoutingPolicy: {
        enabled: true,
        baselineMs: 3_200,
        penaltyWindowMs: 10_000,
        maxPenaltyRatio: 0.65,
        minSamples: 7,
      },
      proxyFirstByteTimeoutSec: 8,
      tokenRouterFailureCooldownMaxSec: 10,
      disableCrossProtocolFallback: false,
      routingFallbackUnitCost: 1,
      routingWeights: {
        baseWeightFactor: 0.5,
        valueScoreFactor: 0.5,
        costWeight: 0.4,
        balanceWeight: 0.3,
        usageWeight: 0.3,
      },
      balanceRoutingPolicy: {
        mode: 'observe_only',
        threshold: 0,
        softAvoidMultiplier: 0.1,
      },
    });
  });
});
