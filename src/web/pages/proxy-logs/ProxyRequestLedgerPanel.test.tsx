import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';

import ModernSelect from '../../components/ModernSelect.js';
import { ToastProvider } from '../../components/Toast.js';
import ProxyRequestLedgerPanel from './ProxyRequestLedgerPanel.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProxyRequestLedgers: vi.fn(),
    getProxyRequestLedgerDetail: vi.fn(),
  },
}));

const { isMobileMock } = vi.hoisted(() => ({
  isMobileMock: vi.fn(),
}));

vi.mock('../../api.js', () => ({ api: apiMock }));
vi.mock('../../components/useIsMobile.js', () => ({ useIsMobile: isMobileMock }));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const listItem = {
  id: 1,
  requestId: 'req-risk-webui',
  requestedModel: 'gpt-5.4',
  downstreamPath: '/v1/responses',
  clientKind: 'codex',
  sessionId: 'session-webui',
  clientThreadId: 'thread-webui',
  clientTurnId: null,
  bridgeTaskId: null,
  bridgeRouteAction: null,
  bridgeContinuationNumber: null,
  downstreamApiKeyId: 9,
  downstreamApiKeyName: 'Local Codex',
  status: 'unknown',
  retryOwner: 'cooperative',
  replaySafety: 'safe_only',
  policySnapshot: { retryOwner: 'cooperative', replaySafety: 'safe_only' },
  retryBudget: {
    startedAtMs: 1_000,
    limits: {
      maxElapsedMs: 60_000,
      maxAttempts: 5,
      maxCredentialRotations: 2,
      maxChannelSwitches: 1,
    },
    attempts: 1,
    credentialRotations: 0,
    channelSwitches: 0,
  },
  attemptCount: 1,
  latestCommitState: 'sent_unknown',
  hasSentUnknown: true,
  createdAt: '2026-08-04 01:00:00',
  finishedAt: '2026-08-04 01:00:02',
  updatedAt: '2026-08-04 01:00:02',
} as const;

