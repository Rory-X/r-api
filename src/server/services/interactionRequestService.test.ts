import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type ConnectorService = typeof import('./localConnectorService.js');
type InteractionService = typeof import('./interactionRequestService.js');

describe('interaction request service', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let connector: ConnectorService;
  let service: InteractionService;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-interactions-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    connector = await import('./localConnectorService.js');
    service = await import('./interactionRequestService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.interactionEvents).run();
    await db.delete(schema.interactionRequests).run();
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function pairDevice() {
    const pairing = await connector.createLocalConnectorPairing({
      deviceName: 'MacBook',
      scopes: ['app_server.control'],
    });
    return connector.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    });
  }

  async function createRequest(deviceId: string, overrides: Record<string, unknown> = {}) {
    return service.createInteractionRequest({
      deviceId,
      connectionId: 'connection-a',
      sourceRequestId: '41',
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      requestPayload: { reason: 'needs network', command: ['curl', 'https://example.com'] },
      ttlMs: 60_000,
      now: 1_000,
      ...overrides,
    } as any);
  }

  it('deduplicates the same source request and rejects conflicting reuse', async () => {
    const paired = await pairDevice();
    const first = await createRequest(paired.device.id);
    const replay = await createRequest(paired.device.id);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.request.state.requestId).toBe(first.request.state.requestId);

    await expect(createRequest(paired.device.id, {
      requestPayload: { reason: 'different command', command: ['rm', '-rf'] },
    })).rejects.toThrow('内容冲突');
  });

  it('commits one response, replays delivery idempotently, and resolves from the source', async () => {
    const paired = await pairDevice();
    const created = await createRequest(paired.device.id);
    const requestId = created.request.state.requestId;
    const committed = await service.commitInteractionResponse({
      requestId,
      responsePayload: { decision: 'accept' },
      source: 'im',
      operatorId: 'ou_operator_a',
      idempotencyKey: 'interaction-response-a',
      now: 2_000,
    });
    expect(committed).toMatchObject({
      deduplicated: false,
      request: { state: { status: 'response_pending', responseSource: 'im' } },
    });
    const replayedCommit = await service.commitInteractionResponse({
      requestId,
      responsePayload: { decision: 'accept' },
      source: 'im',
      operatorId: 'ou_operator_a',
      idempotencyKey: 'interaction-response-a',
      now: 2_500,
    });
    expect(replayedCommit.deduplicated).toBe(true);

    const firstDelivery = await service.claimInteractionResponse({
      requestId,
      deviceId: paired.device.id,
      deliveryId: 'interaction-response-delivery-a',
      now: 3_000,
    });
    const replayedDelivery = await service.claimInteractionResponse({
      requestId,
      deviceId: paired.device.id,
      deliveryId: 'interaction-response-delivery-a',
      now: 3_500,
    });
    expect(firstDelivery).toMatchObject({ ready: true, responsePayload: { decision: 'accept' } });
    expect(replayedDelivery.request.state.responseDeliveryCount).toBe(1);

    const resolved = await service.resolveInteractionSource({
      requestId,
      deviceId: paired.device.id,
      deliveryId: 'interaction-source-resolved-a',
      now: 4_000,
    });
    const replayedResolution = await service.resolveInteractionSource({
      requestId,
      deviceId: paired.device.id,
      deliveryId: 'interaction-source-resolved-a',
      now: 4_500,
    });
    expect(resolved.state).toMatchObject({ status: 'resolved', reason: 'source_resolved' });
    expect(replayedResolution.state.status).toBe('resolved');

    const events = await service.listInteractionEvents(requestId);
    expect(events.filter((event) => event.deliveryId === 'interaction-response-delivery-a')).toHaveLength(1);
    expect(events.filter((event) => event.deliveryId === 'interaction-source-resolved-a')).toHaveLength(1);
  });

  it('allows only one competing operator response to win the CAS boundary', async () => {
    const paired = await pairDevice();
    const created = await createRequest(paired.device.id);
    const requestId = created.request.state.requestId;
    const results = await Promise.allSettled([
      service.commitInteractionResponse({
        requestId,
        responsePayload: { decision: 'accept' },
        source: 'webui',
        operatorId: 'admin-a',
        idempotencyKey: 'response-a',
        now: 2_000,
      }),
      service.commitInteractionResponse({
        requestId,
        responsePayload: { decision: 'decline' },
        source: 'im',
        operatorId: 'operator-b',
        idempotencyKey: 'response-b',
        now: 2_000,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await service.getInteractionRequest(requestId))?.state.status).toBe('response_pending');
  });

  it('marks source cleanup before a response as cancelled', async () => {
    const paired = await pairDevice();
    const created = await createRequest(paired.device.id);
    const resolved = await service.resolveInteractionSource({
      requestId: created.request.state.requestId,
      deviceId: paired.device.id,
      deliveryId: 'interaction-source-cleared-a',
      now: 2_000,
    });
    expect(resolved.state).toMatchObject({ status: 'cancelled', reason: 'source_cleared' });
  });

  it('expires due requests and cancels remaining work when a device is revoked', async () => {
    const paired = await pairDevice();
    const expiring = await createRequest(paired.device.id, {
      sourceRequestId: 'expiring',
      ttlMs: 1_000,
      now: 1_000,
    });
    const active = await createRequest(paired.device.id, {
      sourceRequestId: 'active',
      ttlMs: 60_000,
      now: 1_000,
    });
    expect(await service.expireInteractionRequests(2_000)).toBe(1);
    expect((await service.getInteractionRequest(expiring.request.state.requestId))?.state.status).toBe('expired');
    expect(await service.cancelInteractionRequestsForDevice(paired.device.id, 3_000)).toBe(1);
    expect((await service.getInteractionRequest(active.request.state.requestId))?.state)
      .toMatchObject({ status: 'cancelled', reason: 'device_revoked' });
  });
});
