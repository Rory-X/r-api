import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  api,
  type BridgeContinuationEvent,
  type BridgeContinuationPolicyInput,
  type BridgeContinuationRuleAction,
  type BridgeContinuationTask,
  type BridgeContinuationTaskStatus,
  type BridgeFailureClass,
  type BridgeManualPromptSubmissionMode,
  type GlobalBridgeContinuationConfig,
  type LocalConnectorDevice,
  type LocalConnectorThread,
  type LocalConnectorThreadActivity,
  type LocalConnectorThreadActivityCategory,
  type InteractionRequest,
} from '../api.js';
import SideDrawer from '../components/SideDrawer.js';
import { useToast } from '../components/Toast.js';
import { useIsMobile } from '../components/useIsMobile.js';
import {
  Button,
  Disclosure,
  Input,
  Option,
  Select,
  TextArea,
  useConfirmDialog,
} from '../components/ui/index.js';

type MainFailureClass = Extract<
  BridgeFailureClass,
  'rate_limited' | 'concurrency_limited' | 'service_temporary' | 'retry_exhausted'
>;

type RuleDraft = {
  action: BridgeContinuationRuleAction;
  limitMode: 'bounded' | 'unlimited';
  maxContinuations: string;
};

const STATUS_OPTIONS: Array<{ value: BridgeContinuationTaskStatus | ''; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'waiting', label: '等待' },
  { value: 'backoff', label: '退避中' },
  { value: 'running', label: '执行中' },
  { value: 'stopped', label: '已停止' },
  { value: 'superseded', label: '已被新消息替代' },
  { value: 'dead', label: '已终止' },
];

const ACTION_OPTIONS: Array<{ value: BridgeContinuationRuleAction; label: string }> = [
  { value: 'continue_same_route', label: '保留当前线路' },
  { value: 'continue_rotate_credential', label: '轮换同站凭据' },
  { value: 'continue_switch_channel', label: '切换 API 渠道' },
  { value: 'stop', label: '停止续跑' },
];

const MAIN_FAILURES: Array<{ value: MainFailureClass; label: string; hint: string }> = [
  { value: 'rate_limited', label: '429 / Rate limit', hint: '上游限流或请求过多' },
  { value: 'concurrency_limited', label: 'Concurrent limit', hint: '并发额度已占满' },
  { value: 'service_temporary', label: 'Service temporary', hint: '服务过载或临时不可用' },
  { value: 'retry_exhausted', label: 'Codex 重试耗尽', hint: '客户端内部重试结束后仍失败' },
];

const INITIAL_RULES: Record<MainFailureClass, RuleDraft> = {
  rate_limited: { action: 'continue_same_route', limitMode: 'bounded', maxContinuations: '5' },
  concurrency_limited: { action: 'continue_same_route', limitMode: 'bounded', maxContinuations: '5' },
  service_temporary: { action: 'continue_same_route', limitMode: 'bounded', maxContinuations: '5' },
  retry_exhausted: { action: 'continue_rotate_credential', limitMode: 'bounded', maxContinuations: '3' },
};

const ACTIVE_STATUSES = new Set<BridgeContinuationTaskStatus>(['waiting', 'backoff', 'running']);
const ACTIVE_INTERACTION_STATUSES = new Set(['pending', 'response_pending']);

const fieldLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  color: 'var(--color-text-secondary)',
  fontSize: 12,
};

function formatDate(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return '-';
  const parsed = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : String(value);
}

