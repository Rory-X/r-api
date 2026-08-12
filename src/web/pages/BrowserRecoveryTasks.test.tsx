import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toast.js';
import BrowserRecoveryTasks from './BrowserRecoveryTasks.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteAdapterContracts: vi.fn(),
    getBrowserRecoveryTasks: vi.fn(),
    getAccounts: vi.fn(),
    createBrowserRecoveryTask: vi.fn(),
    activateBrowserRecoveryTask: vi.fn(),
    cancelBrowserRecoveryTask: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('BrowserRecoveryTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([{ id: 1, name: 'Demo', platform: 'demo' }]);
    apiMock.getSiteAdapterContracts.mockResolvedValue({ adapters: [] });
    apiMock.getAccounts.mockResolvedValue([]);
    apiMock.getBrowserRecoveryTasks.mockResolvedValue({
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `task-${index + 1}`,
        siteId: 1,
        accountId: null,
        mode: 'assisted',
        status: 'expired',
        credentialName: `凭证任务 ${index + 1}`,
        adapterPlatform: 'demo',
        targetOrigin: 'https://demo.example.com',
        expiresAt: '2026-08-12T08:00:00.000Z',
        resultCredentialId: null,
      })),
    });
  });

  it('shows eight tasks per page instead of stretching the whole page', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <BrowserRecoveryTasks />
          </ToastProvider>,
        );
      });
      await flush();

      expect(collectText(root.root)).toContain('凭证任务 8');
      expect(collectText(root.root)).not.toContain('凭证任务 9');
      const next = root.root.find((node) => node.type === 'button' && collectText(node) === '下一页');
      await act(async () => { next.props.onClick(); });

      expect(collectText(root.root)).toContain('凭证任务 9');
      expect(collectText(root.root)).toContain('凭证任务 10');
      const visibleTaskTitles = root.root
        .findAll((node) => node.type === 'strong' && collectText(node).startsWith('凭证任务 '))
        .map((node) => collectText(node));
      expect(visibleTaskTitles).toEqual(['凭证任务 9', '凭证任务 10']);
    } finally {
      root?.unmount();
    }
  });
});
