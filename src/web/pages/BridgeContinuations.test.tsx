import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { Select } from '../components/ui/index.js';
import BridgeContinuations from './BridgeContinuations.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getLocalConnectorDevices: vi.fn(),
    getLocalConnectorThreads: vi.fn(),
    getLocalConnectorThreadActivity: vi.fn(),
    getInteractionRequests: vi.fn(),
    getBridgeContinuationTasks: vi.fn(),
    getBridgeContinuationTask: vi.fn(),
    takeOverLocalConnectorSession: vi.fn(),
    createManualBridgePromptTask: vi.fn(),
    stopBridgeContinuationTask: vi.fn(),
    supersedeBridgeContinuationTask: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flush(rounds = 4) {
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

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      taskId: 'bridge-task-1',
      sessionKey: 'device-1:thread-a',
      threadId: 'thread-a',
      taskKind: 'automatic',
      submissionMode: null,
      status: 'backoff',
      reason: 'backoff',
      policy: {
        capturedAt: '2026-08-04T01:00:00.000Z',
        fingerprint: 'a'.repeat(64),
        policyVersion: 1,
        enabled: true,
        continuePrompt: '继续',
        maxElapsedMs: null,
        backoff: { initialDelayMs: 5_000, maxDelayMs: 300_000, multiplier: 2, jitterRatio: 0.2 },
        rules: {},
      },
      continuationCount: 2,
      startedAtMs: Date.parse('2026-08-04T01:00:00.000Z'),
      updatedAtMs: Date.parse('2026-08-04T01:01:00.000Z'),
      nextRunAtMs: Date.parse('2026-08-04T01:02:00.000Z'),
      threadStatus: 'idle',
      activeFlags: [],
      activeTurnId: null,
      lastFailure: {
        failureClass: 'rate_limited',
        source: 'turn_completed',
        recoverability: 'transient',
        codexErrorCode: null,
        httpStatusCode: 429,
        messageSummary: 'Too many requests',
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
    stateVersion: 3,
    createdAt: '2026-08-04T01:00:00.000Z',
    updatedAt: '2026-08-04T01:01:00.000Z',
    stoppedAt: null,
    lease: null,
    requestSource: null,
    requestedBy: null,
    sourceAdapterId: null,
    promptFingerprint: null,
  };
}

