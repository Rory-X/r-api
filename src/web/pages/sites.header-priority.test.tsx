import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import Sites from './Sites.js';

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteDisabledModels: vi.fn().mockResolvedValue({ models: [] }),
    getSiteAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
    updateSite: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('../components/Toast.js', () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => children,
  useToast: () => toastMock,
}));

function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}

describe('Sites header priority', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it.each([undefined, true])('saves and reloads the priority switch from %s', async (initial) => {
    let site = {
      id: 1,
      name: 'Demo Site',
      url: 'https://example.com',
      platform: 'new-api',
      status: 'active',
      customHeaders: '{"Authorization":"Bearer site"}',
      customHeadersOverrideRequestHeaders: initial,
    };
    apiMock.getSites.mockImplementation(async () => [site]);
    apiMock.updateSite.mockImplementation(async (_id: number, payload: Partial<typeof site>) => {
      site = { ...site, ...payload };
      return site;
    });
    let root!: WebTestRenderer;
    const clickButton = async (label: string) => {
      const button = root.root.find((node) => node.type === 'button' && text(node).trim() === label);
      await act(async () => button.props.onClick());
    };
    const findSwitch = () => root.root.findByProps({
      'aria-label': '允许站点自定义请求头覆盖同名出站请求头',
    });
    try {
      await act(async () => {
        root = create(<MemoryRouter><Sites /></MemoryRouter>);
      });
      await clickButton('编辑');
      expect(findSwitch().props.checked).toBe(!!initial);
      const next = !initial;
      await act(async () => findSwitch().props.onChange({ target: { checked: next } }));
      if (next) {
        expect(text(root.root)).toContain('Authorization、Cookie、Content-Type、User-Agent 和 Version');
      }
      await clickButton('保存修改');
      expect(apiMock.updateSite).toHaveBeenCalledWith(1, expect.objectContaining({
        customHeadersOverrideRequestHeaders: next,
        customHeaders: '{"Authorization":"Bearer site"}',
      }));
      expect(toastMock.error).not.toHaveBeenCalled();
      await clickButton('编辑');
      expect(findSwitch().props.checked).toBe(next);
    } finally {
      await act(async () => root?.unmount());
    }
  });
});
