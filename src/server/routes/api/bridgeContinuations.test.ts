import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');
type ConnectorService = typeof import('../../services/localConnectorService.js');
type BridgeService = typeof import('../../services/bridgeContinuationService.js');

describe('bridge continuation routes', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let connector: ConnectorService;
  let bridge: BridgeService;
  let app: ReturnType<typeof Fastify>;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-bridge-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    connector = await import('../../services/localConnectorService.js');
    bridge = await import('../../services/bridgeContinuationService.js');
    const connectorRoutes = await import('./localConnector.js');
    const bridgeRoutes = await import('./bridgeContinuations.js');
    app = Fastify();
    await app.register(connectorRoutes.localConnectorRoutes);
    await app.register(bridgeRoutes.bridgeContinuationRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function pair(scopes: ConnectorService['LOCAL_CONNECTOR_SCOPES'][number][]) {
    const pairing = await connector.createLocalConnectorPairing({ deviceName: 'MacBook', scopes });
    return connector.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    });
  }

  it('exposes admin task lifecycle and keeps public control scoped to the paired device', async () => {
    const controlled = await pair(['app_server.control']);
    const observerOnly = await pair(['app_server.observe']);
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/bridge-continuations',
      payload: {
        sessionKey: `${controlled.device.id}:thread-a`,
        threadId: 'thread-a',
        deviceId: controlled.device.id,
        policy: {
          enabled: true,
          backoff: { initialDelayMs: 250, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0 },
          rules: { rate_limited: { action: 'continue_same_route', limit: 'unlimited' } },
        },
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const taskId = createdResponse.json().task.state.taskId as string;
    await bridge.recordBridgeContinuationFailure({
      taskId,
      failure: { source: 'turn_completed', httpStatusCode: 429, willRetry: false },
      threadStatus: 'idle',
      turnTerminal: true,
      now: 1_000,
    });

    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/local-connector/public/bridge/commands/next',
      headers: { authorization: `Bearer ${observerOnly.connectorToken}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const claimed = await app.inject({
      method: 'GET',
      url: '/api/local-connector/public/bridge/commands/next',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().command).toMatchObject({
      protocol: 'metapi.bridge-continuation.command.v1',
      taskId,
      method: 'turn/start',
      threadId: 'thread-a',
      routeAction: 'preserve',
    });
    const leaseToken = claimed.json().command.leaseToken as string;

    const started = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/bridge/events',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: { event: { kind: 'turn_started', threadId: 'thread-a', turnId: 'turn-b' } },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().task.state).toMatchObject({
      status: 'waiting',
      reason: 'turn_active',
      continuationCount: 1,
      activeTurnId: 'turn-b',
    });

    const idempotentResult = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/bridge/commands/${taskId}/result`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: { leaseToken, outcome: 'accepted', turnId: 'turn-b' },
    });
    expect(idempotentResult.statusCode).toBe(200);

    const completed = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/bridge/events',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: { event: { kind: 'turn_completed', threadId: 'thread-a', turnId: 'turn-b', status: 'completed' } },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().task.state).toMatchObject({ status: 'stopped', reason: 'turn_completed' });

    const detail = await app.inject({ method: 'GET', url: `/api/bridge-continuations/${taskId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().events.map((event: any) => event.eventType)).toContain('turn_started');
  });

  it('acknowledges replayed Connector results and App Server events exactly once by delivery id', async () => {
    const controlled = await pair(['app_server.control']);
    const created = await bridge.createBridgeContinuationTask({
      sessionKey: `${controlled.device.id}:thread-replay`,
      threadId: 'thread-replay',
      deviceId: controlled.device.id,
      policy: {
        enabled: true,
        backoff: { initialDelayMs: 250, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0 },
        rules: { rate_limited: { action: 'continue_same_route', limit: 'unlimited' } },
      },
      now: Date.now() - 5_000,
    });
    await bridge.recordBridgeContinuationFailure({
      taskId: created.task.state.taskId,
      failure: { source: 'turn_completed', httpStatusCode: 429, willRetry: false },
      threadStatus: 'idle',
      turnTerminal: true,
      now: Date.now() - 4_000,
    });

    const claimed = await app.inject({
      method: 'GET',
      url: '/api/local-connector/public/bridge/commands/next',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
    });
    expect(claimed.statusCode).toBe(200);
    const taskId = created.task.state.taskId;
    const leaseToken = claimed.json().command.leaseToken as string;
    const resultPayload = {
      deliveryId: 'bridge-result:rejected-replay',
      leaseToken,
      outcome: 'rejected',
      failure: { message: 'rate limited', httpStatusCode: 429 },
    };

    const firstResult = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/bridge/commands/${taskId}/result`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: resultPayload,
    });
    const replayedResult = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/bridge/commands/${taskId}/result`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: resultPayload,
    });
    expect(firstResult.statusCode).toBe(200);
    expect(replayedResult.statusCode).toBe(200);

    const eventPayload = {
      deliveryId: 'bridge-event:thread-status-replay',
      event: { kind: 'thread_status', threadId: 'thread-replay', status: 'idle', activeFlags: [] },
    };
    const firstEvent = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/bridge/commands/${taskId}/events`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: eventPayload,
    });
    const replayedEvent = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/bridge/commands/${taskId}/events`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: eventPayload,
    });
    expect(firstEvent.statusCode).toBe(200);
    expect(replayedEvent.statusCode).toBe(200);

    const detail = await app.inject({ method: 'GET', url: `/api/bridge-continuations/${taskId}` });
    const deliveryIds = detail.json().events
      .map((event: any) => event.deliveryId)
      .filter(Boolean);
    expect(deliveryIds.filter((id: string) => id === resultPayload.deliveryId)).toHaveLength(1);
    expect(deliveryIds.filter((id: string) => id === eventPayload.deliveryId)).toHaveLength(1);
  });

  it('creates an idempotent manual Prompt task and exposes a turn/steer Connector command', async () => {
    const controlled = await pair(['app_server.control']);
    const context = await bridge.createBridgeContinuationTask({
      sessionKey: `${controlled.device.id}:thread-manual`,
      threadId: 'thread-manual',
      deviceId: controlled.device.id,
      policy: { enabled: true },
      now: Date.now() - 2_000,
    });
    await bridge.recordBridgeThreadState({
      taskId: context.task.state.taskId,
      threadStatus: 'active',
      activeTurnId: 'turn-active',
      now: Date.now() - 1_000,
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/bridge-continuations/manual-prompts',
      headers: { 'idempotency-key': 'webui-prompt-1' },
      payload: {
        contextTaskId: context.task.state.taskId,
        prompt: '检查失败日志后继续',
        submissionMode: 'steer_current',
        operatorId: 'webui:operator-a',
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      success: true,
      created: true,
      deduplicated: false,
      supersededTaskId: context.task.state.taskId,
      task: {
        state: {
          taskKind: 'manual_prompt',
          submissionMode: 'steer_current',
          status: 'backoff',
          pendingMethod: 'turn/steer',
          pendingPrompt: '检查失败日志后继续',
          activeTurnId: 'turn-active',
        },
        requestSource: 'webui',
        requestedBy: 'webui:operator-a',
        sourceAdapterId: null,
      },
    });
    expect(first.json().task.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const manualTaskId = first.json().task.state.taskId as string;

    const superseded = await app.inject({
      method: 'GET',
      url: `/api/bridge-continuations/${context.task.state.taskId}`,
    });
    expect(superseded.statusCode).toBe(200);
    expect(superseded.json().task.state).toMatchObject({
      status: 'superseded',
      reason: 'manual_prompt',
      pendingMethod: null,
      pendingPrompt: null,
      pendingRouteAction: null,
    });

    const replayed = await app.inject({
      method: 'POST',
      url: '/api/bridge-continuations/manual-prompts',
      payload: {
        contextTaskId: context.task.state.taskId,
        prompt: '检查失败日志后继续',
        submissionMode: 'steer_current',
        operatorId: 'webui:operator-a',
        idempotencyKey: 'webui-prompt-1',
      },
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({
      success: true,
      created: false,
      deduplicated: true,
      task: { state: { taskId: manualTaskId } },
    });

    const conflictingReplay = await app.inject({
      method: 'POST',
      url: '/api/bridge-continuations/manual-prompts',
      headers: { 'idempotency-key': 'webui-prompt-1' },
      payload: {
        contextTaskId: context.task.state.taskId,
        prompt: '同一幂等键但不同的 Prompt',
        submissionMode: 'steer_current',
        operatorId: 'webui:operator-a',
      },
    });
    expect(conflictingReplay.statusCode).toBe(400);
    expect(conflictingReplay.json().message).toContain('幂等键已用于不同请求');

    const claimed = await app.inject({
      method: 'GET',
      url: '/api/local-connector/public/bridge/commands/next',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().command).toMatchObject({
      taskId: manualTaskId,
      method: 'turn/steer',
      threadId: 'thread-manual',
      expectedTurnId: 'turn-active',
      prompt: '检查失败日志后继续',
      routeAction: 'preserve',
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/bridge-continuations/${manualTaskId}`,
    });
    const auditMetadata = detail.json().events
      .map((event: any) => event.metadata)
      .filter(Boolean)
      .join('\n');
    expect(auditMetadata).not.toContain('检查失败日志后继续');
    expect(auditMetadata).toContain(first.json().task.promptFingerprint);
  });
});
