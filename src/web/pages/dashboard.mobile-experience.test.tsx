import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Dashboard from './Dashboard.js';
import { installDashboardSnapshotCompat } from './testApiCompat.js';

const { apiMock, isMobileMock } = vi.hoisted(() => ({
  apiMock: {
    getDashboard: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    getDashboardInsights: vi.fn(),
    getSiteSnapshot: vi.fn(),
    getSiteDistribution: vi.fn(),
    getSiteTrend: vi.fn(),
    getSites: vi.fn(),
  },
  isMobileMock: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: isMobileMock }));
vi.mock('../components/charts/SiteDistributionChart.js', () => ({
  default: () => <div data-testid="site-distribution-chart">站点分布图</div>,
}));
vi.mock('../components/charts/SiteTrendChart.js', () => ({
  default: () => <div data-testid="site-trend-chart">使用趋势图</div>,
}));
vi.mock('../components/ModelAnalysisPanel.js', () => ({
  default: () => <div data-testid="model-analysis-panel">模型分析内容</div>,
}));

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

describe('Dashboard mobile experience', () => {
  let root: ReactTestRenderer | undefined;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.mockReturnValue(true);
    installDashboardSnapshotCompat(apiMock);
    apiMock.getDashboard.mockResolvedValue({
      totalBalance: 42.5,
      totalUsed: 8.25,
      todaySpend: 1.5,
      todayReward: 2,
      activeAccounts: 3,
      totalAccounts: 4,
      todayCheckin: { success: 2, total: 3 },
      proxy24h: { success: 90, total: 100, totalTokens: 125_000 },
      performance: { windowSeconds: 60, requestsPerMinute: 17, tokensPerMinute: 7_974 },
      siteAvailability: [],
      modelAnalysis: null,
    });
    apiMock.getSiteDistribution.mockResolvedValue({ distribution: [{ name: 'A', value: 1 }] });
    apiMock.getSiteTrend.mockResolvedValue({ trend: [{ date: '2026-08-15', amount: 1 }] });
    apiMock.getSites.mockResolvedValue([]);
    globalThis.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
    } as unknown as Document;
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
    globalThis.document = originalDocument;
  });

  it('replaces the desktop stat grid with a compact operational summary and shortcuts', async () => {
    await act(async () => {
      root = create(
        <MemoryRouter>
          <ToastProvider>
            <Dashboard />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    expect(root!.root.findAll((node) => node.props.className === 'dashboard-stat-grid')).toHaveLength(0);
    expect(root!.root.findAll((node) => node.props.className === 'dashboard-mobile-overview')).toHaveLength(1);
    const shortcutNavigation = root!.root.findByProps({ 'aria-label': '首页快捷管理' });
    expect(shortcutNavigation.findAllByType('a')).toHaveLength(4);

    const pageText = collectText(root!.root);
    expect(pageText).toContain('24 小时请求成功率90%');
    expect(pageText).toContain('RPM17');
    expect(pageText).toContain('TPM8K');
    expect(pageText).toContain('管理渠道');
    expect(pageText).toContain('调整路由');
    expect(pageText).toContain('管理密钥');
    expect(pageText).toContain('查看日志');
  });

  it('keeps site charts collapsed and renders one selected chart at a time', async () => {
    await act(async () => {
      root = create(
        <MemoryRouter>
          <ToastProvider>
            <Dashboard />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const findChartPanels = () => root!.root.findAll((node) => (
      typeof node.props.className === 'string'
      && node.props.className.includes('chart-panel-enter')
    ));
    expect(findChartPanels()).toHaveLength(0);

    const expandButton = root!.root.find((node) => (
      node.type === 'button' && collectText(node) === '展开趋势'
    ));
    await act(async () => {
      expandButton.props.onClick();
      await Promise.resolve();
    });

    expect(findChartPanels()).toHaveLength(1);
    expect(root!.root.findAllByProps({ 'data-testid': 'site-distribution-chart' })).toHaveLength(1);
    expect(root!.root.findAllByProps({ 'data-testid': 'site-trend-chart' })).toHaveLength(0);

    const trendButton = root!.root.find((node) => (
      node.type === 'button' && collectText(node) === '使用趋势'
    ));
    await act(async () => {
      trendButton.props.onClick();
      await Promise.resolve();
    });

    expect(findChartPanels()).toHaveLength(1);
    expect(root!.root.findAllByProps({ 'data-testid': 'site-distribution-chart' })).toHaveLength(0);
    expect(root!.root.findAllByProps({ 'data-testid': 'site-trend-chart' })).toHaveLength(1);
  });

  it('keeps model analysis and site information collapsed until requested', async () => {
    await act(async () => {
      root = create(
        <MemoryRouter>
          <ToastProvider>
            <Dashboard />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const findToggle = (controls: string) => root!.root.findByProps({ 'aria-controls': controls });

    expect(findToggle('dashboard-model-analysis-content').props['aria-expanded']).toBe(false);
    expect(findToggle('dashboard-site-info-content').props['aria-expanded']).toBe(false);
    expect(root!.root.findAllByProps({ id: 'dashboard-model-analysis-content' })).toHaveLength(0);
    expect(root!.root.findAllByProps({ id: 'dashboard-site-info-content' })).toHaveLength(0);

    await act(async () => {
      findToggle('dashboard-model-analysis-content').props.onClick();
      await Promise.resolve();
    });
    await flushMicrotasks();

    expect(root!.root.findAllByProps({ id: 'dashboard-model-analysis-content' })).toHaveLength(1);
    expect(root!.root.findAllByProps({ 'data-testid': 'model-analysis-panel' })).toHaveLength(1);

    await act(async () => {
      findToggle('dashboard-site-info-content').props.onClick();
      await Promise.resolve();
    });

    expect(root!.root.findAllByProps({ id: 'dashboard-site-info-content' })).toHaveLength(1);

    await act(async () => {
      findToggle('dashboard-model-analysis-content').props.onClick();
      findToggle('dashboard-site-info-content').props.onClick();
      await Promise.resolve();
    });

    expect(root!.root.findAllByProps({ id: 'dashboard-model-analysis-content' })).toHaveLength(0);
    expect(root!.root.findAllByProps({ id: 'dashboard-site-info-content' })).toHaveLength(0);
  });
});
