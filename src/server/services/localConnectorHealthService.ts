import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  LOCAL_CONNECTOR_HEALTH_CHECK_IDS,
  LOCAL_CONNECTOR_HEALTH_REASONS,
  LOCAL_CONNECTOR_HEALTH_STATUSES,
  type LocalConnectorHealthReportWire,
} from '../local-connector/protocol.js';
import { getConfiguredNotificationChannels, type NotificationChannel } from './notificationChannelDispatcher.js';
import { sendNotification } from './notifyService.js';

export const CONNECTOR_RUNTIME_HEALTH_CHECK_ID = 'connector_runtime' as const;
export type LocalConnectorStoredHealthCheckId =
  | typeof CONNECTOR_RUNTIME_HEALTH_CHECK_ID
  | LocalConnectorHealthReportWire['checkId'];
export type LocalConnectorStoredHealthStatus = 'unknown' | 'healthy' | 'unavailable';

export type LocalConnectorHealthCheckPublic = Readonly<{
  checkId: LocalConnectorStoredHealthCheckId;
  status: LocalConnectorStoredHealthStatus;
  reason: string | null;
  observedAt: string | null;
  transitionedAt: string | null;
  incidentStartedAt: string | null;
  alertedAt: string | null;
  recoveryNotifiedAt: string | null;
  autoRepairActionId: string | null;
}>;

export type LocalConnectorHealthDevice = Readonly<{
  id: string;
  name: string;
  platform: string;
  scopes: readonly string[];
  lastSeenAt: string | null;
}>;

type HealthRow = typeof schema.localConnectorHealthChecks.$inferSelect;
type RequestRepair = (deviceId: string) => Promise<string>;

const CONNECTOR_OFFLINE_AFTER_MS = 120_000;
const NOTIFY_REPAIR_GRACE_MS = 90_000;
const REPAIRABLE_NOTIFY_REASONS = new Set([
  'config_missing',
  'managed_wrapper_missing',
  'managed_command_mismatch',
  'forward_notify_invalid',
]);

const REASON_LABELS: Readonly<Record<string, string>> = {
  heartbeat_timeout: 'Connector 心跳超时',
  config_missing: 'Codex 配置文件不存在',
  config_invalid: 'Codex 配置文件无法解析',
  managed_wrapper_missing: 'Connector notify 包装器被覆盖或移除',
  managed_command_mismatch: 'Connector notify 命令与当前运行环境不一致',
  forward_notify_invalid: '被转发的 notify 命令格式无效',
  runtime_missing: 'Connector Node 或 CLI 运行文件不存在',
};

function healthRowId(deviceId: string, checkId: LocalConnectorStoredHealthCheckId): string {
  return `${deviceId}:${checkId}`;
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeReports(value: unknown): LocalConnectorHealthReportWire[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LOCAL_CONNECTOR_HEALTH_CHECK_IDS.length) {
    throw new Error('Connector 健康状态格式无效');
  }
  const checkIds = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Connector 健康状态格式无效');
    }
    const report = item as Record<string, unknown>;
    if (!(LOCAL_CONNECTOR_HEALTH_CHECK_IDS as readonly unknown[]).includes(report.checkId)
      || !(LOCAL_CONNECTOR_HEALTH_STATUSES as readonly unknown[]).includes(report.status)
      || checkIds.has(report.checkId as string)) {
      throw new Error('Connector 健康状态格式无效');
    }
    const reason = report.reason === null
      ? null
      : (LOCAL_CONNECTOR_HEALTH_REASONS as readonly unknown[]).includes(report.reason)
        ? report.reason as LocalConnectorHealthReportWire['reason']
        : undefined;
    if (reason === undefined || (report.status === 'healthy' && reason !== null)
      || (report.status === 'unavailable' && reason === null)) {
      throw new Error('Connector 健康状态原因无效');
    }
    const observedAtMs = typeof report.observedAt === 'string' ? Date.parse(report.observedAt) : Number.NaN;
    if (!Number.isFinite(observedAtMs)) throw new Error('Connector 健康状态时间无效');
    checkIds.add(report.checkId as string);
    return {
      checkId: report.checkId as LocalConnectorHealthReportWire['checkId'],
      status: report.status as LocalConnectorHealthReportWire['status'],
      reason,
      observedAt: new Date(observedAtMs).toISOString(),
    };
  });
}

