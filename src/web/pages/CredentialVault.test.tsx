import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
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

function collectText(node: ReactTestInstance): string {
  return node.children.map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAll((node) => node.type === 'button' && collectText(node) === label)[0];
  if (!button) throw new Error(`button not found: ${label}`);
  return button;
}

const vaultItems = [{
  id: 7,
  siteId: 1,
  accountId: null,
  name: 'Vault Session',
  kind: 'session_token',
  status: 'active',
  fingerprint: '123456789012abcdef',
  metadata: { source: 'manual', username: 'alice' },
  version: 1,
  createdAt: '2026-08-13T08:00:00.000Z',
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
  createdAt: '2026-08-13T08:00:00.000Z',
}];

describe('CredentialVault', () => {
  let root: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 1, name: 'Demo Site', platform: 'new-api', url: 'https://demo.example.com' },
    ]);
    apiMock.getSiteAdapterContracts.mockResolvedValue({
      adapters: [{
        platformName: 'new-api',
        credentialKinds: ['session_token', 'cookie'],
        browser: { supported: true, modes: ['manual', 'assisted'], taskTtlSec: 300 },
      }],
    });
    apiMock.getCredentialVaultItems.mockResolvedValue({ items: vaultItems, total: vaultItems.length });
    apiMock.createCredentialVaultItem.mockResolvedValue({ success: true });
    apiMock.revokeCredentialVaultItem.mockResolvedValue({ success: true });
    apiMock.deleteCredentialVaultItem.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    root?.unmount();
    root = undefined;
    vi.clearAllMocks();
  });

  async function renderVault() {
    await act(async () => {
      root = create(<ToastProvider><CredentialVault /></ToastProvider>);
    });
    await flushMicrotasks();
    return root!;
  }

  it('is a focused safety vault and excludes official credential workflows', async () => {
    await renderVault();

    expect(root!.root.findByType('h2').children.join('')).toBe('安全凭证库');
    expect(root!.root.findAll((node) => node.type === 'button' && node.props.role === 'tab')).toHaveLength(0);
    const rendered = JSON.stringify(root!.toJSON());
    expect(rendered).toContain('Vault Session');
    expect(rendered).toContain('Feishu App Secret');
    expect(rendered).toContain('归属：系统集成');
    expect(rendered).toContain('官方订阅与 OAuth 凭证由“官方凭证池”独立管理');
    expect(rendered).not.toContain('统一凭证');
    expect(rendered).not.toContain('导入任务');
    expect(rendered).not.toContain('session-secret');
  });

  it('creates a site-scoped encrypted secret', async () => {
    await renderVault();
    await act(async () => { findButton(root!.root, '添加站点凭证').props.onClick(); });

    const form = root!.root.findByProps({ id: 'credential-vault-create-form' });
    const selects = form.findAllByType(ModernSelect);
    await act(async () => { selects[0]!.props.onChange('1'); });
    await flushMicrotasks();

    const refreshedForm = root!.root.findByProps({ id: 'credential-vault-create-form' });
    const inputs = refreshedForm.findAllByType('input');
    const nameInput = inputs.find((input) => input.props.placeholder === '例如：主账号 Session');
    const secretInput = refreshedForm.findByType('textarea');
    await act(async () => {
      nameInput!.props.onChange({ target: { value: 'Primary Session' } });
      secretInput.props.onChange({ target: { value: 'session-secret' } });
    });
    await act(async () => {
      await refreshedForm.props.onSubmit({ preventDefault: vi.fn() });
    });
    await flushMicrotasks();

    expect(apiMock.createCredentialVaultItem).toHaveBeenCalledWith(expect.objectContaining({
      siteId: 1,
      name: 'Primary Session',
      kind: 'session_token',
      secret: 'session-secret',
      metadata: expect.objectContaining({ adapterPlatform: 'new-api' }),
    }));
  });

  it('requires confirmation before revoking or deleting a vault item', async () => {
    await renderVault();

    await act(async () => { findButton(root!.root, '撤销').props.onClick(); });
    expect(apiMock.revokeCredentialVaultItem).not.toHaveBeenCalled();
    await act(async () => { await findButton(root!.root, '确认撤销').props.onClick(); });
    await flushMicrotasks();
    expect(apiMock.revokeCredentialVaultItem).toHaveBeenCalledWith(7);

    await act(async () => { findButton(root!.root, '删除').props.onClick(); });
    expect(apiMock.deleteCredentialVaultItem).not.toHaveBeenCalled();
    await act(async () => { await findButton(root!.root, '永久删除').props.onClick(); });
    await flushMicrotasks();
    expect(apiMock.deleteCredentialVaultItem).toHaveBeenCalledWith(7);
  });
});
