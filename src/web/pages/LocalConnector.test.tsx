import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import LocalConnector from './LocalConnector.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getLocalConnectorDevices: vi.fn(),
    getLocalConnectorThreads: vi.fn(),
    getBridgeContinuationTasks: vi.fn(),
    getLocalConnectorActions: vi.fn(),
    takeOverLocalConnectorSession: vi.fn(),
    createLocalConnectorPairing: vi.fn(),
    createLocalConnectorAction: vi.fn(),
    revokeLocalConnectorDevice: vi.fn(),
    cancelLocalConnectorAction: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flush(rounds = 6) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      taskId: 'task-active',
      sessionKey: 'connector:device-1:codex:thread-managed',
      threadId: 'thread-managed',
      taskKind: 'automatic',
      submissionMode: null,
      status: 'backoff',
      reason: 'backoff',
      policy: {
        capturedAt: '2026-08-12T01:00:00.000Z',
        fingerprint: 'a'.repeat(64),
        policyVersion: 1,
        enabled: true,
        continuePrompt: '继续',
        maxElapsedMs: null,
        backoff: { initialDelayMs: 5_000, maxDelayMs: 300_000, multiplier: 2, jitterRatio: 0.2 },
        rules: {},
      },
      continuationCount: 1,
      startedAtMs: Date.parse('2026-08-12T01:00:00.000Z'),
      updatedAtMs: Date.parse('2026-08-12T01:04:00.000Z'),
      nextRunAtMs: Date.parse('2026-08-12T01:05:00.000Z'),
      threadStatus: 'idle',
      activeFlags: [],
      activeTurnId: null,
      lastFailure: {
        failureClass: 'rate_limited',
        source: 'turn_completed',
        recoverability: 'transient',
        codexErrorCode: null,
        httpStatusCode: 429,
        messageSummary: '等待限流恢复',
        messageFingerprint: 'b'.repeat(64),
        willRetry: false,
      },
      lastFailureTurnTerminal: true,
      retryAfterMs: 10_000,
      pendingRouteAction: 'preserve',
      pendingPrompt: '继续',
      pendingMethod: 'turn/start',
      ...overrides,
    },
    deviceId: 'device-1',
    stateVersion: 2,
    createdAt: '2026-08-12T01:00:00.000Z',
    updatedAt: '2026-08-12T01:04:00.000Z',
    stoppedAt: null,
    lease: null,
    requestSource: 'webui',
    requestedBy: 'webui:admin',
    sourceAdapterId: null,
    promptFingerprint: null,
  };
}

