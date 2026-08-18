import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import Accounts from './Accounts.js';
import { installAccountsSnapshotCompat } from './testApiCompat.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getAccounts: vi.fn(),
    getAccountsSnapshot: vi.fn(),
    getSites: vi.fn(),
    getAccountTokens: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children
    .map((child) => {
      if (typeof child === 'string') return child;
      return collectText(child);
    })
    .join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Accounts tokens embedded header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the accounts page header when showing the 上游 API Token segment', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        status: 'active',
        credentialMode: 'session',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const pageHeaders = root.root.findAll((node) => {
        const className = node.props?.className;
        return typeof className === 'string' && className.split(/\s+/).includes('page-header');
      });
      expect(pageHeaders).toHaveLength(1);

      const buttonTexts = root.root
        .findAll((node) => node.type === 'button')
        .map((node) => collectText(node));
      expect(buttonTexts).toContain('同步上游 Token');
      expect(buttonTexts).toContain('同步全部面板账号');
      expect(buttonTexts).toContain('在上游创建 Token');
    } finally {
      root?.unmount();
    }
  });

  it('keeps signed tokens under the panel account hierarchy', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        status: 'active',
        credentialMode: 'session',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=tokens']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const primaryNavigation = root.root.find((node) => node.props?.['data-testid'] === 'accounts-primary-navigation');
      const topLevelTabs = primaryNavigation.findAll((node) => node.type === 'button');
      const tabList = root.root.find((node) => node.props?.['data-testid'] === 'accounts-secondary-navigation');
      const subTabs = tabList.findAll((node) => node.type === 'button');

      expect(collectText(tabList)).toContain('签发令牌');
      expect(subTabs).toHaveLength(2);
      expect(subTabs[1]?.props['aria-selected']).toBe(true);
      expect(subTabs[0]?.props['data-tooltip']).toBe('用于登录、签到、余额和状态维护');
      expect(subTabs[1]?.props['data-tooltip']).toBe('属于面板账号的上游 API Token，供路由通道自动使用');
      expect(subTabs[0]?.findAll((node) => node.type === 'small')).toHaveLength(0);
      expect(subTabs[1]?.findAll((node) => node.type === 'small')).toHaveLength(0);
      expect(collectText(root.root)).toContain('面板账号的下游资源：签发令牌');
      expect(topLevelTabs.some((node) => collectText(node) === '签发令牌')).toBe(false);
    } finally {
      root?.unmount();
    }
  });
});
