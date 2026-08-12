import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  api,
  type ProxyAttemptCommitState,
  type ProxyRequestLedgerDetail,
  type ProxyRequestLedgerListItem,
  type ProxyRequestLedgerStatus,
  type ProxyRequestLedgerSummary,
} from '../../api.js';
import CenteredModal from '../../components/CenteredModal.js';
import { MobileCard, MobileField } from '../../components/MobileCard.js';
import MobileDrawer from '../../components/MobileDrawer.js';
import ModernSelect from '../../components/ModernSelect.js';
import { useToast } from '../../components/Toast.js';
import { Button, Input } from '../../components/ui/index.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { formatDateTimeLocal } from '../helpers/checkinLogTime.js';

const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 5_000;
const PANEL_STORAGE_KEY = 'metapi.proxyLogs.requestLedgerPanelExpanded';

const EMPTY_SUMMARY: ProxyRequestLedgerSummary = {
  total: 0,
  active: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  unknown: 0,
  sentUnknown: 0,
};

const REQUEST_STATUS_OPTIONS = [
  { value: 'all', label: '全部请求状态' },
  { value: 'active', label: '进行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
  { value: 'unknown', label: '结果未知' },
];

const COMMIT_STATE_OPTIONS = [
  { value: 'all', label: '全部提交阶段' },
  { value: 'not_started', label: '未发送' },
  { value: 'request_sent', label: '请求已发送' },
  { value: 'response_started', label: '响应已开始' },
  { value: 'completed', label: '业务已完成' },
  { value: 'sent_unknown', label: '送达结果未知' },
];

type DetailState = {
  loading: boolean;
  data?: ProxyRequestLedgerDetail;
  error?: string;
};

type ProxyRequestLedgerPanelProps = {
  autoRefresh?: boolean;
};

function readStoredExpanded(): boolean {
  try {
    return globalThis.localStorage?.getItem(PANEL_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function persistExpanded(expanded: boolean) {
  try {
    globalThis.localStorage?.setItem(PANEL_STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {
    // Storage is optional; the panel remains usable without persistence.
  }
}

function formatRequestStatus(status: ProxyRequestLedgerStatus): string {
  return {
    active: '进行中',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
    unknown: '结果未知',
  }[status];
}

function formatAttemptStatus(status: ProxyRequestLedgerDetail['attempts'][number]['status']): string {
  return {
    in_flight: '进行中',
    succeeded: '成功',
    failed: '失败',
    cancelled: '已取消',
    unknown: '结果未知',
  }[status];
}

function formatCommitState(state?: ProxyAttemptCommitState | null): string {
  if (!state) return '-';
  return {
    not_started: '未发送',
    request_sent: '请求已发送',
    response_started: '响应已开始',
    completed: '业务已完成',
    sent_unknown: '送达结果未知',
  }[state];
}

function formatRetryOwner(owner: ProxyRequestLedgerListItem['retryOwner']): string {
  return {
    local_proxy: '本地 Proxy',
    upstream_gateway: '上游网关',
    cooperative: '协同',
  }[owner];
}

function statusTone(status: ProxyRequestLedgerStatus | ProxyRequestLedgerDetail['attempts'][number]['status']) {
  if (status === 'succeeded') {
    return { color: 'var(--color-success)', background: 'var(--color-success-soft)' };
  }
  if (status === 'failed') {
    return { color: 'var(--color-danger)', background: 'var(--color-danger-soft)' };
  }
  if (status === 'unknown') {
    return { color: 'var(--color-warning)', background: 'var(--color-warning-soft)' };
  }
  if (status === 'active' || status === 'in_flight') {
    return { color: 'var(--color-info)', background: 'var(--color-info-soft)' };
  }
  return { color: 'var(--color-text-secondary)', background: 'var(--color-bg)' };
}

function StatusBadge({
  status,
  attempt = false,
}: {
  status: ProxyRequestLedgerStatus | ProxyRequestLedgerDetail['attempts'][number]['status'];
  attempt?: boolean;
}) {
  const tone = statusTone(status);
  return (
    <span
      className="badge"
      style={{ color: tone.color, background: tone.background, borderColor: tone.color }}
    >
      {attempt
        ? formatAttemptStatus(status as ProxyRequestLedgerDetail['attempts'][number]['status'])
        : formatRequestStatus(status as ProxyRequestLedgerStatus)}
    </span>
  );
}

function CommitStateBadge({ state }: { state?: ProxyAttemptCommitState | null }) {
  const isUnknown = state === 'sent_unknown';
  return (
    <span
      className="badge"
      style={{
        color: isUnknown ? 'var(--color-danger)' : 'var(--color-text-secondary)',
        background: isUnknown ? 'var(--color-danger-soft)' : 'var(--color-bg)',
        borderColor: isUnknown ? 'var(--color-danger)' : 'var(--color-border)',
      }}
    >
      {formatCommitState(state)}
    </span>
  );
}

function SummaryMetric({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <div style={{ minWidth: 74 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</div>
      <div
        style={{
          marginTop: 2,
          fontSize: 18,
          lineHeight: 1.2,
          fontWeight: 650,
          color: danger && value > 0 ? 'var(--color-danger)' : 'var(--color-text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function limitLabel(value: number | null, suffix = ''): string {
  return value == null ? '不限' : `${value.toLocaleString()}${suffix}`;
}

function identityLabel(item: ProxyRequestLedgerListItem): string {
  return item.clientThreadId || item.sessionId || item.bridgeTaskId || '-';
}

export default function ProxyRequestLedgerPanel({ autoRefresh = false }: ProxyRequestLedgerPanelProps) {
  const [items, setItems] = useState<ProxyRequestLedgerListItem[]>([]);
  const [summary, setSummary] = useState<ProxyRequestLedgerSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<ProxyRequestLedgerStatus | 'all'>('all');
  const [commitState, setCommitState] = useState<ProxyAttemptCommitState | 'all'>('all');
  const [searchInput, setSearchInput] = useState('');
  const search = useDeferredValue(searchInput.trim());
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(readStoredExpanded);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [detailByRequestId, setDetailByRequestId] = useState<Record<string, DetailState>>({});
  const loadSequence = useRef(0);
  const toast = useToast();
  const isMobile = useIsMobile(768);

  const load = useCallback(async (silent = false) => {
    const sequence = ++loadSequence.current;
    if (!silent) setLoading(true);
    try {
      const response = await api.getProxyRequestLedgers({
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        status,
        commitState,
        search,
      });
      if (sequence !== loadSequence.current) return;
      setItems(Array.isArray(response.items) ? response.items : []);
      setSummary(response.summary || EMPTY_SUMMARY);
      setTotal(Number(response.total || 0));
    } catch (error: any) {
      if (sequence !== loadSequence.current) return;
      if (!silent) toast.error(error?.message || '加载请求台账失败');
    } finally {
      if (!silent && sequence === loadSequence.current) setLoading(false);
    }
  }, [commitState, page, search, status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    persistExpanded(expanded);
  }, [expanded]);

  useEffect(() => {
    setPage(1);
  }, [commitState, search, status]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const loadDetail = useCallback(async (requestId: string, force = false) => {
    const existing = detailByRequestId[requestId];
    if (!force && (existing?.loading || existing?.data)) return;
    setDetailByRequestId((current) => ({
      ...current,
      [requestId]: { loading: true, data: force ? current[requestId]?.data : undefined },
    }));
    try {
      const detail = await api.getProxyRequestLedgerDetail(requestId);
      setDetailByRequestId((current) => ({
        ...current,
        [requestId]: { loading: false, data: detail },
      }));
    } catch (error: any) {
      const message = error?.message || '加载请求台账详情失败';
      setDetailByRequestId((current) => ({
        ...current,
        [requestId]: { loading: false, error: message },
      }));
      toast.error(message);
    }
  }, [detailByRequestId, toast]);

  const openDetail = useCallback((requestId: string) => {
    setSelectedRequestId(requestId);
    setShowDetail(true);
    void loadDetail(requestId);
  }, [loadDetail]);

  const selectedListItem = useMemo(
    () => items.find((item) => item.requestId === selectedRequestId) || null,
    [items, selectedRequestId],
  );
  const selectedDetailState = selectedRequestId ? detailByRequestId[selectedRequestId] : undefined;
  const detail = selectedDetailState?.data;

  const renderDetail = () => {
    if (selectedDetailState?.loading && !detail) {
      return <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>加载请求台账详情中...</div>;
    }
    if (selectedDetailState?.error && !detail) {
      return <div className="alert alert-error">{selectedDetailState.error}</div>;
    }
    if (!detail) {
      return <div style={{ padding: 20, color: 'var(--color-text-muted)' }}>暂无详情</div>;
    }

    const budget = detail.retryBudget;
    return (
      <div style={{ display: 'grid', gap: 16 }} data-proxy-ledger-detail>
        {detail.hasSentUnknown ? (
          <div className="alert alert-error" data-proxy-ledger-detail-warning>
            该请求包含 sent_unknown 尝试。默认安全策略不会自动重放，需要结合上游业务状态人工判断。
          </div>
        ) : null}

        <section style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>请求上下文</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))',
              gap: 10,
            }}
          >
            {[
              ['Request ID', detail.requestId],
              ['请求状态', formatRequestStatus(detail.status)],
              ['模型', detail.requestedModel],
              ['下游路径', detail.downstreamPath],
              ['客户端', detail.clientKind || '-'],
              ['Thread / Session', identityLabel(detail)],
              ['下游 Key', detail.downstreamApiKeyName || (detail.downstreamApiKeyId ? `#${detail.downstreamApiKeyId}` : '-')],
              ['Bridge Task', detail.bridgeTaskId || '-'],
              ['开始时间', formatDateTimeLocal(detail.createdAt)],
              ['结束时间', formatDateTimeLocal(detail.finishedAt)],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  minWidth: 0,
                  padding: 10,
                  border: '1px solid var(--color-border-light)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-bg)',
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</div>
                <div style={{ marginTop: 4, fontSize: 12, overflowWrap: 'anywhere' }}>{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>策略快照与共享预算</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? 'repeat(2, minmax(0, 1fr))' : 'repeat(4, minmax(0, 1fr))',
              gap: 10,
            }}
          >
            {[
              ['重试归属', formatRetryOwner(detail.retryOwner)],
              ['重放安全', detail.replaySafety === 'safe_only' ? '仅安全重放' : '允许显式重放'],
              ['请求尝试', `${budget.attempts} / ${limitLabel(budget.limits.maxAttempts)}`],
              ['Credential 轮换', `${budget.credentialRotations} / ${limitLabel(budget.limits.maxCredentialRotations)}`],
              ['Channel 切换', `${budget.channelSwitches} / ${limitLabel(budget.limits.maxChannelSwitches)}`],
              ['总耗时预算', limitLabel(budget.limits.maxElapsedMs, ' ms')],
            ].map(([label, value]) => (
              <div key={label} style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</div>
                <div style={{ marginTop: 3, fontSize: 12, fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</div>
              </div>
            ))}
          </div>
        </section>

        <section style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>上游尝试 ({detail.attempts.length})</div>
          {detail.attempts.length === 0 ? (
            <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>尚未创建上游尝试。</div>
          ) : isMobile ? (
            <div className="mobile-card-list">
              {detail.attempts.map((attempt) => (
                <MobileCard
                  key={attempt.attemptId}
                  title={`尝试 ${attempt.attemptIndex + 1}`}
                  subtitle={attempt.siteName || attempt.endpoint || attempt.attemptId}
                  compact
                  headerActions={<CommitStateBadge state={attempt.commitState} />}
                >
                  <MobileField label="状态" value={<StatusBadge status={attempt.status} attempt />} />
                  <MobileField label="Channel" value={attempt.channelId ? `#${attempt.channelId}` : '-'} />
                  <MobileField label="Credential" value={attempt.credentialName || (attempt.credentialId ? `#${attempt.credentialId}` : '-')} />
                  <MobileField label="HTTP" value={attempt.statusCode ?? '-'} />
                  <MobileField label="目标" value={attempt.targetUrl || attempt.requestPath || '-'} />
                  <MobileField label="错误" value={attempt.errorSummary || '-'} />
                </MobileCard>
              ))}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>尝试</th>
                    <th>时间</th>
                    <th>站点 / Credential</th>
                    <th>Channel</th>
                    <th>状态</th>
                    <th>提交阶段</th>
                    <th>HTTP</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.attempts.map((attempt) => (
                    <tr
                      key={attempt.attemptId}
                      style={attempt.commitState === 'sent_unknown'
                        ? { background: 'color-mix(in srgb, var(--color-danger) 7%, var(--color-bg-card))' }
                        : undefined}
                    >
                      <td>
                        <div style={{ fontSize: 12, fontWeight: 650 }}>#{attempt.attemptIndex + 1}</div>
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}>
                          {attempt.attemptId}
                        </div>
                      </td>
                      <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTimeLocal(attempt.startedAt)}</td>
                      <td style={{ minWidth: 150 }}>
                        <div style={{ fontSize: 12 }}>{attempt.siteName || attempt.accountUsername || '-'}</div>
                        <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                          {attempt.credentialName || (attempt.credentialId ? `Credential #${attempt.credentialId}` : '-')}
                        </div>
                      </td>
                      <td style={{ fontSize: 12 }}>{attempt.channelId ? `#${attempt.channelId}` : '-'}</td>
                      <td><StatusBadge status={attempt.status} attempt /></td>
                      <td><CommitStateBadge state={attempt.commitState} /></td>
                      <td style={{ fontSize: 12 }}>{attempt.statusCode ?? '-'}</td>
                      <td style={{ maxWidth: 260, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        <div style={{ overflowWrap: 'anywhere' }}>{attempt.errorSummary || '-'}</div>
                        {attempt.targetUrl ? (
                          <div title={attempt.targetUrl} style={{ marginTop: 4, color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}>
                            {attempt.targetUrl}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    );
  };

  return (
    <>
      <section
        className="card"
        style={{ marginBottom: 12, padding: 14, display: 'grid', gap: 12 }}
        data-proxy-request-ledger-panel
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 650 }}>请求重试台账</div>
            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-muted)' }}>
              请求级策略快照、共享重试预算与上游尝试
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="ghost"
              style={{ border: '1px solid var(--color-border)' }}
              aria-expanded={expanded}
              data-proxy-ledger-panel-toggle
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? '收起台账' : '展开台账'}
            </Button>
            <Button
              variant="ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={() => void load()}
              disabled={loading}
            >
              {loading ? '刷新中...' : '刷新台账'}
            </Button>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 22px' }}>
          <SummaryMetric label="全部" value={summary.total} />
          <SummaryMetric label="进行中" value={summary.active} />
          <SummaryMetric label="失败" value={summary.failed} />
          <SummaryMetric label="结果未知" value={summary.unknown} danger />
          <SummaryMetric label="送达未知" value={summary.sentUnknown} danger />
        </div>

        {summary.sentUnknown > 0 ? (
          <div
            className="alert alert-error"
            style={{ margin: 0 }}
            data-proxy-ledger-sent-unknown-alert
          >
            {summary.sentUnknown} 个请求包含 sent_unknown。默认安全策略不会自动重放。
          </div>
        ) : null}

        <div className={`anim-collapse ${expanded ? 'is-open' : ''}`.trim()}>
          <div className="anim-collapse-inner">
            <div
              style={{
                paddingTop: 12,
                borderTop: '1px solid var(--color-border-light)',
                display: 'grid',
                gap: 12,
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: isMobile ? '1fr' : 'minmax(220px, 1fr) 180px 190px',
                  gap: 10,
                  alignItems: 'center',
                }}
              >
                <Input
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="Request ID、模型、Session、Thread"
                  aria-label="搜索请求台账"
                  data-proxy-ledger-search
                  style={{
                    width: '100%',
                    minHeight: 36,
                    padding: '8px 10px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--color-bg-card)',
                    color: 'var(--color-text-primary)',
                  }}
                />
                <ModernSelect
                  value={status}
                  onChange={(value) => setStatus(value as ProxyRequestLedgerStatus | 'all')}
                  options={REQUEST_STATUS_OPTIONS}
                  size="sm"
                  data-testid="proxy-ledger-status-filter"
                />
                <ModernSelect
                  value={commitState}
                  onChange={(value) => setCommitState(value as ProxyAttemptCommitState | 'all')}
                  options={COMMIT_STATE_OPTIONS}
                  size="sm"
                  data-testid="proxy-ledger-commit-filter"
                />
              </div>

              {loading && items.length === 0 ? (
                <div style={{ padding: 20, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                  加载请求台账中...
                </div>
              ) : items.length === 0 ? (
                <div style={{ padding: 20, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                  当前筛选条件下没有请求台账。
                </div>
              ) : isMobile ? (
                <div className="mobile-card-list">
                  {items.map((item) => (
                    <MobileCard
                      key={item.requestId}
                      title={item.requestedModel || item.requestId}
                      subtitle={formatDateTimeLocal(item.createdAt)}
                      compact
                      headerActions={<CommitStateBadge state={item.latestCommitState} />}
                      footerActions={
                        <Button variant="link" onClick={() => openDetail(item.requestId)}>
                          查看详情
                        </Button>
                      }
                    >
                      <MobileField label="Request ID" value={item.requestId} />
                      <MobileField label="状态" value={<StatusBadge status={item.status} />} />
                      <MobileField label="Thread / Session" value={identityLabel(item)} />
                      <MobileField label="尝试" value={item.attemptCount} />
                      <MobileField label="重试归属" value={formatRetryOwner(item.retryOwner)} />
                    </MobileCard>
                  ))}
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>Request / 会话</th>
                        <th>模型 / 路径</th>
                        <th>状态</th>
                        <th>提交阶段</th>
                        <th>尝试</th>
                        <th>策略</th>
                        <th style={{ textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr
                          key={item.requestId}
                          data-proxy-ledger-row={item.requestId}
                          style={item.hasSentUnknown
                            ? { background: 'color-mix(in srgb, var(--color-danger) 7%, var(--color-bg-card))' }
                            : undefined}
                        >
                          <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTimeLocal(item.createdAt)}</td>
                          <td style={{ minWidth: 210 }}>
                            <div style={{ fontSize: 12, fontWeight: 650, overflowWrap: 'anywhere' }}>{item.requestId}</div>
                            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--color-text-muted)', overflowWrap: 'anywhere' }}>
                              {identityLabel(item)}
                            </div>
                          </td>
                          <td style={{ minWidth: 150 }}>
                            <div style={{ fontSize: 12 }}>{item.requestedModel || '-'}</div>
                            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--color-text-muted)' }}>{item.downstreamPath}</div>
                          </td>
                          <td><StatusBadge status={item.status} /></td>
                          <td><CommitStateBadge state={item.latestCommitState} /></td>
                          <td style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{item.attemptCount}</td>
                          <td>
                            <div style={{ fontSize: 11 }}>{formatRetryOwner(item.retryOwner)}</div>
                            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--color-text-muted)' }}>
                              {item.replaySafety === 'safe_only' ? '仅安全重放' : '允许显式重放'}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <Button variant="link" onClick={() => openDetail(item.requestId)}>
                              查看详情
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {total > 0 ? (
                <div className="pagination">
                  <div style={{ marginRight: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
                    第 {page} / {totalPages} 页，共 {total.toLocaleString()} 条
                  </div>
                  <Button
                    variant="ghost"
                    className="pagination-btn"
                    aria-label="请求台账上一页"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    ‹
                  </Button>
                  <Button
                    variant="ghost"
                    className="pagination-btn"
                    aria-label="请求台账下一页"
                    disabled={page >= totalPages}
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                  >
                    ›
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {isMobile ? (
        <MobileDrawer
          open={showDetail}
          onClose={() => setShowDetail(false)}
          title={selectedListItem?.requestId || selectedRequestId || '请求台账详情'}
          closeLabel="关闭请求台账详情"
          side="right"
        >
          <div style={{ padding: 16 }}>{renderDetail()}</div>
        </MobileDrawer>
      ) : (
        <CenteredModal
          open={showDetail}
          onClose={() => setShowDetail(false)}
          title={selectedListItem?.requestId || selectedRequestId || '请求台账详情'}
          maxWidth={1040}
          closeOnBackdrop
          closeOnEscape
        >
          {renderDetail()}
        </CenteredModal>
      )}
    </>
  );
}
