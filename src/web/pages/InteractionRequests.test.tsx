import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import { Select } from '../components/ui/index.js';
import InteractionRequests from './InteractionRequests.js';

vi.mock('./interactions/FeishuInteractionAdaptersPanel.js', () => ({
  default: ({ deviceId }: { deviceId: string }) => <div>飞书连接面板 · {deviceId}</div>,
}));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getInteractionRequests: vi.fn(),
    getInteractionRequest: vi.fn(),
    respondInteractionRequest: vi.fn(),
    cancelInteractionRequest: vi.fn(),
    getInteractionAdapters: vi.fn(),
    getInteractionDispatches: vi.fn(),
    createFeishuInteractionAdapter: vi.fn(),
    updateFeishuInteractionAdapter: vi.fn(),
    runInteractionAdapterDispatch: vi.fn(),
    retryInteractionDispatch: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

async function flush(rounds = 5) {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    state: {
      requestId: 'interaction-1',
      sourceRequestKey: 'source-key-1',
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      deviceId: 'device-1',
      connectionId: 'connection-1',
      sourceRequestId: '77',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      status: 'pending',
      reason: 'awaiting_operator',
      responsePayload: null,
      responseSource: null,
      responseOperatorId: null,
      responseIdempotencyKeyHash: null,
      responseCommittedAtMs: null,
      responseDeliveryCount: 0,
      responseDeliveredAtMs: null,
      resolvedAtMs: null,
      cancelledAtMs: null,
      expiresAtMs: Date.parse('2026-08-04T02:00:00.000Z'),
      createdAtMs: Date.parse('2026-08-04T01:00:00.000Z'),
      updatedAtMs: Date.parse('2026-08-04T01:00:00.000Z'),
      ...(overrides.state as Record<string, unknown> || {}),
    },
    requestPayload: {
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      command: 'npm test',
      cwd: '/workspace',
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      ...(overrides.requestPayload as Record<string, unknown> || {}),
    },
    requestFingerprint: 'a'.repeat(64),
    responseFingerprint: null,
    stateVersion: 1,
    createdAt: '2026-08-04T01:00:00.000Z',
    updatedAt: '2026-08-04T01:00:00.000Z',
  };
}

