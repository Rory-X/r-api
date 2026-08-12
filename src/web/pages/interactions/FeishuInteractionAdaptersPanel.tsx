import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type FeishuInteractionAdapter,
  type FeishuLongConnection,
  type InteractionCardUpdate,
  type InteractionDispatch,
} from '../../api.js';
import BoundedHistoryList from '../../components/BoundedHistoryList.js';
import SideDrawer from '../../components/SideDrawer.js';
import { useToast } from '../../components/Toast.js';
import { Button, Disclosure, Input, Option, Select, Switch, TextArea, useConfirmDialog } from '../../components/ui/index.js';

const RECEIVE_ID_OPTIONS: Array<{
  value: FeishuInteractionAdapter['receiveIdType'];
  label: string;
}> = [
  { value: 'chat_id', label: '群聊 Chat ID' },
  { value: 'open_id', label: '用户 Open ID' },
  { value: 'user_id', label: '用户 User ID' },
  { value: 'union_id', label: '用户 Union ID' },
  { value: 'email', label: '用户邮箱' },
];

const fieldLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  color: 'var(--color-text-secondary)',
  fontSize: 12,
};

type AdapterDraft = {
  name: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  apiBaseUrl: string;
  receiveIdType: FeishuInteractionAdapter['receiveIdType'];
  receiveId: string;
  consoleBaseUrl: string;
  operatorAllowlist: string;
};

const EMPTY_DRAFT: AdapterDraft = {
  name: '',
  enabled: true,
  appId: '',
  appSecret: '',
  verificationToken: '',
  encryptKey: '',
  apiBaseUrl: 'https://open.feishu.cn',
  receiveIdType: 'chat_id',
  receiveId: '',
  consoleBaseUrl: '',
  operatorAllowlist: '',
};

function adapterDraft(adapter: FeishuInteractionAdapter): AdapterDraft {
  return {
    name: adapter.name,
    enabled: adapter.enabled,
    appId: adapter.appId,
    appSecret: '',
    verificationToken: '',
    encryptKey: '',
    apiBaseUrl: adapter.apiBaseUrl,
    receiveIdType: adapter.receiveIdType,
    receiveId: adapter.receiveId,
    consoleBaseUrl: adapter.consoleBaseUrl || '',
    operatorAllowlist: adapter.operatorAllowlist.join('\n'),
  };
}

function parseAllowlist(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((entry) => entry.trim()).filter(Boolean))];
}

