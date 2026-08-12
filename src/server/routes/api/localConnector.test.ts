import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

describe('local connector routes', () => {
  let app: FastifyInstance;
  let db: typeof import('../../db/index.js')['db'];
  let schema: typeof import('../../db/index.js')['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-local-connector-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    const routeModule = await import('./localConnector.js');
    app = Fastify();
    await app.register(routeModule.localConnectorRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.interactionCardUpdates).run();
    await db.delete(schema.interactionActionTickets).run();
    await db.delete(schema.interactionDispatches).run();
    await db.delete(schema.interactionPromptCards).run();
    await db.delete(schema.feishuTopicBindings).run();
    await db.delete(schema.interactionEvents).run();
    await db.delete(schema.interactionRequests).run();
    await db.delete(schema.interactionAdapters).run();
    await db.delete(schema.notificationOutbox).run();
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorThreads).run();
    await db.delete(schema.localConnectorDevices).run();
    await db.delete(schema.events).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('pairs a device, delivers a command, accepts the result, and revokes access', async () => {
    const pairingResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/pairings',
      payload: {
        deviceName: 'Test Connector',
        scopes: ['hooks.manage', 'hooks.emit', 'notify.manage', 'notify.emit'],
      },
    });
    expect(pairingResponse.statusCode).toBe(200);
    const pairing = pairingResponse.json() as { pairingId: string; pairingToken: string };

    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: {
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        platform: 'linux',
      },
    });
    expect(claimResponse.statusCode).toBe(200);
    const claimed = claimResponse.json() as { device: { id: string }; connectorToken: string };
    const authHeader = { authorization: `Bearer ${claimed.connectorToken}` };

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/heartbeat',
      headers: authHeader,
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ success: true, device: { id: claimed.device.id } });

    const actionResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/actions',
      payload: {
        deviceId: claimed.device.id,
        kind: 'notify',
        operation: 'install',
      },
    });
    expect(actionResponse.statusCode).toBe(200);
    const action = actionResponse.json() as { action: { id: string } };

    const nextCommand = await app.inject({
      method: 'GET',
      url: '/api/local-connector/public/commands/next',
      headers: authHeader,
    });
    expect(nextCommand.statusCode).toBe(200);
    expect(nextCommand.json()).toMatchObject({ success: true, action: { id: action.action.id, status: 'claimed' } });

    const resultResponse = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/commands/${action.action.id}/result`,
      headers: authHeader,
      payload: { status: 'succeeded', result: { installed: true }, backupRef: 'backup:test' },
    });
    expect(resultResponse.statusCode).toBe(200);
    expect(resultResponse.json()).toMatchObject({ success: true, action: { status: 'succeeded', backupRef: 'backup:test' } });

    const eventResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/events',
      headers: authHeader,
      payload: { kind: 'notify', title: 'Hook finished', message: 'done', idempotencyKey: 'event-1' },
    });
    expect(eventResponse.statusCode).toBe(200);
    expect(eventResponse.json()).toMatchObject({ success: true, notification: { attempted: 0 } });

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/local-connector/devices/${claimed.device.id}/revoke`,
    });
    expect(revoke.statusCode).toBe(200);

    const rejectedHeartbeat = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/heartbeat',
      headers: authHeader,
    });
    expect(rejectedHeartbeat.statusCode).toBe(401);
  });

  it('rejects malformed public commands without leaking admin access', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/events',
      payload: { kind: 'notify', title: 'x', message: 'y' },
    });
    expect(response.statusCode).toBe(401);

    const invalidPairing = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: { pairingId: 'missing', pairingToken: 'bad', platform: 'linux' },
    });
    expect(invalidPairing.statusCode).toBe(400);

    const events = await db.select().from(schema.events)
      .where(eq(schema.events.relatedType, 'local_connector'))
      .all();
    expect(events).toHaveLength(0);
  });

  it('indexes App Server threads even when no Bridge task is active', async () => {
    const pairingResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/pairings',
      payload: {
        deviceName: 'Codex Mac',
        scopes: ['app_server.control'],
      },
    });
    const pairing = pairingResponse.json() as { pairingId: string; pairingToken: string };
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: {
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        platform: 'macos',
      },
    });
    const claimed = claimResponse.json() as { device: { id: string }; connectorToken: string };

    const observed = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/bridge/events',
      headers: { authorization: `Bearer ${claimed.connectorToken}` },
      payload: {
        deliveryId: 'delivery-thread-1',
        event: {
          kind: 'thread_status',
          threadId: 'thread-discovered',
          status: 'idle',
          activeFlags: [],
        },
      },
    });
    expect(observed.statusCode).toBe(202);
    expect(observed.json()).toMatchObject({ success: true, ignored: true });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/local-connector/threads',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      success: true,
      items: [{
        deviceId: claimed.device.id,
        deviceName: 'Codex Mac',
        devicePlatform: 'macos',
        threadId: 'thread-discovered',
        threadStatus: 'idle',
        activeFlags: [],
      }],
    });

    const takeover = await app.inject({
      method: 'POST',
      url: `/api/local-connector/devices/${claimed.device.id}/sessions/thread-discovered/takeover`,
      payload: {},
    });
    expect(takeover.statusCode).toBe(201);
    expect(takeover.json()).toMatchObject({
      success: true,
      created: true,
      task: {
        deviceId: claimed.device.id,
        state: { threadId: 'thread-discovered', threadStatus: 'idle' },
      },
    });
  });

  it('returns a thread-scoped activity timeline across Bridge, Feishu, interactions, and notifications', async () => {
    const pairingResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/pairings',
      payload: { deviceName: 'Activity Mac', scopes: ['app_server.control', 'notify.emit'] },
    });
    const pairing = pairingResponse.json() as { pairingId: string; pairingToken: string };
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: {
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        platform: 'darwin-arm64',
      },
    });
    const claimed = claimResponse.json() as { device: { id: string }; connectorToken: string };
    const authHeader = { authorization: `Bearer ${claimed.connectorToken}` };
    await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: {
        source: 'connector_app_server',
        threads: [{ threadId: 'activity-thread', title: '审计链路', status: 'idle', activeFlags: [] }],
      },
    });

    const takeover = await app.inject({
      method: 'POST',
      url: `/api/local-connector/devices/${claimed.device.id}/sessions/activity-thread/takeover`,
      payload: {},
    });
    const taskId = takeover.json().task.state.taskId as string;
    const now = '2026-08-12T10:00:00.000Z';
    await db.insert(schema.interactionAdapters).values({
      id: 'activity-adapter',
      deviceId: claimed.device.id,
      kind: 'feishu',
      name: 'Codex 助手',
      appId: 'cli_activity',
      appSecretCredentialId: null,
      receiveIdType: 'chat_id',
      receiveId: 'oc_activity',
      operatorAllowlist: '[]',
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(schema.interactionRequests).values({
      id: 'activity-interaction',
      deviceId: claimed.device.id,
      sourceRequestKey: 'activity-source-key',
      connectionId: 'connection-1',
      sourceRequestId: 'source-request-1',
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'activity-thread',
      requestPayload: '{}',
      requestFingerprint: 'activity-request-fingerprint',
      status: 'pending',
      reason: 'request_created',
      expiresAt: '2026-08-12T11:00:00.000Z',
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(schema.interactionEvents).values({
      interactionId: 'activity-interaction',
      eventType: 'request_created',
      fromStatus: null,
      toStatus: 'pending',
      actorKind: 'connector',
      actorId: claimed.device.id,
      createdAt: now,
    }).run();
    await db.insert(schema.interactionDispatches).values({
      id: 'activity-dispatch',
      subjectKind: 'interaction',
      interactionId: 'activity-interaction',
      promptCardId: null,
      adapterId: 'activity-adapter',
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: now,
      externalMessageId: 'om_activity',
      deliveredAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(schema.feishuTopicBindings).values({
      id: 'activity-topic',
      adapterId: 'activity-adapter',
      deviceId: claimed.device.id,
      codexThreadId: 'activity-thread',
      rootMessageId: 'om_root',
      feishuThreadId: 'omt_topic',
      lastMessageId: 'om_activity',
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(schema.notificationOutbox).values({
      notificationId: 'activity-notification',
      channel: `feishu:${claimed.device.id}`,
      title: '审计链路 · Codex 会话已完成',
      message: '会话名称：审计链路\n线程 ID：activity-thread\n轮次 ID：turn-1\n状态：completed',
      level: 'info',
      occurredAt: now,
      status: 'delivered',
      deliveredAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(schema.notificationOutbox).values({
      notificationId: 'other-notification',
      channel: `feishu:${claimed.device.id}`,
      title: '其他会话已完成',
      message: '线程 ID：other-thread\n轮次 ID：turn-2\n状态：completed',
      level: 'info',
      occurredAt: now,
      status: 'delivered',
      deliveredAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: `/api/local-connector/devices/${claimed.device.id}/sessions/activity-thread/activity`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      thread: { threadId: 'activity-thread', title: '审计链路' },
      summary: { bridgeTasks: 1, interactions: 1, feishuDeliveries: 2 },
      topicBindings: [{ id: 'activity-topic', adapterName: 'Codex 助手' }],
    });
    const body = response.json() as { items: Array<{ category: string; referenceId: string | null }> };
    expect(body.items.map((item) => item.category)).toEqual(expect.arrayContaining([
      'bridge',
      'interaction',
      'feishu',
      'notification',
    ]));
    expect(body.items.some((item) => item.referenceId === 'activity-notification')).toBe(true);
    expect(body.items.some((item) => item.referenceId === 'other-notification')).toBe(false);
    expect(body.items.some((item) => item.referenceId === taskId)).toBe(true);
  });

  it('uploads privacy-safe Desktop session metadata and releases control after Desktop unloads it', async () => {
    const pairingResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/pairings',
      payload: {
        deviceName: 'Codex Desktop Mac',
        scopes: ['app_server.observe', 'app_server.control'],
      },
    });
    const pairing = pairingResponse.json() as { pairingId: string; pairingToken: string };
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: {
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        platform: 'darwin-arm64',
      },
    });
    const claimed = claimResponse.json() as { device: { id: string }; connectorToken: string };
    const authHeader = { authorization: `Bearer ${claimed.connectorToken}` };

    const snapshot = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: {
        source: 'codex_desktop',
        threads: [{
          threadId: 'desktop-thread-1',
          status: 'active',
          activeTurnId: 'desktop-turn-1',
          updatedAt: '2026-08-11T01:00:00.000Z',
        }],
      },
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ success: true, observed: 1, released: 0 });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/local-connector/threads?deviceId=${claimed.device.id}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      success: true,
      items: [{
        deviceId: claimed.device.id,
        threadId: 'desktop-thread-1',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
        threadStatus: 'active',
        activeTurnId: 'desktop-turn-1',
      }],
    });

    const blockedTakeover = await app.inject({
      method: 'POST',
      url: `/api/local-connector/devices/${claimed.device.id}/sessions/desktop-thread-1/takeover`,
      payload: {},
    });
    expect(blockedTakeover.statusCode).toBe(400);
    expect(blockedTakeover.json()).toMatchObject({
      success: false,
      message: expect.stringMatching(/Desktop App Server 持有/),
    });

    const released = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: { source: 'codex_desktop', threads: [] },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({ success: true, observed: 0, released: 1 });

    const listedAfterRelease = await app.inject({
      method: 'GET',
      url: `/api/local-connector/threads?deviceId=${claimed.device.id}`,
    });
    expect(listedAfterRelease.json()).toMatchObject({
      items: [{
        threadId: 'desktop-thread-1',
        observationSource: 'codex_desktop',
        controlState: 'available',
        threadStatus: 'not_loaded',
        activeTurnId: null,
      }],
    });

    const takeover = await app.inject({
      method: 'POST',
      url: `/api/local-connector/devices/${claimed.device.id}/sessions/desktop-thread-1/takeover`,
      payload: {},
    });
    expect(takeover.statusCode).toBe(201);
    expect(takeover.json()).toMatchObject({
      success: true,
      created: true,
      task: {
        deviceId: claimed.device.id,
        state: { threadId: 'desktop-thread-1', threadStatus: 'not_loaded' },
      },
    });
  });

  it('marks control snapshots available and keeps each snapshot source release isolated', async () => {
    const pairingResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/pairings',
      payload: {
        deviceName: 'Codex Control Mac',
        scopes: ['app_server.observe', 'app_server.control'],
      },
    });
    const pairing = pairingResponse.json() as { pairingId: string; pairingToken: string };
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: {
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        platform: 'darwin-arm64',
      },
    });
    const claimed = claimResponse.json() as { device: { id: string }; connectorToken: string };
    const authHeader = { authorization: `Bearer ${claimed.connectorToken}` };

    const desktopSnapshot = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: {
        source: 'codex_desktop',
        threads: [{
          threadId: 'shared-thread-1',
          status: 'active',
          activeTurnId: 'desktop-turn-1',
        }],
      },
    });
    expect(desktopSnapshot.statusCode).toBe(200);

    const controlSnapshot = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: {
        source: 'connector_app_server',
        threads: [{
          threadId: 'shared-thread-1',
          status: 'active',
          activeFlags: ['waitingOnApproval'],
        }],
      },
    });
    expect(controlSnapshot.statusCode).toBe(200);
    expect(controlSnapshot.json()).toMatchObject({ success: true, observed: 1, released: 0 });

    const stillExternal = await app.inject({
      method: 'GET',
      url: `/api/local-connector/threads?deviceId=${claimed.device.id}`,
    });
    expect(stillExternal.json()).toMatchObject({
      items: [{
        threadId: 'shared-thread-1',
        observationSource: 'codex_desktop',
        controlState: 'external_owner',
        threadStatus: 'active',
        activeTurnId: 'desktop-turn-1',
      }],
    });

    const desktopRelease = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: { source: 'codex_desktop', threads: [] },
    });
    expect(desktopRelease.statusCode).toBe(200);
    expect(desktopRelease.json()).toMatchObject({ success: true, observed: 0, released: 1 });

    const controlAfterRelease = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: {
        source: 'connector_app_server',
        threads: [{
          threadId: 'shared-thread-1',
          status: 'active',
          activeFlags: ['waitingOnApproval'],
        }],
      },
    });
    expect(controlAfterRelease.statusCode).toBe(200);

    const listed = await app.inject({
      method: 'GET',
      url: `/api/local-connector/threads?deviceId=${claimed.device.id}`,
    });
    expect(listed.json()).toMatchObject({
      items: [{
        threadId: 'shared-thread-1',
        observationSource: 'connector_app_server',
        controlState: 'available',
        threadStatus: 'active',
        activeFlags: ['waitingOnApproval'],
        activeTurnId: null,
      }],
    });

    const controlRelease = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: authHeader,
      payload: { source: 'connector_app_server', threads: [] },
    });
    expect(controlRelease.statusCode).toBe(200);
    expect(controlRelease.json()).toMatchObject({ success: true, observed: 0, released: 1 });

    const listedAfterRelease = await app.inject({
      method: 'GET',
      url: `/api/local-connector/threads?deviceId=${claimed.device.id}`,
    });
    expect(listedAfterRelease.json()).toMatchObject({
      items: [{
        threadId: 'shared-thread-1',
        observationSource: 'connector_app_server',
        controlState: 'available',
        threadStatus: 'not_loaded',
        activeFlags: [],
        activeTurnId: null,
      }],
    });
  });

  it('requires the control scope for controllable App Server snapshots', async () => {
    const pairingResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/pairings',
      payload: {
        deviceName: 'Observe-only Mac',
        scopes: ['app_server.observe'],
      },
    });
    const pairing = pairingResponse.json() as { pairingId: string; pairingToken: string };
    const claimResponse = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/pairings/claim',
      payload: {
        pairingId: pairing.pairingId,
        pairingToken: pairing.pairingToken,
        platform: 'darwin-arm64',
      },
    });
    const claimed = claimResponse.json() as { connectorToken: string };

    const response = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/threads/snapshot',
      headers: { authorization: `Bearer ${claimed.connectorToken}` },
      payload: {
        source: 'connector_app_server',
        threads: [{ threadId: 'thread-control-denied', status: 'idle' }],
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
