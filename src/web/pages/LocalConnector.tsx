import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type BridgeContinuationTask,
  type BridgeContinuationTaskStatus,
  type LocalConnectorAction,
  type LocalConnectorDevice,
  type LocalConnectorScope,
  type LocalConnectorThread,
} from '../api.js';
import BoundedHistoryList from '../components/BoundedHistoryList.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { Button, Checkbox, Disclosure, Input, Option, Select, useConfirmDialog } from '../components/ui/index.js';

const SCOPE_OPTIONS: Array<{ value: LocalConnectorScope; label: string }> = [
  { value: 'hooks.manage', label: '管理 Hook 安装' },
  { value: 'hooks.emit', label: '接收 Hook 事件' },
  { value: 'notify.manage', label: '管理 Notify 安装' },
  { value: 'notify.emit', label: '发送通知事件' },
  { value: 'browser.recovery', label: '浏览器凭证' },
  { value: 'app_server.observe', label: '观察 App Server' },
  { value: 'app_server.control', label: '控制 Codex 会话' },
];

const ACTIVE_TASK_STATUSES = new Set<BridgeContinuationTaskStatus>(['waiting', 'backoff', 'running']);

type ActionKind = 'hook' | 'notify';
type ActionOperation = 'install' | 'backup' | 'rollback' | 'uninstall';
type ActionAgent = 'codex' | 'claude_code';
type ThreadFilter = 'all' | 'active' | 'attention' | 'idle' | 'error';

function formatDate(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return '-';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : String(value);
}

function actionStatusLabel(status: LocalConnectorAction['status']): string {
  return {
    pending: '等待领取',
    claimed: '执行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    expired: '已过期',
  }[status];
}

function actionName(action: LocalConnectorAction): string {
  const kind = action.kind === 'hook' ? 'Hook' : 'Notify';
  const operation = {
    install: '安装',
    backup: '备份',
    rollback: '回滚',
    uninstall: '卸载',
  }[action.operation];
  return `${kind} · ${operation}`;
}

function threadStatusMeta(thread: LocalConnectorThread): { label: string; className: string; detail: string } {
  if (thread.activeFlags.includes('waitingOnApproval')) {
    return { label: '等待审批', className: 'badge-warning', detail: 'Codex 正在等待交互审批' };
  }
  if (thread.activeFlags.includes('waitingOnUserInput')) {
    return { label: '等待输入', className: 'badge-warning', detail: 'Codex 正在等待你的消息' };
  }
  return {
    active: { label: '运行中', className: 'badge-success', detail: '当前存在活动 Turn' },
    idle: { label: '空闲', className: 'badge-neutral', detail: '可以开启下一轮' },
    system_error: { label: '异常', className: 'badge-error', detail: '本地 App Server 报告异常' },
    not_loaded: { label: '未加载', className: 'badge-muted', detail: '会话尚未加载到 App Server' },
    unknown: { label: '未知', className: 'badge-muted', detail: '等待 Connector 上报状态' },
  }[thread.threadStatus];
}

function taskStatusMeta(task: BridgeContinuationTask | null): { label: string; className: string; detail: string } {
  if (!task) return { label: '未接管', className: 'badge-muted', detail: '尚无自动续跑事务' };
  const reason = task.state.lastFailure?.messageSummary || task.state.reason;
  return {
    waiting: { label: '等待接管', className: 'badge-warning', detail: reason || '等待 Connector 领取' },
    backoff: { label: '退避中', className: 'badge-warning', detail: reason || '等待下一次续跑' },
    running: { label: '接管中', className: 'badge-info', detail: 'Connector 正在执行续跑指令' },
    stopped: { label: '已停止', className: 'badge-muted', detail: reason || '接管事务已停止' },
    superseded: { label: '已结束', className: 'badge-neutral', detail: reason || '事务已被新消息替代' },
    dead: { label: '接管失败', className: 'badge-error', detail: reason || '事务无法继续' },
  }[task.state.status];
}