function formatDate(value?: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function callbackUrl(adapter: FeishuInteractionAdapter): string {
  const browserOrigin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : '';
  const base = adapter.consoleBaseUrl || browserOrigin;
  return base ? `${base.replace(/\/+$/, '')}${adapter.callbackPath}` : adapter.callbackPath;
}

function dispatchStatusMeta(status: InteractionDispatch['status']): { label: string; className: string } {
  return {
    pending: { label: '等待投递', className: 'badge-warning' },
    processing: { label: '投递中', className: 'badge-info' },
    delivered: { label: '已送达', className: 'badge-success' },
    delivery_unknown: { label: '结果未知', className: 'badge-error' },
    failed: { label: '失败', className: 'badge-error' },
    cancelled: { label: '已取消', className: 'badge-muted' },
  }[status];
}

function DispatchStatusBadge({ status }: { status: InteractionDispatch['status'] }) {
  const meta = dispatchStatusMeta(status);
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

function cardUpdateStatusMeta(status: InteractionCardUpdate['status']): { label: string; className: string } {
  return {
    pending: { label: '等待回写', className: 'badge-warning' },
    processing: { label: '回写中', className: 'badge-info' },
    delivered: { label: '状态已回写', className: 'badge-success' },
    delivery_unknown: { label: '回写结果未知', className: 'badge-error' },
    failed: { label: '回写失败', className: 'badge-error' },
    cancelled: { label: '回写已取消', className: 'badge-muted' },
  }[status];
}

function SecretState({ configured }: { configured: boolean }) {
  return (
    <span className={`badge ${configured ? 'badge-success' : 'badge-muted'}`}>
      {configured ? '已配置' : '未配置'}
    </span>
  );
}

function connectionStatus(adapter: FeishuInteractionAdapter, connection?: FeishuLongConnection) {
  if (!adapter.enabled) return { label: '已停用', className: 'badge-muted' };
  if (!connection) return { label: '等待连接', className: 'badge-muted' };
  if (connection.state === 'connected') return { label: '长连接正常', className: 'badge-success' };
  if (connection.state === 'connecting') return { label: '连接中', className: 'badge-warning' };
  if (connection.state === 'reconnecting') return { label: '重连中', className: 'badge-warning' };
  if (connection.state === 'failed') return { label: '连接失败', className: 'badge-error' };
  return { label: '未连接', className: 'badge-muted' };
}

function dispatchSubjectLabel(dispatch: InteractionDispatch): string {
  return dispatch.subjectKind === 'interaction' ? '交互审批通知' : '会话消息卡片';
}

export default function FeishuInteractionAdaptersPanel({
  deviceId,
  onRequestSelect,
  onDispatchComplete,
}: {
  deviceId: string;
  onRequestSelect: (requestId: string) => void;
  onDispatchComplete: () => void;
}) {
  const { success, error, info } = useToast();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const [adapters, setAdapters] = useState<FeishuInteractionAdapter[]>([]);
  const [connections, setConnections] = useState<FeishuLongConnection[]>([]);
  const [selectedAdapterId, setSelectedAdapterId] = useState('');
  const [editingAdapterId, setEditingAdapterId] = useState('');
  const [draft, setDraft] = useState<AdapterDraft>({ ...EMPTY_DRAFT });
  const [dispatches, setDispatches] = useState<InteractionDispatch[]>([]);
  const [adaptersLoading, setAdaptersLoading] = useState(true);
  const [dispatchesLoading, setDispatchesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [retryingId, setRetryingId] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);

  const editingAdapter = useMemo(
    () => adapters.find((adapter) => adapter.id === editingAdapterId) || null,
    [adapters, editingAdapterId],
  );
  const selectedAdapter = useMemo(
    () => adapters.find((adapter) => adapter.id === selectedAdapterId) || null,
    [adapters, selectedAdapterId],
  );
  const connectionByAdapterId = useMemo(
    () => new Map(connections.map((connection) => [connection.adapterId, connection])),
    [connections],
  );
  const healthSummary = useMemo(() => ({
    connected: adapters.filter((adapter) => connectionByAdapterId.get(adapter.id)?.state === 'connected').length,
    enabled: adapters.filter((adapter) => adapter.enabled).length,
    failed: adapters.filter((adapter) => adapter.lastError || connectionByAdapterId.get(adapter.id)?.state === 'failed').length,
  }), [adapters, connectionByAdapterId]);
  const dispatchSummary = useMemo(() => ({
    pending: dispatches.filter((dispatch) => dispatch.status === 'pending' || dispatch.status === 'processing').length,
    failed: dispatches.filter((dispatch) => dispatch.status === 'failed' || dispatch.status === 'delivery_unknown').length,
  }), [dispatches]);

  const loadAdapters = async (preferredId = selectedAdapterId) => {
    setAdaptersLoading(true);
    try {
      const response = await api.getInteractionAdapters({ deviceId });
      const nextAdapters = Array.isArray(response.items) ? response.items : [];
      setAdapters(nextAdapters);
      const nextSelected = preferredId && nextAdapters.some((adapter) => adapter.id === preferredId)
        ? preferredId
        : nextAdapters[0]?.id || '';
      setSelectedAdapterId(nextSelected);
      return nextSelected;
    } catch (err: any) {
      error(err?.message || '加载飞书 Interaction Adapter 失败');
      return '';
    } finally {
      setAdaptersLoading(false);
    }
  };

  const loadConnections = async () => {
    try {
      const response = await api.getFeishuLongConnections();
      setConnections(Array.isArray(response.items) ? response.items : []);
    } catch {
      // Adapter errors remain visible through lastError; polling should stay quiet.
    }
  };

  const loadDispatches = async (adapterId = selectedAdapterId) => {
    if (!adapterId) {
      setDispatches([]);
      return;
    }
    setDispatchesLoading(true);
    try {
      const response = await api.getInteractionDispatches({ adapterId, limit: 50 });
      setDispatches(Array.isArray(response.items) ? response.items : []);
    } catch (err: any) {
      error(err?.message || '加载飞书投递记录失败');
    } finally {
      setDispatchesLoading(false);
    }
  };

  useEffect(() => {
    void loadAdapters();
    void loadConnections();
    const timer = setInterval(() => void loadConnections(), 5_000);
    return () => clearInterval(timer);
  }, [deviceId]);

  useEffect(() => {
    void loadDispatches(selectedAdapterId);
  }, [selectedAdapterId]);

  const startCreate = () => {
    setEditingAdapterId('');
    setDraft({ ...EMPTY_DRAFT });
    setEditorOpen(true);
  };

  const startEdit = (adapter: FeishuInteractionAdapter) => {
    setEditingAdapterId(adapter.id);
    setSelectedAdapterId(adapter.id);
    setDraft(adapterDraft(adapter));
    setEditorOpen(true);
  };

  const saveAdapter = async (event: React.FormEvent) => {
    event.preventDefault();
    const operatorAllowlist = parseAllowlist(draft.operatorAllowlist);
    if (!draft.name.trim() || !draft.appId.trim() || !draft.receiveId.trim()) {
      error('请填写 Adapter 名称、App ID 和接收目标');
      return;
    }
    if (operatorAllowlist.length === 0) {
      error('至少填写一个操作者白名单 ID');
      return;
    }
    if (!editingAdapterId && !draft.appSecret.trim()) {
      error('创建 Adapter 时必须填写 App Secret');
      return;
    }
    setSaving(true);
    try {
      const common = {
        name: draft.name.trim(),
        enabled: draft.enabled,
        appId: draft.appId.trim(),
        apiBaseUrl: draft.apiBaseUrl,
        receiveIdType: draft.receiveIdType,
        receiveId: draft.receiveId.trim(),
        consoleBaseUrl: draft.consoleBaseUrl.trim() || null,
        operatorAllowlist,
      };
      const response = editingAdapterId
        ? await api.updateFeishuInteractionAdapter(editingAdapterId, {
          deviceId,
          ...common,
          ...(draft.appSecret.trim() ? { appSecret: draft.appSecret.trim() } : {}),
          ...(draft.verificationToken.trim() ? { verificationToken: draft.verificationToken.trim() } : {}),
          ...(draft.encryptKey.trim() ? { encryptKey: draft.encryptKey.trim() } : {}),
        })
        : await api.createFeishuInteractionAdapter({
          deviceId,
          ...common,
          appSecret: draft.appSecret.trim(),
          ...(draft.verificationToken.trim() ? { verificationToken: draft.verificationToken.trim() } : {}),
          ...(draft.encryptKey.trim() ? { encryptKey: draft.encryptKey.trim() } : {}),
        });
      success(editingAdapterId ? '飞书 Adapter 已更新' : '飞书 Adapter 已创建');
      setEditingAdapterId(response.adapter.id);
      setSelectedAdapterId(response.adapter.id);
      setDraft(adapterDraft(response.adapter));
      await loadAdapters(response.adapter.id);
      await loadDispatches(response.adapter.id);
      setEditorOpen(false);
    } catch (err: any) {
      error(err?.message || '保存飞书 Interaction Adapter 失败');
    } finally {
      setSaving(false);
    }
  };

  const runDispatchPass = async () => {
    setRunning(true);
    try {
      const response = await api.runInteractionAdapterDispatch();
      const result = response.result || {};
      success(
        `扫描 ${Number(result.reconciled || 0)}，送达 ${Number(result.delivered || 0)}，失败 ${Number(result.failed || 0)}，未知 ${Number(result.unknown || 0)}`,
      );
      const adapterId = await loadAdapters(selectedAdapterId);
      await loadDispatches(adapterId);
      onDispatchComplete();
    } catch (err: any) {
      error(err?.message || '处理飞书待投递任务失败');
    } finally {
      setRunning(false);
    }
  };

  const retryDispatch = async (dispatch: InteractionDispatch) => {
    if (dispatch.status === 'delivery_unknown' && !await requestConfirmation({
      title: '重新投递飞书卡片',
      description: '该投递结果未知，重新投递可能产生重复卡片。确认重新入队吗？',
      confirmLabel: '重新入队',
      confirmVariant: 'danger',
    })) return;
    setRetryingId(dispatch.id);
    try {
      await api.retryInteractionDispatch(dispatch.id);
      info('投递已重新入队');
      await loadDispatches(dispatch.adapterId);
    } catch (err: any) {
      error(err?.message || '重新入队失败');
    } finally {
      setRetryingId('');
    }
  };

  const retryCardUpdate = async (dispatch: InteractionDispatch) => {
    const update = dispatch.cardUpdate;
    if (!update) return;
    if (update.status === 'delivery_unknown'
      && !await requestConfirmation({
        title: '重试飞书卡片回写',
        description: '卡片 PATCH 结果未知。确认以当前最终状态重新回写原卡片吗？',
        confirmLabel: '重试回写',
        confirmVariant: 'danger',
      })) return;
    setRetryingId(update.id);
    try {
      await api.retryInteractionCardUpdate(update.id);
      await api.runInteractionAdapterDispatch();
      info('卡片状态更新已重新入队');
      await loadDispatches(dispatch.adapterId);
    } catch (err: any) {
      error(err?.message || '卡片状态更新重新入队失败');
    } finally {
      setRetryingId('');
    }
  };

  const copyCallbackUrl = async (adapter: FeishuInteractionAdapter) => {
    try {
      await navigator.clipboard.writeText(callbackUrl(adapter));
      success('回调地址已复制');
    } catch {
      error('复制失败，请手动复制回调地址');
    }
  };

  const renderDispatch = (dispatch: InteractionDispatch) => {
    const update = dispatch.cardUpdate;
    const updateMeta = update ? cardUpdateStatusMeta(update.status) : null;
    const updateRetryable = update?.status === 'failed' || update?.status === 'delivery_unknown';
    return (
      <article className="feishu-dispatch-row">
        <div className="feishu-dispatch-primary">
          <div className="feishu-dispatch-heading">
            <strong>{dispatchSubjectLabel(dispatch)}</strong>
            <DispatchStatusBadge status={dispatch.status} />
          </div>
          <div className="feishu-dispatch-time">{formatDate(dispatch.createdAt)}</div>
          {dispatch.subjectKind === 'interaction' && dispatch.interactionId ? (
            <Button type="button" className="feishu-dispatch-open-request" onClick={() => onRequestSelect(dispatch.interactionId!)}>
              查看对应审批
            </Button>
          ) : null}
        </div>
        <div className={`feishu-dispatch-message ${dispatch.lastError ? 'has-error' : ''}`}>
          {dispatch.lastError || (dispatch.status === 'delivered' ? '通知已发送到飞书' : `等待下一次处理：${formatDate(dispatch.nextAttemptAt)}`)}
          {update && updateMeta && (
            <div className="feishu-card-update-status">
              <span className={`badge ${updateMeta.className}`}>{updateMeta.label}</span>
              <span>{update.lastError || `卡片状态：${update.targetStatus}`}</span>
            </div>
          )}
        </div>
        <div className="feishu-dispatch-actions">
          {(dispatch.status === 'failed' || dispatch.status === 'delivery_unknown') && (
            <Button type="button" className="btn btn-ghost" disabled={retryingId === dispatch.id} onClick={() => void retryDispatch(dispatch)}>
              {retryingId === dispatch.id ? '处理中...' : '重新发送通知'}
            </Button>
          )}
          {updateRetryable && update && (
            <Button type="button" className="btn btn-ghost" disabled={retryingId === update.id} onClick={() => void retryCardUpdate(dispatch)}>
              {retryingId === update.id ? '处理中...' : '重新同步卡片状态'}
            </Button>
          )}
          <Disclosure title="技术信息" className="feishu-dispatch-technical">
            <div>
              <span>投递 ID：{dispatch.id}</span>
              <span>尝试次数：{dispatch.attemptCount}</span>
              {dispatch.externalMessageId ? <span>飞书消息 ID：{dispatch.externalMessageId}</span> : null}
              {dispatch.interactionId ? <span>Interaction ID：{dispatch.interactionId}</span> : null}
              {dispatch.promptCardId ? <span>Prompt Card ID：{dispatch.promptCardId}</span> : null}
            </div>
          </Disclosure>
        </div>
      </article>
    );
  };

  return (
    <>
      <section className="card interaction-panel-card feishu-adapters-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="interaction-panel-header">
          <div>
            <div className="interaction-panel-title">飞书连接</div>
            <div className="interaction-panel-subtitle">先确认长连接与通知目标，再处理异常投递。</div>
          </div>
          <div className="interaction-panel-actions">
            <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={startCreate}>
              新建连接
            </Button>
            <Button type="button" className="btn btn-ghost" onClick={() => void runDispatchPass()} disabled={running || adapters.length === 0}>
              {running ? '处理中...' : '刷新并处理'}
            </Button>
          </div>
        </div>

        <div className="feishu-health-strip">
          <div><span>已连接</span><strong>{healthSummary.connected}/{healthSummary.enabled}</strong></div>
          <div><span>连接异常</span><strong>{healthSummary.failed}</strong></div>
          <div><span>待投递</span><strong>{dispatchSummary.pending}</strong></div>
          <div><span>投递异常</span><strong>{dispatchSummary.failed}</strong></div>
        </div>

        <div className="feishu-connection-list">
          {adaptersLoading && <div className="feishu-empty-state">加载中...</div>}
          {!adaptersLoading && adapters.length === 0 && <div className="feishu-empty-state">尚未配置飞书连接</div>}
          {!adaptersLoading && adapters.map((adapter) => {
            const active = adapter.id === selectedAdapterId;
            const connection = connectionByAdapterId.get(adapter.id);
            const status = connectionStatus(adapter, connection);
            return (
              <article key={adapter.id} className={`feishu-connection-row ${active ? 'is-active' : ''}`}>
                <Button type="button" className="feishu-connection-select" onClick={() => setSelectedAdapterId(adapter.id)}>
                  <span className="feishu-connection-heading">
                    <strong>{adapter.name}</strong>
                    <span className={`badge ${status.className}`}>{status.label}</span>
                  </span>
                  <span className="feishu-connection-target">通知目标 · {adapter.receiveIdType}:{adapter.receiveId}</span>
                  <span className="feishu-connection-meta">
                    最近事件 {formatDate(adapter.lastCallbackAt)} · 最近投递 {formatDate(adapter.lastDispatchAt)}
                  </span>
                  {adapter.lastError && <span className="feishu-adapter-error">{adapter.lastError}</span>}
                </Button>
                <div className="feishu-connection-actions">
                  <Button type="button" className="btn btn-ghost" onClick={() => startEdit(adapter)}>配置</Button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="card interaction-panel-card feishu-dispatches-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="interaction-panel-header interaction-panel-header-compact">
          <div className="interaction-panel-title">
            最近投递{selectedAdapter ? ` · ${selectedAdapter.name}` : ''}
          </div>
          <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} disabled={!selectedAdapterId || dispatchesLoading} onClick={() => void loadDispatches()}>
            刷新
          </Button>
        </div>
        {dispatchesLoading && <div style={{ padding: 18, color: 'var(--color-text-muted)', fontSize: 12 }}>加载中...</div>}
        {!dispatchesLoading && !selectedAdapterId && <div style={{ padding: 22, color: 'var(--color-text-muted)', fontSize: 12 }}>选择一个飞书连接查看投递记录</div>}
        {!dispatchesLoading && selectedAdapterId && dispatches.length === 0 && <div style={{ padding: 22, color: 'var(--color-text-muted)', fontSize: 12 }}>暂无投递记录</div>}
        {!dispatchesLoading && dispatches.length > 0 && (
          <BoundedHistoryList
            items={dispatches}
            getKey={(dispatch) => dispatch.id}
            renderItem={(dispatch) => renderDispatch(dispatch)}
            emptyText={null}
            modalTitle={`全部飞书投递${selectedAdapter ? ` · ${selectedAdapter.name}` : ''}`}
            modalDescription="主页面仅保留最近投递摘要。完整记录在弹窗内分页查看，异常记录仍可直接重试。"
            listClassName="feishu-dispatch-list"
            viewAllLabel={(count) => `查看全部投递（${count}）`}
          />
        )}
      </section>
      <SideDrawer
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={editingAdapter ? `配置 · ${editingAdapter.name}` : '新建飞书连接'}
        maxWidth={720}
        footer={(
          <div className="feishu-editor-footer">
            <span>{editingAdapter ? `SDK 长连接：${connectionStatus(editingAdapter, connectionByAdapterId.get(editingAdapter.id)).label}` : '保存后自动建立 SDK 长连接'}</span>
            <Button type="submit" form="feishu-adapter-editor" className="btn btn-primary" disabled={saving}>
              {saving ? '保存中...' : editingAdapter ? '保存修改' : '创建连接'}
            </Button>
          </div>
        )}
      >
        <form id="feishu-adapter-editor" onSubmit={(event) => void saveAdapter(event)} className="feishu-adapter-form">
          <div className="feishu-adapter-form-heading">
            <div className="feishu-editor-status">
              <span>连接启用后，通知发送与飞书消息接收都由官方 SDK 长连接处理。</span>
            </div>
            <Switch label="启用" checked={draft.enabled} onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))} />
          </div>
          <div className="feishu-adapter-fields">
            <label style={fieldLabelStyle}>连接名称<Input aria-label="飞书 Adapter 名称" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
            <label style={fieldLabelStyle}>API 区域<Select aria-label="飞书 API 区域" value={draft.apiBaseUrl} onChange={(event) => setDraft((current) => ({ ...current, apiBaseUrl: event.target.value }))}><Option value="https://open.feishu.cn">飞书 open.feishu.cn</Option><Option value="https://open.larksuite.com">Lark open.larksuite.com</Option></Select></label>
            <label style={fieldLabelStyle}>App ID<Input aria-label="飞书 App ID" value={draft.appId} onChange={(event) => setDraft((current) => ({ ...current, appId: event.target.value }))} autoComplete="off" /></label>
            <label style={fieldLabelStyle}>接收 ID 类型<Select aria-label="飞书接收 ID 类型" value={draft.receiveIdType} onChange={(event) => setDraft((current) => ({ ...current, receiveIdType: event.target.value as FeishuInteractionAdapter['receiveIdType'] }))}>{RECEIVE_ID_OPTIONS.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}</Select></label>
            <label style={fieldLabelStyle}>接收目标<Input aria-label="飞书接收目标" value={draft.receiveId} onChange={(event) => setDraft((current) => ({ ...current, receiveId: event.target.value }))} placeholder="oc_xxx / ou_xxx / email" /></label>
            <label style={fieldLabelStyle}>控制台公开 URL<Input aria-label="飞书控制台公开 URL" value={draft.consoleBaseUrl} onChange={(event) => setDraft((current) => ({ ...current, consoleBaseUrl: event.target.value }))} placeholder="https://gateway.example.com" /></label>
            <label style={fieldLabelStyle}><span className="feishu-secret-label">App Secret {editingAdapter && <SecretState configured={editingAdapter.secretsConfigured.appSecret} />}</span><Input aria-label="飞书 App Secret" type="password" value={draft.appSecret} onChange={(event) => setDraft((current) => ({ ...current, appSecret: event.target.value }))} placeholder={editingAdapter ? '留空表示不修改' : ''} autoComplete="new-password" /></label>
          </div>
          <label style={{ ...fieldLabelStyle, marginTop: 12 }}>操作者白名单<TextArea aria-label="飞书操作者白名单" value={draft.operatorAllowlist} onChange={(event) => setDraft((current) => ({ ...current, operatorAllowlist: event.target.value }))} rows={4} placeholder={'open_id:ou_xxx\nunion_id:on_xxx\nuser_id:12345'} spellCheck={false} className="feishu-allowlist-editor" /></label>
          <Disclosure title="HTTP 兼容与加密配置" className="feishu-advanced-settings">
            <div className="feishu-adapter-fields">
              <label style={fieldLabelStyle}><span className="feishu-secret-label">Verification Token {editingAdapter && <SecretState configured={editingAdapter.secretsConfigured.verificationToken} />}</span><Input aria-label="飞书 Verification Token" type="password" value={draft.verificationToken} onChange={(event) => setDraft((current) => ({ ...current, verificationToken: event.target.value }))} placeholder={editingAdapter ? '留空表示不修改' : '可选'} autoComplete="new-password" /></label>
              <label style={fieldLabelStyle}><span className="feishu-secret-label">Encrypt Key {editingAdapter && <SecretState configured={editingAdapter.secretsConfigured.encryptKey} />}</span><Input aria-label="飞书 Encrypt Key" type="password" value={draft.encryptKey} onChange={(event) => setDraft((current) => ({ ...current, encryptKey: event.target.value }))} placeholder={editingAdapter ? '留空表示不修改' : '可选'} autoComplete="new-password" /></label>
            </div>
            {editingAdapter && (
              <label style={{ ...fieldLabelStyle, marginTop: 12 }}>HTTP 兼容回调 URL<div className="feishu-callback-row"><Input aria-label="飞书卡片回调 URL" value={callbackUrl(editingAdapter)} readOnly /><Button type="button" className="btn btn-ghost" onClick={() => void copyCallbackUrl(editingAdapter)}>复制</Button></div></label>
            )}
          </Disclosure>
        </form>
      </SideDrawer>
      {confirmationDialog}
    </>
  );
}
