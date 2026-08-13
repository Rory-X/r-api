import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export type ObservedCodexThreadStatus = 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
export type ObservedCodexThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';
export type LocalConnectorThreadObservationSource = 'connector_app_server' | 'codex_desktop';
export type LocalConnectorThreadControlState = 'available' | 'external_owner';

export type LocalConnectorThreadEvent = Readonly<{
  kind: 'thread_started' | 'thread_status' | 'turn_started' | 'turn_completed' | 'error' | 'lifecycle';
  threadId: string;
  title?: string | null;
  turnId?: string | null;
  status?: string | null;
  activeFlags?: readonly string[];
  observationSource?: LocalConnectorThreadObservationSource;
  controlState?: LocalConnectorThreadControlState;
  activeAt?: string | null;
}>;

export type LocalConnectorThreadPublic = Readonly<{
  id: string;
  deviceId: string;
  deviceName: string;
  devicePlatform: string;
  deviceStatus: string;
  threadId: string;
  title: string | null;
  observationSource: LocalConnectorThreadObservationSource;
  controlState: LocalConnectorThreadControlState;
  threadStatus: ObservedCodexThreadStatus;
  activeFlags: readonly ObservedCodexThreadActiveFlag[];
  activeTurnId: string | null;
  lastEventKind: string;
  lastSeenAt: string;
  lastActiveAt: string | null;
}>;

const THREAD_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,256}$/;
const ACTIVE_FLAGS = new Set<ObservedCodexThreadActiveFlag>([
  'waitingOnApproval',
  'waitingOnUserInput',
]);
type DbExecutor = typeof db;

function normalizeId(value: unknown, label: string, maxLength = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength || !THREAD_ID_PATTERN.test(normalized)) {
    throw new Error(`${label} 无效`);
  }
  return normalized;
}

function normalizeOptionalTitle(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Codex 会话名称无效');
  const normalized = value.replace(/[\0\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, 160);
}

function normalizeStatus(value: unknown): ObservedCodexThreadStatus {
  if (value === 'not_loaded' || value === 'idle' || value === 'active' || value === 'system_error') {
    return value;
  }
  return 'unknown';
}

function normalizeObservationSource(value: unknown): LocalConnectorThreadObservationSource {
  return value === 'codex_desktop' ? 'codex_desktop' : 'connector_app_server';
}

function requireObservationSource(value: unknown): LocalConnectorThreadObservationSource {
  if (value === 'codex_desktop' || value === 'connector_app_server') return value;
  throw new Error('Connector 会话快照来源无效');
}

function normalizeControlState(value: unknown): LocalConnectorThreadControlState {
  return value === 'external_owner' ? 'external_owner' : 'available';
}

function normalizeActiveFlags(value: unknown): ObservedCodexThreadActiveFlag[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is ObservedCodexThreadActiveFlag => (
    typeof item === 'string' && ACTIVE_FLAGS.has(item as ObservedCodexThreadActiveFlag)
  )))];
}

function parseStoredActiveFlags(value: string): ObservedCodexThreadActiveFlag[] {
  try {
    return normalizeActiveFlags(JSON.parse(value));
  } catch {
    return [];
  }
}

