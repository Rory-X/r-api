import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ToastProvider } from '../../components/Toast.js';
import type { FeishuBridgePromptCard } from '../../api.js';
import FeishuPromptCardsPanel from './FeishuPromptCardsPanel.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getInteractionAdapters: vi.fn(),
    getLocalConnectorDevices: vi.fn(),
    getLocalConnectorThreads: vi.fn(),
    getBridgeContinuationTasks: vi.fn(),
    getFeishuBridgePromptCards: vi.fn(),
    createFeishuBridgePromptCard: vi.fn(),
    runInteractionAdapterDispatch: vi.fn(),
    cancelFeishuBridgePromptCard: vi.fn(),
    retryInteractionDispatch: vi.fn(),
    retryInteractionCardUpdate: vi.fn(),
  },
}));

vi.mock('../../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flush(rounds = 8) {
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

const adapter = {
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

const device = {
  id: 'device-1',
  name: 'MacBook',
  platform: 'macos',
  status: 'active',
  scopes: ['app_server.control'],
  capabilities: [],
  pairedAt: '2026-08-04T01:00:00.000Z',
};

const task = {
  state: {
    taskId: 'task-1',
    sessionKey: 'device-1:thread-1',
    threadId: 'thread-1',
    taskKind: 'automatic',
    submissionMode: null,
    status: 'waiting',
    reason: 'thread_active',
    policy: {},
    continuationCount: 0,
    startedAtMs: Date.parse('2026-08-04T01:00:00.000Z'),
    updatedAtMs: Date.parse('2026-08-04T01:00:00.000Z'),
    nextRunAtMs: null,
    threadStatus: 'active',
    activeFlags: [],
    activeTurnId: 'turn-1',
    lastFailure: null,
    lastFailureTurnTerminal: false,
    retryAfterMs: null,
    pendingRouteAction: null,
    pendingPrompt: null,
    pendingMethod: null,
  },
  deviceId: 'device-1',
  stateVersion: 1,
  createdAt: '2026-08-04T01:00:00.000Z',
  updatedAt: '2026-08-04T01:00:00.000Z',
  stoppedAt: null,
  lease: null,
  requestSource: null,
  requestedBy: null,
  sourceAdapterId: null,
  promptFingerprint: null,
};

const observedThread = {
  id: 'observed-thread-1',
  deviceId: 'device-1',
  deviceName: 'MacBook',
  devicePlatform: 'macos',
  deviceStatus: 'active',
  threadId: 'thread-observed',
  observationSource: 'connector_app_server',
  controlState: 'available',
  threadStatus: 'idle',
  activeFlags: [],
  activeTurnId: null,
  lastEventKind: 'thread_status',
  lastSeenAt: '2026-08-04T01:05:00.000Z',
};

function promptCard(
  status: 'pending' | 'consumed' | 'expired' | 'cancelled' = 'pending',
): FeishuBridgePromptCard {
  return {
    id: 'card-1',
    adapterId: 'adapter-1',
    deviceId: 'device-1',
    threadId: 'thread-1',
    contextTaskId: 'task-1',
    status,
    expiresAt: '2026-08-04T02:00:00.000Z',
    requestedBy: 'webui:admin',
    consumedTaskId: null,
    consumedBy: null,
    consumedAt: null,
    createdAt: '2026-08-04T01:00:00.000Z',
    updatedAt: '2026-08-04T01:00:00.000Z',
    dispatch: {
      id: 'dispatch-1',
      subjectKind: 'prompt_card',
      interactionId: null,
      promptCardId: 'card-1',
      adapterId: 'adapter-1',
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: '2026-08-04T01:00:00.000Z',
      externalMessageId: 'om-message-1',
      lastError: null,
      deliveredAt: '2026-08-04T01:00:01.000Z',
      createdAt: '2026-08-04T01:00:00.000Z',
      updatedAt: '2026-08-04T01:00:01.000Z',
      cardUpdate: null,
    },
  };
}

describe('FeishuPromptCardsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [adapter] });
    apiMock.getLocalConnectorDevices.mockResolvedValue({ items: [device] });
    apiMock.getLocalConnectorThreads.mockResolvedValue({ success: true, items: [observedThread] });
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [task] });
    apiMock.getFeishuBridgePromptCards.mockResolvedValue({ success: true, items: [] });
    apiMock.runInteractionAdapterDispatch.mockResolvedValue({ success: true, result: {} });
    apiMock.cancelFeishuBridgePromptCard.mockResolvedValue({ success: true, card: promptCard('cancelled') });
    apiMock.retryInteractionDispatch.mockResolvedValue({ success: true });
    apiMock.retryInteractionCardUpdate.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('queues a standalone card from the latest selectable Bridge context', async () => {
    apiMock.createFeishuBridgePromptCard.mockResolvedValue({
      success: true,
      created: true,
      card: promptCard(),
    });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><FeishuPromptCardsPanel deviceId="device-1" /></ToastProvider>);
      });
      await flush();
      const send = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '发送 Prompt 卡片');
      await act(async () => { await send.props.onClick(); });
      await flush();

      expect(apiMock.createFeishuBridgePromptCard).toHaveBeenCalledWith('adapter-1', expect.objectContaining({
        contextTaskId: 'task-1',
        ttlMs: 60 * 60_000,
        requestedBy: 'webui:admin',
        idempotencyKey: expect.stringMatching(/^webui:feishu-prompt-card:/),
      }));
      expect(apiMock.runInteractionAdapterDispatch).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('uses a Connector-discovered Codex thread without exposing manual input by default', async () => {
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [] });
    apiMock.createFeishuBridgePromptCard.mockResolvedValue({
      success: true,
      created: true,
      card: { ...promptCard(), contextTaskId: null, threadId: 'thread-observed' },
    });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><FeishuPromptCardsPanel deviceId="device-1" /></ToastProvider>);
      });
      await flush();

      expect(root.root.findAll((node) => node.type === 'input' && node.props['aria-label'] === '主动 Prompt Thread ID')).toHaveLength(0);
      expect(collectText(root.root)).toContain('thread-observed');
      const send = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '发送 Prompt 卡片');
      await act(async () => { await send.props.onClick(); });
      await flush();

      expect(apiMock.createFeishuBridgePromptCard).toHaveBeenCalledWith('adapter-1', expect.objectContaining({
        deviceId: 'device-1',
        threadId: 'thread-observed',
      }));
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('does not offer a Codex Desktop-owned thread for Prompt control', async () => {
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [] });
    apiMock.getLocalConnectorThreads.mockResolvedValue({
      success: true,
      items: [{
        ...observedThread,
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
      }],
    });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><FeishuPromptCardsPanel deviceId="device-1" /></ToastProvider>);
      });
      await flush();

      expect(collectText(root.root)).not.toContain('thread-observed');
      expect(collectText(root.root)).toContain('Desktop 正在持有的会话只能观测');
      const send = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '发送 Prompt 卡片');
      await act(async () => { await send.props.onClick(); });
      await flush();

      expect(apiMock.createFeishuBridgePromptCard).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('cancels a pending card after explicit confirmation', async () => {
    apiMock.getFeishuBridgePromptCards.mockResolvedValue({ success: true, items: [promptCard()] });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><FeishuPromptCardsPanel deviceId="device-1" /></ToastProvider>);
      });
      await flush();
      const cancel = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '取消');
      await act(async () => { await cancel.props.onClick(); });
      await confirmDialog(root);
      await flush();

      expect(apiMock.cancelFeishuBridgePromptCard).toHaveBeenCalledWith('card-1');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('retries a standalone card status PATCH without re-sending the original card', async () => {
    const consumed = promptCard('consumed');
    consumed.dispatch!.cardUpdate = {
      id: 'card-update-1',
      dispatchId: consumed.dispatch!.id,
      subjectRevision: 2,
      targetStatus: 'consumed',
      cardFingerprint: 'fingerprint-1',
      status: 'delivery_unknown',
      attemptCount: 1,
      nextAttemptAt: '2026-08-04T01:01:00.000Z',
      deadlineAt: '2026-08-18T01:00:01.000Z',
      lastError: 'socket closed after PATCH write',
      deliveredAt: null,
      createdAt: '2026-08-04T01:00:02.000Z',
      updatedAt: '2026-08-04T01:00:03.000Z',
    };
    apiMock.getFeishuBridgePromptCards.mockResolvedValue({ success: true, items: [consumed] });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(<ToastProvider><FeishuPromptCardsPanel deviceId="device-1" /></ToastProvider>);
      });
      await flush();
      expect(collectText(root.root)).toContain('状态回写结果未知');
      const retry = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '重试回写');
      await act(async () => { await retry.props.onClick(); });
      await confirmDialog(root);
      await flush();

      expect(apiMock.retryInteractionCardUpdate).toHaveBeenCalledWith('card-update-1');
      expect(apiMock.retryInteractionDispatch).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });
});
