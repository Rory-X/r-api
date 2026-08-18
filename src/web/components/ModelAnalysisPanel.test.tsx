import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import ModelAnalysisPanel from './ModelAnalysisPanel.js';

const { chartSpecs } = vi.hoisted(() => ({ chartSpecs: [] as any[] }));

vi.mock('@visactor/react-vchart', () => ({
  VChart: ({ spec }: { spec: any }) => {
    chartSpecs.push(spec);
    return <div>mock-chart</div>;
  },
}));

vi.mock('./BrandIcon.js', () => ({
  InlineBrandIcon: () => <span>brand-icon</span>,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

describe('ModelAnalysisPanel token summaries', () => {
  const originalDocument = globalThis.document;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalMutationObserver = globalThis.MutationObserver;

  beforeEach(() => {
    chartSpecs.length = 0;
    globalThis.document = {
      documentElement: {},
    } as unknown as Document;
    globalThis.getComputedStyle = vi.fn(() => ({
      getPropertyValue: () => '#9ca3af',
    })) as unknown as typeof getComputedStyle;
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof MutationObserver;
  });

  afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.MutationObserver = originalMutationObserver;
  });

  it('renders total token summaries with compact units', () => {
    let root!: WebTestRenderer;

    act(() => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: {
              spend: 0.123456,
              calls: 10,
              tokens: 611_540_335,
            },
          }}
        />,
      );
    });

    const rendered = collectText(root!.root);

    expect(rendered).toContain('总 Tokens');
    expect(rendered).toContain('611.5M');

    root?.unmount();
  });

  it('renders with fallback label color when browser theme APIs are unavailable', async () => {
    globalThis.document = {
      documentElement: {},
    } as unknown as Document;
    Reflect.deleteProperty(globalThis as typeof globalThis & Record<string, unknown>, 'getComputedStyle');
    Reflect.deleteProperty(globalThis as typeof globalThis & Record<string, unknown>, 'MutationObserver');

    let root!: WebTestRenderer;

    await expect(act(async () => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: {
              spend: 0.123456,
              calls: 10,
              tokens: 611_540_335,
            },
          }}
        />,
      );
    })).resolves.toBeUndefined();

    root?.unmount();
  });

  it('uses responsive layout hooks and confines every chart tooltip', () => {
    let root!: WebTestRenderer;

    act(() => {
      root = create(
        <ModelAnalysisPanel
          data={{
            totals: { spend: 3.5, calls: 12, tokens: 9000 },
            spendDistribution: [{ model: 'gpt-5', spend: 3.5, calls: 12 }],
            spendTrend: [{ day: '08-15', spend: 3.5 }],
            callsDistribution: [{ model: 'gpt-5', calls: 12, share: 100 }],
            callRanking: [{ model: 'gpt-5', calls: 12, successRate: 100, avgLatencyMs: 800, spend: 3.5, tokens: 9000 }],
          }}
        />,
      );
    });

    expect(root.root.findByProps({ className: 'model-analysis-panel' })).toBeTruthy();
    expect(root.root.findByProps({ className: 'model-analysis-summary' })).toBeTruthy();
    expect(root.root.findByProps({ className: 'pill-tabs model-analysis-tabs' })).toBeTruthy();
    expect(chartSpecs.at(-1)?.tooltip?.confine).toBe(true);

    const clickTab = (label: string) => {
      const button = root.root.findAllByType('button').find((node) => collectText(node).includes(label));
      expect(button).toBeTruthy();
      act(() => button!.props.onClick());
      expect(chartSpecs.at(-1)?.tooltip?.confine).toBe(true);
    };

    clickTab('消耗趋势');
    clickTab('调用分布');

    act(() => {
      root.root.findAllByType('button').find((node) => collectText(node).includes('排行榜'))!.props.onClick();
    });
    expect(root.root.findByProps({ className: 'model-analysis-ranking' })).toBeTruthy();

    root.unmount();
  });
});
