import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../../components/Toast.js';
import ChannelOverview from './ChannelOverview.js';

const { apiMock, isMobileMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getAccounts: vi.fn(),
    getCredentialVaultItems: vi.fn(),
  },
  isMobileMock: vi.fn(),
}));

vi.mock('../../api.js', () => ({ api: apiMock }));
vi.mock('../../components/useIsMobile.js', () => ({ useIsMobile: isMobileMock }));

function collectText(node: any): string {
  if (Array.isArray(node)) return node.map(collectText).join('');
  if (typeof node === 'string') return node;
  return (node?.children || []).map(collectText).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ChannelOverview', () => {
  let root: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.mockReturnValue(false);
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Panel Site',
        url: 'https://panel.example.com',
        platform: 'new-api',
        apiEndpoints: [{ enabled: true }, { enabled: false }],
      },
      {
        id: 2,
        name: 'OAuth Site',
        url: 'https://oauth.example.com',
        platform: 'codex',
      },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      { id: 10, siteId: 1, status: 'active', oauthProvider: null },
      { id: 11, siteId: 1, status: 'disabled', oauthProvider: null },
      { id: 12, siteId: 2, status: 'active', oauthProvider: 'codex' },
    ]);
    apiMock.getCredentialVaultItems.mockResolvedValue({
      items: [
        { id: 20, siteId: 1, status: 'active' },
        { id: 21, siteId: 1, status: 'revoked' },
        { id: 22, siteId: null, status: 'active' },
      ],
      total: 3,
    });
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
  });

  it('counts only site-scoped credentials in the channel overview', async () => {
    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/channels']}>
            <ChannelOverview />
          </MemoryRouter>
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const text = collectText(root!.toJSON());
    expect(apiMock.getAccounts).toHaveBeenCalledWith();
    expect(text).toContain('2个上游站点');
    expect(text).toContain('1个官方渠道');
    expect(text).toContain('2个普通连接');
    expect(text).toContain('1个渠道凭证');
    expect(text).toContain('Panel Site');
    expect(text).toContain('OAuth Site');
    expect(text).toContain('1/2');
    expect(text).toContain('1 个 API 端点');
  });

  it('renders actionable channel cards instead of the wide table on mobile', async () => {
    isMobileMock.mockReturnValue(true);

    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/channels']}>
            <ChannelOverview />
          </MemoryRouter>
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    expect(root!.root.findAllByProps({ 'data-testid': 'channel-overview-mobile-list' })).toHaveLength(1);
    expect(root!.root.findAllByType('table')).toHaveLength(0);
    expect(root!.root.findAll((node) => String(node.props?.className || '').startsWith('mobile-card '))).toHaveLength(2);
    const text = collectText(root!.toJSON());
    expect(text).toContain('Panel Site');
    expect(text).toContain('API 端点1');
    expect(text).toContain('站点');
    expect(text).toContain('连接');
  });

  it('shows Site breaker scope, cooldown and failure reason', async () => {
    apiMock.getSites.mockResolvedValue([{
      id: 1,
      name: 'Broken Site',
      url: 'https://broken.example.com',
      platform: 'new-api',
      runtimeHealth: [{
        scope: 'site',
        modelName: null,
        state: 'open',
        breakerLevel: 2,
        remainingMs: 125_000,
        probeInFlight: false,
        recoverySuccessCount: 0,
        recoverySuccessThreshold: 2,
        recoveryTrafficRatio: 0.1,
        lastFailureDomain: 'endpoint',
        lastFailureReason: 'fetch failed: ECONNREFUSED',
      }],
    }]);
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getCredentialVaultItems.mockResolvedValue({ items: [], total: 0 });

    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/channels']}>
            <ChannelOverview />
          </MemoryRouter>
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const text = collectText(root!.toJSON());
    expect(text).toContain('熔断中');
    expect(text).toContain('站点主地址');
    expect(text).toContain('级别 2');
    expect(text).toContain('3 分钟');
    expect(text).toContain('endpoint: fetch failed: ECONNREFUSED');
  });

  it('shows an isolated API endpoint cooldown without marking the whole Site unavailable', async () => {
    apiMock.getSites.mockResolvedValue([{
      id: 1,
      name: 'Endpoint Pool Site',
      url: 'https://panel.example.com',
      platform: 'new-api',
      runtimeHealth: [],
      apiEndpoints: [{
        id: 91,
        url: 'https://api-a.example.com',
        enabled: true,
        cooldownUntil: new Date(Date.now() + 125_000).toISOString(),
        lastFailureReason: 'fetch failed: ECONNREFUSED',
      }],
    }]);
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getCredentialVaultItems.mockResolvedValue({ items: [], total: 0 });

    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/channels']}>
            <ChannelOverview />
          </MemoryRouter>
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const text = collectText(root!.toJSON());
    expect(text).toContain('端点冷却中');
    expect(text).toContain('API 端点 #91');
    expect(text).toContain('endpoint: fetch failed: ECONNREFUSED');
  });

  it('shows first-byte soft degradation even when the Site is otherwise healthy', async () => {
    apiMock.getSites.mockResolvedValue([{
      id: 1,
      name: 'Slow First Byte Site',
      url: 'https://slow-first-byte.example.com',
      platform: 'new-api',
      runtimeHealth: [{
        scope: 'model',
        modelName: 'gpt-5.4',
        state: 'healthy',
        breakerLevel: 0,
        remainingMs: 0,
        probeInFlight: false,
        recoverySuccessCount: 0,
        recoverySuccessThreshold: 2,
        recoveryTrafficRatio: 1,
        firstByteLatencyEmaMs: 12_500,
        firstByteSampleCount: 8,
        firstByteMultiplier: 0.35,
      }],
    }]);
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getCredentialVaultItems.mockResolvedValue({ items: [], total: 0 });

    await act(async () => {
      root = create(
        <ToastProvider>
          <MemoryRouter initialEntries={['/channels']}>
            <ChannelOverview />
          </MemoryRouter>
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const text = collectText(root!.toJSON());
    expect(text).toContain('可用');
    expect(text).toContain('模型 gpt-5.4');
    expect(text).toContain('首字 EMA 12500ms');
    expect(text).toContain('8 样本');
    expect(text).toContain('调度倍率 35%');
  });
});