describe('LocalConnector page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      location: { origin: 'https://direct-api.example.test' },
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    apiMock.getLocalConnectorDevices.mockResolvedValue({
      items: [{
        id: 'device-1',
        name: 'MacBook Connector',
        platform: 'darwin-arm64',
        version: '1.0.0',
        status: 'active',
        scopes: ['hooks.manage', 'hooks.emit', 'notify.manage', 'notify.emit', 'app_server.observe', 'app_server.control'],
        capabilities: ['app-server-control-v1'],
        pairedAt: '2026-08-12T00:30:00.000Z',
        lastSeenAt: '2026-08-12T01:05:00.000Z',
      }],
    });
    apiMock.getLocalConnectorThreads.mockResolvedValue({
      success: true,
      items: [{
        id: 'observed-available',
        deviceId: 'device-1',
        deviceName: 'MacBook Connector',
        devicePlatform: 'darwin-arm64',
        deviceStatus: 'active',
        threadId: 'thread-available',
        title: '优化 Connector 会话总览',
        observationSource: 'connector_app_server',
        controlState: 'available',
        threadStatus: 'active',
        activeFlags: [],
        activeTurnId: 'turn-1',
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-12T01:05:00.000Z',
      }, {
        id: 'observed-managed',
        deviceId: 'device-1',
        deviceName: 'MacBook Connector',
        devicePlatform: 'darwin-arm64',
        deviceStatus: 'active',
        threadId: 'thread-managed',
        title: '修复飞书通知漏发',
        observationSource: 'connector_app_server',
        controlState: 'available',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        lastEventKind: 'turn_completed',
        lastSeenAt: '2026-08-12T01:04:00.000Z',
      }, {
        id: 'observed-desktop',
        deviceId: 'device-1',
        deviceName: 'MacBook Connector',
        devicePlatform: 'darwin-arm64',
        deviceStatus: 'active',
        threadId: 'thread-desktop',
        title: 'Desktop 正在运行的会话',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
        threadStatus: 'active',
        activeFlags: ['waitingOnUserInput'],
        activeTurnId: 'turn-desktop',
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-12T01:03:00.000Z',
      }],
    });
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [createTask()] });
    apiMock.getLocalConnectorActions.mockResolvedValue({ items: [] });
    apiMock.takeOverLocalConnectorSession.mockResolvedValue({
      success: true,
      created: true,
      task: createTask({ taskId: 'task-new', threadId: 'thread-available', status: 'waiting', reason: 'waiting' }),
    });
    apiMock.createLocalConnectorPairing.mockResolvedValue({
      success: true,
      claimPath: '/api/local-connector/public/pairings/claim',
      pairingId: 'pair-1',
      pairingToken: 'lcp_test_token_123456789012345678901234567890',
      deviceName: '本机 Connector',
      scopes: ['hooks.manage'],
      expiresAt: '2026-08-12T02:00:00.000Z',
    });
    apiMock.createLocalConnectorAction.mockResolvedValue({
      success: true,
      action: {
        id: 'action-1',
        deviceId: 'device-1',
        kind: 'hook',
        operation: 'install',
        status: 'pending',
        manifest: {},
        expiresAt: '2026-08-12T02:00:00.000Z',
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses reported Codex sessions as the primary management surface', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider><LocalConnector /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flush();

      const text = collectText(root.root);
      expect(text).toContain('Codex 会话接管');
      expect(text).toContain('优化 Connector 会话总览');
      expect(text).toContain('thread-available');
      expect(text).toContain('Connector App Server');
      expect(text).toContain('修复飞书通知漏发');
      expect(text).toContain('退避中');
      expect(text).toContain('等待限流恢复');
      expect(text).toContain('Desktop 正在运行的会话');
      expect(text).toContain('Codex Desktop');
      expect(text).toContain('Desktop 持有，可直接追加 Prompt');
      expect(apiMock.getLocalConnectorThreads).toHaveBeenCalledWith({ limit: 200 });
      expect(apiMock.getBridgeContinuationTasks).toHaveBeenCalledWith({ limit: 200 });

      const desktopLink = root.root.find((node) => (
        node.type === 'a' && collectText(node).trim() === '打开并发消息'
      ));
      expect(desktopLink.props.href).toContain('threadId=thread-desktop');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('creates a takeover transaction only for an available session without an active task', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider><LocalConnector /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flush();

      const takeoverButtons = root.root.findAll((node) => node.type === 'button' && collectText(node).trim() === '接管会话');
      expect(takeoverButtons).toHaveLength(1);
      await act(async () => { takeoverButtons[0].props.onClick(); });
      await flush(8);

      expect(apiMock.takeOverLocalConnectorSession).toHaveBeenCalledWith({
        deviceId: 'device-1',
        threadId: 'thread-available',
      });
      expect(root.root.findAll((node) => node.type === 'a' && collectText(node).trim() === '查看接管')).toHaveLength(1);
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('keeps pairing and local Hook or Notify operations in collapsed Connector settings', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter>
            <ToastProvider><LocalConnector /></ToastProvider>
          </MemoryRouter>,
        );
      });
      await flush();

      const settingsTrigger = root.root.find((node) => (
        node.type === 'button' && collectText(node).includes('Connector 设置')
      ));
      expect(settingsTrigger.props['aria-expanded']).toBe(false);
      await act(async () => { settingsTrigger.props.onClick(); });
      expect(settingsTrigger.props['aria-expanded']).toBe(true);

      const pairingButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '生成配对令牌');
      await act(async () => { pairingButton.props.onClick(); });
      await flush(8);
      expect(apiMock.createLocalConnectorPairing).toHaveBeenCalledTimes(1);
      expect(collectText(root.root)).toContain('lcp_test_token');

      const actionButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '创建动作');
      await act(async () => { actionButton.props.onClick(); });
      await flush(8);
      expect(apiMock.createLocalConnectorAction).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: 'device-1',
        agent: 'codex',
        kind: 'hook',
        operation: 'install',
      }));
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });
});
