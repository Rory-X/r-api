import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');
type ConnectorService = typeof import('../../services/localConnectorService.js');

describe('interaction request routes', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let connector: ConnectorService;
  let app: ReturnType<typeof Fastify>;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-interaction-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    connector = await import('../../services/localConnectorService.js');
    const routeModule = await import('./interactionRequests.js');
    app = Fastify();
    await app.register(routeModule.interactionRequestRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.interactionEvents).run();
    await db.delete(schema.interactionRequests).run();
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

  it('runs the durable admin and Connector response lifecycle with replay protection', async () => {
    const controlled = await pair(['app_server.control']);
    const observer = await pair(['app_server.observe']);
    const otherDevice = await pair(['app_server.control']);
    const payload = {
      connectionId: 'connection-a',
      sourceRequestId: 17,
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      threadId: 'thread-a',
      turnId: 'turn-a',
      itemId: 'item-a',
      requestPayload: { command: 'npm test', reason: 'needs approval' },
      ttlMs: 60_000,
    };

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/interactions',
      headers: { authorization: `Bearer ${observer.connectorToken}` },
      payload,
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/interactions',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ success: true, created: true });
    const requestId = created.json().request.state.requestId as string;

    const replayedCreate = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/interactions',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload,
    });
    expect(replayedCreate.statusCode).toBe(200);
    expect(replayedCreate.json()).toMatchObject({
      created: false,
      request: { state: { requestId } },
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/api/interactions?status=pending&kind=command_approval',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);

    const responded = await app.inject({
      method: 'POST',
      url: `/api/interactions/${requestId}/respond`,
      headers: { 'idempotency-key': 'admin-response-1' },
      payload: {
        operatorId: 'admin:test',
        responsePayload: { decision: 'accept' },
      },
    });
    expect(responded.statusCode).toBe(200);
    expect(responded.json()).toMatchObject({
      deduplicated: false,
      request: { state: { status: 'response_pending', responseSource: 'webui' } },
    });

    const replayedResponse = await app.inject({
      method: 'POST',
      url: `/api/interactions/${requestId}/respond`,
      headers: { 'idempotency-key': 'admin-response-1' },
      payload: {
        operatorId: 'admin:test',
        responsePayload: { decision: 'accept' },
      },
    });
    expect(replayedResponse.statusCode).toBe(200);
    expect(replayedResponse.json().deduplicated).toBe(true);

    const competingResponse = await app.inject({
      method: 'POST',
      url: `/api/interactions/${requestId}/respond`,
      headers: { 'idempotency-key': 'admin-response-2' },
      payload: {
        operatorId: 'admin:other',
        responsePayload: { decision: 'decline' },
      },
    });
    expect(competingResponse.statusCode).toBe(409);

    const wrongDeviceClaim = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/interactions/${requestId}/response/claim`,
      headers: { authorization: `Bearer ${otherDevice.connectorToken}` },
      payload: { deliveryId: 'response-delivery-other' },
    });
    expect(wrongDeviceClaim.statusCode).toBe(403);

    const missingDeliveryId = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/interactions/${requestId}/response/claim`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: {},
    });
    expect(missingDeliveryId.statusCode).toBe(400);

    const claimPayload = { deliveryId: 'response-delivery-1' };
    const claimed = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/interactions/${requestId}/response/claim`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: claimPayload,
    });
    const replayedClaim = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/interactions/${requestId}/response/claim`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: claimPayload,
    });
    expect(claimed.statusCode).toBe(200);
    expect(replayedClaim.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({
      protocol: 'metapi.interaction-response.v1',
      ready: true,
      responsePayload: { decision: 'accept' },
      request: { state: { responseDeliveryCount: 1 } },
    });
    expect(replayedClaim.json().request.state.responseDeliveryCount).toBe(1);

    const resolvedPayload = { deliveryId: 'resolved-delivery-1' };
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/interactions/${requestId}/resolved`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: resolvedPayload,
    });
    const replayedResolved = await app.inject({
      method: 'POST',
      url: `/api/local-connector/public/interactions/${requestId}/resolved`,
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: resolvedPayload,
    });
    expect(resolved.statusCode).toBe(200);
    expect(replayedResolved.statusCode).toBe(200);
    expect(resolved.json().interaction.state.status).toBe('resolved');

    const detail = await app.inject({ method: 'GET', url: `/api/interactions/${requestId}` });
    expect(detail.statusCode).toBe(200);
    const deliveryIds = detail.json().events.map((event: { deliveryId: string | null }) => event.deliveryId);
    expect(deliveryIds.filter((id: string | null) => id === claimPayload.deliveryId)).toHaveLength(1);
    expect(deliveryIds.filter((id: string | null) => id === resolvedPayload.deliveryId)).toHaveLength(1);
  });

  it('allows an administrator to cancel a pending request', async () => {
    const controlled = await pair(['app_server.control']);
    const created = await app.inject({
      method: 'POST',
      url: '/api/local-connector/public/interactions',
      headers: { authorization: `Bearer ${controlled.connectorToken}` },
      payload: {
        connectionId: 'connection-b',
        sourceRequestId: 'request-b',
        kind: 'user_input',
        method: 'item/tool/requestUserInput',
        requestPayload: { questions: [{ id: 'environment', question: 'Which environment?' }] },
      },
    });
    const requestId = created.json().request.state.requestId as string;

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/interactions/${requestId}/cancel`,
      payload: { operatorId: 'admin:test' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().interaction.state).toMatchObject({
      status: 'cancelled',
      reason: 'manual_cancel',
    });
  });
});
