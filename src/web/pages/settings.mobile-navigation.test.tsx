import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Settings from './Settings.js';

const { apiMock, isMobileMock } = vi.hoisted(() => ({
  apiMock: {
    getAuthInfo: vi.fn(),
    getRuntimeSettings: vi.fn(),
    getDownstreamApiKeys: vi.fn(),
    getRoutesLite: vi.fn(),
    getRuntimeDatabaseConfig: vi.fn(),
    getBrandList: vi.fn(),
    getModelTokenCandidates: vi.fn(),
  },
  isMobileMock: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('../components/useIsMobile.js', () => ({ useIsMobile: isMobileMock }));
vi.mock('../components/BrandIcon.js', () => ({
  BrandGlyph: () => null,
  InlineBrandIcon: () => null,
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon,
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

describe('Settings mobile category navigation', () => {
  let root: ReactTestRenderer | undefined;
  const contentScrollIntoView = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.mockReturnValue(true);
    apiMock.getAuthInfo.mockResolvedValue({ masked: 'sk-****' });
    apiMock.getRuntimeSettings.mockResolvedValue({
      checkinCron: '0 8 * * *',
      balanceRefreshCron: '0 * * * *',
      logCleanupCron: '0 6 * * *',
      logCleanupRetentionDays: 30,
      adminIpAllowlist: [],
    });
    apiMock.getDownstreamApiKeys.mockResolvedValue({ items: [] });
    apiMock.getRoutesLite.mockResolvedValue([]);
    apiMock.getRuntimeDatabaseConfig.mockResolvedValue({
      active: { dialect: 'sqlite', connection: '(default sqlite path)', ssl: false },
      saved: null,
      restartRequired: false,
    });
    apiMock.getBrandList.mockResolvedValue({ brands: [] });
    apiMock.getModelTokenCandidates.mockResolvedValue({ models: {} });
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
  });

  it('keeps five categories available and switches content from the sticky tab strip', async () => {
    await act(async () => {
      root = create(
        <MemoryRouter>
          <ToastProvider>
            <Settings />
          </ToastProvider>
        </MemoryRouter>,
        {
          createNodeMock: (element) => (
            element.props.className?.includes?.('settings-tab-content')
              ? { scrollIntoView: contentScrollIntoView }
              : null
          ),
        },
      );
    });
    await flushMicrotasks();

    const navigation = root!.root.findByProps({ 'aria-label': '系统设置分类导航' });
    const tabs = root!.root.findAll((node) => node.props.role === 'tab');
    const triggerScrollIntoView = vi.fn();

    expect(navigation.props['aria-orientation']).toBe('horizontal');
    expect(tabs).toHaveLength(5);
    expect(tabs.map(collectText)).toEqual(expect.arrayContaining([
      expect.stringContaining('安全与访问'),
      expect.stringContaining('自动化任务'),
      expect.stringContaining('网络与代理'),
      expect.stringContaining('AI 请求与路由'),
      expect.stringContaining('数据与维护'),
    ]));
    expect(tabs[0].props['aria-selected']).toBe(true);

    await act(async () => {
      tabs[2].props.onClick({ currentTarget: { scrollIntoView: triggerScrollIntoView } });
    });

    const selectedTab = root!.root.findAll((node) => (
      node.props.role === 'tab' && node.props['aria-selected'] === true
    ));
    expect(selectedTab).toHaveLength(1);
    expect(collectText(selectedTab[0])).toContain('网络与代理');
    expect(triggerScrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
      inline: 'center',
    });
    expect(contentScrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('supports keyboard traversal between categories', async () => {
    await act(async () => {
      root = create(
        <MemoryRouter>
          <ToastProvider>
            <Settings />
          </ToastProvider>
        </MemoryRouter>,
      );
    });
    await flushMicrotasks();

    const preventDefault = vi.fn();
    const firstTab = root!.root.findAll((node) => node.props.role === 'tab')[0];
    await act(async () => {
      firstTab.props.onKeyDown({ key: 'ArrowRight', preventDefault });
    });

    const selectedTab = root!.root.find((node) => (
      node.props.role === 'tab' && node.props['aria-selected'] === true
    ));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(collectText(selectedTab)).toContain('自动化任务');
  });
});