function formatDuration(value: number | null): string {
  if (value === null) return '不限制';
  if (value < 60_000) return `${Math.round(value / 1_000)} 秒`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`;
  return `${Math.round(value / 3_600_000)} 小时`;
}

function statusMeta(status: BridgeContinuationTaskStatus): { label: string; className: string } {
  return {
    waiting: { label: '等待', className: 'badge-info' },
    backoff: { label: '退避中', className: 'badge-warning' },
    running: { label: '执行中', className: 'badge-success' },
    stopped: { label: '已停止', className: 'badge-muted' },
    superseded: { label: '已被替代', className: 'badge-info' },
    dead: { label: '已终止', className: 'badge-error' },
  }[status];
}

function routeActionLabel(action: BridgeContinuationTask['state']['pendingRouteAction']): string {
  if (action === 'rotate_credential') return '轮换同站凭据';
  if (action === 'switch_channel') return '切换 API 渠道';
  if (action === 'preserve') return '保留当前线路';
  return '-';
}

function taskKindLabel(kind: BridgeContinuationTask['state']['taskKind']): string {
  return kind === 'manual_prompt' ? '会话消息' : '自动续跑';
}

function submissionModeLabel(mode: BridgeContinuationTask['state']['submissionMode']): string {
  if (mode === 'steer_current') return '补充当前轮';
  if (mode === 'start_next') return '下一轮发送';
  if (mode === 'auto') return '自动判断';
  return '-';
}

function pendingMethodLabel(method: BridgeContinuationTask['state']['pendingMethod']): string {
  if (method === 'turn/steer') return 'turn/steer';
  if (method === 'turn/start') return 'turn/start';
  return '-';
}

function manualPromptProgress(task: BridgeContinuationTask | null): {
  label: string;
  detail: string;
  className: string;
} | null {
  if (!task || task.state.taskKind !== 'manual_prompt') return null;
  const { status, reason } = task.state;
  if (status === 'running') return { label: '处理中', detail: 'Connector 正在提交到 Codex', className: 'badge-info' };
  if (status === 'backoff') return { label: '队列中', detail: '等待本地 Connector 领取', className: 'badge-warning' };
  if (status === 'waiting' && reason === 'turn_active') {
    return { label: '已送达', detail: 'Codex 已接收并正在处理', className: 'badge-success' };
  }
  if (status === 'waiting' && reason === 'dispatch_outcome_unknown') {
    return { label: '确认中', detail: '正在核对 Codex 是否已接收', className: 'badge-warning' };
  }
  if (status === 'waiting') return { label: '等待中', detail: taskReasonLabel(reason, status), className: 'badge-warning' };
  if (status === 'dead') return { label: '发送失败', detail: task.state.lastFailure?.messageSummary || 'Connector 未能提交消息', className: 'badge-error' };
  if (status === 'superseded') return { label: '已被替代', detail: '更新的消息已接替该任务', className: 'badge-neutral' };
  return { label: '已完成', detail: '该消息对应的 Codex 轮次已结束', className: 'badge-success' };
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

function threadActivityLabel(thread: LocalConnectorThread): string {
  if (thread.activeFlags.includes('waitingOnApproval')) return '等待审批';
  if (thread.activeFlags.includes('waitingOnUserInput')) return '等待你输入';
  if (thread.threadStatus === 'active') return '正在执行';
  if (thread.threadStatus === 'not_loaded') return '尚未加载';
  if (thread.threadStatus === 'system_error') return '运行异常';
  if (thread.threadStatus === 'idle') return '暂时空闲';
  return '等待状态同步';
}

function threadControlLabel(thread: LocalConnectorThread): string {
  return thread.controlState === 'external_owner' ? 'Codex Desktop 正在使用，可直接追加消息' : '本地 Connector 已就绪';
}

function interactionKindLabel(kind: InteractionRequest['state']['kind']): string {
  return {
    command_approval: '命令审批',
    file_change_approval: '文件修改审批',
    permissions_approval: '权限审批',
    user_input: '等待你的输入',
    mcp_elicitation: 'MCP 交互',
  }[kind];
}

function interactionStatusLabel(status: InteractionRequest['state']['status']): string {
  if (status === 'pending') return '待处理';
  if (status === 'response_pending') return '等待 Codex 接收';
  return '已结束';
}

function taskReasonLabel(reason: string, status: BridgeContinuationTaskStatus): string {
  const labels: Record<string, string> = {
    backoff: '等待重试',
    waiting: '等待发送',
    running: '正在执行',
    manual_stop: '已手动停止',
    manual_prompt: '自动续跑已被新消息替代',
    dead: '续跑失败并终止',
  };
  return labels[reason] || labels[status] || '状态已更新';
}

function eventTypeLabel(eventType: string): string {
  const labels: Record<string, string> = {
    task_created: '创建续跑任务',
    manual_prompt_created: '提交会话消息',
    manual_prompt_superseded: '自动续跑被新消息替代',
    failure_observed: '检测到失败',
    thread_state_changed: '会话状态更新',
    turn_started: '开始执行一轮',
    turn_completed: '一轮执行完成',
    manual_stop: '手动停止任务',
    device_revoked: 'Connector 已撤销',
    lease_expired: '控制租约过期',
    lease_acquired: '获得控制权',
  };
  return labels[eventType] || '任务状态变化';
}

function activityCategoryMeta(category: LocalConnectorThreadActivityCategory): { label: string; className: string } {
  return {
    bridge: { label: 'Codex 控制', className: 'badge-info' },
    interaction: { label: '交互审批', className: 'badge-warning' },
    feishu: { label: '飞书卡片', className: 'badge-success' },
    notification: { label: '完成通知', className: 'badge-neutral' },
  }[category];
}

function activityStatusLabel(status: string | null): string {
  if (!status) return '已记录';
  const labels: Record<string, string> = {
    pending: '等待中',
    processing: '处理中',
    running: '执行中',
    waiting: '等待中',
    backoff: '退避中',
    response_pending: '等待送达',
    resolved: '已处理',
    delivered: '已送达',
    succeeded: '已完成',
    stopped: '已停止',
    superseded: '已结束',
    cancelled: '已取消',
    expired: '已过期',
    bound: '已绑定',
    dead: '失败',
    failed: '失败',
    delivery_unknown: '结果未知',
  };
  return labels[status] || status;
}

function createManualPromptIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const suffix = randomUUID
    ? randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `webui:bridge-prompt:${suffix}`;
}

function failureLabel(failureClass?: BridgeFailureClass | null): string {
  const labels: Partial<Record<BridgeFailureClass, string>> = {
    rate_limited: '429 / Rate limit',
    concurrency_limited: 'Concurrent limit',
    service_temporary: 'Service temporary',
    transport_failure: '传输失败',
    stream_interrupted: '响应流中断',
    retry_exhausted: 'Codex 重试耗尽',
    usage_limit: '用量限制',
    context_exhausted: '上下文耗尽',
    session_budget_exhausted: '会话预算耗尽',
    authentication_failure: '认证失败',
    request_invalid: '请求无效',
    policy_rejected: '策略拒绝',
    sandbox_failure: '沙箱失败',
    turn_conflict: 'Turn 冲突',
    cancelled: '已取消',
    unknown: '未知失败',
  };
  return failureClass ? labels[failureClass] || failureClass : '-';
}

function formatEventMetadata(value: string | null): string {
  if (!value) return '';
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function SummaryMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ borderLeft: `3px solid ${tone}`, padding: '8px 12px', minWidth: 120 }}>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>{label}</div>
      <div style={{ marginTop: 4, color: 'var(--color-text-primary)', fontSize: 22, fontWeight: 650 }}>{value}</div>
    </div>
  );
}

function RuleEditor({
  item,
  value,
  onChange,
  isMobile,
}: {
  item: typeof MAIN_FAILURES[number];
  value: RuleDraft;
  onChange: (next: RuleDraft) => void;
  isMobile: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : 'minmax(180px, 1fr) 220px 130px 110px',
        gap: 10,
        alignItems: 'center',
        padding: '10px 0',
        borderTop: '1px solid var(--color-border-light)',
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</div>
        <div style={{ marginTop: 3, color: 'var(--color-text-muted)', fontSize: 11 }}>{item.hint}</div>
      </div>
      <Select
        aria-label={`${item.label} 动作`}
        value={value.action}
        onChange={(event) => onChange({ ...value, action: event.target.value as BridgeContinuationRuleAction })}
      >
        {ACTION_OPTIONS.map((option) => <Option key={option.value} value={option.value}>{option.label}</Option>)}
      </Select>
      <Select
        aria-label={`${item.label} 次数模式`}
        value={value.limitMode}
        disabled={value.action === 'stop'}
        onChange={(event) => onChange({ ...value, limitMode: event.target.value as RuleDraft['limitMode'] })}
      >
        <Option value="bounded">有限次数</Option>
        <Option value="unlimited">无限续跑</Option>
      </Select>
      <Input
        aria-label={`${item.label} 最大次数`}
        type="number"
        min={1}
        max={10_000}
        value={value.maxContinuations}
        disabled={value.action === 'stop' || value.limitMode === 'unlimited'}
        onChange={(event) => onChange({ ...value, maxContinuations: event.target.value })}
      />
    </div>
  );
}

function TaskStatusBadge({ status }: { status: BridgeContinuationTaskStatus }) {
  const meta = statusMeta(status);
  return <span className={`badge ${meta.className}`}>{meta.label}</span>;
}

export default function BridgeContinuations() {
  const { deviceId: routeDeviceId } = useParams<{ deviceId: string }>();
  const [searchParams] = useSearchParams();
  const deviceId = routeDeviceId || '';
  const requestedThreadId = searchParams.get('threadId')?.trim() || '';
  const { success, error, info } = useToast();
  const isMobile = useIsMobile();
  const { requestConfirmation, confirmationDialog } = useConfirmDialog();
  const [tasks, setTasks] = useState<BridgeContinuationTask[]>([]);
  const [globalContinuation, setGlobalContinuation] = useState<GlobalBridgeContinuationConfig | null>(null);
  const [devices, setDevices] = useState<LocalConnectorDevice[]>([]);
  const [threads, setThreads] = useState<LocalConnectorThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [taskScope, setTaskScope] = useState<'current' | 'all'>('current');
  const [detail, setDetail] = useState<{ task: BridgeContinuationTask; events: BridgeContinuationEvent[] } | null>(null);
  const [filterStatus, setFilterStatus] = useState<BridgeContinuationTaskStatus | ''>('');
  const [filterSession, setFilterSession] = useState('');
  const [continuePrompt, setContinuePrompt] = useState('继续');
  const [initialDelaySeconds, setInitialDelaySeconds] = useState('5');
  const [maxDelaySeconds, setMaxDelaySeconds] = useState('300');
  const [multiplier, setMultiplier] = useState('2');
  const [jitterRatio, setJitterRatio] = useState('0.2');
  const [maxElapsedMinutes, setMaxElapsedMinutes] = useState('0');
  const [rules, setRules] = useState<Record<MainFailureClass, RuleDraft>>(INITIAL_RULES);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionTaskId, setActionTaskId] = useState('');
  const [manualPrompt, setManualPrompt] = useState('');
  const [manualPromptMode, setManualPromptMode] = useState<BridgeManualPromptSubmissionMode>('auto');
  const [promptSubmitting, setPromptSubmitting] = useState(false);
  const [threadSearch, setThreadSearch] = useState('');
  const [lastSubmittedTask, setLastSubmittedTask] = useState<BridgeContinuationTask | null>(null);
  const [activity, setActivity] = useState<LocalConnectorThreadActivity | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [threadInteractions, setThreadInteractions] = useState<InteractionRequest[]>([]);
  const [threadInteractionsLoading, setThreadInteractionsLoading] = useState(false);
  const manualPromptAttempt = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const activityRequestVersion = useRef(0);
  const interactionRequestVersion = useRef(0);

  const controlDevices = useMemo(
    () => devices.filter((device) => device.id === deviceId
      && device.status === 'active'
      && device.scopes.includes('app_server.control')),
    [deviceId, devices],
  );

  const deviceNames = useMemo(
    () => new Map(devices.map((device) => [device.id, device.name])),
    [devices],
  );

  const activeAutomaticTaskByThread = useMemo(() => new Map(
    tasks
      .filter((task) => task.state.taskKind === 'automatic' && ACTIVE_STATUSES.has(task.state.status))
      .map((task) => [task.state.threadId, task]),
  ), [tasks]);

  const visibleThreads = useMemo(() => {
    const query = threadSearch.trim().toLocaleLowerCase();
    if (!query) return threads;
    return threads.filter((thread) => [thread.title, thread.threadId, thread.deviceName]
      .some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [threadSearch, threads]);

  const threadLabels = useMemo(() => new Map(
    threads.map((thread, index) => [thread.threadId, thread.title || `会话 ${index + 1}`]),
  ), [threads]);

  const getThreadLabel = (threadId: string): string => threadLabels.get(threadId) || '未命名会话';

  const visibleTasks = useMemo(() => (
    taskScope === 'current' && selectedThreadId
      ? tasks.filter((task) => task.state.threadId === selectedThreadId)
      : tasks
  ), [selectedThreadId, taskScope, tasks]);

  const summary = useMemo(() => ({
    waiting: visibleTasks.filter((task) => task.state.status === 'waiting').length,
    backoff: visibleTasks.filter((task) => task.state.status === 'backoff').length,
    running: visibleTasks.filter((task) => task.state.status === 'running').length,
    terminal: visibleTasks.filter((task) => !ACTIVE_STATUSES.has(task.state.status)).length,
  }), [visibleTasks]);

  const loadThreads = async () => {
    try {
      const response = await api.getLocalConnectorThreads({ deviceId, limit: 200 });
      const items = Array.isArray(response.items) ? response.items : [];
      setThreads(items);
      setSelectedThreadId((current) => (
        current && items.some((thread) => thread.threadId === current)
          ? current
          : items.find((thread) => thread.threadId === requestedThreadId)?.threadId || items[0]?.threadId || ''
      ));
    } catch (err: any) {
      error(err?.message || '加载 Codex 会话失败');
    }
  };

  const loadTasks = async (preferredTaskId?: string) => {
    setLoading(true);
    try {
      const response = await api.getBridgeContinuationTasks({
        deviceId: deviceId || undefined,
        sessionKey: filterSession.trim() || undefined,
        status: filterStatus || undefined,
        limit: 100,
      });
      const items = Array.isArray(response.items) ? response.items : [];
      setTasks(items);
      setSelectedTaskId((current) => {
        const preferred = preferredTaskId || current;
        if (preferred && items.some((item) => item.state.taskId === preferred)) return preferred;
        return items[0]?.state.taskId || '';
      });
    } catch (err: any) {
      error(err?.message || '加载 Bridge 续跑任务失败');
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (taskIdToLoad: string) => {
    if (!taskIdToLoad) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const response = await api.getBridgeContinuationTask(taskIdToLoad, 200);
      setDetail({ task: response.task, events: Array.isArray(response.events) ? response.events : [] });
    } catch (err: any) {
      error(err?.message || '加载 Bridge 任务详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const loadActivity = async (threadIdToLoad: string, options: { silent?: boolean } = {}) => {
    const requestVersion = ++activityRequestVersion.current;
    if (!deviceId || !threadIdToLoad) {
      setActivity(null);
      setActivityLoading(false);
      return;
    }
    if (!options.silent) {
      setActivity(null);
      setActivityLoading(true);
    }
    try {
      const response = await api.getLocalConnectorThreadActivity(deviceId, threadIdToLoad, 160);
      if (requestVersion !== activityRequestVersion.current) return;
      setActivity(response);
    } catch (err: any) {
      if (requestVersion !== activityRequestVersion.current) return;
      if (Number(err?.status) === 404) {
        setActivity(null);
      } else {
        error(err?.message || '加载会话活动失败');
      }
    } finally {
      if (requestVersion === activityRequestVersion.current) setActivityLoading(false);
    }
  };

  const loadThreadInteractions = async (threadIdToLoad: string, options: { silent?: boolean } = {}) => {
    const requestVersion = ++interactionRequestVersion.current;
    if (!deviceId || !threadIdToLoad) {
      setThreadInteractions([]);
      setThreadInteractionsLoading(false);
      return;
    }
    if (!options.silent) {
      setThreadInteractions([]);
      setThreadInteractionsLoading(true);
    }
    try {
      const response = await api.getInteractionRequests({
        deviceId,
        threadId: threadIdToLoad,
        limit: 50,
      });
      if (requestVersion !== interactionRequestVersion.current) return;
      setThreadInteractions((Array.isArray(response.items) ? response.items : []).filter(
        (item) => ACTIVE_INTERACTION_STATUSES.has(item.state.status),
      ));
    } catch (err: any) {
      if (requestVersion !== interactionRequestVersion.current) return;
      error(err?.message || '加载当前会话待办失败');
    } finally {
      if (requestVersion === interactionRequestVersion.current) setThreadInteractionsLoading(false);
    }
  };

  const openTask = (taskId: string) => {
    setSelectedTaskId(taskId);
    setTaskDrawerOpen(true);
  };

  useEffect(() => {
    void (async () => {
      try {
        const [deviceResponse, threadResponse, globalResponse] = await Promise.all([
          api.getLocalConnectorDevices(),
          api.getLocalConnectorThreads({ deviceId, limit: 200 }),
          api.getGlobalBridgeContinuation(),
        ]);
        setDevices(Array.isArray(deviceResponse.items) ? deviceResponse.items : []);
        setGlobalContinuation(globalResponse.config);
        const threadItems = Array.isArray(threadResponse.items) ? threadResponse.items : [];
        setThreads(threadItems);
        setSelectedThreadId((current) => (
          current
          || threadItems.find((thread) => thread.threadId === requestedThreadId)?.threadId
          || threadItems[0]?.threadId
          || ''
        ));
      } catch (err: any) {
        error(err?.message || '加载 Connector 设备失败');
      }
    })();
    void loadTasks();
  }, [deviceId, requestedThreadId]);

  useEffect(() => {
    void loadDetail(selectedTaskId);
  }, [selectedTaskId]);

  useEffect(() => {
    void Promise.all([
      loadActivity(selectedThreadId),
      loadThreadInteractions(selectedThreadId),
    ]);
  }, [deviceId, selectedThreadId]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const timer = setInterval(() => {
      void Promise.all([
        loadActivity(selectedThreadId, { silent: true }),
        loadThreadInteractions(selectedThreadId, { silent: true }),
      ]);
    }, 5_000);
    return () => clearInterval(timer);
  }, [deviceId, selectedThreadId]);

  useEffect(() => {
    const taskId = lastSubmittedTask?.state.taskId;
    if (!taskId || !ACTIVE_STATUSES.has(lastSubmittedTask.state.status)) return;
    const timer = setInterval(() => {
      void api.getBridgeContinuationTask(taskId, 20).then((response) => {
        setLastSubmittedTask(response.task);
        setTasks((current) => current.map((task) => task.state.taskId === taskId ? response.task : task));
      }).catch(() => undefined);
    }, 2_000);
    return () => clearInterval(timer);
  }, [lastSubmittedTask?.state.taskId, lastSubmittedTask?.state.status]);

  const updateRule = (failureClass: MainFailureClass, next: RuleDraft) => {
    setRules((current) => ({ ...current, [failureClass]: next }));
  };

  const takeOverThread = async (threadIdInput: string) => {
    const normalizedThreadId = threadIdInput.trim();
    if (!deviceId || !normalizedThreadId) {
      error('请选择当前 Connector 已观测到的 Codex 会话');
      return;
    }
    const policyRules: NonNullable<BridgeContinuationPolicyInput['rules']> = {};
    for (const item of MAIN_FAILURES) {
      const draft = rules[item.value];
      policyRules[item.value] = {
        action: draft.action,
        limit: draft.limitMode === 'unlimited'
          ? { mode: 'unlimited' }
          : { mode: 'bounded', maxContinuations: Math.max(1, Number(draft.maxContinuations) || 1) },
      };
    }
    setSaving(true);
    try {
      const response = await api.takeOverLocalConnectorSession({
        deviceId,
        threadId: normalizedThreadId,
        policy: {
          enabled: true,
          continuePrompt: continuePrompt.trim() || '继续',
          maxElapsedMs: Number(maxElapsedMinutes) > 0
            ? Math.round(Number(maxElapsedMinutes) * 60_000)
            : null,
          backoff: {
            initialDelayMs: Math.max(250, Math.round((Number(initialDelaySeconds) || 5) * 1_000)),
            maxDelayMs: Math.max(250, Math.round((Number(maxDelaySeconds) || 300) * 1_000)),
            multiplier: Math.max(1, Number(multiplier) || 2),
            jitterRatio: Math.min(1, Math.max(0, Number(jitterRatio) || 0)),
          },
          rules: policyRules,
        },
      });
      if (response.created) success('已为该会话开启失败自动续跑');
      else info('该会话已开启自动续跑，已打开现有任务');
      setSelectedTaskId(response.task.state.taskId);
      await Promise.all([
        loadTasks(response.task.state.taskId),
        loadDetail(response.task.state.taskId),
        loadActivity(normalizedThreadId),
      ]);
    } catch (err: any) {
      error(err?.message || '开启自动续跑失败');
    } finally {
      setSaving(false);
    }
  };

  const applyTaskAction = async (task: BridgeContinuationTask, action: 'stop' | 'supersede') => {
    const prompt = action === 'stop'
      ? '确认停止这个 Bridge 续跑任务吗？'
      : '确认结束这个自动续跑任务吗？结束后，你仍可以在上方直接发送新消息。';
    const confirmed = await requestConfirmation({
      title: action === 'stop' ? '停止 Bridge 续跑' : '结束自动续跑',
      description: prompt,
      confirmLabel: action === 'stop' ? '停止任务' : '结束续跑',
      confirmVariant: action === 'stop' ? 'danger' : 'primary',
    });
    if (!confirmed) return;
    setActionTaskId(task.state.taskId);
    try {
      if (action === 'stop') await api.stopBridgeContinuationTask(task.state.taskId);
      else await api.supersedeBridgeContinuationTask(task.state.taskId);
      success(action === 'stop' ? 'Bridge 续跑任务已停止' : '自动续跑任务已结束');
      await Promise.all([
        loadTasks(task.state.taskId),
        loadDetail(task.state.taskId),
        loadActivity(task.state.threadId),
      ]);
    } catch (err: any) {
      error(err?.message || '更新 Bridge 续跑任务失败');
    } finally {
      setActionTaskId('');
    }
  };

  const selectedTask = detail?.task.state.taskId === selectedTaskId
    ? detail.task
    : tasks.find((task) => task.state.taskId === selectedTaskId) || null;
  const selectedThread = threads.find((thread) => thread.threadId === selectedThreadId) || null;
  const selectedAutomaticTask = selectedThread
    ? activeAutomaticTaskByThread.get(selectedThread.threadId) || null
    : null;
  const selectedPromptProgress = manualPromptProgress(
    lastSubmittedTask?.state.threadId === selectedThreadId ? lastSubmittedTask : null,
  );

  const submitManualPrompt = async () => {
    const prompt = manualPrompt.trim();
    if (!selectedThread) {
      error('请先选择一个 Codex 会话');
      return;
    }
    if (!prompt) {
      error('请输入要发送给 Codex 的 Prompt');
      return;
    }

    const fingerprint = `${selectedThread.threadId}\0${manualPromptMode}\0${prompt}`;
    if (!manualPromptAttempt.current || manualPromptAttempt.current.fingerprint !== fingerprint) {
      manualPromptAttempt.current = {
        fingerprint,
        idempotencyKey: createManualPromptIdempotencyKey(),
      };
    }

    setPromptSubmitting(true);
    try {
      const response = await api.createManualBridgePromptTask({
        deviceId,
        threadId: selectedThread.threadId,
        threadStatus: selectedThread.threadStatus,
        activeFlags: selectedThread.activeFlags,
        activeTurnId: selectedThread.activeTurnId,
        prompt,
        submissionMode: manualPromptMode,
        operatorId: 'webui:admin',
        idempotencyKey: manualPromptAttempt.current.idempotencyKey,
      });
      manualPromptAttempt.current = null;
      setManualPrompt('');
      setLastSubmittedTask(response.task);
      if (response.created) success('消息已进入本地 Connector 队列');
      else info('该 Prompt 已提交过，已打开原任务');
      setSelectedTaskId(response.task.state.taskId);
      await Promise.all([
        loadTasks(response.task.state.taskId),
        loadDetail(response.task.state.taskId),
        loadActivity(selectedThread.threadId),
      ]);
    } catch (err: any) {
      error(err?.message || '发送消息失败；再次提交会安全复用同一次请求');
    } finally {
      setPromptSubmitting(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">Connector 工作台</h2>
          <p style={{ margin: '6px 0 0', color: 'var(--color-text-muted)', fontSize: 12 }}>
            查看本机 Codex 会话并直接发送消息；故障自动续跑是可选能力。
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} to="/local-connector">所有 Connector</Link>
          <Button
            type="button"
            className="btn btn-ghost"
            onClick={() => void Promise.all([
              loadThreads(),
              loadTasks(selectedTaskId),
              selectedTaskId ? loadDetail(selectedTaskId) : Promise.resolve(),
              selectedThreadId ? loadActivity(selectedThreadId) : Promise.resolve(),
              selectedThreadId ? loadThreadInteractions(selectedThreadId) : Promise.resolve(),
            ])}
            style={{ border: '1px solid var(--color-border)', display: 'inline-flex', gap: 7, alignItems: 'center' }}
            title="刷新会话、任务和事件"
          >
            <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 11a8 8 0 10-2.34 5.66M20 4v7h-7" />
            </svg>
            刷新
          </Button>
        </div>
      </div>

      <nav className="tabs connector-workspace-tabs" aria-label="Connector 工作台导航">
        <Link className="tab active" to={`/local-connector/${encodeURIComponent(deviceId)}/sessions`}>会话</Link>
        <Link className="tab" to={`/local-connector/${encodeURIComponent(deviceId)}/interactions?view=approvals`}>全部待办</Link>
        <Link className="tab" to={`/local-connector/${encodeURIComponent(deviceId)}/interactions?view=feishu`}>Connector 设置 · 飞书</Link>
      </nav>

      <div style={{ display: 'grid', gap: 16, maxWidth: 1180 }}>
        <section className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 650, fontSize: 14 }}>Codex 会话</div>
          <div style={{ marginTop: 5, color: 'var(--color-text-muted)', fontSize: 12 }}>
            选择会话并直接发送。Connector 会自动判断是补充当前轮，还是开启下一轮。
          </div>

          {controlDevices.length === 0 && (
            <div className="alert alert-warning" style={{ marginTop: 12 }}>
              暂无具备 app_server.control 权限的在线 Connector，请先在“本地 Connector”中完成配对。
            </div>
          )}

          <div className="connector-session-workspace">
            <div className="connector-session-browser">
              <Input
                aria-label="搜索 Codex 会话"
                value={threadSearch}
                onChange={(event) => setThreadSearch(event.target.value)}
                placeholder="搜索会话名称"
              />
              <div className="connector-session-list">
                {threads.length === 0 && (
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '18px 0' }}>当前 Connector 尚未上报 Codex 会话</div>
                )}
                {threads.length > 0 && visibleThreads.length === 0 && (
                  <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '18px 0' }}>没有匹配的会话</div>
                )}
                {visibleThreads.map((thread) => {
                  const selected = thread.threadId === selectedThreadId;
                  return (
                    <Button
                      key={thread.id}
                      type="button"
                      className={`connector-session-row${selected ? ' selected' : ''}`}
                      disabled={controlDevices.length === 0}
                      onClick={() => setSelectedThreadId(thread.threadId)}
                    >
                      <span className="connector-session-row-main">
                        <span className="connector-session-row-title">{getThreadLabel(thread.threadId)}</span>
                        <span className="connector-session-row-meta">{threadActivityLabel(thread)} · 最近活跃 {formatDate(thread.lastActiveAt)}</span>
                      </span>
                      <span className={`badge ${thread.threadStatus === 'system_error' ? 'badge-error' : thread.threadStatus === 'active' ? 'badge-success' : 'badge-neutral'}`}>
                        {threadStatusLabel(thread.threadStatus)}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>

            <form
              className="connector-prompt-composer"
              onSubmit={(event) => { event.preventDefault(); void submitManualPrompt(); }}
            >
              <div className="connector-prompt-heading">
                <div>
                  <div style={{ fontSize: 14, fontWeight: 650 }}>
                    {selectedThread ? getThreadLabel(selectedThread.threadId) : '选择一个会话'}
                  </div>
                  <div style={{ marginTop: 4, color: 'var(--color-text-muted)', fontSize: 11 }}>
                    {selectedThread ? `${threadActivityLabel(selectedThread)} · ${threadControlLabel(selectedThread)}` : '从左侧选择目标会话后发送'}
                  </div>
                </div>
                {selectedThread && (
                  <Disclosure title="会话信息" className="bridge-session-technical-info">
                    <div style={{ display: 'grid', gap: 4, paddingTop: 6, color: 'var(--color-text-muted)', fontSize: 11, wordBreak: 'break-all' }}>
                      <span>Thread ID：{selectedThread.threadId}</span>
                      {selectedThread.activeTurnId ? <span>Turn ID：{selectedThread.activeTurnId}</span> : null}
                      <span>Connector：{selectedThread.deviceName}</span>
                    </div>
                  </Disclosure>
                )}
              </div>
              <TextArea
                aria-label="会话消息"
                value={manualPrompt}
                onChange={(event) => setManualPrompt(event.target.value)}
                rows={7}
                maxLength={4_000}
                placeholder="输入要发送给 Codex 的消息"
                style={{ resize: 'vertical', minHeight: 150 }}
              />
              {selectedPromptProgress && (
                <div className="connector-prompt-progress" aria-live="polite">
                  <span className={`badge ${selectedPromptProgress.className}`}>{selectedPromptProgress.label}</span>
                  <span>{selectedPromptProgress.detail}</span>
                </div>
              )}
              <Disclosure title="高级发送方式" className="connector-send-mode-disclosure">
                <label style={{ ...fieldLabelStyle, maxWidth: 240, paddingTop: 8 }}>
                  发送方式
                  <Select
                    aria-label="人工 Prompt 发送模式"
                    value={manualPromptMode}
                    onChange={(event) => setManualPromptMode(event.target.value as BridgeManualPromptSubmissionMode)}
                  >
                    <Option value="auto">自动判断（推荐）</Option>
                    <Option value="steer_current">补充当前轮</Option>
                    <Option value="start_next">开启下一轮</Option>
                  </Select>
                </label>
              </Disclosure>
              <div className="connector-prompt-footer">
                <span>{selectedThread?.threadStatus === 'active' ? '当前正在运行，消息会优先追加到这一轮。' : '空闲会话将直接开启下一轮。'}</span>
                <Button
                  type="submit"
                  className="btn btn-primary"
                  loading={promptSubmitting}
                  loadingLabel="发送中..."
                  disabled={!manualPrompt.trim() || !selectedThread || controlDevices.length === 0}
                >
                  发送到 Codex
                </Button>
              </div>
            </form>
          </div>

          {(threadInteractionsLoading
            || threadInteractions.length > 0
            || selectedThread?.activeFlags.includes('waitingOnApproval')
            || selectedThread?.activeFlags.includes('waitingOnUserInput')) && (
            <section className="connector-thread-attention" aria-label="当前会话待处理事项">
              <div className="connector-thread-attention-heading">
                <div>
                  <strong>当前会话待处理事项</strong>
                  <span>审批和输入都绑定到这个 Codex 会话；提交后由 Connector 回传给原请求。</span>
                </div>
                <span className={`badge ${threadInteractions.length > 0 ? 'badge-warning' : 'badge-neutral'}`}>
                  {threadInteractionsLoading ? '同步中' : `${threadInteractions.length} 项`}
                </span>
              </div>
              {threadInteractionsLoading ? (
                <div className="connector-thread-attention-empty">正在同步会话待办...</div>
              ) : threadInteractions.length === 0 ? (
                <div className="connector-thread-attention-empty">Connector 已报告等待状态，具体请求正在同步。</div>
              ) : (
                <div className="connector-thread-attention-list">
                  {threadInteractions.map((interaction) => (
                    <Link
                      key={interaction.state.requestId}
                      className="connector-thread-attention-row"
                      to={`/local-connector/${encodeURIComponent(deviceId)}/interactions?view=approvals&request=${encodeURIComponent(interaction.state.requestId)}`}
                    >
                      <span className="connector-thread-attention-main">
                        <strong>{interactionKindLabel(interaction.state.kind)}</strong>
                        <span>{interaction.state.reason || interaction.state.method}</span>
                      </span>
                      <span className="connector-thread-attention-meta">
                        <span className={`badge ${interaction.state.status === 'pending' ? 'badge-warning' : 'badge-info'}`}>
                          {interactionStatusLabel(interaction.state.status)}
                        </span>
                        <time>{formatDate(interaction.createdAt || interaction.state.createdAtMs)}</time>
                        <strong>{interaction.state.status === 'pending' ? '处理' : '查看'}</strong>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}

          <Disclosure title="自动续跑（高级）" className="bridge-takeover-policy-disclosure">
            {globalContinuation?.enabled ? (
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                所有会话自动续跑已开启。当前页仍可查看任务和发送人工消息，但不能重复创建单会话自动续跑事务。
              </div>
            ) : null}
            <div className="bridge-policy-primary-fields">
              <label style={fieldLabelStyle}>
                续跑 Prompt
                <Input aria-label="续跑 Prompt" value={continuePrompt} onChange={(event) => setContinuePrompt(event.target.value)} maxLength={4_000} />
              </label>
              <label style={fieldLabelStyle}>
                最长持续（分钟）
                <Input aria-label="最长持续分钟" type="number" min={0} step={1} value={maxElapsedMinutes} onChange={(event) => setMaxElapsedMinutes(event.target.value)} />
              </label>
            </div>

            <Disclosure title="退避参数" className="bridge-backoff-disclosure">
              <div className="bridge-backoff-fields">
                <label style={fieldLabelStyle}>
                  初始退避（秒）
                  <Input aria-label="初始退避秒数" type="number" min={0.25} step={0.25} value={initialDelaySeconds} onChange={(event) => setInitialDelaySeconds(event.target.value)} />
                </label>
                <label style={fieldLabelStyle}>
                  最大退避（秒）
                  <Input aria-label="最大退避秒数" type="number" min={0.25} step={1} value={maxDelaySeconds} onChange={(event) => setMaxDelaySeconds(event.target.value)} />
                </label>
                <label style={fieldLabelStyle}>
                  退避倍数
                  <Input aria-label="退避倍数" type="number" min={1} max={10} step={0.1} value={multiplier} onChange={(event) => setMultiplier(event.target.value)} />
                </label>
                <label style={fieldLabelStyle}>
                  抖动比例
                  <Input aria-label="抖动比例" type="number" min={0} max={1} step={0.05} value={jitterRatio} onChange={(event) => setJitterRatio(event.target.value)} />
                </label>
              </div>
            </Disclosure>

            <div style={{ marginTop: 18, fontSize: 12, fontWeight: 650 }}>主要失败策略</div>
            <div style={{ marginTop: 6 }}>
              {MAIN_FAILURES.map((item) => (
                <RuleEditor
                  key={item.value}
                  item={item}
                  value={rules[item.value]}
                  isMobile={isMobile}
                  onChange={(next) => updateRule(item.value, next)}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              {selectedAutomaticTask ? (
                <Button type="button" className="btn btn-ghost" onClick={() => openTask(selectedAutomaticTask.state.taskId)}>查看当前自动续跑</Button>
              ) : globalContinuation?.enabled ? (
                <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>由所有会话自动续跑统一管理</span>
              ) : (
                <Button
                  type="button"
                  className="btn btn-ghost"
                  disabled={saving || !selectedThread || controlDevices.length === 0}
                  onClick={() => selectedThread && void takeOverThread(selectedThread.threadId)}
                  style={{ border: '1px solid var(--color-border)' }}
                >
                  {saving ? '启用中...' : '开启自动续跑'}
                </Button>
              )}
            </div>
          </Disclosure>

        </section>

        <section className="card connector-activity-card" style={{ padding: 20 }}>
          <div className="connector-activity-header">
            <div>
              <div style={{ fontWeight: 650, fontSize: 14 }}>当前会话活动</div>
              <div style={{ marginTop: 5, color: 'var(--color-text-muted)', fontSize: 12 }}>
                按会话汇总 Codex 控制、审批、飞书卡片、话题绑定和完成通知。
              </div>
            </div>
            {activity && (
              <div className="connector-activity-summary" aria-label="当前会话活动摘要">
                <span><strong>{activity.summary.bridgeTasks}</strong>控制任务</span>
                <span><strong>{activity.summary.interactions}</strong>交互</span>
                <span><strong>{activity.summary.feishuDeliveries}</strong>飞书发送</span>
                <span className={activity.summary.issues > 0 ? 'has-issues' : ''}>
                  <strong>{activity.summary.issues}</strong>异常
                </span>
              </div>
            )}
          </div>

          {activity?.topicBindings.length ? (
            <div className="connector-topic-bindings">
              {activity.topicBindings.map((binding) => (
                <div key={binding.id} className="connector-topic-binding">
                  <span className={`badge ${binding.rootMessageId ? 'badge-success' : 'badge-warning'}`}>
                    {binding.rootMessageId ? '话题已绑定' : '等待首张卡片'}
                  </span>
                  <strong>{binding.adapterName}</strong>
                  <span>{binding.feishuThreadId ? '飞书话题可接收 Prompt' : '完成卡片送达后建立话题'}</span>
                  <Disclosure title="话题技术信息" className="connector-topic-technical">
                    <div className="connector-activity-technical">
                      <span>Binding ID：{binding.id}</span>
                      {binding.rootMessageId ? <span>Root Message：{binding.rootMessageId}</span> : null}
                      {binding.feishuThreadId ? <span>Feishu Thread：{binding.feishuThreadId}</span> : null}
                      {binding.lastMessageId ? <span>Last Message：{binding.lastMessageId}</span> : null}
                    </div>
                  </Disclosure>
                </div>
              ))}
            </div>
          ) : null}

          <div className="connector-activity-timeline" aria-live="polite">
            {activityLoading ? (
              <div className="skeleton" style={{ height: 180, borderRadius: 'var(--radius-sm)' }} />
            ) : !selectedThread ? (
              <div className="connector-task-empty">请选择一个 Codex 会话查看活动</div>
            ) : !activity || activity.items.length === 0 ? (
              <div className="connector-task-empty">当前会话尚无控制、审批或飞书活动</div>
            ) : activity.items.map((item) => {
              const category = activityCategoryMeta(item.category);
              return (
                <article key={item.id} className={`connector-activity-row category-${item.category}`}>
                  <div className="connector-activity-marker" aria-hidden="true" />
                  <div className="connector-activity-content">
                    <div className="connector-activity-row-heading">
                      <div className="connector-activity-title">
                        <span className={`badge ${category.className}`}>{category.label}</span>
                        <strong>{item.title}</strong>
                      </div>
                      <time>{formatDate(item.occurredAt)}</time>
                    </div>
                    <div className="connector-activity-copy">
                      <span className={`connector-activity-status${item.error ? ' is-error' : ''}`}>
                        {activityStatusLabel(item.status)}
                      </span>
                      {item.detail ? <span>{item.detail}</span> : null}
                    </div>
                    {item.error ? <div className="connector-activity-error">{item.error}</div> : null}
                    {item.category === 'interaction' && item.referenceId ? (
                      <Link
                        className="connector-activity-action"
                        to={`/local-connector/${encodeURIComponent(deviceId)}/interactions?view=approvals&request=${encodeURIComponent(item.referenceId)}`}
                      >
                        {item.status === 'pending' ? '处理这项待办' : '查看交互记录'}
                      </Link>
                    ) : null}
                    <Disclosure title="技术信息" className="connector-activity-disclosure">
                      <div className="connector-activity-technical">
                        <span>事件：{item.eventType}</span>
                        {item.referenceId ? <span>引用：{item.referenceId}</span> : null}
                        {Object.entries(item.metadata).map(([key, value]) => (
                          value === null || value === undefined || value === '' ? null : (
                            <span key={key}>{key}：{typeof value === 'string' ? value : JSON.stringify(value)}</span>
                          )
                        ))}
                      </div>
                    </Disclosure>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="card connector-task-card" style={{ padding: 20 }}>
          <div className="connector-task-header">
            <div>
              <div style={{ fontWeight: 650, fontSize: 14 }}>消息与续跑记录</div>
              <div style={{ marginTop: 5, color: 'var(--color-text-muted)', fontSize: 12 }}>
                默认只看当前会话。打开记录可查看状态变化和排障信息。
              </div>
            </div>
            <div className="connector-task-summary">
              <SummaryMetric label="等待" value={summary.waiting} tone="var(--color-info)" />
              <SummaryMetric label="退避中" value={summary.backoff} tone="var(--color-warning)" />
              <SummaryMetric label="执行中" value={summary.running} tone="var(--color-success)" />
              <SummaryMetric label="终态" value={summary.terminal} tone="var(--color-text-muted)" />
            </div>
          </div>
          <form
            className="connector-task-toolbar"
            onSubmit={(event) => { event.preventDefault(); void loadTasks(); }}
          >
            <div className="connector-task-scope" role="group" aria-label="记录范围">
              <Button
                type="button"
                className={`btn ${taskScope === 'current' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTaskScope('current')}
                disabled={!selectedThreadId}
              >
                当前会话
              </Button>
              <Button
                type="button"
                className={`btn ${taskScope === 'all' ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setTaskScope('all')}
              >
                全部记录
              </Button>
            </div>
            <label style={fieldLabelStyle}>
              状态
              <Select aria-label="任务状态筛选" value={filterStatus} onChange={(event) => setFilterStatus(event.target.value as BridgeContinuationTaskStatus | '')}>
                {STATUS_OPTIONS.map((option) => <Option key={option.value || 'all'} value={option.value}>{option.label}</Option>)}
              </Select>
            </label>
            <Button type="submit" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>筛选</Button>
            <Disclosure title="高级筛选" className="bridge-task-filter-disclosure">
              <label style={{ ...fieldLabelStyle, minWidth: 280, paddingTop: 8 }}>
                技术会话标识
                <Input aria-label="Session 筛选" value={filterSession} onChange={(event) => setFilterSession(event.target.value)} placeholder="仅在排障时精确匹配" />
              </label>
            </Disclosure>
          </form>

          <div className="connector-task-list" aria-live="polite">
            {loading ? (
              <div className="skeleton" style={{ height: 150, borderRadius: 'var(--radius-sm)' }} />
            ) : visibleTasks.length === 0 ? (
              <div className="connector-task-empty">
                {taskScope === 'current' ? '当前会话暂无消息或自动续跑记录' : '暂无消息或自动续跑记录'}
                {taskScope === 'current' && tasks.length > 0 && (
                  <Button type="button" className="btn btn-ghost" onClick={() => setTaskScope('all')}>查看全部记录</Button>
                )}
              </div>
            ) : (
              visibleTasks.map((task) => {
                const state = task.state;
                const progress = manualPromptProgress(task);
                const busy = actionTaskId === state.taskId;
                const automatic = state.taskKind === 'automatic';
                return (
                  <article key={state.taskId} className="connector-task-row">
                    <Button type="button" className="connector-task-open" onClick={() => openTask(state.taskId)}>
                      <span className="connector-task-row-heading">
                        <span className="connector-task-row-title">{getThreadLabel(state.threadId)}</span>
                        <TaskStatusBadge status={state.status} />
                      </span>
                      <span className="connector-task-row-body">
                        <span className="connector-task-kind">{taskKindLabel(state.taskKind)}</span>
                        <span className="connector-task-reason">
                          {progress?.detail || taskReasonLabel(state.reason, state.status)}
                        </span>
                      </span>
                      <span className="connector-task-row-meta">
                        <span>{formatDate(task.updatedAt || state.updatedAtMs)}</span>
                        <span>
                          {automatic
                            ? state.nextRunAtMs
                              ? `下次 ${formatDate(state.nextRunAtMs)}`
                              : `已续跑 ${state.continuationCount} 次`
                            : submissionModeLabel(state.submissionMode)}
                        </span>
                      </span>
                      {automatic && state.lastFailure?.messageSummary && (
                        <span className="connector-task-row-error">{failureLabel(state.lastFailure.failureClass)} · {state.lastFailure.messageSummary}</span>
                      )}
                    </Button>
                    <div className="connector-task-row-actions">
                      <Button type="button" className="btn btn-ghost" onClick={() => openTask(state.taskId)}>详情</Button>
                      {automatic && ACTIVE_STATUSES.has(state.status) && (
                        <Button type="button" className="btn btn-danger" disabled={busy} onClick={() => void applyTaskAction(task, 'stop')}>停止</Button>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>
      </div>
      <SideDrawer
        open={taskDrawerOpen}
        onClose={() => setTaskDrawerOpen(false)}
        title={selectedTask ? `${getThreadLabel(selectedTask.state.threadId)} · ${taskKindLabel(selectedTask.state.taskKind)}` : '记录详情'}
        maxWidth={680}
        footer={selectedTask?.state.taskKind === 'automatic' && ACTIVE_STATUSES.has(selectedTask.state.status) ? (
          <div className="connector-task-drawer-actions">
            <Button
              type="button"
              className="btn btn-ghost"
              disabled={actionTaskId === selectedTask.state.taskId}
              onClick={() => void applyTaskAction(selectedTask, 'supersede')}
            >
              结束自动续跑
            </Button>
            <Button
              type="button"
              className="btn btn-danger"
              disabled={actionTaskId === selectedTask.state.taskId}
              onClick={() => void applyTaskAction(selectedTask, 'stop')}
            >
              停止任务
            </Button>
          </div>
        ) : undefined}
      >
        {detailLoading ? (
          <div className="skeleton" style={{ height: 180, borderRadius: 'var(--radius-sm)' }} />
        ) : !selectedTask ? (
          <div className="connector-task-empty">记录不存在或已被清理</div>
        ) : (
          <div className="connector-task-detail" aria-live="polite">
            <div className="connector-task-detail-status">
              <TaskStatusBadge status={selectedTask.state.status} />
              <span>{taskReasonLabel(selectedTask.state.reason, selectedTask.state.status)}</span>
            </div>

            <div className="connector-task-detail-grid">
              {[
                ['Codex 状态', threadStatusLabel(selectedTask.state.threadStatus)],
                ['当前执行', selectedTask.state.activeFlags.includes('waitingOnApproval')
                  ? '等待审批'
                  : selectedTask.state.activeFlags.includes('waitingOnUserInput')
                    ? '等待你输入'
                    : selectedTask.state.activeTurnId
                      ? '正在运行'
                      : '无活动轮次'],
                ['来源', selectedTask.requestSource === 'webui' ? '管理控制台' : selectedTask.requestSource === 'im' ? '飞书' : '自动触发'],
                ['最近更新', formatDate(selectedTask.updatedAt || selectedTask.state.updatedAtMs)],
                ...(selectedTask.state.taskKind === 'manual_prompt'
                  ? [
                    ['发送方式', submissionModeLabel(selectedTask.state.submissionMode)],
                    ['提交方法', pendingMethodLabel(selectedTask.state.pendingMethod)],
                  ]
                  : [
                    ['续跑次数', String(selectedTask.state.continuationCount)],
                    ['下次运行', selectedTask.state.nextRunAtMs ? formatDate(selectedTask.state.nextRunAtMs) : '未计划'],
                    ['线路动作', routeActionLabel(selectedTask.state.pendingRouteAction)],
                    ['最长持续', formatDuration(selectedTask.state.policy.maxElapsedMs)],
                  ]),
              ].map(([label, value]) => (
                <div key={label} className="connector-task-detail-cell">
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>

            {selectedTask.state.pendingPrompt && (
              <div className="connector-task-detail-section">
                <div className="connector-task-detail-label">
                  {selectedTask.state.taskKind === 'manual_prompt' ? '发送内容' : '续跑 Prompt'}
                </div>
                <div className="connector-task-prompt">{selectedTask.state.pendingPrompt}</div>
              </div>
            )}

            {selectedTask.state.lastFailure && (
              <div className="connector-task-detail-section">
                <div className="connector-task-detail-label">最近失败</div>
                <div className="connector-task-failure">
                  <strong>{failureLabel(selectedTask.state.lastFailure.failureClass)}</strong>
                  <span>{selectedTask.state.lastFailure.messageSummary}</span>
                </div>
              </div>
            )}

            {selectedTask.state.taskKind === 'automatic' && (
              <div className="connector-task-detail-section">
                <div className="connector-task-detail-label">策略快照</div>
                <div className="connector-task-policy-copy">
                  失败后发送“{selectedTask.state.policy.continuePrompt}”，保存于 {formatDate(selectedTask.state.policy.capturedAt)}。
                </div>
              </div>
            )}

            <Disclosure title="技术信息" className="bridge-detail-technical-info">
              <div className="connector-task-technical-grid">
                <span>Task ID：{selectedTask.state.taskId}</span>
                <span>Session：{selectedTask.state.sessionKey}</span>
                <span>Thread ID：{selectedTask.state.threadId}</span>
                {selectedTask.state.activeTurnId ? <span>Turn ID：{selectedTask.state.activeTurnId}</span> : null}
                <span>Connector：{selectedTask.deviceId ? deviceNames.get(selectedTask.deviceId) || selectedTask.deviceId : '未绑定'}</span>
                <span>策略指纹：{selectedTask.state.policy.fingerprint}</span>
                {selectedTask.promptFingerprint ? <span>Prompt 指纹：{selectedTask.promptFingerprint}</span> : null}
                {selectedTask.requestedBy ? <span>操作者：{selectedTask.requestedBy}</span> : null}
                {selectedTask.sourceAdapterId ? <span>来源适配器：{selectedTask.sourceAdapterId}</span> : null}
                {selectedTask.lease ? <span>控制租约：{selectedTask.lease.ownerId}，到期 {formatDate(selectedTask.lease.expiresAt)}</span> : null}
              </div>
            </Disclosure>

            <Disclosure title={`状态事件 · ${detail?.events.length || 0}`} className="bridge-event-history">
              {!detail || detail.events.length === 0 ? (
                <div className="connector-task-event-empty">暂无事件记录</div>
              ) : detail.events.map((event) => (
                <div key={event.id} className="connector-task-event-row">
                  <div className="connector-task-event-heading">
                    <strong>{eventTypeLabel(event.eventType)}</strong>
                    <span>{formatDate(event.createdAt)}</span>
                  </div>
                  <div className="connector-task-event-copy">
                    {event.fromStatus ? statusMeta(event.fromStatus).label : '创建'} → {statusMeta(event.toStatus).label} · {taskReasonLabel(event.reason, event.toStatus)}
                  </div>
                  {event.metadata && (
                    <Disclosure title="事件技术信息" className="bridge-event-disclosure">
                      <pre>{`事件类型: ${event.eventType}\n内部原因: ${event.reason}\n${formatEventMetadata(event.metadata)}`}</pre>
                    </Disclosure>
                  )}
                </div>
              ))}
            </Disclosure>
          </div>
        )}
      </SideDrawer>
      {confirmationDialog}
    </div>
  );
}
