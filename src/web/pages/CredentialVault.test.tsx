import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import CredentialVault from './CredentialVault.js';

const { apiMock, downloadJsonMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteAdapterContracts: vi.fn(),
    getCredentialLifecycle: vi.fn(),
    runCredentialLifecycleAction: vi.fn(),
    previewCredentialImport: vi.fn(),
    executeCredentialImport: vi.fn(),
    getCredentialImportJobs: vi.fn(),
    getCredentialImportJob: vi.fn(),
    exportCredentials: vi.fn(),
    getCredentialVaultItems: vi.fn(),
    createCredentialVaultItem: vi.fn(),
    revokeCredentialVaultItem: vi.fn(),
    deleteCredentialVaultItem: vi.fn(),
  },
  downloadJsonMock: vi.fn(),
}));

vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('./credential-management/shared.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./credential-management/shared.js')>(),
  downloadJson: downloadJsonMock,
}));

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

function findControl(root: ReactTestInstance, ariaLabel: string): ReactTestInstance {
  const control = root.findAll((node) => (
    node.props['aria-label'] === ariaLabel
    && typeof node.props.onChange === 'function'
  ))[0];
  if (!control) throw new Error(`control not found: ${ariaLabel}`);
  return control;
}

const lifecycleItem = {
  entityType: 'account' as const,
  entityId: 12,
  siteId: 1,
  accountId: 12,
  name: 'Demo Session',
  site: { id: 1, name: 'Demo Site', platform: 'new-api', url: 'https://demo.example.com' },
  provider: 'new-api',
  kind: 'session_token',
  status: 'active' as const,
  sourceStatus: 'active',
  statusReason: '凭证可用',
  refreshOwner: 'none' as const,
  fingerprint: '123456789012abcdef',
  lastRefreshSuccessAt: '2026-08-13T07:45:00.000Z',
  provenance: {
    importJobId: 'job-preview-1',
    sourceFormat: 'new_api_account',
    operatorId: 'webui:admin',
    conflictPolicy: 'skip',
    importAction: 'imported',
    createdAt: '2026-08-13T07:30:00.000Z',
  },
  actions: { validate: true, refresh: false, enable: false, disable: true, revoke: true },
};

const importPreview = {
  success: true as const,
  importJobId: 'job-preview-1',
  deduplicated: false,
  status: 'previewed',
  detection: {
    format: 'new_api_account',
    isBatch: false,
    confidence: 'high' as const,
    warnings: [],
  },
  warnings: [],
  batchFingerprint: 'a'.repeat(64),
  duplicateCount: 0,
  candidates: [{
    candidate: {
      source: { format: 'new_api_account', sourceIndex: 0 },
      provider: 'new-api',
      kind: 'api_key',
      identity: { username: 'alice' },
      secretPresence: { apiKey: true },
      secretSummary: { apiKey: true },
      disabled: false,
      fingerprint: 'abcdef1234567890',
      warnings: [],
      compatibleTargets: ['new_api' as const, 'api_key' as const, 'vault' as const],
    },
    validation: {
      status: 'ready' as const,
      target: 'new_api' as const,
      errors: [],
      warnings: [],
    },
  }],
};

const importJob = {
  id: 'job-preview-1',
  status: 'completed' as const,
  target: 'new_api' as const,
  siteId: 1,
  operatorId: 'webui:admin',
  conflictPolicy: 'skip' as const,
  detection: importPreview.detection,
  warnings: [],
  batchFingerprint: 'a'.repeat(64),
  candidateCount: 1,
  duplicateCount: 0,
  imported: 1,
  updated: 0,
  skipped: 0,
  failed: 0,
  createdAt: '2026-08-13T08:00:00.000Z',
  completedAt: '2026-08-13T08:00:01.000Z',
};