describe('ProxyRequestLedgerPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMobileMock.mockReturnValue(false);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
    apiMock.getProxyRequestLedgers.mockResolvedValue({
      items: [listItem],
      total: 1,
      limit: 20,
      offset: 0,
      summary: {
        total: 4,
        active: 1,
        succeeded: 1,
        failed: 1,
        cancelled: 0,
        unknown: 1,
        sentUnknown: 1,
      },
    });
    apiMock.getProxyRequestLedgerDetail.mockResolvedValue({
      ...listItem,
      attempts: [{
        id: 10,
        attemptId: 'attempt-risk-webui',
        attemptIndex: 0,
        channelId: 12,
        routeId: 3,
        routeModelPattern: 'gpt-5.4',
        accountId: 4,
        accountUsername: 'upstream-user',
        siteId: 5,
        siteName: 'Upstream A',
        credentialId: 6,
        credentialName: 'Credential A',
        endpoint: 'responses',
        requestPath: '/v1/responses',
        targetUrl: 'https://upstream.example/v1/responses?key=redacted',
        status: 'unknown',
        commitState: 'sent_unknown',
        errorScope: 'transport',
        statusCode: null,
        errorSummary: 'connection ended after send',
        startedAt: '2026-08-04 01:00:01',
        finishedAt: '2026-08-04 01:00:02',
        updatedAt: '2026-08-04 01:00:02',
      }],
      routingExplanation: {
        version: 1,
        requestedModel: 'gpt-5.4',
        route: { id: 3, name: 'GPT 高质量', modelPattern: 'gpt-5.4' },
        candidateCount: 2,
        candidates: [{
          channelId: 11,
          accountId: 3,
          username: 'filtered-user',
          siteName: 'Filtered Site',
          tokenName: 'default',
          priority: 0,
          sortOrder: 0,
          weight: 10,
          eligible: false,
          recentlyFailed: false,
          avoidedByRecentFailure: false,
          probability: 0,
          reason: '余额不足',
        }, {
          channelId: 12,
          accountId: 4,
          username: 'upstream-user',
          siteName: 'Upstream A',
          tokenName: 'Credential A',
          priority: 0,
          sortOrder: 1,
          weight: 10,
          eligible: true,
          recentlyFailed: false,
          avoidedByRecentFailure: false,
          probability: 62,
          reason: '当前权重命中概率 62%',
        }],
        decisions: [{
          selectionIndex: 0,
          retryCount: 0,
          selectionMode: 'initial',
          recordedAt: '2026-08-04T01:00:00.000Z',
          requestedModel: 'gpt-5.4',
          actualModel: 'gpt-5.4',
          matched: true,
          routeId: 3,
          routeName: 'GPT 高质量',
          modelPattern: 'gpt-5.4',
          selectedChannelId: 12,
          selectedAccountId: 4,
          selectedLabel: 'upstream-user @ Upstream A / Credential A',
          summary: ['命中路由：gpt-5.4'],
          candidates: [],
        }],
        attempts: [{
          attemptId: 'attempt-risk-webui',
          attemptIndex: 0,
          channelId: 12,
          channelLabel: 'Upstream A / upstream-user / Credential A',
          status: 'unknown',
          commitState: 'sent_unknown',
          statusCode: null,
          errorScope: 'transport',
          failureCode: 'transport_failure',
          errorSummary: 'connection ended after send',
        }],
        failovers: [],
        final: {
          status: 'unknown',
          channelId: 12,
          channelLabel: 'Upstream A / upstream-user / Credential A',
        },
      },
    });
  });

  it('renders global risk summary and highlights sent_unknown requests', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <ToastProvider>
          <ProxyRequestLedgerPanel />
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    expect(apiMock.getProxyRequestLedgers).toHaveBeenCalledWith({
      limit: 20,
      offset: 0,
      status: 'all',
      commitState: 'all',
      search: '',
    });
    const text = collectText(root.root);
    expect(text).toContain('请求重试台账');
    expect(text).toContain('1 个请求包含 sent_unknown');
    expect(text).toContain('req-risk-webui');
    expect(text).toContain('送达结果未知');
    expect(root.root.findAll((node) => node.props['data-proxy-ledger-row'] === 'req-risk-webui')).toHaveLength(1);

    await act(async () => root.unmount());
  });

  it('loads policy and attempt detail on demand', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <ToastProvider>
          <ProxyRequestLedgerPanel />
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const detailButton = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).trim() === '查看详情'
    ));
    await act(async () => detailButton.props.onClick());
    await flushMicrotasks();

    expect(apiMock.getProxyRequestLedgerDetail).toHaveBeenCalledWith('req-risk-webui');
    const text = collectText(root.root);
    expect(text).toContain('策略快照与共享预算');
    expect(text).toContain('路由解释');
    expect(text).toContain('GPT 高质量');
    expect(text).toContain('余额不足');
    expect(text).toContain('概率 62%');
    expect(text).toContain('仅安全重放');
    expect(text).toContain('Credential A');
    expect(text).toContain('connection ended after send');

    await act(async () => root.unmount());
  });

  it('keeps request and attempt fields complete on mobile', async () => {
    isMobileMock.mockReturnValue(true);

    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <ToastProvider>
          <ProxyRequestLedgerPanel />
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const listText = collectText(root.root);
    expect(listText).toContain('下游路径');
    expect(listText).toContain('/v1/responses');
    expect(listText).toContain('提交阶段');
    expect(listText).toContain('重放安全');
    expect(listText).toContain('包含 sent_unknown');

    const detailButton = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.onClick === 'function'
      && collectText(node).trim() === '查看详情'
    ));
    await act(async () => detailButton.props.onClick());
    await flushMicrotasks();

    const detailText = collectText(root.root);
    expect(detailText).toContain('Attempt ID');
    expect(detailText).toContain('attempt-risk-webui');
    expect(detailText).toContain('开始时间');
    expect(detailText).toContain('账号');
    expect(detailText).toContain('upstream-user');
    expect(detailText).toContain('提交阶段');
    expect(detailText).toContain('connection ended after send');

    await act(async () => root.unmount());
  });

  it('passes request and commit-state filters to the server', async () => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(
        <ToastProvider>
          <ProxyRequestLedgerPanel />
        </ToastProvider>,
      );
    });
    await flushMicrotasks();

    const filters = root.root.findAllByType(ModernSelect);
    await act(async () => {
      filters[0].props.onChange('unknown');
      filters[1].props.onChange('sent_unknown');
    });
    await flushMicrotasks();

    expect(apiMock.getProxyRequestLedgers).toHaveBeenLastCalledWith({
      limit: 20,
      offset: 0,
      status: 'unknown',
      commitState: 'sent_unknown',
      search: '',
    });

    await act(async () => root.unmount());
  });
});
