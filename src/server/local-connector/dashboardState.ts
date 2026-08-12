import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  AppServerThreadSnapshot,
  NormalizedAppServerControlEvent,
} from './appServerControl.js';
import type { NormalizedAppServerEvent } from './appServerObserver.js';
import type { CodexDesktopSessionSnapshot } from './codexDesktopObserver.js';

export type ConnectorDashboardEventLevel = 'info' | 'warning' | 'error';
export type ConnectorThreadSnapshotSyncStatus = 'unknown' | 'supported' | 'unsupported' | 'error';

export type ConnectorDashboardEvent = Readonly<{
  id: number;
  kind: 'connector' | 'app_server' | 'bridge' | 'interaction' | 'queue';
  level: ConnectorDashboardEventLevel;
  title: string;
  detail: string;
  threadId: string | null;
  occurredAt: string;
}>;

export type ConnectorDashboardSession = Readonly<{
  threadId: string;
  title: string;
  cwd: string | null;
  status: 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
  source: 'connector_app_server' | 'codex_desktop';
  controlState: 'available' | 'external_owner';
  activeFlags: readonly ('waitingOnApproval' | 'waitingOnUserInput')[];
  activeTurnId: string | null;
  lastTurnStatus: 'completed' | 'interrupted' | 'failed' | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string;
}>;

export type ConnectorDashboardInteraction = Readonly<{
  sourceRequestId: string;
  interactionId: string | null;
  method: string;
  kind: string;
  threadId: string | null;
  turnId: string | null;
  status: 'publishing' | 'waiting' | 'responding' | 'resolved';
  expiresAt: string | null;
  updatedAt: string;
}>;

export type ConnectorDashboardSnapshot = Readonly<{
  protocol: 'metapi.local-connector.dashboard.v1';
  generatedAt: string;
  connector: Readonly<{
    deviceId: string;
    serverUrl: string;
    dataDir: string;
    pid: number;
    startedAt: string;
    status: 'starting' | 'online' | 'degraded' | 'stopping';
    pollIntervalMs: number;
    lastServerSuccessAt: string | null;
    lastServerErrorAt: string | null;
    lastServerError: string | null;
    consecutiveServerFailures: number;
    activeActionId: string | null;
    activeBridgeTaskId: string | null;
    threadSnapshotSyncStatus: ConnectorThreadSnapshotSyncStatus;
    lastThreadSnapshotSyncAt: string | null;
    lastThreadSnapshotSyncError: string | null;
  }>;
  appServer: Readonly<{
    mode: 'disabled' | 'observe' | 'control';
    status: 'disabled' | 'connecting' | 'connected' | 'error';
    endpoint: string | null;
    lastError: string | null;
  }>;
  summary: Readonly<{
    activeSessions: number;
    waitingInteractions: number;
    queuedDeliveries: number;
  }>;
  sessions: readonly ConnectorDashboardSession[];
  interactions: readonly ConnectorDashboardInteraction[];
  queue: Readonly<{
    events: number;
    results: number;
    bridgeEvents: number;
    bridgeResults: number;
    total: number;
  }>;
  events: readonly ConnectorDashboardEvent[];
}>;

type MutableSession = {
  threadId: string;
  title: string;
  cwd: string | null;
  status: ConnectorDashboardSession['status'];
  activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'>;
  activeTurnId: string | null;
  lastTurnStatus: ConnectorDashboardSession['lastTurnStatus'];
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string;
  externalStatus: 'loaded' | 'active' | null;
  externalActiveTurnId: string | null;
  externalUpdatedAt: string | null;
};

const MAX_EVENTS = 120;
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

function normalizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return Buffer.from(message.replace(/[\r\n]+/g, ' '), 'utf8').subarray(0, 1_000).toString('utf8');
}

function isoNow(): string {
  return new Date().toISOString();
}

