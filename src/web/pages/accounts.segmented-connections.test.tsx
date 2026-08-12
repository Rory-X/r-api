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

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

describe('Accounts segmented connections view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installAccountsSnapshotCompat(apiMock);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows only apikey connections in the apikey segment and labels unnamed ones as API Key 连接', async () => {
    apiMock.getAccounts.mockResolvedValue([
      {
        id: 1,
        username: 'session-user',
        accessToken: 'session-token',
        apiToken: 'sk-session',
        status: 'active',
        credentialMode: 'session',
        capabilities: { canCheckin: true, canRefreshBalance: true, proxyOnly: false },
        site: { id: 10, name: 'Session Site', platform: 'new-api', status: 'active', url: 'https://session.example.com' },
      },
      {
        id: 2,
        username: '',
        accessToken: '',
        apiToken: 'sk-apikey',
        status: 'active',
        credentialMode: 'apikey',
        capabilities: { canCheckin: false, canRefreshBalance: false, proxyOnly: true },
        site: { id: 11, name: 'Key Site', platform: 'new-api', status: 'active', url: 'https://key.example.com' },
      },
    ]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
      { id: 11, name: 'Key Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts?segment=apikey']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('连接管理');
      expect(rendered).toContain('账号管理');
      expect(rendered).toContain('API Key管理');
      expect(rendered).toContain('上游 API Token');
      expect(rendered).toContain('用于签到、余额、状态维护');
      expect(rendered).toContain('只有 Base URL + Key 时使用，只负责代理调用');
      expect(rendered).toContain('从面板账号同步或创建，供模型请求路由使用');
      expect(rendered).toContain('Key Site');
      expect(rendered).not.toContain('仅代理');
      expect(rendered).not.toContain('session-user');
      expect(rendered).not.toContain('自定义排序');
      expect(rendered).not.toContain('置顶');
      expect(rendered).not.toContain('上移');
      expect(rendered).not.toContain('下移');

      const segmentButtons = root.root.findAll((node) => {
        if (node.type !== 'button') return false;
        const text = collectText(node);
        return text === '账号管理' || text === 'API Key管理' || text === '上游 API Token';
      });
      expect(segmentButtons).toHaveLength(3);
      expect(segmentButtons[0]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[0]?.props['data-tooltip-align']).toBe('start');
      expect(segmentButtons[1]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[1]?.props['data-tooltip-align']).toBe('center');
      expect(segmentButtons[2]?.props['data-tooltip-side']).toBe('bottom');
      expect(segmentButtons[2]?.props['data-tooltip-align']).toBe('end');
    } finally {
      root?.unmount();
    }
  });

  it('uses existing-site guidance instead of asking to add a site when the segment is empty but sites exist', async () => {
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getSites.mockResolvedValue([
      { id: 10, name: 'Session Site', platform: 'new-api', status: 'active' },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([]);

    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/accounts']}>
            <ToastProvider>
              <Accounts />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('暂无 Session 连接');
      expect(rendered).toContain('请为现有站点添加 Session 连接');
      expect(rendered).not.toContain('请先添加站点');
    } finally {
      root?.unmount();
    }
  });
});
