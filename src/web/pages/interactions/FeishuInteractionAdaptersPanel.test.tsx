import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ToastProvider } from '../../components/Toast.js';
import FeishuInteractionAdaptersPanel from './FeishuInteractionAdaptersPanel.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getInteractionAdapters: vi.fn(),
    getFeishuLongConnections: vi.fn(),
    getInteractionDispatches: vi.fn(),
    createFeishuInteractionAdapter: vi.fn(),
    updateFeishuInteractionAdapter: vi.fn(),
    runInteractionAdapterDispatch: vi.fn(),
    retryInteractionDispatch: vi.fn(),
    retryInteractionCardUpdate: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function confirmDialog(root: ReactTestRenderer) {
  await flush();
  const confirmButton = root.root.find((node) => (
    node.type === 'button' && node.props['data-testid'] === 'confirm-dialog-confirm'
  ));
  await act(async () => { confirmButton.props.onClick(); });
}

function adapter() {
  return {
    id: 'adapter-1',
    kind: 'feishu',
    name: 'Operations',
    enabled: true,
    appId: 'cli_test_app',
    apiBaseUrl: 'https://open.feishu.cn',
    receiveIdType: 'chat_id',
    receiveId: 'oc_chat_1',
    consoleBaseUrl: 'https://gateway.example.com',
    operatorAllowlist: ['open_id:ou_allowed'],
    secretsConfigured: { appSecret: true, verificationToken: true, encryptKey: false },
    callbackPath: '/api/interaction-adapters/public/feishu/adapter-1/callback',
    lastDispatchAt: null,
    lastCallbackAt: null,
    lastError: null,
    createdAt: '2026-08-04T01:00:00.000Z',
    updatedAt: '2026-08-04T01:00:00.000Z',
  };
}

function change(root: ReactTestRenderer, ariaLabel: string, value: string) {
  const field = root.root.find((node) => node.props['aria-label'] === ariaLabel);
  act(() => { field.props.onChange({ target: { value } }); });
}

describe('FeishuInteractionAdaptersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      location: { origin: 'https://console.example.com' },
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn() } });
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [] });
    apiMock.getFeishuLongConnections.mockResolvedValue({ success: true, items: [] });
    apiMock.getInteractionDispatches.mockResolvedValue({ success: true, items: [] });
    apiMock.runInteractionAdapterDispatch.mockResolvedValue({
      success: true,
      result: { reconciled: 0, recovered: 0, delivered: 0, failed: 0, unknown: 0, cancelled: 0 },
    });
    apiMock.retryInteractionDispatch.mockResolvedValue({ success: true });
    apiMock.retryInteractionCardUpdate.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('groups connection identity, target, activity, and status into a full-width summary row', async () => {
    const existing = {
      ...adapter(),
      lastCallbackAt: '2026-08-13T13:19:59.000Z',
      lastDispatchAt: '2026-08-13T14:28:26.000Z',
    };
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [existing] });
    apiMock.getFeishuLongConnections.mockResolvedValue({
      success: true,
      items: [{ adapterId: existing.id, state: 'connected' }],
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <FeishuInteractionAdaptersPanel deviceId="device-1" onRequestSelect={vi.fn()} onDispatchComplete={vi.fn()} />
          </ToastProvider>,
        );
      });
      await flush();

      const selector = root.root.find((node) => {
        const className = String(node.props.className || '');
        return node.type === 'button' && className.includes('feishu-connection-select');
      });
      expect(selector.props['aria-pressed']).toBe(true);
      expect(selector.findAll((node) => String(node.props.className || '').includes('feishu-connection-identity'))).toHaveLength(1);
      expect(selector.findAll((node) => String(node.props.className || '').includes('feishu-connection-activity'))).toHaveLength(1);
      expect(collectText(selector)).toContain('长连接正常');
      expect(collectText(selector)).toContain('群聊 Chat ID · oc_chat_1');
      expect(collectText(selector)).toContain('最近事件');
      expect(collectText(selector)).toContain('最近投递');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('creates an adapter with a normalized operator allowlist', async () => {
    const created = adapter();
    created.secretsConfigured.verificationToken = false;
    apiMock.createFeishuInteractionAdapter.mockResolvedValue({ success: true, adapter: created });
    apiMock.getInteractionAdapters
      .mockResolvedValueOnce({ success: true, items: [] })
      .mockResolvedValue({ success: true, items: [created] });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <FeishuInteractionAdaptersPanel deviceId="device-1" onRequestSelect={vi.fn()} onDispatchComplete={vi.fn()} />
          </ToastProvider>,
        );
      });
      await flush();

      const createButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '新建连接');
      act(() => { createButton.props.onClick(); });
      change(root, '飞书 Adapter 名称', 'Operations');
      change(root, '飞书 App ID', 'cli_test_app');
      change(root, '飞书接收目标', 'oc_chat_1');
      change(root, '飞书 App Secret', 'app-secret');
      change(root, '飞书 Encrypt Key', 'encrypt-key');
      change(root, '飞书控制台公开 URL', 'https://gateway.example.com');
      change(root, '飞书操作者白名单', 'open_id:ou_allowed\nopen_id:ou_allowed, user_id:123');

      const form = root.root.findByType('form');
      await act(async () => { form.props.onSubmit({ preventDefault: vi.fn() }); });
      await flush(8);

      expect(apiMock.createFeishuInteractionAdapter).toHaveBeenCalledWith({
        deviceId: 'device-1',
        name: 'Operations',
        enabled: true,
        appId: 'cli_test_app',
        appSecret: 'app-secret',
        encryptKey: 'encrypt-key',
        apiBaseUrl: 'https://open.feishu.cn',
        receiveIdType: 'chat_id',
        receiveId: 'oc_chat_1',
        consoleBaseUrl: 'https://gateway.example.com',
        operatorAllowlist: ['open_id:ou_allowed', 'user_id:123'],
      });
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('keeps stored secrets blank while editing and omits unchanged secrets from the update', async () => {
    const existing = adapter();
    existing.secretsConfigured.encryptKey = true;
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [existing] });
    apiMock.updateFeishuInteractionAdapter.mockResolvedValue({ success: true, adapter: existing });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <FeishuInteractionAdaptersPanel deviceId="device-1" onRequestSelect={vi.fn()} onDispatchComplete={vi.fn()} />
          </ToastProvider>,
        );
      });
      await flush();

      const edit = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '配置');
      act(() => { edit.props.onClick(); });
      expect(root.root.find((node) => node.props['aria-label'] === '飞书 App Secret').props.value).toBe('');
      expect(root.root.find((node) => node.props['aria-label'] === '飞书 Verification Token').props.value).toBe('');
      expect(root.root.find((node) => node.props['aria-label'] === '飞书 Encrypt Key').props.value).toBe('');
      expect(root.root.find((node) => node.props['aria-label'] === '飞书卡片回调 URL').props.value)
        .toBe('https://gateway.example.com/api/interaction-adapters/public/feishu/adapter-1/callback');

      change(root, '飞书 Adapter 名称', 'Operations Updated');
      const form = root.root.findByType('form');
      await act(async () => { form.props.onSubmit({ preventDefault: vi.fn() }); });
      await flush(8);

      expect(apiMock.updateFeishuInteractionAdapter).toHaveBeenCalledWith('adapter-1', expect.not.objectContaining({
        appSecret: expect.anything(),
        verificationToken: expect.anything(),
        encryptKey: expect.anything(),
      }));
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('requires confirmation before requeueing a delivery with an unknown outcome', async () => {
    const existing = adapter();
    const dispatch = {
      id: 'dispatch-1',
      subjectKind: 'interaction',
      interactionId: 'interaction-1',
      promptCardId: null,
      adapterId: existing.id,
      status: 'delivery_unknown',
      attemptCount: 1,
      nextAttemptAt: '2026-08-04T01:01:00.000Z',
      externalMessageId: null,
      lastError: 'socket closed after write',
      deliveredAt: null,
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T01:00:00.000Z',
    };
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [existing] });
    apiMock.getInteractionDispatches.mockResolvedValue({ success: true, items: [dispatch] });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <FeishuInteractionAdaptersPanel deviceId="device-1" onRequestSelect={vi.fn()} onDispatchComplete={vi.fn()} />
          </ToastProvider>,
        );
      });
      await flush(8);

      const retry = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '重新发送通知');
      await act(async () => { retry.props.onClick(); });
      await confirmDialog(root);
      await flush();

      expect(apiMock.retryInteractionDispatch).toHaveBeenCalledWith('dispatch-1');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('shows the independent card update state and retries an unknown PATCH explicitly', async () => {
    const existing = adapter();
    const dispatch = {
      id: 'dispatch-update-1',
      subjectKind: 'interaction',
      interactionId: 'interaction-1',
      promptCardId: null,
      adapterId: existing.id,
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: '2026-08-04T01:01:00.000Z',
      externalMessageId: 'om-message-1',
      lastError: null,
      deliveredAt: '2026-08-04T01:00:01.000Z',
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T01:00:01.000Z',
      cardUpdate: {
        id: 'card-update-1',
        dispatchId: 'dispatch-update-1',
        subjectRevision: 2,
        targetStatus: 'response_pending',
        cardFingerprint: 'fingerprint-1',
        status: 'delivery_unknown',
        attemptCount: 1,
        nextAttemptAt: '2026-08-04T01:01:00.000Z',
        deadlineAt: '2026-08-18T01:00:01.000Z',
        lastError: 'socket closed after PATCH write',
        deliveredAt: null,
        createdAt: '2026-08-04T01:00:02.000Z',
        updatedAt: '2026-08-04T01:00:03.000Z',
      },
    };
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [existing] });
    apiMock.getInteractionDispatches.mockResolvedValue({ success: true, items: [dispatch] });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <FeishuInteractionAdaptersPanel deviceId="device-1" onRequestSelect={vi.fn()} onDispatchComplete={vi.fn()} />
          </ToastProvider>,
        );
      });
      await flush(8);

      expect(collectText(root.root)).toContain('回写结果未知');
      const retry = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '重新同步卡片状态');
      await act(async () => { retry.props.onClick(); });
      await confirmDialog(root);
      await flush();

      expect(apiMock.retryInteractionCardUpdate).toHaveBeenCalledWith('card-update-1');
      expect(apiMock.runInteractionAdapterDispatch).toHaveBeenCalled();
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });
});