function bridgeFailureMessage(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventDetail(event: NormalizedAppServerControlEvent): string {
  if (event.kind === 'thread_status') {
    return event.activeFlags.length > 0
      ? `${event.status} (${event.activeFlags.join(', ')})`
      : event.status;
  }
  if (event.kind === 'turn_started') return `turn ${event.turnId} started`;
  if (event.kind === 'turn_completed') return `turn ${event.turnId} ${event.status}`;
  if (event.kind === 'server_request_resolved') return `request ${event.sourceRequestId} resolved`;
  return bridgeFailureMessage(event.failure.message) || `turn ${event.turnId} failed`;
}

async function countQueueFiles(path: string): Promise<number> {
  try {
    const names = await readdir(path);
    return names.filter((name) => /^[0-9]+-[a-zA-Z0-9-]+\.json$/.test(name)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw error;
  }
}

export class LocalConnectorDashboardState {
  private readonly startedAt = isoNow();
  private readonly sessions = new Map<string, MutableSession>();
  private readonly events: ConnectorDashboardEvent[] = [];
  private nextEventId = 1;
  private stopping = false;
  private lastServerSuccessAt: string | null = null;
  private lastServerErrorAt: string | null = null;
  private lastServerError: string | null = null;
  private consecutiveServerFailures = 0;
  private activeActionId: string | null = null;
  private activeBridgeTaskId: string | null = null;
  private threadSnapshotSyncStatus: ConnectorThreadSnapshotSyncStatus = 'unknown';
  private lastThreadSnapshotSyncAt: string | null = null;
  private lastThreadSnapshotSyncError: string | null = null;
  private appServerMode: ConnectorDashboardSnapshot['appServer']['mode'] = 'disabled';
  private appServerStatus: ConnectorDashboardSnapshot['appServer']['status'] = 'disabled';
  private appServerEndpoint: string | null = null;
  private appServerError: string | null = null;
  private desktopObserverError: string | null = null;

  constructor(private readonly input: {
    deviceId: string;
    serverUrl: string;
    dataDir: string;
    pollIntervalMs: number;
  }) {
    this.recordEvent('connector', 'info', 'Connector starting', `device ${input.deviceId}`, null);
  }

  configureAppServer(input: {
    mode: ConnectorDashboardSnapshot['appServer']['mode'];
    endpoint: string | null;
  }): void {
    this.appServerMode = input.mode;
    this.appServerEndpoint = input.endpoint;
    this.appServerStatus = input.mode === 'disabled' ? 'disabled' : 'connecting';
    this.appServerError = null;
  }

  markAppServerConnected(): void {
    const changed = this.appServerStatus !== 'connected';
    this.appServerStatus = 'connected';
    this.appServerError = null;
    if (changed) {
      this.recordEvent('app_server', 'info', 'App Server connected', this.appServerEndpoint || 'owned process', null);
    }
  }

  markAppServerError(error: unknown): void {
    const message = normalizedError(error);
    const changed = this.appServerStatus !== 'error' || this.appServerError !== message;
    this.appServerStatus = 'error';
    this.appServerError = message;
    if (changed) this.recordEvent('app_server', 'error', 'App Server connection error', message, null);
  }

  recordAppServerThreadError(threadId: string, error: unknown): void {
    this.recordEvent(
      'app_server',
      'warning',
      'App Server thread reconciliation error',
      normalizedError(error),
      threadId,
    );
  }

  markServerSuccess(): void {
    const recovered = this.consecutiveServerFailures > 0;
    this.lastServerSuccessAt = isoNow();
    this.lastServerErrorAt = null;
    this.lastServerError = null;
    this.consecutiveServerFailures = 0;
    if (recovered) this.recordEvent('connector', 'info', 'Metapi connection restored', this.input.serverUrl, null);
  }

  markServerError(error: unknown): void {
    const firstFailure = this.consecutiveServerFailures === 0;
    this.consecutiveServerFailures += 1;
    this.lastServerErrorAt = isoNow();
    this.lastServerError = normalizedError(error);
    if (firstFailure) {
      this.recordEvent('connector', 'warning', 'Metapi connection interrupted', this.lastServerError, null);
    }
  }

  setActiveAction(actionId: string | null): void {
    this.activeActionId = actionId;
    if (actionId) this.recordEvent('connector', 'info', 'Connector action claimed', actionId, null);
  }

  setActiveBridgeTask(taskId: string | null): void {
    this.activeBridgeTaskId = taskId;
    if (taskId) this.recordEvent('bridge', 'info', 'Bridge continuation claimed', taskId, null);
  }

  markThreadSnapshotSyncSupported(): void {
    const changed = this.threadSnapshotSyncStatus !== 'supported';
    this.threadSnapshotSyncStatus = 'supported';
    this.lastThreadSnapshotSyncAt = isoNow();
    this.lastThreadSnapshotSyncError = null;
    if (changed) {
      this.recordEvent('connector', 'info', 'Session ownership sync enabled', 'Metapi accepted thread snapshots', null);
    }
  }

  markThreadSnapshotSyncUnsupported(): void {
    const changed = this.threadSnapshotSyncStatus !== 'unsupported';
    this.threadSnapshotSyncStatus = 'unsupported';
    this.lastThreadSnapshotSyncAt = isoNow();
    this.lastThreadSnapshotSyncError = '线上服务尚未部署 session snapshot 接口';
    if (changed) {
      this.recordEvent('connector', 'warning', 'Session ownership sync unavailable', this.lastThreadSnapshotSyncError, null);
    }
  }

  markThreadSnapshotSyncError(error: unknown): void {
    const message = normalizedError(error);
    const changed = this.threadSnapshotSyncStatus !== 'error' || this.lastThreadSnapshotSyncError !== message;
    this.threadSnapshotSyncStatus = 'error';
    this.lastThreadSnapshotSyncAt = isoNow();
    this.lastThreadSnapshotSyncError = message;
    if (changed) this.recordEvent('connector', 'warning', 'Session ownership sync error', message, null);
  }

  syncThreads(threads: readonly AppServerThreadSnapshot[]): void {
    for (const thread of threads) {
      const existing = this.sessions.get(thread.threadId);
      const threadUpdatedAt = thread.updatedAt || null;
      const existingUpdatedAt = existing?.updatedAt || null;
      const updatedAt = threadUpdatedAt && existingUpdatedAt
        ? (Date.parse(threadUpdatedAt) >= Date.parse(existingUpdatedAt) ? threadUpdatedAt : existingUpdatedAt)
        : threadUpdatedAt || existingUpdatedAt || isoNow();
      const keepLiveStatus = thread.status === 'unknown' && existing;
      this.sessions.set(thread.threadId, {
        threadId: thread.threadId,
        title: thread.title || existing?.title || `Codex ${thread.threadId.slice(0, 8)}`,
        cwd: thread.cwd || existing?.cwd || null,
        status: keepLiveStatus ? existing.status : thread.status,
        activeFlags: keepLiveStatus ? [...existing.activeFlags] : [...thread.activeFlags],
        activeTurnId: existing?.activeTurnId || null,
        lastTurnStatus: existing?.lastTurnStatus || null,
        lastError: existing?.lastError || null,
        createdAt: thread.createdAt || existing?.createdAt || null,
        updatedAt,
        externalStatus: existing?.externalStatus || null,
        externalActiveTurnId: existing?.externalActiveTurnId || null,
        externalUpdatedAt: existing?.externalUpdatedAt || null,
      });
    }
    this.pruneSessions();
  }

  syncDesktopSessions(threads: readonly CodexDesktopSessionSnapshot[]): void {
    this.desktopObserverError = null;
    const nextThreadIds = new Set(threads.map((thread) => thread.threadId));
    for (const session of this.sessions.values()) {
      if (!session.externalStatus || nextThreadIds.has(session.threadId)) continue;
      session.externalStatus = null;
      session.externalActiveTurnId = null;
      session.externalUpdatedAt = null;
      this.recordEvent(
        'app_server',
        'info',
        'Codex Desktop session released',
        'writer lock released',
        session.threadId,
      );
    }
    for (const thread of threads) {
      const existing = this.sessions.get(thread.threadId) || this.newSession(thread.threadId, thread.updatedAt);
      const previousStatus = existing.externalStatus;
      const previousTurnId = existing.externalActiveTurnId;
      existing.externalStatus = thread.status;
      existing.externalActiveTurnId = thread.activeTurnId;
      existing.externalUpdatedAt = thread.updatedAt;
      this.sessions.set(thread.threadId, existing);
      if (previousStatus !== thread.status || previousTurnId !== thread.activeTurnId) {
        this.recordEvent(
          'app_server',
          'info',
          thread.status === 'active' ? 'Codex Desktop turn running' : 'Codex Desktop session loaded',
          thread.activeTurnId ? `turn ${thread.activeTurnId}` : 'external App Server owner',
          thread.threadId,
        );
      }
    }
    this.pruneSessions();
  }

  recordDesktopObserverError(error: unknown): void {
    const message = normalizedError(error);
    if (this.desktopObserverError === message) return;
    this.desktopObserverError = message;
    this.recordEvent(
      'app_server',
      'warning',
      'Codex Desktop observer error',
      message,
      null,
    );
  }

  recordControlEvent(event: NormalizedAppServerControlEvent): void {
    const now = isoNow();
    const existing = this.sessions.get(event.threadId) || this.newSession(event.threadId, now);
    if (event.kind === 'thread_status') {
      existing.status = event.status;
      existing.activeFlags = [...event.activeFlags];
      if (event.status !== 'active') existing.activeTurnId = null;
    } else if (event.kind === 'turn_started') {
      existing.status = 'active';
      existing.activeFlags = [];
      existing.activeTurnId = event.turnId;
      existing.lastTurnStatus = null;
      existing.lastError = null;
    } else if (event.kind === 'turn_completed') {
      existing.status = 'idle';
      existing.activeFlags = [];
      existing.activeTurnId = null;
      existing.lastTurnStatus = event.status;
      existing.lastError = bridgeFailureMessage(event.failure?.message);
    } else if (event.kind === 'error') {
      existing.status = 'system_error';
      existing.lastError = bridgeFailureMessage(event.failure.message) || 'Codex App Server error';
    }
    existing.updatedAt = now;
    this.sessions.set(event.threadId, existing);
    this.recordEvent(
      event.kind === 'server_request_resolved' ? 'interaction' : 'app_server',
      event.kind === 'error' || (event.kind === 'turn_completed' && event.status === 'failed') ? 'error' : 'info',
      event.kind.replaceAll('_', ' '),
      eventDetail(event),
      event.threadId,
    );
  }

  recordObservedEvent(event: NormalizedAppServerEvent): void {
    const threadId = /(?:^|\s)thread=([a-zA-Z0-9._:-]+)/.exec(event.message)?.[1] || null;
    const turnId = /(?:^|\s)turn=([a-zA-Z0-9._:-]+)/.exec(event.message)?.[1] || null;
    const status = /(?:^|\s)status=([a-zA-Z0-9._:-]+)/.exec(event.message)?.[1] || null;
    const now = isoNow();
    if (threadId) {
      const session = this.sessions.get(threadId) || this.newSession(threadId, now);
      if (event.title.endsWith('turn/started')) {
        session.status = 'active';
        session.activeTurnId = turnId;
      } else if (event.title.endsWith('turn/completed')) {
        session.status = 'idle';
        session.activeTurnId = null;
        session.lastTurnStatus = status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed';
      } else if (event.title.endsWith('thread/status/changed')) {
        session.status = status === 'active' || status === 'idle' || status === 'system_error'
          ? status
          : session.status;
      }
      session.updatedAt = now;
      this.sessions.set(threadId, session);
    }
    this.recordEvent('app_server', event.level, event.title, event.message, threadId);
  }

  recordInteractionChange(title: string, detail: string, threadId: string | null): void {
    this.recordEvent('interaction', 'info', title, detail, threadId);
  }

  markStopping(): void {
    this.stopping = true;
    this.recordEvent('connector', 'info', 'Connector stopping', `pid ${process.pid}`, null);
  }

  async snapshot(
    interactions: readonly ConnectorDashboardInteraction[] = [],
  ): Promise<ConnectorDashboardSnapshot> {
    const dataDir = resolve(this.input.dataDir);
    const [events, results, bridgeEvents, bridgeResults] = await Promise.all([
      countQueueFiles(join(dataDir, 'events')),
      countQueueFiles(join(dataDir, 'results')),
      countQueueFiles(join(dataDir, 'bridge-events')),
      countQueueFiles(join(dataDir, 'bridge-results')),
    ]);
    const queueTotal = events + results + bridgeEvents + bridgeResults;
    const sessions = [...this.sessions.values()]
      .map((session): ConnectorDashboardSession => {
        const externalOwner = Boolean(session.externalStatus)
          && session.status !== 'active'
          && session.status !== 'idle';
        const status = externalOwner
          ? session.externalStatus === 'active' ? 'active' : 'idle'
          : session.status;
        const updatedAt = externalOwner && session.externalUpdatedAt
          && Date.parse(session.externalUpdatedAt) > Date.parse(session.updatedAt)
          ? session.externalUpdatedAt
          : session.updatedAt;
        return Object.freeze({
          threadId: session.threadId,
          title: session.title,
          cwd: session.cwd,
          status,
          source: externalOwner ? 'codex_desktop' : 'connector_app_server',
          controlState: externalOwner ? 'external_owner' : 'available',
          activeFlags: Object.freeze(externalOwner ? [] : [...session.activeFlags]),
          activeTurnId: externalOwner ? session.externalActiveTurnId : session.activeTurnId,
          lastTurnStatus: session.lastTurnStatus,
          lastError: session.lastError,
          createdAt: session.createdAt,
          updatedAt,
        });
      })
      .sort((left, right) => {
        const activeDelta = Number(right.status === 'active') - Number(left.status === 'active');
        return activeDelta || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      });
    const waitingInteractions = interactions.filter((item) => item.status !== 'resolved').length;
    const status: ConnectorDashboardSnapshot['connector']['status'] = this.stopping
      ? 'stopping'
      : this.consecutiveServerFailures > 0 || this.appServerStatus === 'error'
        ? 'degraded'
        : this.lastServerSuccessAt
          ? 'online'
          : 'starting';
    return Object.freeze({
      protocol: 'metapi.local-connector.dashboard.v1',
      generatedAt: isoNow(),
      connector: Object.freeze({
        deviceId: this.input.deviceId,
        serverUrl: this.input.serverUrl,
        dataDir,
        pid: process.pid,
        startedAt: this.startedAt,
        status,
        pollIntervalMs: this.input.pollIntervalMs,
        lastServerSuccessAt: this.lastServerSuccessAt,
        lastServerErrorAt: this.lastServerErrorAt,
        lastServerError: this.lastServerError,
        consecutiveServerFailures: this.consecutiveServerFailures,
        activeActionId: this.activeActionId,
        activeBridgeTaskId: this.activeBridgeTaskId,
        threadSnapshotSyncStatus: this.threadSnapshotSyncStatus,
        lastThreadSnapshotSyncAt: this.lastThreadSnapshotSyncAt,
        lastThreadSnapshotSyncError: this.lastThreadSnapshotSyncError,
      }),
      appServer: Object.freeze({
        mode: this.appServerMode,
        status: this.appServerStatus,
        endpoint: this.appServerEndpoint,
        lastError: this.appServerError,
      }),
      summary: Object.freeze({
        activeSessions: sessions.filter((session) => session.status === 'active').length,
        waitingInteractions,
        queuedDeliveries: queueTotal,
      }),
      sessions: Object.freeze(sessions),
      interactions: Object.freeze(interactions.map((item) => Object.freeze({ ...item }))),
      queue: Object.freeze({
        events,
        results,
        bridgeEvents,
        bridgeResults,
        total: queueTotal,
      }),
      events: Object.freeze(this.events.map((event) => Object.freeze({ ...event }))),
    });
  }

  private newSession(threadId: string, now: string): MutableSession {
    return {
      threadId,
      title: `Codex ${threadId.slice(0, 8)}`,
      cwd: null,
      status: 'unknown',
      activeFlags: [],
      activeTurnId: null,
      lastTurnStatus: null,
      lastError: null,
      createdAt: null,
      updatedAt: now,
      externalStatus: null,
      externalActiveTurnId: null,
      externalUpdatedAt: null,
    };
  }

  private pruneSessions(): void {
    const cutoff = Date.now() - SESSION_RETENTION_MS;
    for (const [threadId, session] of this.sessions) {
      const updatedAt = session.externalUpdatedAt && Date.parse(session.externalUpdatedAt) > Date.parse(session.updatedAt)
        ? session.externalUpdatedAt
        : session.updatedAt;
      if (session.status !== 'active' && session.externalStatus !== 'active' && Date.parse(updatedAt) < cutoff) {
        this.sessions.delete(threadId);
      }
    }
  }

  private recordEvent(
    kind: ConnectorDashboardEvent['kind'],
    level: ConnectorDashboardEventLevel,
    title: string,
    detail: string,
    threadId: string | null,
  ): void {
    this.events.unshift(Object.freeze({
      id: this.nextEventId++,
      kind,
      level,
      title: title.slice(0, 160),
      detail: detail.slice(0, 1_000),
      threadId,
      occurredAt: isoNow(),
    }));
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
  }
}
