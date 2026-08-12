import { randomUUID } from 'node:crypto';
import { executeLocalConnectorAction, type LocalConnectorLaunchCommand } from './actionDriver.js';
import {
  resolveCodexAppServerEndpoint,
  startCodexAppServerObserver,
} from './appServerObserver.js';
import {
  bridgeFailureFromResponseError,
  CodexAppServerControlClient,
  CodexAppServerResponseError,
  type AppServerThreadSnapshot,
  type AppServerTurnCompletionSnapshot,
} from './appServerControl.js';
import { AppServerInteractionBridge } from './appServerInteractionBridge.js';
import { LocalConnectorClient, LocalConnectorHttpError, retryDelayForConnectorError } from './client.js';
import type { LocalConnectorConfig } from './config.js';
import { startLocalConnectorDashboardServer, type LocalConnectorDashboardServer } from './dashboardServer.js';
import {
  clearLocalConnectorDashboardDiscovery,
  writeLocalConnectorDashboardDiscovery,
} from './dashboardDiscovery.js';
import { LocalConnectorDashboardState } from './dashboardState.js';
import {
  CodexDesktopSessionObserver,
  type CodexDesktopSessionSnapshot,
} from './codexDesktopObserver.js';
import { buildTurnCompletionNotification } from './completionNotification.js';
import {
  readLocalConnectorThreadTitle,
  rememberLocalConnectorThreadMetadata,
} from './threadMetadata.js';
import { acquireConnectorRuntimeState } from './runtimeState.js';
import { CONNECTOR_VERSION, LOCAL_CONNECTOR_CAPABILITIES } from './identity.js';
import {
  enqueueBridgeAppServerEvent,
  enqueueBridgeContinuationResult,
  enqueueLocalConnectorEvent,
  enqueueLocalConnectorResult,
  flushLocalConnectorQueues,
} from './queue.js';

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Connector action failed');
  return Buffer.from(message.replace(/[\r\n]+/g, ' '), 'utf8').subarray(0, 2_000).toString('utf8');
}

function isEphemeralThreadReadError(error: unknown): boolean {
  return /ephemeral threads? do not support (?:includeTurns|turns?)/i.test(errorMessage(error));
}

export function selectExternallyOwnedDesktopThreads(
  controlThreadStatuses: ReadonlyMap<string, AppServerThreadSnapshot['status']>,
  threads: readonly CodexDesktopSessionSnapshot[],
): readonly CodexDesktopSessionSnapshot[] {
  return threads.filter((thread) => {
    const controlStatus = controlThreadStatuses.get(thread.threadId);
    return controlStatus !== 'active' && controlStatus !== 'idle';
  });
}