function toPublicHealthCheck(row: HealthRow): LocalConnectorHealthCheckPublic {
  return {
    checkId: row.checkId as LocalConnectorStoredHealthCheckId,
    status: row.status as LocalConnectorStoredHealthStatus,
    reason: row.reason,
    observedAt: row.observedAt,
    transitionedAt: row.transitionedAt,
    incidentStartedAt: row.incidentStartedAt,
    alertedAt: row.alertedAt,
    recoveryNotifiedAt: row.recoveryNotifiedAt,
    autoRepairActionId: row.autoRepairActionId,
  };
}

async function notificationChannels(deviceId: string): Promise<NotificationChannel[]> {
  const channels = getConfiguredNotificationChannels();
  const { hasEnabledFeishuAdapterForDevice } = await import('./feishuInteractionAdapterService.js');
  if (await hasEnabledFeishuAdapterForDevice(deviceId)) {
    channels.push(`feishu:${deviceId}` as NotificationChannel);
  }
  return [...new Set(channels)];
}

function reasonLabel(reason: string | null): string {
  return reason ? REASON_LABELS[reason] || reason : '未知原因';
}

function durationText(startedAt: string | null, endedAt: string): string {
  const durationMs = startedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : 0;
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.round(minutes / 60)} 小时`;
}

async function sendUnavailableNotification(
  device: LocalConnectorHealthDevice,
  row: HealthRow,
  detail?: string | null,
): Promise<void> {
  const runtimeOffline = row.checkId === CONNECTOR_RUNTIME_HEALTH_CHECK_ID;
  const title = runtimeOffline
    ? `${device.name} · 本地 Connector 已离线`
    : `${device.name} · Codex 通知链路不可用`;
  const message = runtimeOffline
    ? [
        `最近心跳：${device.lastSeenAt || '从未上报'}`,
        `原因：${reasonLabel(row.reason)}`,
        '影响：Codex 完成通知、会话接管和续跑暂不可用。',
      ].join('\n')
    : [
        `原因：${reasonLabel(row.reason)}`,
        detail ? `自动修复：${detail}` : '自动修复未能恢复链路。',
        '影响：Codex 任务完成事件暂时无法进入 Connector。',
      ].join('\n');
  await sendNotification(title, message, runtimeOffline ? 'error' : 'warning', {
    bypassThrottle: true,
    idempotencyKey: `local-connector-health:unavailable:${row.id}:${row.incidentStartedAt || row.transitionedAt}`,
    channels: await notificationChannels(device.id),
  });
  const nowIso = new Date().toISOString();
  await db.update(schema.localConnectorHealthChecks).set({
    alertedAt: nowIso,
    updatedAt: nowIso,
  }).where(eq(schema.localConnectorHealthChecks.id, row.id)).run();
}

async function sendRecoveryNotification(
  device: LocalConnectorHealthDevice,
  previous: HealthRow,
  recoveredAt: string,
): Promise<void> {
  const runtimeRecovered = previous.checkId === CONNECTOR_RUNTIME_HEALTH_CHECK_ID;
  if (runtimeRecovered && !previous.alertedAt) return;
  if (!runtimeRecovered && !previous.alertedAt && !previous.autoRepairActionId) return;
  const title = runtimeRecovered
    ? `${device.name} · 本地 Connector 已恢复`
    : `${device.name} · Codex 通知链路已恢复`;
  const message = [
    `此前原因：${reasonLabel(previous.reason)}`,
    `不可用时长：${durationText(previous.incidentStartedAt, recoveredAt)}`,
    !runtimeRecovered && previous.autoRepairActionId
      ? '处理结果：线上自动修复已生效。'
      : '处理结果：链路已重新通过健康检查。',
  ].join('\n');
  await sendNotification(title, message, 'info', {
    bypassThrottle: true,
    idempotencyKey: `local-connector-health:recovered:${previous.id}:${previous.incidentStartedAt || previous.transitionedAt}`,
    channels: await notificationChannels(device.id),
  });
  await db.update(schema.localConnectorHealthChecks).set({
    recoveryNotifiedAt: recoveredAt,
    updatedAt: recoveredAt,
  }).where(eq(schema.localConnectorHealthChecks.id, previous.id)).run();
}

async function persistHealthState(input: Readonly<{
  device: LocalConnectorHealthDevice;
  checkId: LocalConnectorStoredHealthCheckId;
  status: 'healthy' | 'unavailable';
  reason: string | null;
  observedAt: string;
}>): Promise<{ current: HealthRow; previous: HealthRow | null; transitioned: boolean }> {
  const id = healthRowId(input.device.id, input.checkId);
  const previous = await db.select().from(schema.localConnectorHealthChecks)
    .where(eq(schema.localConnectorHealthChecks.id, id)).get() ?? null;
  if (previous?.observedAt && Date.parse(previous.observedAt) > Date.parse(input.observedAt)) {
    return { current: previous, previous, transitioned: false };
  }
  const transitioned = !previous || previous.status !== input.status;
  const nowIso = new Date().toISOString();
  if (!previous) {
    await db.insert(schema.localConnectorHealthChecks).values({
      id,
      deviceId: input.device.id,
      checkId: input.checkId,
      status: input.status,
      reason: input.reason,
      observedAt: input.observedAt,
      transitionedAt: input.observedAt,
      incidentStartedAt: input.status === 'unavailable' ? input.observedAt : null,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
  } else {
    await db.update(schema.localConnectorHealthChecks).set({
      status: input.status,
      reason: input.reason,
      observedAt: input.observedAt,
      transitionedAt: transitioned ? input.observedAt : previous.transitionedAt,
      incidentStartedAt: transitioned
        ? input.status === 'unavailable' ? input.observedAt : null
        : previous.incidentStartedAt,
      alertedAt: transitioned ? null : previous.alertedAt,
      recoveryNotifiedAt: transitioned ? null : previous.recoveryNotifiedAt,
      autoRepairActionId: transitioned ? null : previous.autoRepairActionId,
      updatedAt: nowIso,
    }).where(eq(schema.localConnectorHealthChecks.id, id)).run();
  }
  const current = await db.select().from(schema.localConnectorHealthChecks)
    .where(eq(schema.localConnectorHealthChecks.id, id)).get();
  if (!current) throw new Error('Connector 健康状态写入失败');
  if (transitioned && input.status === 'healthy' && previous?.status === 'unavailable') {
    await sendRecoveryNotification(input.device, previous, input.observedAt);
  }
  return { current, previous, transitioned };
}

async function requestNotifyRepair(
  device: LocalConnectorHealthDevice,
  row: HealthRow,
  requestRepair: RequestRepair,
): Promise<void> {
  if (row.autoRepairActionId || !REPAIRABLE_NOTIFY_REASONS.has(row.reason || '')) return;
  try {
    const actionId = await requestRepair(device.id);
    await db.update(schema.localConnectorHealthChecks).set({
      autoRepairActionId: actionId,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.localConnectorHealthChecks.id, row.id)).run();
  } catch (error) {
    await sendUnavailableNotification(
      device,
      row,
      `无法下发修复动作：${(error as Error)?.message || '未知错误'}`,
    );
  }
}

export async function recordLocalConnectorHealthReports(input: Readonly<{
  device: LocalConnectorHealthDevice;
  reports: unknown;
  requestRepair: RequestRepair;
}>): Promise<void> {
  if (!input.device.scopes.includes('notify.manage')) return;
  for (const report of normalizeReports(input.reports)) {
    const state = await persistHealthState({
      device: input.device,
      checkId: report.checkId,
      status: report.status,
      reason: report.reason,
      observedAt: report.observedAt,
    });
    if (state.current.status === 'unavailable' && !state.current.alertedAt) {
      if (REPAIRABLE_NOTIFY_REASONS.has(state.current.reason || '')) {
        await requestNotifyRepair(input.device, state.current, input.requestRepair);
      } else {
        await sendUnavailableNotification(input.device, state.current, '该故障不支持自动修改本地文件');
      }
    }
  }
}

export async function recordLocalConnectorHeartbeat(
  device: LocalConnectorHealthDevice,
  observedAt: string,
): Promise<void> {
  await persistHealthState({
    device,
    checkId: CONNECTOR_RUNTIME_HEALTH_CHECK_ID,
    status: 'healthy',
    reason: null,
    observedAt,
  });
}

export async function listLocalConnectorHealthChecks(): Promise<Map<string, LocalConnectorHealthCheckPublic[]>> {
  const rows = await db.select().from(schema.localConnectorHealthChecks).all();
  const result = new Map<string, LocalConnectorHealthCheckPublic[]>();
  for (const row of rows) {
    const checks = result.get(row.deviceId) || [];
    checks.push(toPublicHealthCheck(row));
    result.set(row.deviceId, checks);
  }
  return result;
}

export async function runLocalConnectorHealthMonitorPass(input: Readonly<{
  now?: Date;
  offlineAfterMs?: number;
  notifyRepairGraceMs?: number;
  requestRepair: RequestRepair;
}>): Promise<{ offline: number; notifyUnavailable: number }> {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const offlineAfterMs = Math.max(30_000, input.offlineAfterMs ?? CONNECTOR_OFFLINE_AFTER_MS);
  const notifyRepairGraceMs = Math.max(10_000, input.notifyRepairGraceMs ?? NOTIFY_REPAIR_GRACE_MS);
  const deviceRows = await db.select().from(schema.localConnectorDevices)
    .where(eq(schema.localConnectorDevices.status, 'active')).all();
  const devices = new Map<string, LocalConnectorHealthDevice>(deviceRows.map((row) => [row.id, {
    id: row.id,
    name: row.name,
    platform: row.platform,
    scopes: parseScopes(row.scopes),
    lastSeenAt: row.lastSeenAt,
  }]));
  let offline = 0;
  for (const device of devices.values()) {
    const lastSeenAtMs = device.lastSeenAt ? Date.parse(device.lastSeenAt) : Number.NEGATIVE_INFINITY;
    if (now.getTime() - lastSeenAtMs < offlineAfterMs) continue;
    const unavailableAt = Number.isFinite(lastSeenAtMs)
      ? new Date(lastSeenAtMs + offlineAfterMs).toISOString()
      : nowIso;
    const state = await persistHealthState({
      device,
      checkId: CONNECTOR_RUNTIME_HEALTH_CHECK_ID,
      status: 'unavailable',
      reason: 'heartbeat_timeout',
      observedAt: unavailableAt,
    });
    if (!state.current.alertedAt) await sendUnavailableNotification(device, state.current);
    offline += 1;
  }

  const unavailableRows = await db.select().from(schema.localConnectorHealthChecks)
    .where(eq(schema.localConnectorHealthChecks.status, 'unavailable')).all();
  let notifyUnavailable = 0;
  for (const row of unavailableRows) {
    if (row.checkId !== 'codex_notify' || row.alertedAt) continue;
    const device = devices.get(row.deviceId);
    if (!device || !device.scopes.includes('notify.manage')) continue;
    notifyUnavailable += 1;
    if (!row.autoRepairActionId) {
      if (REPAIRABLE_NOTIFY_REASONS.has(row.reason || '')) {
        await requestNotifyRepair(device, row, input.requestRepair);
      } else {
        await sendUnavailableNotification(device, row, '该故障不支持自动修改本地文件');
      }
      continue;
    }
    const action = await db.select().from(schema.localConnectorActions)
      .where(eq(schema.localConnectorActions.id, row.autoRepairActionId)).get();
    const incidentAgeMs = now.getTime() - Date.parse(row.incidentStartedAt || row.transitionedAt || nowIso);
    if (action && ['failed', 'cancelled', 'expired'].includes(action.status)) {
      await sendUnavailableNotification(device, row, action.errorMessage || `修复动作状态：${action.status}`);
    } else if (incidentAgeMs >= notifyRepairGraceMs) {
      const detail = action?.status === 'succeeded'
        ? '修复动作已完成，但本地健康检查仍未恢复'
        : `修复动作仍处于 ${action?.status || '未知'} 状态`;
      await sendUnavailableNotification(device, row, detail);
    }
  }
  return { offline, notifyUnavailable };
}

export function __normalizeLocalConnectorHealthReportsForTests(value: unknown): LocalConnectorHealthReportWire[] {
  return normalizeReports(value);
}
