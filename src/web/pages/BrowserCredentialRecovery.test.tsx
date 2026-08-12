import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import BrowserCredentialRecovery from './BrowserCredentialRecovery.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    claimBrowserRecoveryTask: vi.fn(),
    completeBrowserRecoveryTask: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

describe('BrowserCredentialRecovery page', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('leaves the one-time token unclaimed until manual fallback is selected', async () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: {
        hash: '#task=task-1&token=abcdefghijklmnopqrstuvwxyzABCDEF123456',
        pathname: '/browser-credential-recovery',
        search: '',
      },
      history: { replaceState },
    });
    vi.stubGlobal('document', { title: 'Metapi' });
    apiMock.claimBrowserRecoveryTask.mockResolvedValue({
      task: {
        id: 'task-1',
        siteId: 1,
        mode: 'assisted',
        status: 'claimed',
        credentialName: '浏览器会话',
        credentialKind: 'browser_storage',
        adapterPlatform: 'new-api',
        targetUrl: 'https://gateway.example/login',
        targetOrigin: 'https://gateway.example',
        allowedOrigins: ['https://gateway.example'],
        fields: [{ name: 'session_cookie', kind: 'cookie', required: true }],
        requiresUserGesture: true,
        expiresAt: '2026-08-04T08:00:00.000Z',
      },
      claimToken: 'claim-token-abcdefghijklmnopqrstuvwxyz123456',
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<BrowserCredentialRecovery />);
      });

      expect(apiMock.claimBrowserRecoveryTask).not.toHaveBeenCalled();
      expect(collectText(root.root)).toContain('一次性令牌尚未领取');

      const manualButton = root.root.find((node) =>
        node.type === 'button' && collectText(node).trim() === '手动填写并领取');
      await act(async () => {
        manualButton.props.onClick();
        await Promise.resolve();
      });

      expect(apiMock.claimBrowserRecoveryTask).toHaveBeenCalledWith(
        'task-1',
        'abcdefghijklmnopqrstuvwxyzABCDEF123456',
        'browser-web',
      );
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(collectText(root.root)).toContain('保存 浏览器会话');
    } finally {
      root?.unmount();
    }
  });
});
