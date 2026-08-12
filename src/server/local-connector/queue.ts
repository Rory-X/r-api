import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  normalizeBridgeAppServerEventWire,
  type BridgeAppServerEventWire,
  type LocalConnectorEventKind,
} from './protocol.js';
import { atomicWriteFile, ensurePrivateDirectory, readOptionalFile } from './atomicFile.js';

const EVENT_PROTOCOL = 'metapi.local-connector.event.v1' as const;
const RESULT_PROTOCOL = 'metapi.local-connector.result.v1' as const;
const BRIDGE_RESULT_PROTOCOL = 'metapi.bridge-continuation.result.v1' as const;
const BRIDGE_EVENT_PROTOCOL = 'metapi.bridge-continuation.event.v1' as const;

export type QueuedLocalConnectorEvent = {
  protocol: typeof EVENT_PROTOCOL;
  id: string;
  kind: LocalConnectorEventKind;
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  idempotencyKey: string;
  createdAt: string;
};

export type QueuedLocalConnectorResult = {
  protocol: typeof RESULT_PROTOCOL;
  actionId: string;
  status: 'succeeded' | 'failed';
  result: Record<string, unknown> | null;
  backupRef: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type QueuedBridgeContinuationResult = {
  protocol: typeof BRIDGE_RESULT_PROTOCOL;
  deliveryId: string;
  taskId: string;
  leaseToken: string;
  outcome: 'accepted' | 'rejected' | 'unknown';
  turnId: string | null;
  failure: Record<string, unknown> | null;
  createdAt: string;
};

export type QueuedBridgeAppServerEvent = {
  protocol: typeof BRIDGE_EVENT_PROTOCOL;
  deliveryId: string;
  taskId: string | null;
  event: BridgeAppServerEventWire;
  createdAt: string;
};

function eventQueueDir(dataDir: string): string {
  return join(resolve(dataDir), 'events');
}

function resultQueueDir(dataDir: string): string {
  return join(resolve(dataDir), 'results');
}

function bridgeResultQueueDir(dataDir: string): string {
  return join(resolve(dataDir), 'bridge-results');
}

function bridgeEventQueueDir(dataDir: string): string {
  return join(resolve(dataDir), 'bridge-events');
}

function queueFilename(prefix: string): string {
  const safePrefix = /^[a-zA-Z0-9-]{1,80}$/.test(prefix)
    ? prefix
    : createHash('sha256').update(prefix).digest('hex').slice(0, 24);
  return `${Date.now().toString().padStart(16, '0')}-${safePrefix}-${randomUUID()}.json`;
}

function normalizeQueueText(value: unknown, fallback: string, maxBytes: number): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const bytes = Buffer.from(text, 'utf8');
  return bytes.byteLength <= maxBytes ? text : bytes.subarray(0, maxBytes).toString('utf8');
}

function normalizeSafeId(value: unknown, label: string, maxLength = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || !/^[a-zA-Z0-9._:-]+$/.test(normalized)) {
    throw new Error(`${label} 无效`);
  }
  return normalized;
}