describe('InteractionRequests page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      innerWidth: 1280,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const item = interaction();
    apiMock.getInteractionRequests.mockResolvedValue({ success: true, items: [item] });
    apiMock.getInteractionRequest.mockResolvedValue({
      success: true,
      interaction: item,
      events: [{
        id: 1,
        interactionId: 'interaction-1',
        deliveryId: null,
        eventType: 'request_created',
        fromStatus: null,
        toStatus: 'pending',
        actorKind: 'connector',
        actorId: 'device-1',
        metadata: JSON.stringify({ kind: 'command_approval' }),
        createdAt: '2026-08-04T01:00:00.000Z',
      }],
    });
    apiMock.respondInteractionRequest.mockResolvedValue({
      success: true,
      deduplicated: false,
      request: interaction({ state: { status: 'response_pending' } }),
    });
    apiMock.cancelInteractionRequest.mockResolvedValue({
      success: true,
      interaction: interaction({ state: { status: 'cancelled', reason: 'manual_cancel' } }),
    });
    apiMock.getInteractionAdapters.mockResolvedValue({ success: true, items: [] });
    apiMock.getInteractionDispatches.mockResolvedValue({ success: true, items: [] });
    apiMock.runInteractionAdapterDispatch.mockResolvedValue({
      success: true,
      result: { reconciled: 0, recovered: 0, delivered: 0, failed: 0, unknown: 0, cancelled: 0 },
    });
    apiMock.retryInteractionDispatch.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows pending context and durable audit events', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/interactions']}>
            <Routes><Route path="/local-connector/:deviceId/interactions" element={<ToastProvider><InteractionRequests /></ToastProvider>} /></Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const text = collectText(root.root);
      expect(text).toContain('npm test');
      expect(text).toContain('/workspace');
      expect(text).toContain('item/commandExecution/requestApproval');
      expect(text).toContain('request_created');
      expect(root.root.findAll((node) => node.props['aria-label'] === 'Interaction JSON 响应')).toHaveLength(0);
      expect(apiMock.getInteractionRequests).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending' }));
      expect(apiMock.getInteractionRequest).toHaveBeenCalledWith('interaction-1', 200);
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('commits a common approval with a stable WebUI idempotency key', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/interactions']}>
            <Routes><Route path="/local-connector/:deviceId/interactions" element={<ToastProvider><InteractionRequests /></ToastProvider>} /></Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const allow = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '允许');
      await act(async () => { allow.props.onClick(); });
      await flush(8);

      expect(apiMock.respondInteractionRequest).toHaveBeenCalledWith('interaction-1', {
        responsePayload: { decision: 'accept' },
        operatorId: 'webui:admin',
        idempotencyKey: expect.stringMatching(/^webui:interaction-1:/),
      });
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('builds the official answer map for a user-input request', async () => {
    const inputRequest = interaction({
      state: { kind: 'user_input', method: 'item/tool/requestUserInput' },
      requestPayload: {
        questions: [{
          id: 'environment',
          header: 'Environment',
          question: 'Which environment?',
          options: [
            { label: 'Production', description: 'Use production' },
            { label: 'Staging', description: 'Use staging' },
          ],
        }],
      },
    });
    apiMock.getInteractionRequests.mockResolvedValue({ success: true, items: [inputRequest] });
    apiMock.getInteractionRequest.mockResolvedValue({ success: true, interaction: inputRequest, events: [] });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/interactions']}>
            <Routes><Route path="/local-connector/:deviceId/interactions" element={<ToastProvider><InteractionRequests /></ToastProvider>} /></Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const answer = root.root.find((node) => node.type === Select && node.props['aria-label'] === 'Interaction 回答 environment');
      await act(async () => { answer.props.onChange({ target: { value: 'Production' } }); });
      const submit = root.root.find((node) => node.type === 'button' && collectText(node).trim() === '提交回答');
      await act(async () => { submit.props.onClick(); });
      await flush(8);

      expect(apiMock.respondInteractionRequest).toHaveBeenCalledWith('interaction-1', expect.objectContaining({
        responsePayload: {
          answers: { environment: { answers: ['Production'] } },
        },
      }));
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('selects the request addressed by an IM console deep link', async () => {
    const first = interaction();
    const linked = interaction({
      state: { requestId: 'interaction-2', sourceRequestId: '88' },
      requestPayload: { command: 'npm run build' },
    });
    apiMock.getInteractionRequests.mockResolvedValue({ success: true, items: [first, linked] });
    apiMock.getInteractionRequest.mockImplementation(async (requestId: string) => ({
      success: true,
      interaction: requestId === 'interaction-2' ? linked : first,
      events: [],
    }));
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/interactions?request=interaction-2']}>
            <Routes><Route path="/local-connector/:deviceId/interactions" element={<ToastProvider><InteractionRequests /></ToastProvider>} /></Routes>
          </MemoryRouter>,
        );
      });
      await flush(8);

      expect(apiMock.getInteractionRequest).toHaveBeenCalledWith('interaction-2', 200);
      expect(collectText(root.root)).toContain('npm run build');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('opens a request in a drawer on mobile instead of stacking detail below the queue', async () => {
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      innerWidth: 600,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/interactions']}>
            <Routes><Route path="/local-connector/:deviceId/interactions" element={<ToastProvider><InteractionRequests /></ToastProvider>} /></Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      expect(root.root.findAll((node) => node.props.role === 'dialog')).toHaveLength(0);
      const requestRow = root.root.find((node) => node.type === 'button' && collectText(node).includes('npm test'));
      await act(async () => { requestRow.props.onClick(); });
      await flush();

      expect(root.root.findAll((node) => node.props.role === 'dialog')).toHaveLength(1);
      expect(collectText(root.root)).toContain('处理请求');
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });

  it('keeps the Feishu view separate from the approval queue', async () => {
    let root!: ReactTestRenderer;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/local-connector/device-1/interactions?view=feishu']}>
            <Routes><Route path="/local-connector/:deviceId/interactions" element={<ToastProvider><InteractionRequests /></ToastProvider>} /></Routes>
          </MemoryRouter>,
        );
      });
      await flush();

      const text = collectText(root.root);
      expect(text).toContain('飞书连接');
      expect(text).toContain('飞书连接面板 · device-1');
      expect(text).not.toContain('请求队列');
      expect(text).not.toContain('提交响应');
      expect(apiMock.getInteractionRequests).not.toHaveBeenCalled();
    } finally {
      await act(async () => { root?.unmount(); });
    }
  });
});
