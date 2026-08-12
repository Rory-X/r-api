import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import CredentialVault from './CredentialVault.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteAdapterContracts: vi.fn(),
    getCredentialVaultItems: vi.fn(),
    createCredentialVaultItem: vi.fn(),
    revokeCredentialVaultItem: vi.fn(),
    deleteCredentialVaultItem: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CredentialVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Demo Site', platform: 'new-api', url: 'https://demo.example.com' },
    ]);
    apiMock.getSiteAdapterContracts.mockResolvedValue({
      adapters: [{
        platformName: 'new-api',
        credentialKinds: ['session_token', 'cookie'],
        browser: {
          supported: true,
          modes: ['manual', 'assisted', 'managed'],
          taskTtlSec: 300,
        },
      }],
    });
    apiMock.getCredentialVaultItems.mockResolvedValue({
      items: [{
        id: 7,
        siteId: 1,
        name: 'Demo Session',
        kind: 'session_token',
        status: 'active',
        fingerprint: '123456789012abcdef',
        metadata: { source: 'manual', username: 'alice' },
        version: 1,
        createdAt: '2026-08-03T08:00:00.000Z',
      }, {
        id: 9,
        siteId: null,
        accountId: null,
        name: 'Feishu App Secret',
        kind: 'integration_secret',
        status: 'active',
        fingerprint: 'abcdef1234567890',
        metadata: { source: 'manual', adapterPlatform: 'feishu', purpose: 'app_secret' },
        version: 1,
        createdAt: '2026-08-03T08:00:00.000Z',
      }],
    });
    apiMock.createCredentialVaultItem.mockResolvedValue({
      success: true,
      item: {
        id: 8,
        siteId: 1,
        name: 'New Session',
        kind: 'session_token',
        status: 'active',
        fingerprint: 'new-fingerprint',
        version: 1,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders safe metadata and never renders the secret value', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <CredentialVault />
          </ToastProvider>,
        );
      });
      await flushMicrotasks();

      const text = root.root.children.map((child) => String(child)).join('');
      expect(root.root.findByType('h2').children.join('')).toBe('凭证中心');
      expect(root.root.findAll((node) => node.type === 'strong').some((node) => node.children.includes('Demo Session'))).toBe(true);
      expect(root.root.findAll((node) => node.type === 'strong').some((node) => node.children.includes('Feishu App Secret'))).toBe(true);
      expect(root.root.findAll((node) => node.type === 'span').some((node) => node.children.includes('归属：系统集成'))).toBe(true);
      expect(root.root.findAll((node) => node.type === 'span').some((node) => node.children.includes('系统集成密钥'))).toBe(true);
      expect(text).not.toContain('session-secret');
      expect(text).not.toContain('ciphertext');

      const filterSelectShells = root.root.findAll((node) => (
        node.type === 'span'
        && typeof node.props.className === 'string'
        && node.props.className.includes('ui-select-shell')
      ));
      expect(filterSelectShells.map((node) => node.props.style)).toEqual([
        { width: 240 },
        { width: 160 },
      ]);
    } finally {
      root?.unmount();
    }
  });
});