function normalizeOptionalRecord(value: unknown, label: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 无效`);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024) throw new Error(`${label} 过大`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

export async function enqueueLocalConnectorEvent(input: {
  dataDir: string;
  kind: LocalConnectorEventKind;
  title: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  idempotencyKey?: string;
}): Promise<QueuedLocalConnectorEvent> {
  const directory = eventQueueDir(input.dataDir);
  await ensurePrivateDirectory(directory);
  const id = randomUUID();
  const title = normalizeQueueText(input.title, 'Connector event', 160);
  const message = normalizeQueueText(input.message, 'Connector event', 16 * 1024);
  const event: QueuedLocalConnectorEvent = {
    protocol: EVENT_PROTOCOL,
    id,
    kind: input.kind,
    title,
    message,
    level: input.level === 'warning' || input.level === 'error' ? input.level : 'info',
    idempotencyKey: input.idempotencyKey?.trim().slice(0, 256)
      || createHash('sha256').update(`${input.kind}\0${title}\0${message}`).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  await atomicWriteFile(join(directory, queueFilename('event')), `${JSON.stringify(event)}\n`, 0o600);
  return event;
}

export async function enqueueLocalConnectorResult(
  dataDir: string,
  result: Omit<QueuedLocalConnectorResult, 'protocol' | 'createdAt'>,
): Promise<void> {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(result.actionId)) throw new Error('Connector actionId 无效');
  const directory = resultQueueDir(dataDir);
  await ensurePrivateDirectory(directory);
  const queued: QueuedLocalConnectorResult = {
    protocol: RESULT_PROTOCOL,
    ...result,
    createdAt: new Date().toISOString(),
  };
  await atomicWriteFile(join(directory, queueFilename(result.actionId)), `${JSON.stringify(queued)}\n`, 0o600);
}

export async function enqueueBridgeContinuationResult(input: {
  dataDir: string;
  deliveryId?: string;
  taskId: string;
  leaseToken: string;
  outcome: 'accepted' | 'rejected' | 'unknown';
  turnId?: string | null;
  failure?: Record<string, unknown> | null;
}): Promise<QueuedBridgeContinuationResult> {
  const directory = bridgeResultQueueDir(input.dataDir);
  await ensurePrivateDirectory(directory);
  const taskId = normalizeSafeId(input.taskId, 'Bridge taskId');
  const leaseToken = typeof input.leaseToken === 'string' ? input.leaseToken.trim() : '';
  if (!/^bcl_[a-zA-Z0-9_-]{20,256}$/.test(leaseToken)) throw new Error('Bridge leaseToken 无效');
  const turnId = input.turnId == null ? null : normalizeSafeId(input.turnId, 'Bridge turnId');
  if (input.outcome === 'accepted' && !turnId) throw new Error('Bridge accepted 结果缺少 turnId');
  const queued: QueuedBridgeContinuationResult = {
    protocol: BRIDGE_RESULT_PROTOCOL,
    deliveryId: input.deliveryId
      ? normalizeSafeId(input.deliveryId, 'Bridge deliveryId', 128)
      : `bridge-result:${randomUUID()}`,
    taskId,
    leaseToken,
    outcome: input.outcome,
    turnId,
    failure: normalizeOptionalRecord(input.failure, 'Bridge failure'),
    createdAt: new Date().toISOString(),
  };
  await atomicWriteFile(join(directory, queueFilename(taskId)), `${JSON.stringify(queued)}\n`, 0o600);
  return queued;
}

export async function enqueueBridgeAppServerEvent(input: {
  dataDir: string;
  deliveryId?: string;
  taskId?: string | null;
  event: BridgeAppServerEventWire;
}): Promise<QueuedBridgeAppServerEvent> {
  const directory = bridgeEventQueueDir(input.dataDir);
  await ensurePrivateDirectory(directory);
  const event = normalizeBridgeAppServerEventWire(input.event);
  if (!event) throw new Error('App Server Bridge 事件无效');
  const taskId = input.taskId == null ? null : normalizeSafeId(input.taskId, 'Bridge taskId');
  const queued: QueuedBridgeAppServerEvent = {
    protocol: BRIDGE_EVENT_PROTOCOL,
    deliveryId: input.deliveryId
      ? normalizeSafeId(input.deliveryId, 'Bridge deliveryId', 128)
      : `bridge-event:${randomUUID()}`,
    taskId,
    event,
    createdAt: new Date().toISOString(),
  };
  await atomicWriteFile(join(directory, queueFilename(taskId || event.threadId)), `${JSON.stringify(queued)}\n`, 0o600);
  return queued;
}

async function listQueueFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => /^[0-9]+-[a-zA-Z0-9-]+\.json$/.test(name))
      .sort()
      .map((name) => join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
}

function parseQueuedEvent(value: unknown): QueuedLocalConnectorEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('事件队列记录无效');
  const item = value as Partial<QueuedLocalConnectorEvent>;
  if (item.protocol !== EVENT_PROTOCOL || typeof item.id !== 'string'
    || !['hook', 'notify', 'app_server', 'browser_recovery'].includes(String(item.kind))
    || typeof item.title !== 'string' || typeof item.message !== 'string'
    || !['info', 'warning', 'error'].includes(String(item.level))
    || typeof item.idempotencyKey !== 'string' || typeof item.createdAt !== 'string') {
    throw new Error('事件队列记录无效');
  }
  return item as QueuedLocalConnectorEvent;
}

function parseQueuedResult(value: unknown): QueuedLocalConnectorResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结果队列记录无效');
  const item = value as Partial<QueuedLocalConnectorResult>;
  if (item.protocol !== RESULT_PROTOCOL || typeof item.actionId !== 'string'
    || !/^[a-zA-Z0-9._:-]{1,128}$/.test(item.actionId)
    || (item.status !== 'succeeded' && item.status !== 'failed')
    || typeof item.createdAt !== 'string') {
    throw new Error('结果队列记录无效');
  }
  return item as QueuedLocalConnectorResult;
}

function parseQueuedBridgeResult(value: unknown): QueuedBridgeContinuationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge 结果队列记录无效');
  const item = value as Partial<QueuedBridgeContinuationResult>;
  if (item.protocol !== BRIDGE_RESULT_PROTOCOL
    || typeof item.deliveryId !== 'string'
    || !/^[a-zA-Z0-9._:-]{1,128}$/.test(item.deliveryId)
    || typeof item.taskId !== 'string'
    || !/^[a-zA-Z0-9._:-]{1,256}$/.test(item.taskId)
    || typeof item.leaseToken !== 'string'
    || !/^bcl_[a-zA-Z0-9_-]{20,256}$/.test(item.leaseToken)
    || !['accepted', 'rejected', 'unknown'].includes(String(item.outcome))
    || typeof item.createdAt !== 'string') {
    throw new Error('Bridge 结果队列记录无效');
  }
  if (item.outcome === 'accepted' && (typeof item.turnId !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(item.turnId))) {
    throw new Error('Bridge 结果队列记录无效');
  }
  if (item.turnId !== null && item.turnId !== undefined
    && (typeof item.turnId !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(item.turnId))) {
    throw new Error('Bridge 结果队列记录无效');
  }
  if (item.failure !== null && item.failure !== undefined
    && (!item.failure || typeof item.failure !== 'object' || Array.isArray(item.failure))) {
    throw new Error('Bridge 结果队列记录无效');
  }
  return item as QueuedBridgeContinuationResult;
}

function parseQueuedBridgeEvent(value: unknown): QueuedBridgeAppServerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge 事件队列记录无效');
  const item = value as Partial<QueuedBridgeAppServerEvent>;
  const event = normalizeBridgeAppServerEventWire(item.event);
  if (item.protocol !== BRIDGE_EVENT_PROTOCOL
    || typeof item.deliveryId !== 'string'
    || !/^[a-zA-Z0-9._:-]{1,128}$/.test(item.deliveryId)
    || (item.taskId !== null && item.taskId !== undefined
      && (typeof item.taskId !== 'string' || !/^[a-zA-Z0-9._:-]{1,256}$/.test(item.taskId)))
    || !event
    || typeof item.createdAt !== 'string') {
    throw new Error('Bridge 事件队列记录无效');
  }
  return { ...item, taskId: item.taskId || null, event } as QueuedBridgeAppServerEvent;
}

async function readQueueItem<T>(path: string, parser: (value: unknown) => T): Promise<T> {
  const snapshot = await readOptionalFile(path, 128 * 1024);
  if (!snapshot.exists) throw new Error('队列记录已不存在');
  try {
    return parser(JSON.parse(snapshot.data.toString('utf8')));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('队列记录 JSON 损坏');
    throw error;
  }
}

export async function flushLocalConnectorQueues(input: {
  dataDir: string;
  sendEvent: (event: QueuedLocalConnectorEvent) => Promise<void>;
  sendResult: (result: QueuedLocalConnectorResult) => Promise<void>;
  sendBridgeResult?: (result: QueuedBridgeContinuationResult) => Promise<void>;
  sendBridgeEvent?: (event: QueuedBridgeAppServerEvent) => Promise<void>;
  maxItems?: number;
}): Promise<{ events: number; results: number; bridgeEvents: number; bridgeResults: number }> {
  const maxItems = Math.max(1, Math.min(100, input.maxItems ?? 50));
  let events = 0;
  let results = 0;
  let bridgeEvents = 0;
  let bridgeResults = 0;
  let remaining = maxItems;
  if (input.sendBridgeResult) {
    const bridgeResultFiles = (await listQueueFiles(bridgeResultQueueDir(input.dataDir))).slice(0, remaining);
    for (const path of bridgeResultFiles) {
      const result = await readQueueItem(path, parseQueuedBridgeResult);
      await input.sendBridgeResult(result);
      await rm(path, { force: true });
      bridgeResults += 1;
    }
    remaining = Math.max(0, remaining - bridgeResults);
  }
  if (input.sendBridgeEvent && remaining > 0) {
    const bridgeEventFiles = (await listQueueFiles(bridgeEventQueueDir(input.dataDir))).slice(0, remaining);
    for (const path of bridgeEventFiles) {
      const event = await readQueueItem(path, parseQueuedBridgeEvent);
      await input.sendBridgeEvent(event);
      await rm(path, { force: true });
      bridgeEvents += 1;
    }
    remaining = Math.max(0, remaining - bridgeEvents);
  }
  const resultFiles = (await listQueueFiles(resultQueueDir(input.dataDir))).slice(0, remaining);
  for (const path of resultFiles) {
    const result = await readQueueItem(path, parseQueuedResult);
    await input.sendResult(result);
    await rm(path, { force: true });
    results += 1;
  }
  remaining = Math.max(0, remaining - results);
  const eventFiles = (await listQueueFiles(eventQueueDir(input.dataDir))).slice(0, remaining);
  for (const path of eventFiles) {
    const event = await readQueueItem(path, parseQueuedEvent);
    await input.sendEvent(event);
    await rm(path, { force: true });
    events += 1;
  }
  return { events, results, bridgeEvents, bridgeResults };
}