describe('BridgeContinuations page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const task = createTask();
    apiMock.getLocalConnectorDevices.mockResolvedValue({
      items: [{
        id: 'device-1',
        name: 'MacBook',
        platform: 'macos',
        status: 'active',
        scopes: ['app_server.observe', 'app_server.control'],
        capabilities: ['codex-app-server'],
        pairedAt: '2026-08-04T00:30:00.000Z',
      }],
    });
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [task] });
    apiMock.getInteractionRequests.mockResolvedValue({ success: true, items: [] });
    apiMock.getLocalConnectorThreads.mockResolvedValue({
      success: true,
      items: [{
        id: 'observed-thread-1',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-new',
        observationSource: 'connector_app_server',
        controlState: 'available',
        title: '正在检查 Connector 链路',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:00:00.000Z',
      }],
    });
    apiMock.getLocalConnectorThreadActivity.mockResolvedValue({
      success: true,
      thread: {
        id: 'observed-thread-1',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-new',
        observationSource: 'connector_app_server',
        controlState: 'available',
        title: '正在检查 Connector 链路',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:00:00.000Z',
      },
      summary: { activityCount: 4, bridgeTasks: 1, interactions: 1, feishuDeliveries: 1, issues: 0 },
      topicBindings: [{
        id: 'topic-1',
        adapterId: 'adapter-1',
        adapterName: 'Codex 助手',
        rootMessageId: 'om-root',
        feishuThreadId: 'omt-thread',
        lastMessageId: 'om-last',
        createdAt: '2026-08-04T01:00:00.000Z',
        updatedAt: '2026-08-04T01:04:00.000Z',
      }],
      items: [{
        id: 'bridge-event:1',
        category: 'bridge',
        eventType: 'manual_prompt_created',
        status: 'waiting',
        occurredAt: '2026-08-04T01:03:00.000Z',
        title: '会话消息已进入队列',
        detail: '继续检查通知链路',
        referenceId: 'bridge-task-prompt',
        error: null,
        metadata: { requestSource: 'webui' },
      }, {
        id: 'interaction-event:1',
        category: 'interaction',
        eventType: 'request_created',
        status: 'pending',
        occurredAt: '2026-08-04T01:02:00.000Z',
        title: '命令审批已请求',
        detail: 'item/commandExecution/requestApproval',
        referenceId: 'interaction-1',
        error: null,
        metadata: { actorKind: 'connector' },
      }, {
        id: 'notification:1',
        category: 'notification',
        eventType: 'turn_completion_notification',
        status: 'delivered',
        occurredAt: '2026-08-04T01:01:00.000Z',
        title: '会话已完成',
        detail: '线程 ID：thread-new',
        referenceId: 'notification-1',
        error: null,
        metadata: { channel: 'feishu:device-1' },
      }],
    });
    apiMock.getBridgeContinuationTask.mockResolvedValue({
      success: true,
      task,
      events: [{
        id: 1,
        taskId: 'bridge-task-1',
        eventType: 'failure_observed',
        fromStatus: 'waiting',
        toStatus: 'backoff',
        reason: 'backoff',
        metadata: JSON.stringify({ failureClass: 'rate_limited' }),
        createdAt: '2026-08-04T01:01:00.000Z',
      }],
    });
    apiMock.takeOverLocalConnectorSession.mockResolvedValue({ success: true, created: true, task });
    apiMock.createManualBridgePromptTask.mockResolvedValue({
      success: true,
      created: true,
      deduplicated: false,
      supersededTaskId: 'bridge-task-1',
      task: createTask({
        taskId: 'bridge-task-prompt',
        taskKind: 'manual_prompt',
        submissionMode: 'auto',
        pendingMethod: 'turn/steer',
      }),
    });
    apiMock.stopBridgeContinuationTask.mockResolvedValue({
      success: true,
      task: createTask({ status: 'stopped', reason: 'manual_stop' }),
    });
    apiMock.supersedeBridgeContinuationTask.mockResolvedValue({
      success: true,
      task: createTask({ status: 'superseded', reason: 'manual_prompt' }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps records scoped to the selected session and opens diagnostics in a drawer', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      expect(collectText(root.root)).toContain('当前会话暂无消息或自动续跑记录');
      const showAll = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '查看全部记录');
      await act(async () => { showAll.props.onClick(); });

      expect(collectText(root.root)).toContain('429 / Rate limit');
      const details = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '详情');
      await act(async () => { details.props.onClick(); });
      await flush(8);

      const text = collectText(root.root);
      expect(text).toContain('device-1:thread-a');
      expect(text).toContain('保留当前线路');
      expect(text).toContain('策略快照');
      expect(text).toContain('状态事件 · 1');
      expect(apiMock.getBridgeContinuationTask).toHaveBeenCalledWith('bridge-task-1', 200);
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('takes over an observed Connector session with the selected failure policies', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const limitMode = root.root.find((node) => node.type === Select && node.props['aria-label'] === '429 / Rate limit 次数模式');
      await act(async () => {
        limitMode.props.onChange({ target: { value: 'unlimited' } });
      });

      const takeoverButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '开启自动续跑');
      await act(async () => { takeoverButton.props.onClick(); });
      await flush(8);

      expect(apiMock.takeOverLocalConnectorSession).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: 'device-1',
        threadId: 'thread-new',
        policy: expect.objectContaining({
          enabled: true,
          continuePrompt: '继续',
          rules: expect.objectContaining({
            rate_limited: expect.objectContaining({
              action: 'continue_same_route',
              limit: { mode: 'unlimited' },
            }),
            retry_exhausted: expect.objectContaining({
              action: 'continue_rotate_credential',
              limit: { mode: 'bounded', maxContinuations: 3 },
            }),
          }),
        }),
      }));
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('selects the session requested by the overview deep link', async () => {
    apiMock.getLocalConnectorThreads.mockResolvedValue({
      success: true,
      items: [{
        id: 'observed-thread-first',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-first',
        observationSource: 'connector_app_server',
        controlState: 'available',
        title: '第一个会话',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:00:00.000Z',
      }, {
        id: 'observed-thread-target',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-target',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
        title: '总览指定的会话',
        threadStatus: 'active',
        activeFlags: ['waitingOnUserInput'],
        activeTurnId: 'turn-target',
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:02:00.000Z',
      }],
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions?threadId=thread-target']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const text = collectText(root.root);
      expect(text).toContain('总览指定的会话');
      expect(text).toContain('等待你输入 · Codex Desktop 正在使用，可直接追加消息');
      const selectedRow = root.root.find((node) => (
        node.type === 'button'
        && String(node.props.className || '').split(/\s+/).includes('connector-session-row')
        && String(node.props.className || '').split(/\s+/).includes('selected')
      ));
      expect(collectText(selectedRow)).toContain('总览指定的会话');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('shows a thread-scoped activity timeline and reloads it when the selected session changes', async () => {
    apiMock.getLocalConnectorThreads.mockResolvedValue({
      success: true,
      items: [{
        id: 'thread-one-row',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-one',
        observationSource: 'connector_app_server',
        controlState: 'available',
        title: '第一条会话',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:00:00.000Z',
      }, {
        id: 'thread-two-row',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-two',
        observationSource: 'connector_app_server',
        controlState: 'available',
        title: '第二条会话',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:01:00.000Z',
      }],
    });
    apiMock.getLocalConnectorThreadActivity.mockImplementation(async (_deviceId: string, threadId: string) => ({
      success: true,
      thread: { threadId },
      summary: { activityCount: 1, bridgeTasks: 1, interactions: 0, feishuDeliveries: 1, issues: 0 },
      topicBindings: threadId === 'thread-one' ? [{
        id: 'topic-one',
        adapterId: 'adapter-one',
        adapterName: 'Codex 助手',
        rootMessageId: 'om-root',
        feishuThreadId: 'omt-one',
        lastMessageId: 'om-last',
        createdAt: '2026-08-04T01:00:00.000Z',
        updatedAt: '2026-08-04T01:00:00.000Z',
      }] : [],
      items: [{
        id: `activity-${threadId}`,
        category: 'notification',
        eventType: 'turn_completion_notification',
        status: 'delivered',
        occurredAt: '2026-08-04T01:02:00.000Z',
        title: `${threadId} 完成通知`,
        detail: null,
        referenceId: `notification-${threadId}`,
        error: null,
        metadata: {},
      }],
    }));

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush(8);

      expect(collectText(root.root)).toContain('当前会话活动');
      expect(collectText(root.root)).toContain('话题已绑定');
      expect(collectText(root.root)).toContain('thread-one 完成通知');
      expect(apiMock.getLocalConnectorThreadActivity).toHaveBeenCalledWith('device-1', 'thread-one', 160);

      const secondSession = root.root.find((node) => (
        node.type === 'button'
        && String(node.props.className || '').split(/\s+/).includes('connector-session-row')
        && collectText(node).includes('第二条会话')
      ));
      await act(async () => { secondSession.props.onClick(); });
      await flush(8);

      expect(apiMock.getLocalConnectorThreadActivity).toHaveBeenCalledWith('device-1', 'thread-two', 160);
      expect(collectText(root.root)).toContain('thread-two 完成通知');
      expect(collectText(root.root)).not.toContain('话题已绑定');
      expect(apiMock.getInteractionRequests).toHaveBeenCalledWith({
        deviceId: 'device-1',
        threadId: 'thread-two',
        limit: 50,
      });
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('surfaces active interactions inside the selected session workspace', async () => {
    apiMock.getInteractionRequests.mockResolvedValue({
      success: true,
      items: [{
        state: {
          requestId: 'interaction-pending-1',
          sourceRequestKey: 'device-1:request-1',
          kind: 'command_approval',
          method: 'item/commandExecution/requestApproval',
          deviceId: 'device-1',
          connectionId: 'connection-1',
          sourceRequestId: 'request-1',
          threadId: 'thread-new',
          turnId: 'turn-1',
          itemId: 'item-1',
          status: 'pending',
          reason: '需要执行 npm run test',
          responsePayload: null,
          responseSource: null,
          responseOperatorId: null,
          responseIdempotencyKeyHash: null,
          responseCommittedAtMs: null,
          responseDeliveryCount: 0,
          responseDeliveredAtMs: null,
          resolvedAtMs: null,
          cancelledAtMs: null,
          expiresAtMs: Date.parse('2026-08-04T01:20:00.000Z'),
          createdAtMs: Date.parse('2026-08-04T01:02:00.000Z'),
          updatedAtMs: Date.parse('2026-08-04T01:02:00.000Z'),
        },
        requestPayload: { command: 'npm run test' },
        requestFingerprint: 'a'.repeat(64),
        responseFingerprint: null,
        stateVersion: 1,
        createdAt: '2026-08-04T01:02:00.000Z',
        updatedAt: '2026-08-04T01:02:00.000Z',
      }],
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush(8);

      const text = collectText(root.root);
      expect(text).toContain('当前会话待处理事项');
      expect(text).toContain('命令审批');
      expect(text).toContain('需要执行 npm run test');
      const requestLink = root.root.find((node) => (
        node.type === 'a' && String(node.props.className || '') === 'connector-thread-attention-row'
      ));
      expect(requestLink.props.href).toBe('/local-connector/device-1/interactions?view=approvals&request=interaction-pending-1');
      expect(apiMock.getInteractionRequests).toHaveBeenCalledWith({
        deviceId: 'device-1',
        threadId: 'thread-new',
        limit: 50,
      });
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('opens the matching task from a session row and makes the selection visible', async () => {
    const firstTask = createTask();
    const secondTask = createTask({
      taskId: 'bridge-task-2',
      sessionKey: 'device-1:thread-new',
      threadId: 'thread-new',
      status: 'running',
      reason: 'running',
    });
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [firstTask, secondTask] });
    apiMock.getBridgeContinuationTask.mockImplementation(async (taskId: string) => ({
      success: true,
      task: taskId === 'bridge-task-2' ? secondTask : firstTask,
      events: [],
    }));

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const openButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '详情');
      await act(async () => { openButton.props.onClick(); });
      await flush(8);

      expect(apiMock.getBridgeContinuationTask).toHaveBeenCalledWith('bridge-task-2', 200);
      expect(collectText(root.root)).toContain('正在检查 Connector 链路 · 自动续跑');
      expect(collectText(root.root)).toContain('正在执行');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('supports stopping a task and marking it as manually superseded', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const showAll = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '查看全部记录');
      await act(async () => { showAll.props.onClick(); });
      const stopButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '停止');
      await act(async () => { stopButton.props.onClick(); });
      await confirmDialog(root);
      await flush(6);
      expect(apiMock.stopBridgeContinuationTask).toHaveBeenCalledWith('bridge-task-1');

      const details = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '详情');
      await act(async () => { details.props.onClick(); });
      await flush(6);
      const supersedeButton = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '结束自动续跑');
      await act(async () => { supersedeButton.props.onClick(); });
      await confirmDialog(root);
      await flush(6);
      expect(apiMock.supersedeBridgeContinuationTask).toHaveBeenCalledWith('bridge-task-1');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('submits a manual Prompt and reuses its idempotency key after an ambiguous failure', async () => {
    const task = createTask();
    apiMock.createManualBridgePromptTask
      .mockRejectedValueOnce(new Error('network outcome unknown'))
      .mockResolvedValueOnce({
        success: true,
        created: true,
        deduplicated: false,
        supersededTaskId: 'bridge-task-1',
        task: createTask({
          taskId: 'bridge-task-prompt',
          taskKind: 'manual_prompt',
          submissionMode: 'start_next',
          pendingMethod: 'turn/start',
        }),
      });
    apiMock.getBridgeContinuationTasks.mockResolvedValue({ success: true, items: [task] });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const promptInput = root.root.find(
        (node) => node.type === 'textarea' && node.props['aria-label'] === '会话消息',
      );
      const modeSelect = root.root.find(
        (node) => node.type === Select && node.props['aria-label'] === '人工 Prompt 发送模式',
      );
      await act(async () => {
        promptInput.props.onChange({ target: { value: '完成当前检查后整理文档' } });
        modeSelect.props.onChange({ target: { value: 'start_next' } });
      });

      let promptForm = root.root.find(
        (node) => node.type === 'form' && node.findAll(
          (child) => child.type === 'textarea' && child.props['aria-label'] === '会话消息',
        ).length === 1,
      );
      await act(async () => { promptForm.props.onSubmit({ preventDefault: vi.fn() }); });
      await flush(6);

      promptForm = root.root.find(
        (node) => node.type === 'form' && node.findAll(
          (child) => child.type === 'textarea' && child.props['aria-label'] === '会话消息',
        ).length === 1,
      );
      await act(async () => { promptForm.props.onSubmit({ preventDefault: vi.fn() }); });
      await flush(8);

      expect(apiMock.createManualBridgePromptTask).toHaveBeenCalledTimes(2);
      const first = apiMock.createManualBridgePromptTask.mock.calls[0][0];
      const second = apiMock.createManualBridgePromptTask.mock.calls[1][0];
      expect(first).toMatchObject({
        deviceId: 'device-1',
        threadId: 'thread-new',
        threadStatus: 'idle',
        activeFlags: [],
        activeTurnId: null,
        prompt: '完成当前检查后整理文档',
        submissionMode: 'start_next',
        operatorId: 'webui:admin',
        idempotencyKey: expect.stringMatching(/^webui:bridge-prompt:/),
      });
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('allows a Desktop-owned active session to receive a direct message', async () => {
    apiMock.getLocalConnectorThreads.mockResolvedValue({
      success: true,
      items: [{
        id: 'desktop-thread-1',
        deviceId: 'device-1',
        deviceName: 'MacBook',
        devicePlatform: 'macos',
        deviceStatus: 'active',
        threadId: 'thread-desktop',
        title: 'Desktop 正在处理',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
        threadStatus: 'active',
        activeFlags: [],
        activeTurnId: 'turn-desktop',
        lastEventKind: 'thread_status',
        lastSeenAt: '2026-08-04T01:00:00.000Z',
      }],
    });
    apiMock.createManualBridgePromptTask.mockResolvedValue({
      success: true,
      created: true,
      deduplicated: false,
      supersededTaskId: null,
      task: createTask({ taskId: 'direct-desktop-message', threadId: 'thread-desktop', taskKind: 'manual_prompt' }),
    });

    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/sessions']}>
            <Routes>
              <Route path="/local-connector/:deviceId/sessions" element={<ToastProvider><BridgeContinuations /></ToastProvider>} />
            </Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      expect(collectText(root.root)).toContain('可直接追加消息');
      const promptInput = root.root.find((node) => node.type === 'textarea' && node.props['aria-label'] === '会话消息');
      await act(async () => { promptInput.props.onChange({ target: { value: '请继续当前工作' } }); });
      const promptForm = root.root.find((node) => node.type === 'form' && node.findAll(
        (child) => child.type === 'textarea' && child.props['aria-label'] === '会话消息',
      ).length === 1);
      await act(async () => { promptForm.props.onSubmit({ preventDefault: vi.fn() }); });
      await flush(8);

      expect(apiMock.createManualBridgePromptTask).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: 'device-1',
        threadId: 'thread-desktop',
        threadStatus: 'active',
        activeTurnId: 'turn-desktop',
        prompt: '请继续当前工作',
      }));
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });
});
