import React, { useEffect, useMemo, useState } from 'react';
import {
  api,
  type BridgeContinuationTask,
  type FeishuBridgePromptCard,
  type FeishuInteractionAdapter,
  type InteractionCardUpdate,
  type InteractionDispatch,
  type LocalConnectorDevice,
  type LocalConnectorThread,
} from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { Button, Option, Select, useConfirmDialog } from '../../components/ui/index.js';

const TTL_OPTIONS = [
  { value: 5 * 60_000, label: '5 分钟' },
  { value: 15 * 60_000, label: '15 分钟' },
  { value: 60 * 60_000, label: '1 小时' },
  { value: 4 * 60 * 60_000, label: '4 小时' },
  { value: 24 * 60 * 60_000, label: '24 小时' },
];

const fieldLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  color: 'var(--color-text-secondary)',
  fontSize: 12,
};

function newIdempotencyKey(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `webui:feishu-prompt-card:${suffix}`;
}

function formatDate(value?: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

function compactThreadId(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function threadStatusLabel(status: LocalConnectorThread['threadStatus']): string {
  return {
    unknown: '状态未知',
    not_loaded: '未加载',
    idle: '空闲',
    active: '进行中',
    system_error: '异常',
  }[status];
}

function cardStatusMeta(status: FeishuBridgePromptCard['status']): { label: string; className: string } {
  return {
    pending: { label: '等待输入', className: 'badge-warning' },
    consumed: { label: '已生成任务', className: 'badge-success' },
    expired: { label: '已过期', className: 'badge-error' },
    cancelled: { label: '已取消', className: 'badge-muted' },
  }[status];
}

function dispatchStatusLabel(status?: InteractionDispatch['status']): string {
  if (!status) return '未排队';
  return {
    pending: '等待投递',
    processing: '投递中',
    delivered: '已送达',
    delivery_unknown: '结果未知',
    failed: '投递失败',
    cancelled: '已取消',
  }[status];
}

function cardUpdateStatusLabel(update?: InteractionCardUpdate | null): string {
  if (!update) return '';
  return {
    pending: '等待状态回写',
    processing: '状态回写中',
    delivered: '状态已回写',
    delivery_unknown: '状态回写结果未知',
    failed: '状态回写失败',
    cancelled: '状态回写已取消',
  }[update.status];
}

function hasControlScope(device: LocalConnectorDevice): boolean {
  return device.status === 'active' && device.scopes.includes('app_server.control');
}

export default function FeishuPromptCardsPanel({ deviceId: connectorDeviceId }: { deviceId: string }) {
  const { success, error, info } = useToast();
  const isMobile = useIsMobile();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const [adapters, setAdapters] = useState<FeishuInteractionAdapter[]>([]);
  const [devices, setDevices] = useState<LocalConnectorDevice[]>([]);
  const [threads, setThreads] = useState<LocalConnectorThread[]>([]);
  const [tasks, setTasks] = useState<BridgeContinuationTask[]>([]);
  const [cards, setCards] = useState<FeishuBridgePromptCard[]>([]);
  const [adapterId, setAdapterId] = useState('');
  const [contextTaskId, setContextTaskId] = useState('');
  const [threadSelection, setThreadSelection] = useState('');
  const [deviceId, setDeviceId] = useState(connectorDeviceId);
  const [threadId, setThreadId] = useState('');
  const [ttlMs, setTtlMs] = useState(60 * 60_000);
  const [loading, setLoading] = useState(true);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [workingId, setWorkingId] = useState('');
  const [pendingRequest, setPendingRequest] = useState<{ signature: string; key: string } | null>(null);

  const controlDevices = useMemo(
    () => devices.filter((device) => device.id === connectorDeviceId && hasControlScope(device)),
    [connectorDeviceId, devices],
  );
  const selectableTasks = useMemo(() => {
    const allowedDeviceIds = new Set(controlDevices.map((device) => device.id));
    const seen = new Set<string>();
    return tasks.filter((task) => {
      if (!task.deviceId || !allowedDeviceIds.has(task.deviceId)) return false;
      const key = `${task.deviceId}:${task.state.threadId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [controlDevices, tasks]);
  const selectableThreads = useMemo(() => {
    const allowedDeviceIds = new Set(controlDevices.map((device) => device.id));
    const taskThreads = new Set(selectableTasks.map((task) => `${task.deviceId}:${task.state.threadId}`));
    return threads.filter((thread) => (
      allowedDeviceIds.has(thread.deviceId)
      && thread.controlState === 'available'
      && !taskThreads.has(`${thread.deviceId}:${thread.threadId}`)
    ));
  }, [controlDevices, selectableTasks, threads]);
  const selectedAdapter = useMemo(
    () => adapters.find((adapter) => adapter.id === adapterId) || null,
    [adapterId, adapters],
  );

  const loadCards = async (nextAdapterId = adapterId) => {
    if (!nextAdapterId) {
      setCards([]);
      return;
    }
    setCardsLoading(true);
    try {
      const response = await api.getFeishuBridgePromptCards({ adapterId: nextAdapterId, limit: 50 });
      setCards(Array.isArray(response.items) ? response.items : []);
    } catch (err: any) {
      error(err?.message || '加载主动 Prompt 卡片失败');
    } finally {
      setCardsLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const [adapterResponse, deviceResponse, taskResponse, threadResponse] = await Promise.all([
          api.getInteractionAdapters({ deviceId: connectorDeviceId }),
          api.getLocalConnectorDevices(),
          api.getBridgeContinuationTasks({ deviceId: connectorDeviceId, limit: 200 }),
          api.getLocalConnectorThreads({ deviceId: connectorDeviceId, limit: 200 }),
        ]);
        if (cancelled) return;
        const nextAdapters = Array.isArray(adapterResponse.items) ? adapterResponse.items : [];
        const nextDevices = Array.isArray(deviceResponse.items) ? deviceResponse.items : [];
        const nextTasks = Array.isArray(taskResponse.items) ? taskResponse.items : [];
        const nextThreads = Array.isArray(threadResponse.items) ? threadResponse.items : [];
        setAdapters(nextAdapters);
        setDevices(nextDevices);
        setTasks(nextTasks);
        setThreads(nextThreads);
        setAdapterId(nextAdapters.find((adapter) => adapter.enabled)?.id || nextAdapters[0]?.id || '');
        const controllableIds = new Set(nextDevices.filter(hasControlScope).map((device) => device.id));
        const firstTask = nextTasks.find((task) => task.deviceId
          && controllableIds.has(task.deviceId));
        if (firstTask?.deviceId) {
          setContextTaskId(firstTask.state.taskId);
          setThreadSelection(`task:${firstTask.state.taskId}`);
          setDeviceId(firstTask.deviceId);
          setThreadId(firstTask.state.threadId);
        } else {
          const firstThread = nextThreads.find((thread) => (
            controllableIds.has(thread.deviceId) && thread.controlState === 'available'
          ));
          if (firstThread) {
            setThreadSelection(`thread:${firstThread.id}`);
            setDeviceId(firstThread.deviceId);
            setThreadId(firstThread.threadId);
          } else {
            const firstDevice = nextDevices.find(hasControlScope);
            setDeviceId(firstDevice?.id || '');
          }
        }
      } catch (err: any) {
        if (!cancelled) error(err?.message || '加载飞书 Prompt 上下文失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    }, [connectorDeviceId]);

  useEffect(() => {
    void loadCards(adapterId);
  }, [adapterId]);

  const selectThread = (selection: string) => {
    setThreadSelection(selection);
    setPendingRequest(null);
    const task = selection.startsWith('task:')
      ? selectableTasks.find((item) => item.state.taskId === selection.slice('task:'.length))
      : null;
    if (task?.deviceId) {
      setContextTaskId(task.state.taskId);
      setDeviceId(task.deviceId);
      setThreadId(task.state.threadId);
      return;
    }
    const thread = selection.startsWith('thread:')
      ? selectableThreads.find((item) => item.id === selection.slice('thread:'.length))
      : null;
    setContextTaskId('');
    if (thread) {
      setDeviceId(thread.deviceId);
      setThreadId(thread.threadId);
    }
  };

  const refreshThreadContexts = async () => {
    setLoading(true);
    try {
      const [deviceResponse, taskResponse, threadResponse] = await Promise.all([
        api.getLocalConnectorDevices(),
        api.getBridgeContinuationTasks({ deviceId: connectorDeviceId, limit: 200 }),
        api.getLocalConnectorThreads({ deviceId: connectorDeviceId, limit: 200 }),
      ]);
      const nextDevices = Array.isArray(deviceResponse.items) ? deviceResponse.items : [];
      const nextTasks = Array.isArray(taskResponse.items) ? taskResponse.items : [];
      const nextThreads = Array.isArray(threadResponse.items) ? threadResponse.items : [];
      setDevices(nextDevices);
      setTasks(nextTasks);
      setThreads(nextThreads);
      const stillAvailable = contextTaskId
        ? nextTasks.some((task) => task.state.taskId === contextTaskId)
        : nextThreads.some((thread) => (
          thread.deviceId === deviceId
          && thread.threadId === threadId
          && thread.controlState === 'available'
        ));
      if (!stillAvailable) {
        const controllableIds = new Set(nextDevices.filter(hasControlScope).map((device) => device.id));
        const firstTask = nextTasks.find((task) => task.deviceId && controllableIds.has(task.deviceId));
        const firstThread = nextThreads.find((thread) => (
          controllableIds.has(thread.deviceId) && thread.controlState === 'available'
        ));
        if (firstTask?.deviceId) {
          setThreadSelection(`task:${firstTask.state.taskId}`);
          setContextTaskId(firstTask.state.taskId);
          setDeviceId(firstTask.deviceId);
          setThreadId(firstTask.state.threadId);
        } else if (firstThread) {
          setThreadSelection(`thread:${firstThread.id}`);
          setContextTaskId('');
          setDeviceId(firstThread.deviceId);
          setThreadId(firstThread.threadId);
        }
      }
      success('Codex 会话已刷新');
    } catch (err: any) {
      error(err?.message || '刷新 Codex 会话失败');
    } finally {
      setLoading(false);
    }
  };

  const sendPromptCard = async () => {
    if (!adapterId) {
      error('请选择飞书 Adapter');
      return;
    }
    if (!contextTaskId && (!deviceId || !threadId.trim())) {
      error('请选择当前 Connector 已发现的 Codex 会话');
      return;
    }
    const signature = JSON.stringify({ adapterId, contextTaskId, deviceId, threadId: threadId.trim(), ttlMs });
    const idempotencyKey = pendingRequest?.signature === signature
      ? pendingRequest.key
      : newIdempotencyKey();
    setPendingRequest({ signature, key: idempotencyKey });
    setSending(true);
    try {
      const response = await api.createFeishuBridgePromptCard(adapterId, {
        ...(contextTaskId ? { contextTaskId } : { deviceId, threadId: threadId.trim() }),
        ttlMs,
        requestedBy: 'webui:admin',
        idempotencyKey,
      });
      setPendingRequest(null);
      success(response.created ? 'Prompt 卡片已排队' : '该 Prompt 卡片已存在');
      try {
        await api.runInteractionAdapterDispatch();
      } catch (dispatchError: any) {
        info(dispatchError?.message || '卡片已排队，等待后台投递');
      }
      await loadCards(adapterId);
    } catch (err: any) {
      error(err?.message || '创建主动 Prompt 卡片失败；再次提交会复用同一幂等键');
    } finally {
      setSending(false);
    }
  };

  const cancelCard = async (card: FeishuBridgePromptCard) => {
    if (!await requestConfirmation({
      title: '取消 Prompt 卡片',
      description: '取消后飞书中的卡片将不能再提交 Prompt。',
      confirmLabel: '确认取消',
      confirmVariant: 'danger',
    })) return;
    setWorkingId(card.id);
    try {
      await api.cancelFeishuBridgePromptCard(card.id);
      success('Prompt 卡片已取消');
      await loadCards(card.adapterId);
    } catch (err: any) {
      error(err?.message || '取消 Prompt 卡片失败');
    } finally {
      setWorkingId('');
    }
  };

  const retryDispatch = async (card: FeishuBridgePromptCard) => {
    const dispatch = card.dispatch;
    if (!dispatch) return;
    if (dispatch.status === 'delivery_unknown'
      && !await requestConfirmation({
        title: '重新投递 Prompt 卡片',
        description: '投递结果未知，重新投递可能产生重复卡片。确认重新入队吗？',
        confirmLabel: '重新入队',
        confirmVariant: 'danger',
      })) return;
    setWorkingId(card.id);
    try {
      await api.retryInteractionDispatch(dispatch.id);
      await api.runInteractionAdapterDispatch();
      info('投递已重新入队');
      await loadCards(card.adapterId);
    } catch (err: any) {
      error(err?.message || '重新投递失败');
    } finally {
      setWorkingId('');
    }
  };

  const retryCardUpdate = async (card: FeishuBridgePromptCard) => {
    const update = card.dispatch?.cardUpdate;
    if (!update) return;
    if (update.status === 'delivery_unknown'
      && !await requestConfirmation({
        title: '重试 Prompt 卡片回写',
        description: '卡片 PATCH 结果未知。确认以当前最终状态重新回写原卡片吗？',
        confirmLabel: '重试回写',
        confirmVariant: 'danger',
      })) return;
    setWorkingId(update.id);
    try {
      await api.retryInteractionCardUpdate(update.id);
      await api.runInteractionAdapterDispatch();
      info('卡片状态更新已重新入队');
      await loadCards(card.adapterId);
    } catch (err: any) {
      error(err?.message || '卡片状态更新重试失败');
    } finally {
      setWorkingId('');
    }
  };

  return (
    <>
      <section className="card interaction-panel-card feishu-prompt-compose-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="interaction-panel-header">
          <div>
            <div className="interaction-panel-title">飞书主动 Prompt</div>
            <div className="interaction-panel-subtitle">从一个可控制的 Codex 会话发起一次性 Prompt 卡片。</div>
          </div>
        </div>
        <div className="interaction-panel-body">
          <div className="feishu-prompt-context-grid">
            <label style={fieldLabelStyle}>
              飞书 Adapter
              <Select aria-label="主动 Prompt 飞书 Adapter" value={adapterId} onChange={(event) => { setAdapterId(event.target.value); setPendingRequest(null); }} disabled={loading}>
                {adapters.length === 0 && <Option value="">暂无 Adapter</Option>}
                {adapters.map((adapter) => <Option key={adapter.id} value={adapter.id}>{adapter.name}{adapter.enabled ? '' : '（已停用）'}</Option>)}
              </Select>
            </label>
            <div style={fieldLabelStyle}>
              <span>Codex 会话</span>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
                <Select aria-label="主动 Prompt Codex 会话" value={threadSelection} onChange={(event) => selectThread(event.target.value)} disabled={loading}>
                  <Option value="">{selectableTasks.length + selectableThreads.length > 0 ? '选择会话' : '暂无已发现会话'}</Option>
                  {selectableTasks.map((task) => (
                    <Option key={task.state.taskId} value={`task:${task.state.taskId}`}>
                      Bridge · {compactThreadId(task.state.threadId)} · {task.state.status} · {formatDate(task.updatedAt)}
                    </Option>
                  ))}
                  {selectableThreads.map((thread) => (
                    <Option key={thread.id} value={`thread:${thread.id}`}>
                      最近 · {compactThreadId(thread.threadId)} · {thread.deviceName} · {threadStatusLabel(thread.threadStatus)} · {formatDate(thread.lastSeenAt)}
                    </Option>
                  ))}
                </Select>
                <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', whiteSpace: 'nowrap' }} onClick={() => void refreshThreadContexts()} disabled={loading}>刷新</Button>
              </div>
            </div>
            <label style={fieldLabelStyle}>
              有效期
              <Select aria-label="主动 Prompt 卡片有效期" value={ttlMs} onChange={(event) => { setTtlMs(Number(event.target.value)); setPendingRequest(null); }}>
                {TTL_OPTIONS.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
              </Select>
            </label>
          </div>

          {controlDevices.length === 0 && (
            <div className="alert alert-warning" style={{ marginTop: 12 }}>
              暂无具备 app_server.control 权限的在线 Connector，请先完成本机 Connector 配对并保持 Connector 运行。
            </div>
          )}
          {controlDevices.length > 0 && selectableTasks.length + selectableThreads.length === 0 && (
            <div className="alert alert-warning" style={{ marginTop: 12 }}>
              暂无可控制的 Codex 会话。Desktop 正在持有的会话只能观测；释放后可由 Connector 接管。
            </div>
          )}

          <div className="feishu-prompt-submit-row">
            <div className="feishu-prompt-target">
              {threadId ? `目标：${threadId}` : '请选择 Codex 会话'}
            </div>
            <Button type="button" className="btn btn-primary" onClick={() => void sendPromptCard()} disabled={sending || loading || !selectedAdapter?.enabled}>
              {sending ? '排队中...' : '发送 Prompt 卡片'}
            </Button>
          </div>

          <div className="feishu-prompt-operator-note">
            可响应操作者：{selectedAdapter?.operatorAllowlist.join('、') || '-'}
          </div>
        </div>
      </section>

      <section className="card interaction-panel-card feishu-prompt-records-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="interaction-panel-header interaction-panel-header-compact">
          <div>
            <div className="interaction-panel-title">主动 Prompt 卡片记录</div>
            <div className="interaction-panel-subtitle">查看投递状态、过期时间和后续回写结果。</div>
          </div>
          <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => void loadCards()} disabled={!adapterId || cardsLoading}>刷新</Button>
        </div>
        {cardsLoading && <div style={{ padding: 18, color: 'var(--color-text-muted)', fontSize: 12 }}>加载中...</div>}
        {!cardsLoading && cards.length === 0 && <div style={{ padding: 22, color: 'var(--color-text-muted)', fontSize: 12 }}>暂无主动 Prompt 卡片</div>}
        {!cardsLoading && cards.map((card) => {
          const status = cardStatusMeta(card.status);
          const dispatch = card.dispatch;
          const retryable = dispatch?.status === 'failed' || dispatch?.status === 'delivery_unknown';
          const update = dispatch?.cardUpdate;
          const updateRetryable = update?.status === 'failed' || update?.status === 'delivery_unknown';
          return (
            <div key={card.id} className="feishu-prompt-record-row" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(220px, 1.5fr) 110px minmax(180px, 1fr) auto', gap: 10, alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--color-border-light)' }}>
              <div className="feishu-prompt-record-target">
                <div className="feishu-prompt-record-thread">{card.threadId}</div>
                <div className="feishu-prompt-record-meta">
                  {card.deviceId} · 过期 {formatDate(card.expiresAt)}
                </div>
              </div>
              <div><span className={`badge ${status.className}`}>{status.label}</span></div>
              <div className={`feishu-prompt-record-status ${dispatch?.lastError ? 'has-error' : ''}`}>
                {dispatchStatusLabel(dispatch?.status)}{dispatch?.lastError ? ` · ${dispatch.lastError}` : ''}
                {card.consumedTaskId ? ` · Task ${card.consumedTaskId}` : ''}
                {update ? (
                  <div style={{ marginTop: 5, color: update.lastError ? 'var(--color-error)' : 'var(--color-text-muted)' }}>
                    {cardUpdateStatusLabel(update)} · {update.targetStatus} · 尝试 {update.attemptCount}
                    {update.lastError ? ` · ${update.lastError}` : ''}
                  </div>
                ) : null}
              </div>
              <div className="feishu-prompt-record-actions">
                {retryable && <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} disabled={workingId === card.id} onClick={() => void retryDispatch(card)}>重试投递</Button>}
                {updateRetryable && update && <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} disabled={workingId === update.id} onClick={() => void retryCardUpdate(card)}>重试回写</Button>}
                {card.status === 'pending' && <Button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} disabled={workingId === card.id} onClick={() => void cancelCard(card)}>取消</Button>}
              </div>
            </div>
          );
        })}
      </section>
      {confirmationDialog}
    </>
  );
}