function normalizeOptionalTimestamp(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function latestTimestamp(current: string | null | undefined, candidate: string | null): string | null {
  if (!candidate) return current || null;
  if (!current || !Number.isFinite(Date.parse(current))) return candidate;
  return Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

function eventState(
  event: LocalConnectorThreadEvent,
  current?: typeof schema.localConnectorThreads.$inferSelect | null,
): {
  threadStatus: ObservedCodexThreadStatus;
  activeFlags: ObservedCodexThreadActiveFlag[];
  activeTurnId: string | null;
} {
  const currentStatus = normalizeStatus(current?.threadStatus);
  const currentFlags = current ? parseStoredActiveFlags(current.activeFlags) : [];
  const turnId = event.turnId && THREAD_ID_PATTERN.test(event.turnId) ? event.turnId : null;

  if (event.kind === 'thread_status') {
    const threadStatus = normalizeStatus(event.status);
    const hasTurnSnapshot = Object.prototype.hasOwnProperty.call(event, 'turnId');
    return {
      threadStatus,
      activeFlags: normalizeActiveFlags(event.activeFlags),
      activeTurnId: threadStatus === 'active'
        ? hasTurnSnapshot ? turnId : current?.activeTurnId || null
        : null,
    };
  }
  if (event.kind === 'turn_started') {
    return { threadStatus: 'active', activeFlags: currentFlags, activeTurnId: turnId };
  }
  if (event.kind === 'turn_completed') {
    return { threadStatus: 'idle', activeFlags: [], activeTurnId: null };
  }
  if (event.kind === 'error') {
    return { threadStatus: 'system_error', activeFlags: currentFlags, activeTurnId: turnId };
  }
  return {
    threadStatus: currentStatus,
    activeFlags: currentFlags,
    activeTurnId: current?.activeTurnId || null,
  };
}

function observedThreadId(deviceId: string, threadId: string): string {
  return createHash('sha256').update(`${deviceId}\0${threadId}`).digest('hex');
}

function publicThread(
  row: typeof schema.localConnectorThreads.$inferSelect,
  device: typeof schema.localConnectorDevices.$inferSelect,
): LocalConnectorThreadPublic {
  return Object.freeze({
    id: row.id,
    deviceId: row.deviceId,
    deviceName: device.name,
    devicePlatform: device.platform,
    deviceStatus: device.status,
    threadId: row.threadId,
    title: row.title,
    observationSource: normalizeObservationSource(row.observationSource),
    controlState: normalizeControlState(row.controlState),
    threadStatus: normalizeStatus(row.threadStatus),
    activeFlags: parseStoredActiveFlags(row.activeFlags),
    activeTurnId: row.activeTurnId,
    lastEventKind: row.lastEventKind,
    lastSeenAt: row.lastSeenAt,
    lastActiveAt: row.lastActiveAt,
  });
}

export async function recordLocalConnectorThreadEvent(input: {
  deviceId: unknown;
  event: LocalConnectorThreadEvent;
  now?: Date | number;
}): Promise<void> {
  await upsertLocalConnectorThreadEvent(db, input);
}

async function upsertLocalConnectorThreadEvent(executor: DbExecutor, input: {
  deviceId: unknown;
  event: LocalConnectorThreadEvent;
  now?: Date | number;
}): Promise<void> {
  const deviceId = normalizeId(input.deviceId, 'Connector 设备 ID', 128);
  const threadId = normalizeId(input.event.threadId, 'Codex Thread ID');
  const id = observedThreadId(deviceId, threadId);
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const nowIso = now.toISOString();
  const current = await executor.select().from(schema.localConnectorThreads)
    .where(eq(schema.localConnectorThreads.id, id))
    .get();
  const next = eventState(input.event, current);
  const explicitActiveAt = normalizeOptionalTimestamp(input.event.activeAt);
  // Periodic snapshots may carry an upstream `updatedAt`; without it they
  // only prove that the Connector is alive. Explicit App Server events do
  // represent activity, so use the receive time for those event-shaped
  // thread_status updates while keeping heartbeat-only snapshots neutral.
  const eventActiveAt = input.event.kind === 'thread_status'
    ? explicitActiveAt || (!input.event.observationSource ? nowIso : null)
    : nowIso;
  const values = {
    deviceId,
    threadId,
    title: normalizeOptionalTitle(input.event.title) ?? current?.title ?? null,
    observationSource: normalizeObservationSource(input.event.observationSource),
    controlState: normalizeControlState(input.event.controlState),
    threadStatus: next.threadStatus,
    activeFlags: JSON.stringify(next.activeFlags),
    activeTurnId: next.activeTurnId,
    lastEventKind: input.event.kind,
    lastSeenAt: nowIso,
    lastActiveAt: latestTimestamp(current?.lastActiveAt, eventActiveAt),
    updatedAt: nowIso,
  };

  if (current) {
    await executor.update(schema.localConnectorThreads).set(values)
      .where(eq(schema.localConnectorThreads.id, id))
      .run();
    return;
  }

  try {
    await executor.insert(schema.localConnectorThreads).values({
      id,
      ...values,
      createdAt: nowIso,
    }).run();
  } catch {
    await executor.update(schema.localConnectorThreads).set(values)
      .where(and(
        eq(schema.localConnectorThreads.deviceId, deviceId),
        eq(schema.localConnectorThreads.threadId, threadId),
      ))
      .run();
  }
}

export async function syncLocalConnectorThreadSnapshots(input: {
  deviceId: unknown;
  source: unknown;
  threads: unknown;
  now?: Date | number;
}): Promise<{ observed: number; released: number }> {
  const deviceId = normalizeId(input.deviceId, 'Connector 设备 ID', 128);
  const source = requireObservationSource(input.source);
  if (!Array.isArray(input.threads) || input.threads.length > 200) {
    throw new Error('Connector 会话快照必须是最多 200 项的数组');
  }
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const normalized = input.threads.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Connector 会话快照项无效');
    }
    const item = value as Record<string, unknown>;
    const status = item.status === 'loaded' ? 'idle' : normalizeStatus(item.status);
    if (status === 'unknown' && item.status !== 'unknown') throw new Error('Connector 会话快照状态无效');
    const threadId = normalizeId(item.threadId, 'Codex Thread ID');
    const activeTurnId = status === 'active' && item.activeTurnId != null
      ? normalizeId(item.activeTurnId, 'Codex Turn ID')
      : null;
    const hasActiveTurnId = status !== 'active'
      || Object.prototype.hasOwnProperty.call(item, 'activeTurnId');
    return Object.freeze({
      threadId,
      title: normalizeOptionalTitle(item.title),
      status,
      activeFlags: normalizeActiveFlags(item.activeFlags),
      activeTurnId,
      hasActiveTurnId,
      activeAt: normalizeOptionalTimestamp(item.updatedAt),
    });
  });
  const threadIds = new Set(normalized.map((thread) => thread.threadId));
  const controlState: LocalConnectorThreadControlState = source === 'codex_desktop'
    ? 'external_owner'
    : 'available';
  let released = 0;

  await db.transaction(async (tx: DbExecutor) => {
    for (const thread of normalized) {
      if (source === 'connector_app_server') {
        const current = await tx.select().from(schema.localConnectorThreads).where(and(
          eq(schema.localConnectorThreads.deviceId, deviceId),
          eq(schema.localConnectorThreads.threadId, thread.threadId),
        )).get();
        if (current?.observationSource === 'codex_desktop' && current.controlState === 'external_owner') {
          continue;
        }
      }
      await upsertLocalConnectorThreadEvent(tx, {
        deviceId,
        event: {
          kind: 'thread_status',
          threadId: thread.threadId,
          title: thread.title,
          ...(thread.hasActiveTurnId ? { turnId: thread.activeTurnId } : {}),
          status: thread.status,
          activeFlags: thread.activeFlags,
          observationSource: source,
          controlState,
          activeAt: thread.activeAt,
        },
        now,
      });
    }

    const previous = await tx.select().from(schema.localConnectorThreads).where(and(
      eq(schema.localConnectorThreads.deviceId, deviceId),
      eq(schema.localConnectorThreads.observationSource, source),
    )).all();
    for (const row of previous) {
      if (threadIds.has(row.threadId)) continue;
      if (row.threadStatus === 'not_loaded'
        && row.controlState === 'available'
        && row.activeTurnId === null
        && row.activeFlags === '[]') {
        continue;
      }
      await tx.update(schema.localConnectorThreads).set({
        threadStatus: 'not_loaded',
        activeFlags: '[]',
        activeTurnId: null,
        controlState: 'available',
        lastEventKind: source === 'codex_desktop'
          ? 'external_owner_released'
          : 'connector_snapshot_released',
        lastSeenAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).where(eq(schema.localConnectorThreads.id, row.id)).run();
      released += 1;
    }
  });

  return { observed: normalized.length, released };
}

