import { and, desc, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getLocalConnectorThread,
  type LocalConnectorThreadPublic,
} from './localConnectorThreadService.js';

export type LocalConnectorThreadActivityCategory =
  | 'bridge'
  | 'interaction'
  | 'feishu'
  | 'notification';

export type LocalConnectorThreadActivityItem = Readonly<{
  id: string;
  category: LocalConnectorThreadActivityCategory;
  eventType: string;
  status: string | null;
  occurredAt: string | null;
  title: string;
  detail: string | null;
  referenceId: string | null;
  error: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type LocalConnectorThreadTopicBinding = Readonly<{
  id: string;
  adapterId: string;
  adapterName: string;
  rootMessageId: string | null;
  feishuThreadId: string | null;
  lastMessageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export type LocalConnectorThreadActivity = Readonly<{
  thread: LocalConnectorThreadPublic;
  summary: Readonly<{
    activityCount: number;
    bridgeTasks: number;
    interactions: number;
    feishuDeliveries: number;
    issues: number;
  }>;
  topicBindings: readonly LocalConnectorThreadTopicBinding[];
  items: readonly LocalConnectorThreadActivityItem[];
}>;

const ISSUE_STATUSES = new Set(['dead', 'failed', 'delivery_unknown']);

function normalizeId(value: unknown, label: string, maximum = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function normalizeLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(500, parsed) : 120;
}

function compactText(value: unknown, maximum = 300): string | null {
  const normalized = typeof value === 'string'
    ? value.replace(/[\0\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return null;
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 3)}...` : normalized;
}

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function bridgeEventTitle(eventType: string, taskKind: string): string {
  const labels: Record<string, string> = {
    task_created: '自动续跑任务已创建',
    manual_prompt_created: '会话消息已进入队列',
    manual_prompt_superseded: '新消息已接替自动续跑',
    failure_observed: '检测到 Codex 执行失败',
    thread_state_changed: 'Codex 会话状态已更新',
    turn_started: 'Codex 已开始处理',
    turn_completed: 'Codex 本轮处理完成',
    manual_stop: '控制任务已手动停止',
    device_revoked: 'Connector 设备已撤销',
    lease_expired: 'Connector 控制租约已过期',
    lease_acquired: 'Connector 已领取控制任务',
    dispatch_succeeded: '消息已提交到 Codex',
    dispatch_failed: '消息提交失败',
  };
  if (eventType === 'task_created' && taskKind === 'manual_prompt') return '会话消息已进入队列';
  return labels[eventType] || 'Bridge 控制状态已更新';
}

function interactionEventTitle(eventType: string, kind: string): string {
  const kindLabel = ({
    command_approval: '命令审批',
    file_change_approval: '文件修改审批',
    permissions_approval: '权限审批',
    user_input: '用户输入',
    mcp_elicitation: 'MCP 交互',
  } as Record<string, string>)[kind] || 'Codex 交互';
  const eventLabel: Record<string, string> = {
    request_created: '已请求',
    response_committed: '已提交回复',
    response_claimed: 'Connector 已领取回复',
    source_resolved: 'Codex 已处理回复',
    cancelled: '已取消',
    expired: '已过期',
  };
  return `${kindLabel}${eventLabel[eventType] || '状态已更新'}`;
}

function notificationThreadId(message: string): string | null {
  const matched = message.match(/(?:^|\n)(?:线程 ID|Thread ID)[：:]\s*([^\s\r\n]+)/i);
  return matched?.[1]?.trim() || null;
}

export async function getLocalConnectorThreadActivity(input: {
  deviceId: unknown;
  threadId: unknown;
  limit?: unknown;
}): Promise<LocalConnectorThreadActivity | null> {
  const deviceId = normalizeId(input.deviceId, 'Connector 设备 ID', 128);
  const threadId = normalizeId(input.threadId, 'Codex Thread ID');
  const limit = normalizeLimit(input.limit);
  const sourceLimit = Math.min(500, Math.max(limit, 120));
  const thread = await getLocalConnectorThread({ deviceId, threadId });
  if (!thread) return null;

  const [tasks, interactions, promptCards, topicRows, notificationCandidates] = await Promise.all([
    db.select().from(schema.bridgeContinuationTasks).where(and(
      eq(schema.bridgeContinuationTasks.deviceId, deviceId),
      eq(schema.bridgeContinuationTasks.threadId, threadId),
    )).orderBy(desc(schema.bridgeContinuationTasks.createdAt)).limit(sourceLimit).all(),
    db.select().from(schema.interactionRequests).where(and(
      eq(schema.interactionRequests.deviceId, deviceId),
      eq(schema.interactionRequests.threadId, threadId),
    )).orderBy(desc(schema.interactionRequests.createdAt)).limit(sourceLimit).all(),
    db.select().from(schema.interactionPromptCards).where(and(
      eq(schema.interactionPromptCards.deviceId, deviceId),
      eq(schema.interactionPromptCards.threadId, threadId),
    )).orderBy(desc(schema.interactionPromptCards.createdAt)).limit(sourceLimit).all(),
    db.select().from(schema.feishuTopicBindings).where(and(
      eq(schema.feishuTopicBindings.deviceId, deviceId),
      eq(schema.feishuTopicBindings.codexThreadId, threadId),
    )).orderBy(desc(schema.feishuTopicBindings.updatedAt)).limit(sourceLimit).all(),
    db.select().from(schema.notificationOutbox).where(and(
      eq(schema.notificationOutbox.channel, `feishu:${deviceId}`),
      or(
        like(schema.notificationOutbox.message, `%线程 ID：${threadId}%`),
        like(schema.notificationOutbox.message, `%线程 ID: ${threadId}%`),
        like(schema.notificationOutbox.message, `%Thread ID: ${threadId}%`),
      ),
    )).orderBy(desc(schema.notificationOutbox.createdAt)).limit(Math.min(2_000, sourceLimit * 8)).all(),
  ]);

  const taskIds = tasks.map((task) => task.id);
  const interactionIds = interactions.map((interaction) => interaction.id);
  const promptCardIds = promptCards.map((card) => card.id);
  const [bridgeEvents, interactionEvents] = await Promise.all([
    taskIds.length > 0
      ? db.select().from(schema.bridgeContinuationEvents)
        .where(inArray(schema.bridgeContinuationEvents.taskId, taskIds))
        .orderBy(desc(schema.bridgeContinuationEvents.createdAt)).limit(sourceLimit).all()
      : [],
    interactionIds.length > 0
      ? db.select().from(schema.interactionEvents)
        .where(inArray(schema.interactionEvents.interactionId, interactionIds))
        .orderBy(desc(schema.interactionEvents.createdAt)).limit(sourceLimit).all()
      : [],
  ]);

  const dispatchSubjects: SQL<unknown>[] = [];
  if (interactionIds.length > 0) {
    dispatchSubjects.push(inArray(schema.interactionDispatches.interactionId, interactionIds));
  }
  if (promptCardIds.length > 0) {
    dispatchSubjects.push(inArray(schema.interactionDispatches.promptCardId, promptCardIds));
  }
  const dispatchFilter = dispatchSubjects.length === 1
    ? dispatchSubjects[0]
    : dispatchSubjects.length > 1
      ? or(...dispatchSubjects)
      : null;
  const dispatches = dispatchFilter
    ? await db.select().from(schema.interactionDispatches).where(dispatchFilter)
      .orderBy(desc(schema.interactionDispatches.createdAt)).limit(sourceLimit).all()
    : [];
  const dispatchIds = dispatches.map((dispatch) => dispatch.id);
  const cardUpdates = dispatchIds.length > 0
    ? await db.select().from(schema.interactionCardUpdates)
      .where(inArray(schema.interactionCardUpdates.dispatchId, dispatchIds))
      .orderBy(desc(schema.interactionCardUpdates.createdAt)).limit(sourceLimit).all()
    : [];

  const adapterIds = [...new Set([
    ...topicRows.map((binding) => binding.adapterId),
    ...dispatches.map((dispatch) => dispatch.adapterId),
  ])];
  const adapters = adapterIds.length > 0
    ? await db.select({
      id: schema.interactionAdapters.id,
      name: schema.interactionAdapters.name,
    }).from(schema.interactionAdapters).where(inArray(schema.interactionAdapters.id, adapterIds)).all()
    : [];
  const adapterNames = new Map(adapters.map((adapter) => [adapter.id, adapter.name]));
  const taskById = new Map<string, typeof schema.bridgeContinuationTasks.$inferSelect>(
    tasks.map((task) => [task.id, task]),
  );
  const interactionById = new Map<string, typeof schema.interactionRequests.$inferSelect>(
    interactions.map((interaction) => [interaction.id, interaction]),
  );
  const dispatchById = new Map<string, typeof schema.interactionDispatches.$inferSelect>(
    dispatches.map((dispatch) => [dispatch.id, dispatch]),
  );
  const items: LocalConnectorThreadActivityItem[] = [];

  for (const event of bridgeEvents) {
    const task = taskById.get(event.taskId);
    if (!task) continue;
    items.push(Object.freeze({
      id: `bridge-event:${event.id}`,
      category: 'bridge',
      eventType: event.eventType,
      status: event.toStatus,
      occurredAt: event.createdAt,
      title: bridgeEventTitle(event.eventType, task.taskKind),
      detail: compactText(task.pendingPrompt || event.reason),
      referenceId: event.taskId,
      error: event.eventType.includes('failed') || event.toStatus === 'dead'
        ? compactText(task.lastMessageSummary || event.reason, 500)
        : null,
      metadata: Object.freeze({
        taskKind: task.taskKind,
        requestSource: task.requestSource,
        requestedBy: task.requestedBy,
        fromStatus: event.fromStatus,
        reason: event.reason,
      }),
    }));
  }

  for (const event of interactionEvents) {
    const interaction = interactionById.get(event.interactionId);
    if (!interaction) continue;
    items.push(Object.freeze({
      id: `interaction-event:${event.id}`,
      category: 'interaction',
      eventType: event.eventType,
      status: event.toStatus,
      occurredAt: event.createdAt,
      title: interactionEventTitle(event.eventType, interaction.kind),
      detail: compactText(`${interaction.method} · ${interaction.reason}`),
      referenceId: event.interactionId,
      error: null,
      metadata: Object.freeze({
        kind: interaction.kind,
        method: interaction.method,
        actorKind: event.actorKind,
        actorId: event.actorId,
        responseSource: interaction.responseSource,
        responseDeliveryCount: interaction.responseDeliveryCount,
      }),
    }));
  }

  for (const promptCard of promptCards) {
    items.push(Object.freeze({
      id: `feishu-prompt-card:${promptCard.id}`,
      category: 'feishu',
      eventType: 'prompt_card_state',
      status: promptCard.status,
      occurredAt: promptCard.consumedAt || promptCard.updatedAt || promptCard.createdAt,
      title: promptCard.status === 'consumed'
        ? '飞书追加 Prompt 已进入 Codex 队列'
        : promptCard.status === 'pending'
          ? '飞书追加 Prompt 卡片等待输入'
          : promptCard.status === 'expired'
            ? '飞书追加 Prompt 卡片已过期'
            : '飞书追加 Prompt 卡片已取消',
      detail: compactText(promptCard.requestedBy),
      referenceId: promptCard.id,
      error: null,
      metadata: Object.freeze({
        adapterId: promptCard.adapterId,
        contextTaskId: promptCard.contextTaskId,
        consumedTaskId: promptCard.consumedTaskId,
        consumedBy: promptCard.consumedBy,
        expiresAt: promptCard.expiresAt,
      }),
    }));
  }

  for (const dispatch of dispatches) {
    items.push(Object.freeze({
      id: `feishu-dispatch:${dispatch.id}`,
      category: 'feishu',
      eventType: 'card_dispatch',
      status: dispatch.status,
      occurredAt: dispatch.deliveredAt || dispatch.updatedAt || dispatch.createdAt,
      title: dispatch.subjectKind === 'interaction' ? '飞书交互卡片投递' : '飞书会话消息卡片投递',
      detail: compactText(`${adapterNames.get(dispatch.adapterId) || '飞书 Adapter'} · 尝试 ${dispatch.attemptCount} 次`),
      referenceId: dispatch.id,
      error: compactText(dispatch.lastError, 500),
      metadata: Object.freeze({
        adapterId: dispatch.adapterId,
        externalMessageId: dispatch.externalMessageId,
        subjectKind: dispatch.subjectKind,
        interactionId: dispatch.interactionId,
        promptCardId: dispatch.promptCardId,
      }),
    }));
  }

  for (const update of cardUpdates) {
    const dispatch = dispatchById.get(update.dispatchId);
    if (!dispatch) continue;
    items.push(Object.freeze({
      id: `feishu-card-update:${update.id}`,
      category: 'feishu',
      eventType: 'card_update',
      status: update.status,
      occurredAt: update.deliveredAt || update.updatedAt || update.createdAt,
      title: '飞书卡片状态回写',
      detail: compactText(`目标状态：${update.targetStatus} · 第 ${update.subjectRevision} 版`),
      referenceId: update.dispatchId,
      error: compactText(update.lastError, 500),
      metadata: Object.freeze({
        adapterId: dispatch.adapterId,
        attemptCount: update.attemptCount,
        targetStatus: update.targetStatus,
      }),
    }));
  }

  const notificationRows = notificationCandidates.filter((row) => notificationThreadId(row.message) === threadId);
  for (const row of notificationRows) {
    items.push(Object.freeze({
      id: `notification:${row.id}`,
      category: 'notification',
      eventType: 'turn_completion_notification',
      status: row.status,
      occurredAt: row.deliveredAt || row.updatedAt || row.occurredAt,
      title: row.title,
      detail: compactText(row.message, 500),
      referenceId: row.notificationId,
      error: compactText(row.lastError, 500),
      metadata: Object.freeze({
        channel: row.channel,
        attemptCount: row.attemptCount,
        lastOutcome: row.lastOutcome,
      }),
    }));
  }

  for (const binding of topicRows) {
    items.push(Object.freeze({
      id: `feishu-topic:${binding.id}`,
      category: 'feishu',
      eventType: 'topic_binding',
      status: binding.rootMessageId ? 'bound' : 'pending',
      occurredAt: binding.updatedAt || binding.createdAt,
      title: binding.rootMessageId ? '飞书话题已绑定当前会话' : '飞书话题绑定等待首张卡片',
      detail: compactText(adapterNames.get(binding.adapterId) || '飞书 Adapter'),
      referenceId: binding.id,
      error: null,
      metadata: Object.freeze({
        adapterId: binding.adapterId,
        rootMessageId: binding.rootMessageId,
        feishuThreadId: binding.feishuThreadId,
        lastMessageId: binding.lastMessageId,
      }),
    }));
  }

  items.sort((left, right) => timestamp(right.occurredAt) - timestamp(left.occurredAt)
    || right.id.localeCompare(left.id));
  const visibleItems = Object.freeze(items.slice(0, limit));
  const topicBindings = Object.freeze(topicRows.map((binding) => Object.freeze({
    id: binding.id,
    adapterId: binding.adapterId,
    adapterName: adapterNames.get(binding.adapterId) || '飞书 Adapter',
    rootMessageId: binding.rootMessageId,
    feishuThreadId: binding.feishuThreadId,
    lastMessageId: binding.lastMessageId,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  })));

  return Object.freeze({
    thread,
    summary: Object.freeze({
      activityCount: items.length,
      bridgeTasks: tasks.length,
      interactions: interactions.length,
      feishuDeliveries: dispatches.length + notificationRows.length,
      issues: items.filter((item) => Boolean(item.error) || ISSUE_STATUSES.has(item.status || '')).length,
    }),
    topicBindings,
    items: visibleItems,
  });
}