function observationSourceLabel(source: LocalConnectorThread['observationSource']): string {
  return source === 'codex_desktop' ? 'Codex Desktop' : 'Connector App Server';
}

function threadKey(deviceId: string, threadId: string): string {
  return `${deviceId}\0${threadId}`;
}

function matchesThreadFilter(thread: LocalConnectorThread, filter: ThreadFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return thread.threadStatus === 'active';
  if (filter === 'attention') return thread.activeFlags.length > 0;
  if (filter === 'idle') return thread.threadStatus === 'idle';
  return thread.threadStatus === 'system_error';
}

export default function LocalConnector() {
  const { success, error, info } = useToast();
  const isMobile = useIsMobile();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const [devices, setDevices] = useState<LocalConnectorDevice[]>([]);
  const [threads, setThreads] = useState<LocalConnectorThread[]>([]);
  const [tasks, setTasks] = useState<BridgeContinuationTask[]>([]);
  const [actions, setActions] = useState<LocalConnectorAction[]>([]);
  const [threadSearch, setThreadSearch] = useState('');
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>('all');
  const [threadDeviceId, setThreadDeviceId] = useState('');
  const [takeoverThreadKey, setTakeoverThreadKey] = useState('');
  const [deviceName, setDeviceName] = useState('本机 Connector');
  const [scopes, setScopes] = useState<LocalConnectorScope[]>([
    'hooks.manage',
    'hooks.emit',
    'notify.manage',
    'notify.emit',
    'app_server.observe',
    'app_server.control',
  ]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [actionAgent, setActionAgent] = useState<ActionAgent>('codex');
  const [actionKind, setActionKind] = useState<ActionKind>('hook');
  const [actionOperation, setActionOperation] = useState<ActionOperation>('install');
  const [backupRef, setBackupRef] = useState('');
  const [pairing, setPairing] = useState<{ pairingId: string; pairingToken: string; expiresAt: string } | null>(null);
  const [connectorServerUrl, setConnectorServerUrl] = useState(() =>
    typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:4000',
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const activeDevices = useMemo(() => devices.filter((device) => device.status === 'active'), [devices]);
  const deviceById = useMemo(() => new Map(devices.map((device) => [device.id, device])), [devices]);
  const latestAutomaticTaskByThread = useMemo(() => {
    const result = new Map<string, BridgeContinuationTask>();
    for (const task of tasks) {
      if (task.state.taskKind !== 'automatic' || !task.deviceId) continue;
      const key = threadKey(task.deviceId, task.state.threadId);
      const current = result.get(key);
      if (!current || task.state.updatedAtMs > current.state.updatedAtMs) result.set(key, task);
    }
    return result;
  }, [tasks]);

  const visibleThreads = useMemo(() => {
    const query = threadSearch.trim().toLocaleLowerCase();
    return threads.filter((thread) => {
      if (threadDeviceId && thread.deviceId !== threadDeviceId) return false;
      if (!matchesThreadFilter(thread, threadFilter)) return false;
      if (!query) return true;
      return [thread.title, thread.threadId, thread.deviceName, thread.devicePlatform]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [threadDeviceId, threadFilter, threadSearch, threads]);

  const summary = useMemo(() => ({
    total: threads.length,
    active: threads.filter((thread) => thread.threadStatus === 'active').length,
    attention: threads.filter((thread) => thread.activeFlags.length > 0 || thread.threadStatus === 'system_error').length,
    takeover: Array.from(latestAutomaticTaskByThread.values()).filter((task) => ACTIVE_TASK_STATUSES.has(task.state.status)).length,
  }), [latestAutomaticTaskByThread, threads]);

  const load = async () => {
    setLoading(true);
    try {
      const [deviceResponse, threadResponse, taskResponse, actionResponse] = await Promise.all([
        api.getLocalConnectorDevices(),
        api.getLocalConnectorThreads({ limit: 200 }),
        api.getBridgeContinuationTasks({ limit: 200 }),
        api.getLocalConnectorActions(),
      ]);
      const deviceItems = Array.isArray(deviceResponse.items) ? deviceResponse.items : [];
      setDevices(deviceItems);
      setThreads(Array.isArray(threadResponse.items) ? threadResponse.items : []);
      setTasks(Array.isArray(taskResponse.items) ? taskResponse.items : []);
      setActions(Array.isArray(actionResponse.items) ? actionResponse.items : []);
      setSelectedDeviceId((current) => current || deviceItems.find((item) => item.status === 'active')?.id || '');
    } catch (err: any) {
      error(err?.message || '加载 Connector 会话失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const refreshTasks = async () => {
    const response = await api.getBridgeContinuationTasks({ limit: 200 });
    setTasks(Array.isArray(response.items) ? response.items : []);
  };

  const takeOverThread = async (thread: LocalConnectorThread) => {
    const key = threadKey(thread.deviceId, thread.threadId);
    setTakeoverThreadKey(key);
    try {
      const response = await api.takeOverLocalConnectorSession({
        deviceId: thread.deviceId,
        threadId: thread.threadId,
      });
      setTasks((current) => [response.task, ...current.filter((task) => task.state.taskId !== response.task.state.taskId)]);
      if (response.created) success('会话接管事务已创建，等待本地 Connector 执行');
      else info('该会话已有接管事务，已同步最新状态');
      await refreshTasks();
    } catch (err: any) {
      error(err?.message || '接管会话失败');
    } finally {
      setTakeoverThreadKey('');
    }
  };

  const toggleScope = (scope: LocalConnectorScope) => {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  };

  const createPairing = async () => {
    if (!deviceName.trim() || scopes.length === 0) {
      error('请填写设备名称并至少选择一个权限');
      return;
    }
    setSaving(true);
    try {
      const response = await api.createLocalConnectorPairing({ deviceName: deviceName.trim(), scopes });
      setPairing(response);
      await load();
      success('配对令牌已生成');
    } catch (err: any) {
      error(err?.message || '生成配对令牌失败');
    } finally {
      setSaving(false);
    }
  };

  const revokeDevice = async (device: LocalConnectorDevice) => {
    if (!await requestConfirmation({
      title: '撤销 Connector 设备',
      description: `确认撤销设备“${device.name}”吗？撤销后该设备的动作和事件令牌立即失效。`,
      confirmLabel: '撤销设备',
      confirmVariant: 'danger',
    })) return;
    try {
      await api.revokeLocalConnectorDevice(device.id);
      success('设备已撤销');
      await load();
    } catch (err: any) {
      error(err?.message || '撤销设备失败');
    }
  };

  const createAction = async () => {
    if (!selectedDeviceId) {
      error('请先选择一个已配对设备');
      return;
    }
    if (actionOperation === 'rollback' && !backupRef.trim()) {
      error('回滚动作需要填写备份引用');
      return;
    }
    setSaving(true);
    try {
      await api.createLocalConnectorAction({
        deviceId: selectedDeviceId,
        kind: actionKind,
        operation: actionOperation,
        agent: actionAgent,
        backupRef: backupRef.trim() || null,
      });
      setBackupRef('');
      success('动作已排队，等待 Connector 领取');
      await load();
    } catch (err: any) {
      error(err?.message || '创建 Connector 动作失败');
    } finally {
      setSaving(false);
    }
  };

  const cancelAction = async (action: LocalConnectorAction) => {
    try {
      await api.cancelLocalConnectorAction(action.id);
      success('动作已取消');
      await load();
    } catch (err: any) {
      error(err?.message || '取消动作失败');
    }
  };

  const copyPairingToken = async () => {
    if (!pairing) return;
    try {
      const command = `metapi-connector pair --server ${JSON.stringify(connectorServerUrl.trim())} --pairing-id ${JSON.stringify(pairing.pairingId)} --pairing-token ${JSON.stringify(pairing.pairingToken)}`;
      await navigator.clipboard.writeText(command);
      success('配对命令已复制');
    } catch {
      error('复制失败，请手动复制配对命令');
    }
  };

  const copyBackupRef = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      success('备份引用已复制');
    } catch {
      error('复制备份引用失败');
    }
  };

  const renderAction = (action: LocalConnectorAction) => (
    <div className="local-connector-action-row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{actionName(action)}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>
          设备 {deviceById.get(action.deviceId)?.name || action.deviceId} · {formatDate(action.createdAt)} · {actionStatusLabel(action.status)}
        </div>
        {action.backupRef && (
          <div className="local-connector-backup-ref">
            <code>{action.backupRef}</code>
            <Button type="button" className="btn btn-ghost" onClick={() => void copyBackupRef(action.backupRef!)}>复制</Button>
          </div>
        )}
        {action.errorMessage && <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 4 }}>{action.errorMessage}</div>}
      </div>
      {(action.status === 'pending' || action.status === 'claimed') && <Button type="button" className="btn btn-ghost" onClick={() => void cancelAction(action)}>取消</Button>}
    </div>
  );

  if (loading) {
    return <div className="animate-fade-in"><div className="skeleton" style={{ height: 360, borderRadius: 'var(--radius-sm)' }} /></div>;
  }

  return (
    <div className="animate-fade-in local-connector-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Codex 会话接管</h2>
          <p className="page-subtitle">Local Connector 上报会话状态；线上按会话下发 Prompt、接管事务并记录回执。</p>
        </div>
        <Button type="button" className="btn btn-ghost local-connector-refresh" onClick={() => void load()} title="刷新会话与事务">
          <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 11a8 8 0 10-2.34 5.66M20 4v7h-7" />
          </svg>
          刷新
        </Button>
      </div>

      <section className="card local-session-overview">
        <div className="local-session-summary" aria-label="会话状态摘要">
          <div><span>已上报会话</span><strong>{summary.total}</strong></div>
          <div><span>正在运行</span><strong>{summary.active}</strong></div>
          <div><span>需要关注</span><strong>{summary.attention}</strong></div>
          <div><span>接管事务</span><strong>{summary.takeover}</strong></div>
        </div>

        <div className="local-session-toolbar">
          <Input
            aria-label="搜索会话"
            type="search"
            value={threadSearch}
            onChange={(event) => setThreadSearch(event.target.value)}
            placeholder="搜索会话名、Thread ID 或 Connector"
          />
          <Select aria-label="筛选会话状态" value={threadFilter} onChange={(event) => setThreadFilter(event.target.value as ThreadFilter)}>
            <Option value="all">全部状态</Option>
            <Option value="active">运行中</Option>
            <Option value="attention">等待交互</Option>
            <Option value="idle">空闲</Option>
            <Option value="error">异常</Option>
          </Select>
          <Select aria-label="筛选 Connector" value={threadDeviceId} onChange={(event) => setThreadDeviceId(event.target.value)}>
            <Option value="">全部 Connector</Option>
            {devices.map((device) => <Option key={device.id} value={device.id}>{device.name}</Option>)}
          </Select>
        </div>

        <div className="local-session-list" role="table" aria-label="Codex 会话">
          <div className="local-session-list-header" role="row">
            <span>会话</span>
            <span>Codex 状态</span>
            <span>来源 / Connector</span>
            <span>接管事务</span>
            <span>最近上报</span>
            <span className="ui-visually-hidden">操作</span>
          </div>
          {threads.length === 0 && <div className="local-session-empty">尚未收到本地 Connector 上报的 Codex 会话</div>}
          {threads.length > 0 && visibleThreads.length === 0 && <div className="local-session-empty">没有匹配的会话</div>}
          {visibleThreads.map((thread) => {
            const device = deviceById.get(thread.deviceId);
            const status = threadStatusMeta(thread);
            const task = latestAutomaticTaskByThread.get(threadKey(thread.deviceId, thread.threadId)) || null;
            const taskStatus = taskStatusMeta(task);
            const canControl = device?.status === 'active' && device.scopes.includes('app_server.control');
            const canTakeOver = canControl && thread.controlState === 'available';
            const activeTask = task && ACTIVE_TASK_STATUSES.has(task.state.status);
            const workspaceUrl = `/local-connector/${encodeURIComponent(thread.deviceId)}/sessions?threadId=${encodeURIComponent(thread.threadId)}`;
            const currentKey = threadKey(thread.deviceId, thread.threadId);
            return (
              <div className="local-session-row" role="row" key={thread.id}>
                <div className="local-session-identity" role="cell">
                  <strong title={thread.title || thread.threadId}>{thread.title || '未命名会话'}</strong>
                  <code title={thread.threadId}>{thread.threadId}</code>
                </div>
                <div className="local-session-state" role="cell">
                  <span className={`badge ${status.className}`}>{status.label}</span>
                  <small>{status.detail}</small>
                </div>
                <div className="local-session-source" role="cell">
                  <strong>{thread.deviceName}</strong>
                  <small>{observationSourceLabel(thread.observationSource)} · {thread.devicePlatform}</small>
                </div>
                <div className="local-session-task" role="cell">
                  <span className={`badge ${taskStatus.className}`}>{taskStatus.label}</span>
                  <small title={taskStatus.detail}>{taskStatus.detail}</small>
                  {task && <time>{formatDate(task.state.updatedAtMs)}</time>}
                </div>
                <time className="local-session-seen" role="cell">{formatDate(thread.lastSeenAt)}</time>
                <div className="local-session-row-actions" role="cell">
                  <Link className="btn btn-ghost" to={workspaceUrl}>{thread.controlState === 'external_owner' ? '打开并发消息' : '进入会话'}</Link>
                  {activeTask ? (
                    <Link className="btn btn-soft-primary" to={workspaceUrl}>查看接管</Link>
                  ) : canTakeOver ? (
                    <Button
                      type="button"
                      className="btn btn-primary"
                      loading={takeoverThreadKey === currentKey}
                      loadingLabel="下发中..."
                      onClick={() => void takeOverThread(thread)}
                    >
                      接管会话
                    </Button>
                  ) : (
                    <span className="local-session-control-note">
                      {thread.controlState === 'external_owner' ? 'Desktop 持有，可直接追加 Prompt' : 'Connector 缺少控制权限'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card local-connector-settings">
        <Disclosure
          title={(
            <span className="local-connector-settings-title">
              <strong>Connector 设置</strong>
              <small>{activeDevices.length} 个在线设备 · 配对、权限和本地 Hook / Notify 运维</small>
            </span>
          )}
        >
          <div className="local-connector-settings-content">
            <section className="local-connector-settings-section">
              <div className="local-connector-section-heading">
                <strong>已配对设备</strong>
                <span>设备健康与 App Server 运行状态由本地 Connector 面板负责。</span>
              </div>
              {devices.length === 0 ? (
                <div className="local-connector-settings-empty">暂无设备</div>
              ) : (
                <div className="local-connector-device-list">
                  {devices.map((device) => (
                    <div key={device.id} className="local-connector-device-row">
                      <div>
                        <strong>{device.name}</strong>
                        <span>{device.platform}{device.version ? ` ${device.version}` : ''} · 最近上报 {formatDate(device.lastSeenAt)}</span>
                        <div className="local-connector-device-scopes">
                          {device.scopes.map((scope) => <span key={scope} className="badge badge-neutral">{scope}</span>)}
                        </div>
                      </div>
                      {device.status === 'active' ? (
                        <div className="local-connector-device-actions">
                          {(device.scopes.includes('app_server.observe') || device.scopes.includes('app_server.control')) && (
                            <Link className="btn btn-ghost" to={`/local-connector/${encodeURIComponent(device.id)}/sessions`}>设备工作台</Link>
                          )}
                          <Button type="button" className="btn btn-danger" onClick={() => void revokeDevice(device)}>撤销</Button>
                        </div>
                      ) : <span className="badge badge-neutral">已撤销</span>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="local-connector-settings-section">
              <div className="local-connector-section-heading">
                <strong>配对新设备</strong>
                <span>配对令牌只显示一次，领取后会换成独立设备令牌。</span>
              </div>
              <div className="local-connector-pairing-form">
                <label>
                  设备名称
                  <Input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
                </label>
                <div className="local-connector-scope-grid">
                  {SCOPE_OPTIONS.map((item) => (
                    <Checkbox key={item.value} label={item.label} checked={scopes.includes(item.value)} onChange={() => toggleScope(item.value)} />
                  ))}
                </div>
                <Button type="button" className="btn btn-primary" disabled={saving} onClick={() => void createPairing()}>
                  {saving ? '生成中...' : '生成配对令牌'}
                </Button>
              </div>
              {pairing && (
                <div className="local-connector-pairing-result">
                  <label>
                    Connector 服务地址
                    <Input value={connectorServerUrl} onChange={(event) => setConnectorServerUrl(event.target.value)} />
                  </label>
                  <code>
                    metapi-connector pair --server {JSON.stringify(connectorServerUrl.trim())} --pairing-id {JSON.stringify(pairing.pairingId)} --pairing-token {JSON.stringify(pairing.pairingToken)}
                  </code>
                  <div>
                    <Button type="button" className="btn btn-ghost" onClick={() => void copyPairingToken()}>复制配对命令</Button>
                    <span>有效期至 {formatDate(pairing.expiresAt)}</span>
                  </div>
                </div>
              )}
            </section>

            <section className="local-connector-settings-section">
              <div className="local-connector-section-heading">
                <strong>Hook / Notify 本地运维</strong>
                <span>安装、备份、回滚和卸载由 Connector 在本机执行。</span>
              </div>
              <div className="local-connector-action-form">
                <label>
                  设备
                  <Select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)}>
                    <Option value="">选择设备</Option>
                    {activeDevices.map((device) => <Option key={device.id} value={device.id}>{device.name} · {device.platform}</Option>)}
                  </Select>
                </label>
                <label>
                  Agent
                  <Select value={actionAgent} onChange={(event) => setActionAgent(event.target.value as ActionAgent)}>
                    <Option value="codex">Codex</Option>
                    <Option value="claude_code">Claude Code</Option>
                  </Select>
                </label>
                <label>
                  类型
                  <Select value={actionKind} onChange={(event) => setActionKind(event.target.value as ActionKind)}>
                    <Option value="hook">Hook</Option>
                    <Option value="notify">Notify</Option>
                  </Select>
                </label>
                <label>
                  操作
                  <Select value={actionOperation} onChange={(event) => setActionOperation(event.target.value as ActionOperation)}>
                    <Option value="install">安装</Option>
                    <Option value="backup">备份</Option>
                    <Option value="rollback">回滚</Option>
                    <Option value="uninstall">卸载</Option>
                  </Select>
                </label>
                <Button type="button" className="btn btn-primary" disabled={saving || activeDevices.length === 0} onClick={() => void createAction()}>
                  创建动作
                </Button>
              </div>
              {actionOperation === 'rollback' && (
                <Input value={backupRef} onChange={(event) => setBackupRef(event.target.value)} placeholder="Connector 返回的 backupRef" className="local-connector-backup-input" />
              )}
              <BoundedHistoryList
                items={actions}
                getKey={(action) => action.id}
                renderItem={(action) => renderAction(action)}
                emptyText={<div className="local-connector-settings-empty">暂无动作</div>}
                modalTitle="全部 Connector 动作"
                modalDescription="查看本地 Hook / Notify 安装、备份、回滚和卸载记录。"
                listStyle={{ display: 'grid' }}
              />
            </section>
          </div>
        </Disclosure>
      </section>
      {confirmationDialog}
    </div>
  );
}