describe('CredentialVault workbench', () => {
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
    apiMock.getCredentialLifecycle.mockResolvedValue({ success: true, items: [lifecycleItem] });
    apiMock.previewCredentialImport.mockResolvedValue(importPreview);
    apiMock.executeCredentialImport.mockResolvedValue({
      success: true,
      importJobId: 'job-preview-1',
      deduplicated: false,
      jobStatus: 'completed',
      target: 'new_api',
      batchFingerprint: 'a'.repeat(64),
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      items: [{
        index: 0,
        status: 'imported',
        provider: 'new-api',
        kind: 'api_key',
        fingerprint: 'abcdef1234567890',
        accountId: 21,
      }],
    });
    apiMock.getCredentialImportJobs.mockResolvedValue({ success: true, jobs: [importJob] });
    apiMock.getCredentialImportJob.mockResolvedValue({
      success: true,
      job: {
        ...importJob,
        items: [{
          id: 1,
          index: 0,
          source: { format: 'new_api_account' },
          provider: 'new-api',
          kind: 'api_key',
          identity: { username: 'alice' },
          secretSummary: { apiKey: true },
          compatibleTargets: ['new_api', 'api_key', 'vault'],
          disabled: false,
          fingerprint: 'abcdef1234567890',
          validation: { status: 'ready', errors: [], warnings: [] },
          status: 'imported',
          accountId: 21,
        }],
      },
    });
    apiMock.exportCredentials.mockResolvedValue({
      success: true,
      export: { schema: 'r-api.credential-transfer', version: 1 },
    });
    apiMock.getCredentialVaultItems.mockResolvedValue({
      items: [{
        id: 7,
        siteId: 1,
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
      }],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses one four-view workbench and renders lifecycle metadata without secrets', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><CredentialVault /></ToastProvider>);
      });
      await flushMicrotasks();

      expect(root.root.findByType('h2').children.join('')).toBe('凭证中心');
      expect(root.root.findAll((node) => node.type === 'button' && node.props.role === 'tab').map(collectText)).toEqual([
        '统一凭证',
        '导入',
        '导入任务',
        'Vault',
      ]);
      const rendered = JSON.stringify(root.toJSON());
      expect(rendered).toContain('Demo Session');
      expect(rendered).toContain('凭证可用');
      expect(rendered).toContain('new_api_account');
      expect(rendered).toContain('最近刷新');
      expect(rendered).not.toContain('session-secret');
      expect(rendered).not.toContain('ciphertext');
    } finally {
      root?.unmount();
    }
  });

  it('requires preview before promotion and executes the exact preview job', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><CredentialVault /></ToastProvider>);
      });
      await flushMicrotasks();

      await act(async () => { findButton(root.root, '导入').props.onClick(); });
      expect(findButton(root.root, '执行导入').props.disabled).toBe(true);

      await act(async () => {
        findControl(root.root, '导入目标站点').props.onChange({ target: { value: '1' } });
        findControl(root.root, '凭证内容').props.onChange({
          target: { value: '{"api_key":"sk-test-secret","username":"alice"}' },
        });
      });
      await act(async () => { findButton(root.root, '预览并校验').props.onClick(); });
      await flushMicrotasks();

      expect(apiMock.previewCredentialImport).toHaveBeenCalledWith(expect.objectContaining({
        input: { api_key: 'sk-test-secret', username: 'alice' },
        target: 'new_api',
        siteId: 1,
        conflictPolicy: 'skip',
      }));
      expect(root.root.findByProps({ 'data-testid': 'credential-import-preview' })).toBeTruthy();

      await act(async () => { findButton(root.root, '执行导入').props.onClick(); });
      await flushMicrotasks();
      expect(apiMock.executeCredentialImport).toHaveBeenCalledWith({
        importJobId: 'job-preview-1',
        input: { api_key: 'sk-test-secret', username: 'alice' },
        target: 'new_api',
        siteId: 1,
        batchFingerprint: 'a'.repeat(64),
        conflictPolicy: 'skip',
        passphrase: undefined,
      });
      expect(root.root.findByProps({ 'data-testid': 'credential-import-result' })).toBeTruthy();
    } finally {
      root?.unmount();
    }
  });

  it('requires explicit confirmation before portable secret export', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><CredentialVault /></ToastProvider>);
      });
      await flushMicrotasks();

      await act(async () => {
        root.root.findByProps({
          role: 'checkbox',
          'aria-label': '选择凭证 Demo Session',
        }).props.onClick();
      });
      await act(async () => { findButton(root.root, '导出').props.onClick(); });
      await act(async () => {
        findControl(root.root, '凭证导出模式').props.onChange({
          target: { value: 'portable_secret' },
        });
      });
      expect(apiMock.exportCredentials).not.toHaveBeenCalled();

      await act(async () => {
        root.root.findByProps({
          role: 'checkbox',
          'aria-label': '我确认该文件包含明文凭证',
        }).props.onClick();
      });
      await act(async () => { findButton(root.root, '下载 JSON').props.onClick(); });
      await flushMicrotasks();

      expect(apiMock.exportCredentials).toHaveBeenCalledWith({
        mode: 'portable_secret',
        accountIds: [12],
        vaultItemIds: [],
        confirmation: 'EXPORT_SECRETS',
      });
      expect(downloadJsonMock).toHaveBeenCalledOnce();
    } finally {
      root?.unmount();
    }
  });

  it('shows persisted import jobs, safe item summaries, and the existing Vault inventory', async () => {
    let root!: WebTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><CredentialVault /></ToastProvider>);
      });
      await flushMicrotasks();

      await act(async () => { findButton(root.root, '导入任务').props.onClick(); });
      await flushMicrotasks();
      expect(JSON.stringify(root.toJSON())).toContain('new_api_account');
      await act(async () => { findButton(root.root, '详情').props.onClick(); });
      await flushMicrotasks();
      const detail = collectText(
        root.root.findByProps({ 'data-testid': 'credential-import-job-detail' }),
      );
      expect(detail).toContain('账号 #21');
      expect(detail).toContain('apiKey');
      expect(detail).not.toContain('sk-test-secret');

      await act(async () => { findButton(root.root, '关闭').props.onClick(); });
      await act(async () => { findButton(root.root, 'Vault').props.onClick(); });
      await flushMicrotasks();
      const vault = JSON.stringify(root.toJSON());
      expect(vault).toContain('Vault Session');
      expect(vault).toContain('Feishu App Secret');
      expect(vault).toContain('归属：系统集成');
      expect(vault).not.toContain('session-secret');
    } finally {
      root?.unmount();
    }
  });
});