export function collectNewDesktopCompletions(
  watermarks: Map<string, string>,
  threads: readonly CodexDesktopSessionSnapshot[],
  startedAtMs: number,
): ReadonlyArray<Readonly<{ threadId: string; turnId: string }>> {
  const completed: Array<Readonly<{ threadId: string; turnId: string }>> = [];
  for (const thread of threads) {
    if (thread.lastTurnStatus !== 'completed' || !thread.lastTurnId) continue;
    const previousTurnId = watermarks.get(thread.threadId);
    watermarks.set(thread.threadId, thread.lastTurnId);
    if (previousTurnId === thread.lastTurnId) continue;
    const completedAtMs = thread.lastTurnAt ? Date.parse(thread.lastTurnAt) : Number.NaN;
    if (previousTurnId === undefined
      && (!Number.isFinite(completedAtMs) || completedAtMs < startedAtMs)) {
      continue;
    }
    completed.push(Object.freeze({ threadId: thread.threadId, turnId: thread.lastTurnId }));
  }
  return Object.freeze(completed);
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    let timeout: NodeJS.Timeout;
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      done();
    };
    timeout = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class LocalConnectorRuntime {
  private readonly client: LocalConnectorClient;
  private readonly dashboardState: LocalConnectorDashboardState;
  private readonly controlThreadStatuses = new Map<string, AppServerThreadSnapshot['status']>();
  private readonly controlThreadEphemeral = new Map<string, boolean>();
  private readonly controlThreadTitles = new Map<string, string>();
  private readonly ephemeralActiveCompletions = new Map<string, { completionId: string }>();
  private readonly ephemeralCompletionTimers = new Map<string, NodeJS.Timeout>();
  private readonly controlTerminalNotificationAt = new Map<string, number>();
  private readonly controlTerminalCompletionsHandled = new Set<string>();
  private readonly controlCompletionWatermarks = new Map<string, string>();
  private readonly controlCompletionBaselineReads = new Map<string, Promise<void>>();
  private readonly controlCompletionReconciliations = new Map<string, Promise<void>>();
  private readonly desktopCompletionWatermarks = new Map<string, string>();
  private readonly startedAtMs = Date.now();
  private activeBridgeTaskId: string | null = null;

  constructor(
    private readonly config: LocalConnectorConfig,
    private readonly configPath: string,
    private readonly launch: LocalConnectorLaunchCommand,
    client?: LocalConnectorClient,
    private readonly actionExecutor: typeof executeLocalConnectorAction = executeLocalConnectorAction,
  ) {
    this.client = client || new LocalConnectorClient(config.serverUrl, config.connectorToken);
    this.dashboardState = new LocalConnectorDashboardState({
      deviceId: config.deviceId,
      serverUrl: config.serverUrl,
      dataDir: config.dataDir,
      pollIntervalMs: config.pollIntervalMs,
    });
  }

  async flushQueues(): Promise<{
    events: number;
    results: number;
    bridgeEvents: number;
    bridgeResults: number;
  }> {
    return flushLocalConnectorQueues({
      dataDir: this.config.dataDir,
      sendEvent: (event) => this.client.emitEvent(event),
      sendResult: (result) => this.client.completeAction(result),
      sendBridgeResult: (result) => this.client.completeBridgeContinuation(result),
      sendBridgeEvent: (event) => this.client.emitBridgeAppServerEvent(
        event.event,
        event.taskId,
        event.deliveryId,
      ),
    });
  }

  async runOnce(signal?: AbortSignal): Promise<{ actionId: string | null; flushedEvents: number; flushedResults: number }> {
    const flushed = await this.flushQueues();
    const action = await this.client.claimNextAction(signal);
    if (!action) return { actionId: null, flushedEvents: flushed.events, flushedResults: flushed.results };
    if (action.status !== 'claimed'
      || action.id !== action.manifest.actionId
      || action.kind !== action.manifest.kind
      || action.operation !== action.manifest.operation) {
      throw new Error('Connector 动作与清单不一致，拒绝执行');
    }

    this.dashboardState.setActiveAction(action.id);
    try {
      const execution = await this.actionExecutor(action.manifest, {
        dataDir: this.config.dataDir,
        backupKey: this.config.backupKey,
        configPath: this.configPath,
        launch: this.launch,
      });
      await enqueueLocalConnectorResult(this.config.dataDir, {
        actionId: action.id,
        status: 'succeeded',
        result: {
          changed: execution.changed,
          target: execution.target,
          operation: execution.operation,
          ...execution.details,
        },
        backupRef: execution.backupRef,
        errorMessage: null,
      });
    } catch (error) {
      await enqueueLocalConnectorResult(this.config.dataDir, {
        actionId: action.id,
        status: 'failed',
        result: null,
        backupRef: action.manifest.backupRef,
        errorMessage: errorMessage(error),
      });
    } finally {
      this.dashboardState.setActiveAction(null);
    }
    await this.flushQueues();
    return { actionId: action.id, flushedEvents: flushed.events, flushedResults: flushed.results };
  }

  async runBridgeOnce(
    controlClient: CodexAppServerControlClient,
    signal?: AbortSignal,
  ): Promise<{ taskId: string | null; outcome: 'accepted' | 'rejected' | 'unknown' | null }> {
    const command = await this.client.claimNextBridgeContinuation(signal);
    if (!command) return { taskId: null, outcome: null };
    const remainingLeaseMs = Math.max(1_000, Date.parse(command.leaseExpiresAt) - Date.now());
    const heartbeatMs = Math.max(1_000, Math.min(10_000, Math.trunc(remainingLeaseMs / 3)));
    const heartbeat = setInterval(() => {
      void this.client.renewBridgeContinuationLease({
        taskId: command.taskId,
        leaseToken: command.leaseToken,
      }).catch(() => undefined);
    }, heartbeatMs);
    heartbeat.unref?.();

    let outcome: 'accepted' | 'rejected' | 'unknown';
    let turnId: string | null = null;
    let failure: Record<string, unknown> | null = null;
    this.activeBridgeTaskId = command.taskId;
    this.dashboardState.setActiveBridgeTask(command.taskId);
    try {
      const result = await controlClient.continueThread({
        taskId: command.taskId,
        method: command.method,
        threadId: command.threadId,
        expectedTurnId: command.expectedTurnId,
        prompt: command.prompt,
        routeAction: command.routeAction,
        continuationNumber: command.continuationNumber,
      });
      outcome = 'accepted';
      turnId = result.turnId;
    } catch (error) {
      if (error instanceof CodexAppServerResponseError) {
        outcome = 'rejected';
        failure = bridgeFailureFromResponseError(error) as Record<string, unknown>;
      } else {
        outcome = 'unknown';
      }
    } finally {
      clearInterval(heartbeat);
      this.activeBridgeTaskId = null;
      this.dashboardState.setActiveBridgeTask(null);
    }
    await enqueueBridgeContinuationResult({
      dataDir: this.config.dataDir,
      taskId: command.taskId,
      leaseToken: command.leaseToken,
      outcome,
      turnId,
      failure,
    });
    await this.flushQueues();
    return { taskId: command.taskId, outcome };
  }

  private async enqueueControlCompletion(turn: AppServerTurnCompletionSnapshot): Promise<boolean> {
    if (this.controlCompletionWatermarks.get(turn.threadId) === turn.turnId) return false;
    this.controlCompletionWatermarks.set(turn.threadId, turn.turnId);
    try {
      const threadTitle = this.controlThreadTitles.get(turn.threadId)
        || await readLocalConnectorThreadTitle(this.config.dataDir, turn.threadId);
      const notification = buildTurnCompletionNotification({
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: turn.status,
        threadTitle,
        assistantMessage: turn.assistantMessage,
        failureMessage: typeof turn.failure?.message === 'string' ? turn.failure.message : null,
      });
      await enqueueLocalConnectorEvent({
        dataDir: this.config.dataDir,
        kind: 'notify',
        ...notification,
      });
      return true;
    } catch (error) {
      if (this.controlCompletionWatermarks.get(turn.threadId) === turn.turnId) {
        this.controlCompletionWatermarks.delete(turn.threadId);
      }
      throw error;
    }
  }

  private async primeControlCompletionWatermark(
    controlClient: CodexAppServerControlClient,
    threadId: string,
  ): Promise<void> {
    if (this.controlCompletionWatermarks.has(threadId)) return;
    const existing = this.controlCompletionBaselineReads.get(threadId);
    if (existing) return existing;
    const reading = (async () => {
      const latest = await controlClient.readLatestCompletedTurn(threadId);
      if (latest && !this.controlCompletionWatermarks.has(threadId)) {
        this.controlCompletionWatermarks.set(threadId, latest.turnId);
      }
    })().finally(() => {
      this.controlCompletionBaselineReads.delete(threadId);
    });
    this.controlCompletionBaselineReads.set(threadId, reading);
    return reading;
  }

  private async reconcileControlCompletion(
    controlClient: CodexAppServerControlClient,
    threadId: string,
  ): Promise<void> {
    const existing = this.controlCompletionReconciliations.get(threadId);
    if (existing) return existing;
    const reconciling = (async () => {
      const baseline = this.controlCompletionBaselineReads.get(threadId);
      if (baseline) await baseline;
      const retryDelaysMs = [0, 150, 500, 1_250] as const;
      for (const delayMs of retryDelaysMs) {
        if (delayMs > 0) await wait(delayMs);
        const latest = await controlClient.readLatestCompletedTurn(threadId);
        if (!latest || this.controlCompletionWatermarks.get(threadId) === latest.turnId) continue;
        await this.enqueueControlCompletion(latest);
        return;
      }
    })().finally(() => {
      this.controlCompletionReconciliations.delete(threadId);
    });
    this.controlCompletionReconciliations.set(threadId, reconciling);
    return reconciling;
  }

  private scheduleEphemeralCompletion(
    threadId: string,
    status: 'completed' | 'failed',
  ): void {
    const existing = this.ephemeralCompletionTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.ephemeralCompletionTimers.delete(threadId);
      const expectedThreadStatus = status === 'completed' ? 'idle' : 'system_error';
      if (this.controlThreadStatuses.get(threadId) !== expectedThreadStatus) return;
      const active = this.ephemeralActiveCompletions.get(threadId);
      if (!active) return;
      void this.enqueueControlCompletion({
        threadId,
        turnId: active.completionId,
        status,
        assistantMessage: null,
        failure: status === 'failed'
          ? { source: 'control_error', message: 'Codex App Server reported a thread system error', willRetry: false }
          : null,
      }).then(() => {
        this.controlTerminalCompletionsHandled.add(threadId);
        if (this.ephemeralActiveCompletions.get(threadId) === active) {
          this.ephemeralActiveCompletions.delete(threadId);
        }
      }).catch((error) => {
        this.dashboardState.recordAppServerThreadError(threadId, error);
      });
    }, 300);
    timer.unref?.();
    this.ephemeralCompletionTimers.set(threadId, timer);
  }

  private cancelEphemeralCompletion(threadId: string): void {
    const timer = this.ephemeralCompletionTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.ephemeralCompletionTimers.delete(threadId);
  }

  private trackEphemeralCompletion(threadId: string, activeTurnId: string | null): void {
    this.controlThreadEphemeral.set(threadId, true);
    const existing = this.ephemeralActiveCompletions.get(threadId);
    if (!existing || (activeTurnId && existing.completionId !== activeTurnId)) {
      this.ephemeralActiveCompletions.set(threadId, {
        completionId: activeTurnId || `ephemeral-${randomUUID()}`,
      });
    }
    const currentStatus = this.controlThreadStatuses.get(threadId);
    if (currentStatus === 'active') {
      this.cancelEphemeralCompletion(threadId);
    } else if (currentStatus === 'idle' || currentStatus === 'system_error') {
      this.scheduleEphemeralCompletion(
        threadId,
        currentStatus === 'idle' ? 'completed' : 'failed',
      );
    }
  }

  private async updateControlThreadStatus(
    controlClient: CodexAppServerControlClient,
    threadId: string,
    status: AppServerThreadSnapshot['status'],
    activeTurnId: string | null = null,
    source: 'notification' | 'snapshot' = 'notification',
  ): Promise<void> {
    // thread/list can lag behind lifecycle notifications. Do not let a stale
    // active snapshot cancel, suppress, or replay a completion that just ended.
    if (source === 'snapshot' && status === 'active') {
      const terminalAt = this.controlTerminalNotificationAt.get(threadId);
      const staleSnapshotWindowMs = Math.max(15_000, this.config.pollIntervalMs * 3);
      if (terminalAt && Date.now() - terminalAt < staleSnapshotWindowMs) {
        if (this.controlTerminalCompletionsHandled.has(threadId)) return;
        const terminalStatus = this.controlThreadStatuses.get(threadId);
        if (this.controlThreadEphemeral.get(threadId) === true) {
          this.trackEphemeralCompletion(threadId, activeTurnId);
        } else if (terminalStatus === 'idle') {
          try {
            await this.reconcileControlCompletion(controlClient, threadId);
          } catch (error) {
            if (!isEphemeralThreadReadError(error)) throw error;
            this.trackEphemeralCompletion(threadId, activeTurnId);
          }
        }
        return;
      }
      if (terminalAt) {
        this.controlTerminalNotificationAt.delete(threadId);
        this.controlTerminalCompletionsHandled.delete(threadId);
      }
    } else if (source === 'snapshot' && (status === 'idle' || status === 'system_error')) {
      if (!this.ephemeralCompletionTimers.has(threadId)) {
        this.controlTerminalNotificationAt.delete(threadId);
        this.controlTerminalCompletionsHandled.delete(threadId);
      }
    } else if (source === 'notification') {
      if (status === 'active') {
        this.controlTerminalNotificationAt.delete(threadId);
        this.controlTerminalCompletionsHandled.delete(threadId);
      }
      if (status === 'idle' || status === 'system_error') {
        this.controlTerminalNotificationAt.set(threadId, Date.now());
        this.controlTerminalCompletionsHandled.delete(threadId);
      }
    }
    const previousStatus = this.controlThreadStatuses.get(threadId);
    this.controlThreadStatuses.set(threadId, status);
    const isEphemeral = this.controlThreadEphemeral.get(threadId) === true;
    if (status === 'active' && isEphemeral) {
      this.trackEphemeralCompletion(threadId, activeTurnId);
    } else if (status === 'active' && previousStatus !== 'active') {
      try {
        await this.primeControlCompletionWatermark(controlClient, threadId);
      } catch (error) {
        if (!isEphemeralThreadReadError(error)) throw error;
        this.trackEphemeralCompletion(threadId, activeTurnId);
      }
    } else if ((status === 'idle' || status === 'system_error') && previousStatus === 'active') {
      if (isEphemeral) {
        this.scheduleEphemeralCompletion(threadId, status === 'idle' ? 'completed' : 'failed');
      } else {
        try {
          if (status === 'idle') await this.reconcileControlCompletion(controlClient, threadId);
        } catch (error) {
          if (!isEphemeralThreadReadError(error)) throw error;
          this.trackEphemeralCompletion(threadId, activeTurnId);
        }
      }
    }
  }

  private async syncControlThreads(controlClient: CodexAppServerControlClient): Promise<void> {
    const threads = await controlClient.listThreads();
    const visibleThreadIds = new Set(threads.map((thread) => thread.threadId));
    for (const threadId of this.controlThreadStatuses.keys()) {
      if (!visibleThreadIds.has(threadId)) {
        if (this.ephemeralCompletionTimers.has(threadId)) continue;
        this.controlThreadStatuses.delete(threadId);
        this.controlThreadEphemeral.delete(threadId);
        this.controlTerminalNotificationAt.delete(threadId);
        this.controlTerminalCompletionsHandled.delete(threadId);
        this.ephemeralActiveCompletions.delete(threadId);
        this.cancelEphemeralCompletion(threadId);
      }
    }
    for (const thread of threads) {
      if (thread.title.trim()) this.controlThreadTitles.set(thread.threadId, thread.title.trim());
      if (thread.ephemeral === true || !this.controlThreadEphemeral.has(thread.threadId)) {
        this.controlThreadEphemeral.set(thread.threadId, thread.ephemeral === true);
      }
    }
    await Promise.all(threads.map(async (thread) => {
      try {
        await this.updateControlThreadStatus(controlClient, thread.threadId, thread.status, null, 'snapshot');
      } catch (error) {
        this.dashboardState.recordAppServerThreadError(thread.threadId, error);
      }
    }));
    this.dashboardState.syncThreads(threads);
    await rememberLocalConnectorThreadMetadata({ dataDir: this.config.dataDir, threads });
    const synced = await this.client.syncThreadSnapshots('connector_app_server', threads);
    if (synced) this.dashboardState.markThreadSnapshotSyncSupported();
    else this.dashboardState.markThreadSnapshotSyncUnsupported();
    this.dashboardState.markAppServerConnected();
  }

  private externallyOwnedDesktopThreads(
    threads: readonly CodexDesktopSessionSnapshot[],
  ): readonly CodexDesktopSessionSnapshot[] {
    return selectExternallyOwnedDesktopThreads(this.controlThreadStatuses, threads);
  }

  private async syncDesktopThreads(
    threads: readonly CodexDesktopSessionSnapshot[],
  ): Promise<void> {
    const externalThreads = this.externallyOwnedDesktopThreads(threads);
    this.dashboardState.syncDesktopSessions(externalThreads);
    const completed = collectNewDesktopCompletions(
      this.desktopCompletionWatermarks,
      externalThreads,
      this.startedAtMs,
    );
    for (const turn of completed) {
      const threadTitle = this.controlThreadTitles.get(turn.threadId)
        || await readLocalConnectorThreadTitle(this.config.dataDir, turn.threadId);
      const notification = buildTurnCompletionNotification({
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: 'completed',
        threadTitle,
      });
      await enqueueLocalConnectorEvent({
        dataDir: this.config.dataDir,
        kind: 'notify',
        ...notification,
      });
    }
    try {
      const synced = await this.client.syncThreadSnapshots(
        'codex_desktop',
        externalThreads,
      );
      if (synced) this.dashboardState.markThreadSnapshotSyncSupported();
      else this.dashboardState.markThreadSnapshotSyncUnsupported();
    } catch (error) {
      this.dashboardState.markThreadSnapshotSyncError(error);
    }
  }

  async run(input: {
    signal?: AbortSignal;
    observeAppServer?: boolean;
    controlAppServer?: boolean;
    ownedAppServerExecutable?: string | null;
    dashboard?: boolean;
    dashboardHost?: string;
    dashboardPort?: number;
  } = {}): Promise<void> {
    const releaseLock = await acquireConnectorRuntimeState(this.config.dataDir);
    let observer: { close: () => Promise<void> } | null = null;
    let controlClient: CodexAppServerControlClient | null = null;
    let interactionBridge: AppServerInteractionBridge | null = null;
    let dashboard: LocalConnectorDashboardServer | null = null;
    // An owned App Server is a separate writer. Keep observing Desktop locks so
    // the Connector does not attempt to resume a thread that another process owns.
    const desktopObserver = input.controlAppServer && input.ownedAppServerExecutable
      ? new CodexDesktopSessionObserver()
      : input.dashboard !== false && !input.controlAppServer && !input.observeAppServer
        ? new CodexDesktopSessionObserver()
        : null;
    try {
      // The exclusive runtime lock makes it safe to remove discovery left by a
      // crashed or upgraded Connector before publishing this process's endpoint.
      await clearLocalConnectorDashboardDiscovery(this.config.dataDir, null);
      try {
        const heartbeat = await this.client.heartbeat({
          version: CONNECTOR_VERSION,
          capabilities: LOCAL_CONNECTOR_CAPABILITIES,
          signal: input.signal,
        });
        this.dashboardState.markServerSuccess();
        void heartbeat;
      } catch (error) {
        this.dashboardState.markServerError(error);
      }
      const endpoint = input.observeAppServer || input.controlAppServer
        ? resolveCodexAppServerEndpoint(this.config.appServerEndpoint)
        : null;
      this.dashboardState.configureAppServer({
        mode: input.controlAppServer ? 'control' : input.observeAppServer ? 'observe' : 'disabled',
        endpoint,
      });
      if (input.dashboard !== false) {
        dashboard = await startLocalConnectorDashboardServer({
          host: input.dashboardHost,
          port: input.dashboardPort,
          snapshot: () => this.dashboardState.snapshot(interactionBridge?.snapshot() || []),
        });
        await writeLocalConnectorDashboardDiscovery(this.config.dataDir, dashboard);
        for (const url of dashboard.urls) process.stdout.write(`[metapi-connector] Dashboard: ${url}\n`);
      }
      if ((input.observeAppServer || input.controlAppServer) && !endpoint && !input.ownedAppServerExecutable) {
        throw new Error('未找到 Codex App Server control socket；请先启动 codex app-server daemon，或显式配置 endpoint/owned executable');
      }
      if (input.controlAppServer) {
        interactionBridge = new AppServerInteractionBridge(
          this.client,
          undefined,
          this.config.pollIntervalMs,
        );
        controlClient = new CodexAppServerControlClient({
          endpoint,
          ownedExecutable: input.ownedAppServerExecutable,
          onNotification: async (event) => {
            this.dashboardState.recordControlEvent(event);
            if (event.kind === 'server_request_resolved') {
              interactionBridge?.handleNotification(event);
              return;
            }
            try {
              if (event.kind === 'thread_status') {
                await this.updateControlThreadStatus(
                  controlClient!,
                  event.threadId,
                  event.status,
                  event.activeTurnId || null,
                );
              } else if (event.kind === 'turn_started') {
                await this.updateControlThreadStatus(controlClient!, event.threadId, 'active', event.turnId);
              }
              if (event.kind === 'turn_completed') {
                this.cancelEphemeralCompletion(event.threadId);
                this.ephemeralActiveCompletions.delete(event.threadId);
                this.controlTerminalNotificationAt.set(event.threadId, Date.now());
                this.controlTerminalCompletionsHandled.add(event.threadId);
                this.controlThreadStatuses.set(event.threadId, 'idle');
                await this.enqueueControlCompletion({
                  threadId: event.threadId,
                  turnId: event.turnId,
                  status: event.status,
                  assistantMessage: event.assistantMessage,
                  failure: event.failure,
                });
              }
            } catch (error) {
              this.dashboardState.recordAppServerThreadError(event.threadId, error);
            }
            await enqueueBridgeAppServerEvent({
              dataDir: this.config.dataDir,
              taskId: this.activeBridgeTaskId,
              event,
            });
          },
          onServerRequest: async (request, responder) => {
            if (!interactionBridge) {
              responder.reject(new Error('Metapi Interaction Bridge 未初始化'));
              return;
            }
            await interactionBridge.handleRequest(request, responder);
          },
          onError: (error) => {
            this.dashboardState.markAppServerError(error);
            process.stderr.write(`[metapi-connector] App Server control: ${errorMessage(error)}\n`);
          },
        });
        await controlClient.connect();
        this.dashboardState.markAppServerConnected();
        try {
          await this.syncControlThreads(controlClient);
        } catch (error) {
          this.dashboardState.markAppServerError(error);
          this.dashboardState.markThreadSnapshotSyncError(error);
        }
      } else if (input.observeAppServer) {
        observer = await startCodexAppServerObserver({
          endpoint,
          ownedExecutable: input.ownedAppServerExecutable,
          signal: input.signal,
          onEvent: async (event) => {
            this.dashboardState.recordObservedEvent(event);
            await enqueueLocalConnectorEvent({
              dataDir: this.config.dataDir,
              kind: 'app_server',
              ...event,
            });
          },
          onError: (error) => {
            this.dashboardState.markAppServerError(error);
            void enqueueLocalConnectorEvent({
              dataDir: this.config.dataDir,
              kind: 'app_server',
              title: 'Codex App Server observer error',
              message: errorMessage(error),
              level: 'warning',
            });
          },
        });
        this.dashboardState.markAppServerConnected();
      }

      if (desktopObserver) {
        try {
          const threads = await desktopObserver.scan();
          await this.syncDesktopThreads(threads);
        } catch (error) {
          this.dashboardState.recordDesktopObserverError(error);
        }
      }

      let consecutiveFailures = 0;
      let nextThreadRefreshAt = 0;
      let nextDesktopRefreshAt = Date.now() + 5_000;
      while (!input.signal?.aborted) {
        try {
          await this.runOnce(input.signal);
          if (controlClient) await this.runBridgeOnce(controlClient, input.signal);
          if (controlClient && Date.now() >= nextThreadRefreshAt) {
            try {
              await this.syncControlThreads(controlClient);
            } catch (error) {
              this.dashboardState.markAppServerError(error);
              this.dashboardState.markThreadSnapshotSyncError(error);
            }
            nextThreadRefreshAt = Date.now() + 5_000;
          }
          if (desktopObserver && Date.now() >= nextDesktopRefreshAt) {
            try {
              const threads = await desktopObserver.scan();
              await this.syncDesktopThreads(threads);
            } catch (error) {
              this.dashboardState.recordDesktopObserverError(error);
            }
            nextDesktopRefreshAt = Date.now() + 5_000;
          }
          consecutiveFailures = 0;
          this.dashboardState.markServerSuccess();
          await wait(this.config.pollIntervalMs, input.signal);
        } catch (error) {
          this.dashboardState.markServerError(error);
          if (error instanceof LocalConnectorHttpError && error.status === 401) throw error;
          consecutiveFailures += 1;
          const backoff = Math.min(30_000, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 5)));
          await wait(retryDelayForConnectorError(error, backoff), input.signal);
        }
      }
    } finally {
      this.dashboardState.markStopping();
      await observer?.close().catch(() => undefined);
      await interactionBridge?.close().catch(() => undefined);
      await controlClient?.close().catch(() => undefined);
      for (const timer of this.ephemeralCompletionTimers.values()) clearTimeout(timer);
      this.ephemeralCompletionTimers.clear();
      this.ephemeralActiveCompletions.clear();
      this.controlTerminalNotificationAt.clear();
      this.controlTerminalCompletionsHandled.clear();
      await dashboard?.close().catch(() => undefined);
      await clearLocalConnectorDashboardDiscovery(this.config.dataDir).catch(() => undefined);
      await releaseLock();
    }
  }
}