function field(message: string, name: string): string | null {
  const matched = message.match(new RegExp(`(?:^|\\s)${name}=([a-zA-Z0-9._:-]{1,256})(?:\\s|$)`));
  return matched?.[1] || null;
}

export function parseObservedAppServerEvent(input: {
  title: string;
  message: string;
}): LocalConnectorThreadEvent | null {
  if (!input.title.startsWith('Codex App Server: ')) return null;
  const method = input.title.slice('Codex App Server: '.length).trim();
  const threadId = field(input.message, 'thread');
  if (!threadId) return null;
  const turnId = field(input.message, 'turn');
  const status = field(input.message, 'status');

  if (method === 'thread/started') return { kind: 'thread_started', threadId, status };
  if (method === 'thread/status/changed') return { kind: 'thread_status', threadId, status };
  if (method === 'turn/started') return { kind: 'turn_started', threadId, turnId };
  if (method === 'turn/completed') return { kind: 'turn_completed', threadId, turnId, status };
  if (method === 'error') return { kind: 'error', threadId, turnId, status };
  return { kind: 'lifecycle', threadId, turnId, status };
}

export async function listLocalConnectorThreads(input: {
  deviceId?: unknown;
  limit?: unknown;
} = {}): Promise<LocalConnectorThreadPublic[]> {
  const deviceId = input.deviceId == null || input.deviceId === ''
    ? null
    : normalizeId(input.deviceId, 'Connector 设备 ID', 128);
  const parsedLimit = Math.trunc(Number(input.limit));
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(500, parsedLimit)
    : 100;
  const query = db.select().from(schema.localConnectorThreads);
  const rows = deviceId
    ? await query.where(eq(schema.localConnectorThreads.deviceId, deviceId))
      .orderBy(desc(schema.localConnectorThreads.lastActiveAt), desc(schema.localConnectorThreads.lastSeenAt)).limit(limit).all()
    : await query.orderBy(desc(schema.localConnectorThreads.lastActiveAt), desc(schema.localConnectorThreads.lastSeenAt)).limit(limit).all();
  const devices = await db.select().from(schema.localConnectorDevices).all() as Array<
    typeof schema.localConnectorDevices.$inferSelect
  >;
  const deviceMap = new Map(devices.map((device) => [device.id, device]));

  return rows.flatMap((row) => {
    const device = deviceMap.get(row.deviceId);
    if (!device) return [];
    return [publicThread(row, device)];
  });
}

export async function getLocalConnectorThread(input: {
  deviceId: unknown;
  threadId: unknown;
}): Promise<LocalConnectorThreadPublic | null> {
  const deviceId = normalizeId(input.deviceId, 'Connector 设备 ID', 128);
  const threadId = normalizeId(input.threadId, 'Codex Thread ID');
  const row = await db.select().from(schema.localConnectorThreads).where(and(
    eq(schema.localConnectorThreads.deviceId, deviceId),
    eq(schema.localConnectorThreads.threadId, threadId),
  )).get();
  if (!row) return null;
  const device = await db.select().from(schema.localConnectorDevices)
    .where(eq(schema.localConnectorDevices.id, deviceId))
    .get();
  return device ? publicThread(row, device) : null;
}
