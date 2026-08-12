import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  type InteractionEvent,
  type InteractionRequest,
  type InteractionRequestKind,
  type InteractionRequestStatus,
} from '../api.js';
import SideDrawer from '../components/SideDrawer.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { Button, Disclosure, Input, Option, Select, TextArea, useConfirmDialog } from '../components/ui/index.js';
import FeishuInteractionAdaptersPanel from './interactions/FeishuInteractionAdaptersPanel.js';

type ConnectorWorkspaceView = 'approvals' | 'feishu';

const STATUS_OPTIONS: Array<{ value: InteractionRequestStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待处理' },
  { value: 'response_pending', label: '等待客户端接收' },
  { value: 'resolved', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '已过期' },
];

const KIND_OPTIONS: Array<{ value: InteractionRequestKind | ''; label: string }> = [
  { value: '', label: '全部类型' },
  { value: 'command_approval', label: '命令审批' },
  { value: 'file_change_approval', label: '文件变更审批' },
  { value: 'permissions_approval', label: '权限审批' },
  { value: 'user_input', label: '用户输入' },
  { value: 'mcp_elicitation', label: 'MCP 交互' },
];

const ACTIVE_STATUSES = new Set<InteractionRequestStatus>(['pending', 'response_pending']);

const fieldLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  color: 'var(--color-text-secondary)',
  fontSize: 12,
};

type UserInputOption = { label: string; description?: string; isOther?: boolean };
type UserInputQuestion = {
  id: string;
  header?: string;
  question: string;
  isSecret?: boolean;
  options: UserInputOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatDate(value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return '-';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : String(value);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatStoredJson(value: string | null): string {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function createIdempotencyKey(requestId: string): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `webui:${requestId}:${suffix}`;
}

function kindLabel(kind: InteractionRequestKind): string {
  return KIND_OPTIONS.find((item) => item.value === kind)?.label || kind;
}

function statusMeta(status: InteractionRequestStatus): { label: string; className: string } {
  return {
    pending: { label: '待处理', className: 'badge-warning' },
    response_pending: { label: '等待客户端接收', className: 'badge-info' },
    resolved: { label: '已完成', className: 'badge-success' },
    cancelled: { label: '已取消', className: 'badge-muted' },
    expired: { label: '已过期', className: 'badge-error' },
  }[status];
}

function requestPriority(interaction: InteractionRequest): number {
  if (interaction.state.status === 'pending') return 0;
  if (interaction.state.status === 'response_pending') return 1;
  if (interaction.state.status === 'resolved') return 2;
  return 3;
}

function StatusBadge({ status }: { status: InteractionRequestStatus }) {
  const meta = statusMeta(status);
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="interaction-summary-metric" style={{ borderLeftColor: tone }}>
      <div className="interaction-summary-metric-label">{label}</div>
      <div className="interaction-summary-metric-value">{value}</div>
    </div>
  );
}

function requestTitle(interaction: InteractionRequest): string {
  const payload = interaction.requestPayload;
  if (interaction.state.kind === 'command_approval') {
    const command = typeof payload.command === 'string'
      ? payload.command
      : Array.isArray(payload.command)
        ? payload.command.join(' ')
        : '';
    return command || '命令执行审批';
  }
  if (interaction.state.kind === 'file_change_approval') {
    return typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason : '文件变更审批';
  }
  if (interaction.state.kind === 'permissions_approval') {
    return typeof payload.reason === 'string' && payload.reason.trim() ? payload.reason : '运行权限审批';
  }
  if (interaction.state.kind === 'mcp_elicitation') {
    return typeof payload.message === 'string' && payload.message.trim()
      ? payload.message
      : `${String(payload.serverName || 'MCP')} 交互`;
  }
  const questions = userInputQuestions(payload);
  return questions[0]?.question || 'Codex 等待用户输入';
}

function userInputQuestions(payload: Record<string, unknown>): UserInputQuestion[] {
  if (!Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') return [];
    const options = Array.isArray(value.options)
      ? value.options.flatMap((option) => (
        isRecord(option) && typeof option.label === 'string'
          ? [{
            label: option.label,
            description: typeof option.description === 'string' ? option.description : undefined,
            isOther: option.isOther === true,
          }]
          : []
      ))
      : [];
    return [{
      id: value.id,
      header: typeof value.header === 'string' ? value.header : undefined,
      question: value.question,
      isSecret: value.isSecret === true,
      options,
    }];
  });
}

