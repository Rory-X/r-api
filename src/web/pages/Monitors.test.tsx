import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import Monitors from './Monitors.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getMonitorConfig: vi.fn(),
    updateMonitorConfig: vi.fn(),
    initMonitorSession: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Monitors AIHub LinuxDo OAuth flow', () => {
  const open = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
      cancelAnimationFrame: vi.fn(),
      open,
      location: { origin: 'http://127.0.0.1:4000' },
    });
    apiMock.getMonitorConfig.mockResolvedValue({
      ldohCookieConfigured: true,
      ldohCookieMasked: 'ldoh-masked',
      aihubCookieConfigured: false,
      aihubCookieMasked: '',
    });
    apiMock.updateMonitorConfig.mockResolvedValue({ success: true });
    apiMock.initMonitorSession.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('offers the same LinuxDo OAuth entry when AIHub has no saved cookie', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><Monitors /></ToastProvider>);
      });
      await flushMicrotasks();
      const tab = root.root.find((node) => node.type === 'button' && collectText(node).includes('aihub.top'));
      await act(async () => { tab.props.onClick(); });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('该站点需要 LinuxDo OAuth 授权');
      const iframe = root.root.find((node) => node.type === 'iframe' && node.props.title === 'monitor-aihub-top');
      expect(iframe.props.src).toBe('https://aihub.top/');

      const authorize = root.root.find((node) => node.type === 'button' && collectText(node).includes('授权登录'));
      authorize.props.onClick();
      expect(open).toHaveBeenCalledWith(
        'https://aihub.top/api/oauth/initiate?returnTo=%2F',
        '_blank',
        'noopener,noreferrer',
      );
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('saves an AIHub cookie independently and enters its proxy console', async () => {
    apiMock.getMonitorConfig.mockResolvedValue({
      ldohCookieConfigured: true,
      ldohCookieMasked: 'ldoh-masked',
      aihubCookieConfigured: true,
      aihubCookieMasked: 'aihub-masked',
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><Monitors /></ToastProvider>);
      });
      await flushMicrotasks();
      const tab = root.root.find((node) => node.type === 'button' && collectText(node).includes('aihub.top'));
      await act(async () => { tab.props.onClick(); });
      await flushMicrotasks();

      expect(collectText(root.root)).toContain('已保存 Cookie：aihub-masked');
      expect(collectText(root.root)).not.toContain('已保存 Cookie：ldoh-masked');
      const iframe = root.root.find((node) => node.type === 'iframe' && node.props.title === 'monitor-aihub-top');
      expect(iframe.props.src).toBe('/monitor-proxy/aihub/');

      const input = root.root.find((node) => node.type === 'input' && node.props.className === 'monitor-cookie-input');
      await act(async () => { input.props.onChange({ target: { value: 'fresh-aihub-session' } }); });
      const save = root.root.find((node) => node.type === 'button' && collectText(node).includes('保存 Cookie'));
      await act(async () => {
        save.props.onClick();
        await Promise.resolve();
      });
      expect(apiMock.updateMonitorConfig).toHaveBeenCalledWith({ aihubCookie: 'fresh-aihub-session' });
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });
});