function defaultResponsePayload(interaction: InteractionRequest): Record<string, unknown> {
  if (interaction.state.kind === 'command_approval' || interaction.state.kind === 'file_change_approval') {
    return { decision: 'accept' };
  }
  if (interaction.state.kind === 'permissions_approval') {
    const permissions = isRecord(interaction.requestPayload.permissions)
      ? interaction.requestPayload.permissions
      : isRecord(interaction.requestPayload.requestedPermissions)
        ? interaction.requestPayload.requestedPermissions
        : {};
    return { permissions, scope: 'turn' };
  }
  if (interaction.state.kind === 'user_input') return { answers: {} };
  return { action: 'accept', content: {} };
}

function approvalDecisions(interaction: InteractionRequest): string[] {
  const available = Array.isArray(interaction.requestPayload.availableDecisions)
    ? interaction.requestPayload.availableDecisions.filter((item): item is string => typeof item === 'string')
    : [];
  const defaults = interaction.state.kind === 'command_approval'
    ? ['accept', 'acceptForSession', 'decline', 'cancel']
    : ['accept', 'acceptForSession', 'decline', 'cancel'];
  return (available.length > 0 ? available : defaults).filter(
    (decision) => decision === 'accept'
      || decision === 'acceptForSession'
      || decision === 'decline'
      || decision === 'cancel',
  );
}

function decisionLabel(decision: string): string {
  if (decision === 'accept') return '允许';
  if (decision === 'acceptForSession') return '本会话允许';
  if (decision === 'decline') return '拒绝';
  if (decision === 'cancel') return '取消';
  return decision;
}

function requestContext(interaction: InteractionRequest): Array<{ label: string; value: string }> {
  const payload = interaction.requestPayload;
  const context: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) context.push({ label, value: value.trim() });
  };

  if (interaction.state.kind === 'command_approval') {
    push('工作目录', payload.cwd);
    push('审批原因', payload.reason);
  } else if (interaction.state.kind === 'file_change_approval') {
    push('工作目录', payload.cwd);
    push('目标文件', payload.path || payload.filePath);
    push('变更原因', payload.reason);
  } else if (interaction.state.kind === 'permissions_approval') {
    push('权限原因', payload.reason);
  } else if (interaction.state.kind === 'mcp_elicitation') {
    push('MCP Server', payload.serverName);
    push('请求说明', payload.message);
  }
  return context;
}

export default function InteractionRequests() {
  const { success, error, info } = useToast();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const isMobile = useIsMobile(900);
  const location = useLocation();
  const navigate = useNavigate();
  const { deviceId: routeDeviceId } = useParams<{ deviceId: string }>();
  const deviceId = routeDeviceId || '';
  const activeView = useMemo<ConnectorWorkspaceView>(() => (
    new URLSearchParams(location.search).get('view') === 'feishu' ? 'feishu' : 'approvals'
  ), [location.search]);
  const requestedRequestId = useMemo(
    () => new URLSearchParams(location.search).get('request')?.trim() || '',
    [location.search],
  );
  const [items, setItems] = useState<InteractionRequest[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<{ interaction: InteractionRequest; events: InteractionEvent[] } | null>(null);
  const [filterStatus, setFilterStatus] = useState<InteractionRequestStatus | ''>('pending');
  const [filterKind, setFilterKind] = useState<InteractionRequestKind | ''>('');
  const [filterThread, setFilterThread] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('{}');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const summary = useMemo(() => ({
    pending: items.filter((item) => item.state.status === 'pending').length,
    delivering: items.filter((item) => item.state.status === 'response_pending').length,
    resolved: items.filter((item) => item.state.status === 'resolved').length,
    closed: items.filter((item) => !ACTIVE_STATUSES.has(item.state.status) && item.state.status !== 'resolved').length,
  }), [items]);

  const loadItems = async (preferredId?: string, pinPreferred = false) => {
    setLoading(true);
    try {
      const response = await api.getInteractionRequests({
        deviceId: deviceId || undefined,
        status: filterStatus || undefined,
        kind: filterKind || undefined,
        threadId: filterThread.trim() || undefined,
        limit: 200,
      });
      const nextItems = (Array.isArray(response.items) ? response.items : []).slice().sort((left, right) => {
        const priority = requestPriority(left) - requestPriority(right);
        if (priority !== 0) return priority;
        if (left.state.status === 'pending' && right.state.status === 'pending') {
          return left.state.expiresAtMs - right.state.expiresAtMs;
        }
        return right.state.updatedAtMs - left.state.updatedAtMs;
      });
      setItems(nextItems);
      setSelectedId((current) => {
        const candidate = preferredId || current;
        if (pinPreferred && candidate) return candidate;
        if (candidate && nextItems.some((item) => item.state.requestId === candidate)) return candidate;
        return nextItems[0]?.state.requestId || '';
      });
    } catch (err: any) {
      error(err?.message || '加载 Interaction 请求失败');
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (requestId: string) => {
    if (!requestId) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const response = await api.getInteractionRequest(requestId, 200);
      if (deviceId && response.interaction.state.deviceId !== deviceId) {
        throw new Error('Interaction 不属于当前 Connector');
      }
      setDetail({
        interaction: response.interaction,
        events: Array.isArray(response.events) ? response.events : [],
      });
    } catch (err: any) {
      error(err?.message || '加载 Interaction 详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (activeView !== 'approvals') return;
    void loadItems(requestedRequestId || undefined, Boolean(requestedRequestId));
  }, [activeView, deviceId, requestedRequestId]);

  useEffect(() => {
    if (activeView !== 'approvals') return;
    void loadDetail(selectedId);
  }, [activeView, selectedId]);

  useEffect(() => {
    const interaction = detail?.interaction;
    if (!interaction) return;
    setJsonDraft(formatJson(defaultResponsePayload(interaction)));
    setIdempotencyKey(createIdempotencyKey(interaction.state.requestId));
    setAnswers({});
    setOtherAnswers({});
  }, [detail?.interaction.state.requestId]);

  const refresh = async (preferredId = selectedId) => {
    await Promise.all([
      loadItems(preferredId),
      preferredId ? loadDetail(preferredId) : Promise.resolve(),
    ]);
  };

  const submitResponse = async (responsePayload: Record<string, unknown>) => {
    const interaction = detail?.interaction;
    if (!interaction || interaction.state.status !== 'pending') return;
    setSubmitting(true);
    try {
      const response = await api.respondInteractionRequest(interaction.state.requestId, {
        responsePayload,
        operatorId: 'webui:admin',
        idempotencyKey: idempotencyKey || createIdempotencyKey(interaction.state.requestId),
      });
      if (response.deduplicated) info('该响应已提交，已按幂等键复用原结果');
      else success('Interaction 响应已提交');
      await refresh(interaction.state.requestId);
    } catch (err: any) {
      error(err?.message || '提交 Interaction 响应失败');
    } finally {
      setSubmitting(false);
    }
  };

  const submitJsonDraft = async () => {
    try {
      const parsed = JSON.parse(jsonDraft);
      if (!isRecord(parsed)) throw new Error('响应必须是 JSON 对象');
      await submitResponse(parsed);
    } catch (err: any) {
      error(err?.message || '响应 JSON 无效');
    }
  };

  const submitUserAnswers = async (questions: UserInputQuestion[]) => {
    const responseAnswers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const selected = (answers[question.id] || '').trim();
      const selectedOption = question.options.find((option) => option.label === selected);
      const resolved = selectedOption?.isOther
        ? (otherAnswers[question.id] || '').trim()
        : selected;
      if (!resolved) {
        error(`请填写：${question.header || question.question}`);
        return;
      }
      responseAnswers[question.id] = { answers: [resolved] };
    }
    await submitResponse({ answers: responseAnswers });
  };

  const cancelRequest = async () => {
    const interaction = detail?.interaction;
    if (!interaction || !ACTIVE_STATUSES.has(interaction.state.status)) return;
    if (!await requestConfirmation({
      title: '结束等待且不提交响应',
      description: '这不是“拒绝”。操作后 Codex 将停止等待该请求，且不会收到审批结果。',
      confirmLabel: '结束等待',
      confirmVariant: 'danger',
    })) return;
    setSubmitting(true);
    try {
      await api.cancelInteractionRequest(interaction.state.requestId);
      success('该请求已结束等待');
      await refresh(interaction.state.requestId);
      setMobileDetailOpen(false);
    } catch (err: any) {
      error(err?.message || '关闭 Interaction 请求失败');
    } finally {
      setSubmitting(false);
    }
  };

  const selected = detail?.interaction.state.requestId === selectedId
    ? detail.interaction
    : items.find((item) => item.state.requestId === selectedId) || null;
  const questions = selected ? userInputQuestions(selected.requestPayload) : [];
  const context = selected ? requestContext(selected) : [];
  const requiresRawJsonResponse = selected?.state.kind === 'mcp_elicitation';
  const pageTitle = activeView === 'feishu' ? '飞书连接设置' : '全部交互待办';
  const pageSubtitle = activeView === 'feishu'
    ? '这是 Connector 级设置：管理飞书应用长连接、通知目标和投递状态'
    : '跨会话查看 Codex 发起的命令、文件、权限和用户输入请求';

  const openApprovalRequest = (requestId: string) => {
    navigate(
      `/local-connector/${encodeURIComponent(deviceId)}/interactions?view=approvals&request=${encodeURIComponent(requestId)}`,
    );
  };

  const selectRequest = (requestId: string) => {
    setSelectedId(requestId);
    if (isMobile) setMobileDetailOpen(true);
  };

  const interactionDetailContent = !selected ? (
    <div className="interaction-detail-empty">选择一个请求查看并处理</div>
  ) : (
    <div className="interaction-detail-content">
      <div className="interaction-detail-header">
        <div style={{ minWidth: 0 }}>
          <div className="interaction-detail-kind">{kindLabel(selected.state.kind)}</div>
          <h3 className="interaction-detail-title">{requestTitle(selected)}</h3>
        </div>
        <div className="interaction-detail-actions">
          <StatusBadge status={selected.state.status} />
          {selected.state.status === 'response_pending' && (
            <Button className="btn btn-ghost" type="button" onClick={() => void cancelRequest()} disabled={submitting}>
              结束等待
            </Button>
          )}
        </div>
      </div>

      <div className="interaction-request-context">
        <div className="interaction-request-context-item">
          <span>到期时间</span>
          <strong>{formatDate(selected.state.expiresAtMs)}</strong>
        </div>
        {context.map((item) => (
          <div key={item.label} className="interaction-request-context-item">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      {selected.state.status === 'pending' && (
        <div className="interaction-response-section interaction-primary-response">
          <div className="interaction-subsection-title">
            {selected.state.kind === 'user_input' ? '填写回答' : '处理请求'}
          </div>

          {(selected.state.kind === 'command_approval' || selected.state.kind === 'file_change_approval') && (
            <div className="interaction-response-actions">
              {approvalDecisions(selected).map((decision) => (
                <Button
                  key={decision}
                  type="button"
                  className={`btn ${decision === 'accept' || decision === 'acceptForSession' ? 'btn-primary' : decision === 'decline' ? 'btn-danger' : 'btn-ghost'}`}
                  disabled={submitting}
                  onClick={() => void submitResponse({ decision })}
                >
                  {decisionLabel(decision)}
                </Button>
              ))}
            </div>
          )}

          {selected.state.kind === 'permissions_approval' && (
            <div className="interaction-response-actions">
              <Button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submitResponse({ ...defaultResponsePayload(selected), scope: 'turn' })}>允许本次</Button>
              <Button type="button" className="btn btn-ghost" disabled={submitting} onClick={() => void submitResponse({ ...defaultResponsePayload(selected), scope: 'session' })}>允许本会话</Button>
            </div>
          )}

          {selected.state.kind === 'user_input' && questions.length > 0 && (
            <div className="interaction-answer-form">
              {questions.map((question) => {
                const selectedOption = question.options.find((option) => option.label === answers[question.id]);
                return (
                  <label key={question.id} style={fieldLabelStyle}>
                    <span><strong>{question.header || question.id}</strong> · {question.question}</span>
                    {question.options.length > 0 ? (
                      <Select
                        aria-label={`Interaction 回答 ${question.id}`}
                        value={answers[question.id] || ''}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      >
                        <Option value="">请选择</Option>
                        {question.options.map((option) => <Option key={option.label} value={option.label}>{option.label}</Option>)}
                      </Select>
                    ) : (
                      <Input
                        aria-label={`Interaction 回答 ${question.id}`}
                        type={question.isSecret ? 'password' : 'text'}
                        value={answers[question.id] || ''}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      />
                    )}
                    {selectedOption?.description && <span className="interaction-answer-hint">{selectedOption.description}</span>}
                    {selectedOption?.isOther && (
                      <Input
                        aria-label={`Interaction 其他回答 ${question.id}`}
                        value={otherAnswers[question.id] || ''}
                        onChange={(event) => setOtherAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                        placeholder="填写自定义回答"
                      />
                    )}
                  </label>
                );
              })}
              <div><Button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submitUserAnswers(questions)}>提交回答</Button></div>
            </div>
          )}

          {selected.state.kind === 'mcp_elicitation' && (
            <>
              <div className="interaction-response-actions">
                <Button type="button" className="btn btn-ghost" disabled={submitting} onClick={() => void submitResponse({ action: 'decline', content: null })}>拒绝</Button>
                <Button type="button" className="btn btn-ghost" disabled={submitting} onClick={() => void submitResponse({ action: 'cancel', content: null })}>取消</Button>
              </div>
              {requiresRawJsonResponse && (
                <label style={{ ...fieldLabelStyle, marginTop: 16 }}>
                  MCP JSON 响应
                  <TextArea
                    aria-label="Interaction JSON 响应"
                    value={jsonDraft}
                    onChange={(event) => setJsonDraft(event.target.value)}
                    rows={9}
                    spellCheck={false}
                    className="interaction-json-editor"
                  />
                </label>
              )}
              <div style={{ marginTop: 10 }}>
                <Button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submitJsonDraft()}>
                  {submitting ? '提交中...' : '提交 MCP 响应'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {selected.state.responsePayload && (
        <div className="interaction-response-preview">
          <div className="interaction-response-preview-heading">
            <strong>已提交响应</strong>
            <span>{formatDate(selected.state.responseCommittedAtMs)}</span>
          </div>
          <div className="interaction-response-preview-copy">
            来源 {selected.state.responseSource || '-'} · 操作者 {selected.state.responseOperatorId || '-'} · 投递 {selected.state.responseDeliveryCount} 次
          </div>
        </div>
      )}

      <Disclosure title="技术信息" className="interaction-technical-disclosure">
        <div className="interaction-metadata-grid">
          {[
            ['Thread ID', selected.state.threadId],
            ['Turn ID', selected.state.turnId],
            ['Item ID', selected.state.itemId],
            ['Connector', selected.state.deviceId],
            ['App Server 方法', selected.state.method],
            ['Request ID', selected.state.sourceRequestId],
          ].map(([label, value]) => (
            <div key={label} className="interaction-metadata-cell">
              <div className="interaction-metadata-label">{label}</div>
              <div className="interaction-metadata-value" title={value || undefined}>{value || '-'}</div>
            </div>
          ))}
        </div>
        <Disclosure title="原始请求 JSON" className="interaction-raw-json-disclosure">
          <pre className="interaction-json-block">{formatJson(selected.requestPayload)}</pre>
        </Disclosure>
        {selected.state.responsePayload && (
          <Disclosure title="原始响应 JSON" className="interaction-raw-json-disclosure">
            <pre className="interaction-json-block interaction-json-block-compact">{formatJson(selected.state.responsePayload)}</pre>
          </Disclosure>
        )}
        <Disclosure title={`审计事件 · ${detail?.events.length || 0}`} className="interaction-audit-disclosure">
          {detailLoading && <div className="interaction-technical-empty">加载中...</div>}
          {!detailLoading && (detail?.events.length || 0) === 0 && <div className="interaction-technical-empty">暂无事件</div>}
          {!detailLoading && (detail?.events || []).map((event) => (
            <div key={event.id} className="interaction-audit-row">
              <div className="interaction-audit-heading">
                <strong>{event.eventType}</strong>
                <span>{formatDate(event.createdAt)}</span>
              </div>
              <div className="interaction-audit-copy">
                {event.fromStatus || 'new'} → {event.toStatus} · {event.actorKind}{event.actorId ? `:${event.actorId}` : ''}
              </div>
              {event.metadata && <pre>{formatStoredJson(event.metadata)}</pre>}
            </div>
          ))}
        </Disclosure>
        {selected.state.status === 'pending' && (
          <div className="interaction-abandon-action">
            <div>
              <strong>异常结束等待</strong>
              <span>不会向 Codex 提交“拒绝”结果，仅用于清理失去上下文的等待项。</span>
            </div>
            <Button className="btn btn-ghost" type="button" onClick={() => void cancelRequest()} disabled={submitting}>结束等待</Button>
          </div>
        )}
      </Disclosure>
    </div>
  );

  return (
    <div className="interaction-requests-page animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">{pageTitle}</h2>
          <div style={{ marginTop: 5, color: 'var(--color-text-muted)', fontSize: 12 }}>
            {pageSubtitle}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} to="/local-connector">所有 Connector</Link>
          {activeView === 'approvals' && (
            <Button
              type="button"
              className="btn btn-ghost"
              onClick={() => void refresh()}
              style={{ border: '1px solid var(--color-border)', display: 'inline-flex', gap: 7, alignItems: 'center' }}
              title="刷新审批请求和审计事件"
            >
              <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 11a8 8 0 10-2.34 5.66M20 4v7h-7" />
              </svg>
              刷新
            </Button>
          )}
        </div>
      </div>

      <nav className="tabs connector-workspace-tabs" aria-label="Connector 工作台导航">
        <Link className="tab" to={`/local-connector/${encodeURIComponent(deviceId)}/sessions`}>会话</Link>
        <Link className={`tab ${activeView === 'approvals' ? 'active' : ''}`} to={`/local-connector/${encodeURIComponent(deviceId)}/interactions?view=approvals`}>全部待办</Link>
        <Link className={`tab ${activeView === 'feishu' ? 'active' : ''}`} to={`/local-connector/${encodeURIComponent(deviceId)}/interactions?view=feishu`}>Connector 设置 · 飞书</Link>
      </nav>

      <div className="interaction-page-stack">
        {activeView === 'approvals' && (
          <>
        <section className="card interaction-command-bar" style={{ padding: 16 }}>
          <div className="interaction-summary-grid">
            <SummaryMetric label="待处理" value={summary.pending} tone="var(--color-warning)" />
            <SummaryMetric label="等待客户端" value={summary.delivering} tone="var(--color-info)" />
            <SummaryMetric label="已完成" value={summary.resolved} tone="var(--color-success)" />
            <SummaryMetric label="已关闭" value={summary.closed} tone="var(--color-text-muted)" />
          </div>
          <div className="interaction-filters-grid">
            <label style={fieldLabelStyle}>
              状态
              <Select aria-label="Interaction 状态筛选" value={filterStatus} onChange={(event) => setFilterStatus(event.target.value as InteractionRequestStatus | '')}>
                {STATUS_OPTIONS.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
              </Select>
            </label>
            <label style={fieldLabelStyle}>
              类型
              <Select aria-label="Interaction 类型筛选" value={filterKind} onChange={(event) => setFilterKind(event.target.value as InteractionRequestKind | '')}>
                {KIND_OPTIONS.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
              </Select>
            </label>
            <Button className="btn btn-primary" type="button" onClick={() => void loadItems()} disabled={loading}>应用筛选</Button>
            <Disclosure title="技术筛选" className="interaction-filter-disclosure">
              <label style={{ ...fieldLabelStyle, minWidth: 260, paddingTop: 8 }}>
                Thread ID
                <Input aria-label="Interaction Thread 筛选" value={filterThread} onChange={(event) => setFilterThread(event.target.value)} placeholder="仅在排障时精确匹配" />
              </label>
            </Disclosure>
          </div>
        </section>

        <div className="interaction-workspace">
          <section className="card interaction-queue-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="interaction-section-heading">
              请求队列 · {items.length}
            </div>
            <div className="interaction-queue-list">
              {loading && <div style={{ padding: 20, color: 'var(--color-text-muted)', fontSize: 12 }}>加载中...</div>}
              {!loading && items.length === 0 && <div style={{ padding: 28, color: 'var(--color-text-muted)', fontSize: 12, textAlign: 'center' }}>当前没有等待处理的请求</div>}
              {!loading && items.map((item) => {
                const active = item.state.requestId === selectedId;
                return (
                  <Button
                    key={item.state.requestId}
                    type="button"
                    className="interaction-request-row"
                    onClick={() => selectRequest(item.state.requestId)}
                    style={{
                      width: '100%',
                      display: 'block',
                      padding: '13px 16px',
                      border: 0,
                      borderBottom: '1px solid var(--color-border-light)',
                      borderLeft: active ? '3px solid var(--color-primary)' : '3px solid transparent',
                      background: active ? 'var(--color-bg-hover)' : 'transparent',
                      color: 'inherit',
                      textAlign: 'left',
                      cursor: 'pointer',
                      justifyContent: 'initial',
                    }}
                  >
                    <div className="interaction-request-row-heading">
                      <span className="interaction-request-kind">{kindLabel(item.state.kind)}</span>
                      <StatusBadge status={item.state.status} />
                    </div>
                    <div className="interaction-request-title" title={requestTitle(item)}>
                      {requestTitle(item)}
                    </div>
                    <div className="interaction-request-row-meta">
                      <span>{item.state.threadId || item.state.deviceId}</span>
                      <span>{formatDate(item.createdAt)}</span>
                    </div>
                  </Button>
                );
              })}
            </div>
          </section>

          {!isMobile && (
            <section className="card interaction-detail-card" style={{ padding: 20, minWidth: 0 }}>
              {interactionDetailContent}
            </section>
          )}
        </div>
        {isMobile && (
          <SideDrawer
            open={mobileDetailOpen}
            onClose={() => setMobileDetailOpen(false)}
            title={selected ? kindLabel(selected.state.kind) : '请求详情'}
            maxWidth={640}
          >
            {interactionDetailContent}
          </SideDrawer>
        )}
          </>
        )}

        {activeView === 'feishu' && (
        <FeishuInteractionAdaptersPanel
          deviceId={deviceId}
          onRequestSelect={openApprovalRequest}
          onDispatchComplete={() => undefined}
        />
        )}
      </div>
      {confirmationDialog}
    </div>
  );
}
