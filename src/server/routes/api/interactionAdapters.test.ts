import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { createCipheriv, createHash } from 'node:crypto';

type DbModule = typeof import('../../db/index.js');
type ConnectorService = typeof import('../../services/localConnectorService.js');
type InteractionService = typeof import('../../services/interactionRequestService.js');
type FeishuService = typeof import('../../services/feishuInteractionAdapterService.js');
type ThreadService = typeof import('../../services/localConnectorThreadService.js');

describe('interaction adapter routes', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let connector: ConnectorService;
  let interaction: InteractionService;
  let feishu: FeishuService;
  let threads: ThreadService;
  let app: ReturnType<typeof Fastify>;
  let dataDir = '';
  let deviceId = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-interaction-adapter-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    connector = await import('../../services/localConnectorService.js');
    interaction = await import('../../services/interactionRequestService.js');
    feishu = await import('../../services/feishuInteractionAdapterService.js');
    threads = await import('../../services/localConnectorThreadService.js');
    const routeModule = await import('./interactionAdapters.js');
    app = Fastify();
    await app.register(routeModule.interactionAdapterRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.interactionActionTickets).run();
    await db.delete(schema.interactionCardUpdates).run();
    await db.delete(schema.interactionDispatches).run();
    await db.delete(schema.interactionPromptCards).run();
    await db.delete(schema.interactionAdapters).run();
    await db.delete(schema.interactionEvents).run();
    await db.delete(schema.interactionRequests).run();
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
    await db.delete(schema.credentialVaultItems).run();
    deviceId = await createControlDevice();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function createAdapter(options: { encryptKey?: string } = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/interaction-adapters/feishu',
      payload: {
        deviceId,
        name: 'Operations',
        appId: 'cli_test_app',
        appSecret: 'app-secret-value',
        verificationToken: 'verification-token-value',
        encryptKey: options.encryptKey,
        apiBaseUrl: 'https://open.feishu.cn',
        receiveIdType: 'chat_id',
        receiveId: 'oc_chat_1',
        consoleBaseUrl: 'https://gateway.example.com',
        operatorAllowlist: ['open_id:ou_allowed'],
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().adapter as { id: string };
  }

  function encryptedCallback(encryptKey: string, body: Record<string, unknown>) {
    const iv = Buffer.from('0123456789abcdef');
    const key = createHash('sha256').update(encryptKey).digest();
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([
      iv,
      cipher.update(JSON.stringify(body), 'utf8'),
      cipher.final(),
    ]).toString('base64');
    const rawBody = `\n${JSON.stringify({ encrypt: encrypted })}\n`;
    const timestamp = '1785855600';
    const nonce = 'nonce-route-encrypted-callback';
    const signature = createHash('sha256')
      .update(timestamp)
      .update(nonce)
      .update(encryptKey)
      .update(rawBody)
      .digest('hex');
    return { rawBody, timestamp, nonce, signature };
  }

  async function createPendingInteraction() {
    return await interaction.createInteractionRequest({
      deviceId,
      connectionId: 'connection-a',
      sourceRequestId: 'request-a',
      kind: 'command_approval',
      method: 'item/commandExecution/requestApproval',
      requestPayload: { command: 'npm test', availableDecisions: ['accept', 'decline'] },
      ttlMs: 60_000,
    });
  }

  async function createControlDevice() {
    const pairing = await connector.createLocalConnectorPairing({
      deviceName: 'MacBook',
      scopes: ['app_server.control'],
    });
    const claimed = await connector.claimLocalConnectorPairing({
      pairingId: pairing.pairingId,
      pairingToken: pairing.pairingToken,
      platform: 'macos',
    });
    return claimed.device.id;
  }

  it('creates, lists, and updates safe adapter state without exposing Vault secrets', async () => {
    const created = await createAdapter();
    const listed = await app.inject({ method: 'GET', url: '/api/interaction-adapters' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).toMatchObject({
      id: created.id,
      secretsConfigured: { appSecret: true, verificationToken: true },
      callbackPath: `/api/interaction-adapters/public/feishu/${created.id}/callback`,
    });
    expect(JSON.stringify(listed.json())).not.toContain('app-secret-value');
    expect(JSON.stringify(listed.json())).not.toContain('verification-token-value');

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/interaction-adapters/feishu/${created.id}`,
      payload: {
        name: 'Operations Updated',
        appSecret: '',
        verificationToken: '',
        operatorAllowlist: ['open_id:ou_allowed', 'user_id:123'],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().adapter).toMatchObject({
      name: 'Operations Updated',
      operatorAllowlist: ['open_id:ou_allowed', 'user_id:123'],
      secretsConfigured: { appSecret: true, verificationToken: true },
    });
  });

  it('creates a long-connection adapter without an HTTP Verification Token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/interaction-adapters/feishu',
      payload: {
        deviceId,
        name: 'Long Connection Only',
        appId: 'cli_0123456789abcdef',
        appSecret: 'app-secret-value',
        apiBaseUrl: 'https://open.feishu.cn',
        receiveIdType: 'chat_id',
        receiveId: 'oc_chat_1',
        operatorAllowlist: ['open_id:ou_allowed'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().adapter).toMatchObject({
      secretsConfigured: { appSecret: true, verificationToken: false },
    });
  });

  it('lists unknown dispatches and only requeues explicitly retryable states', async () => {
    const adapter = await createAdapter();
    const pending = await createPendingInteraction();
    await db.insert(schema.interactionDispatches).values({
      id: 'dispatch-route-1',
      interactionId: pending.request.state.requestId,
      adapterId: adapter.id,
      status: 'delivery_unknown',
      attemptCount: 1,
      nextAttemptAt: new Date().toISOString(),
      lastError: 'socket closed after write',
    }).run();

    const listed = await app.inject({
      method: 'GET',
      url: `/api/interaction-adapters/dispatches?adapterId=${adapter.id}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0]).toMatchObject({
      id: 'dispatch-route-1',
      status: 'delivery_unknown',
      attemptCount: 1,
    });

    const retried = await app.inject({
      method: 'POST',
      url: '/api/interaction-adapters/dispatches/dispatch-route-1/retry',
    });
    expect(retried.statusCode).toBe(200);
    const stored = await db.select().from(schema.interactionDispatches)
      .where(eq(schema.interactionDispatches.id, 'dispatch-route-1')).get();
    expect(stored?.status).toBe('pending');

    const repeated = await app.inject({
      method: 'POST',
      url: '/api/interaction-adapters/dispatches/dispatch-route-1/retry',
    });
    expect(repeated.statusCode).toBe(404);
  });

  it('requires an explicit admin retry for a card update with an unknown PATCH outcome', async () => {
    const adapter = await createAdapter();
    const pending = await createPendingInteraction();
    await db.insert(schema.interactionDispatches).values({
      id: 'dispatch-update-route-1',
      subjectKind: 'interaction',
      interactionId: pending.request.state.requestId,
      promptCardId: null,
      adapterId: adapter.id,
      status: 'delivered',
      attemptCount: 1,
      nextAttemptAt: new Date().toISOString(),
      externalMessageId: 'om-update-route-1',
      deliveredAt: new Date().toISOString(),
    }).run();
    await interaction.commitInteractionResponse({
      requestId: pending.request.state.requestId,
      responsePayload: { decision: 'accept' },
      source: 'webui',
      operatorId: 'webui:admin',
      idempotencyKey: 'route-card-update-response',
    });
    await feishu.reconcileFeishuCardUpdates();
    const update = await db.select().from(schema.interactionCardUpdates).get();
    expect(update).toBeTruthy();
    await db.update(schema.interactionCardUpdates).set({
      status: 'delivery_unknown',
      lastError: 'socket closed after PATCH write',
    }).where(eq(schema.interactionCardUpdates.id, update!.id)).run();

    const retried = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/card-updates/${update!.id}/retry`,
    });
    expect(retried.statusCode).toBe(200);
    const stored = await db.select().from(schema.interactionCardUpdates)
      .where(eq(schema.interactionCardUpdates.id, update!.id)).get();
    expect(stored?.status).toBe('pending');

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/card-updates/${update!.id}/retry`,
    });
    expect(repeated.statusCode).toBe(404);
  });

  it('acknowledges operator policy failures with a card toast to prevent callback retries', async () => {
    const adapter = await createAdapter();
    const denied = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      payload: {
        header: { token: 'verification-token-value', event_type: 'card.action.trigger' },
        event: {
          operator: { open_id: 'ou_denied' },
          action: { value: { metapi_ticket: 'invalid-ticket' } },
        },
      },
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({
      toast: { type: 'error', content: '飞书操作者不在 Interaction 白名单中' },
    });

    const invalidToken = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      payload: {
        type: 'url_verification',
        token: 'wrong-token',
        challenge: 'challenge-value',
      },
    });
    expect(invalidToken.statusCode).toBe(401);
  });

  it('uses the exact raw JSON body to validate and decrypt Encrypt Key callbacks', async () => {
    const encryptKey = 'route-encrypt-key-value';
    const adapter = await createAdapter({ encryptKey });
    const plainChallenge = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      payload: {
        type: 'url_verification',
        token: 'verification-token-value',
        challenge: 'route-plain-challenge',
      },
    });
    expect(plainChallenge.statusCode).toBe(200);
    expect(plainChallenge.json()).toEqual({ challenge: 'route-plain-challenge' });

    const plainChallengeWithPartialHeaders = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      headers: {
        'x-lark-request-timestamp': '1785855600',
        'x-lark-request-nonce': 'url-verification-nonce',
      },
      payload: {
        type: 'url_verification',
        token: 'verification-token-value',
        challenge: 'route-partial-header-challenge',
      },
    });
    expect(plainChallengeWithPartialHeaders.statusCode).toBe(200);
    expect(plainChallengeWithPartialHeaders.json()).toEqual({ challenge: 'route-partial-header-challenge' });

    const encryptedChallengeWithoutHeaders = encryptedCallback(encryptKey, {
      type: 'url_verification',
      token: 'verification-token-value',
      challenge: 'route-encrypted-no-header-challenge',
    });
    const encryptedWithoutHeaders = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      headers: { 'content-type': 'application/json' },
      payload: encryptedChallengeWithoutHeaders.rawBody,
    });
    expect(encryptedWithoutHeaders.statusCode).toBe(200);
    expect(encryptedWithoutHeaders.json()).toEqual({ challenge: 'route-encrypted-no-header-challenge' });

    const rejectedPlainChallenge = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      payload: {
        type: 'url_verification',
        token: 'wrong-token',
        challenge: 'route-invalid-plain-challenge',
      },
    });
    expect(rejectedPlainChallenge.statusCode).toBe(401);

    const callback = encryptedCallback(encryptKey, {
      type: 'url_verification',
      token: 'verification-token-value',
      challenge: 'route-encrypted-challenge',
    });
    const verified = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': callback.timestamp,
        'x-lark-request-nonce': callback.nonce,
        'x-lark-signature': callback.signature,
      },
      payload: callback.rawBody,
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ challenge: 'route-encrypted-challenge' });

    const invalidSignatureCallback = encryptedCallback(encryptKey, {
      type: 'card.action.trigger',
      token: 'verification-token-value',
      event: {
        operator: { open_id: 'ou_allowed' },
        action: { value: { metapi_ticket: 'invalid-ticket' } },
      },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/public/feishu/${adapter.id}/callback`,
      headers: {
        'content-type': 'application/json',
        'x-lark-request-timestamp': invalidSignatureCallback.timestamp,
        'x-lark-request-nonce': invalidSignatureCallback.nonce,
        'x-lark-signature': '0'.repeat(64),
      },
      payload: invalidSignatureCallback.rawBody,
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json().message).toContain('签名');
  });

  it('creates, deduplicates, lists, and cancels standalone Prompt cards', async () => {
    const adapter = await createAdapter();
    await threads.recordLocalConnectorThreadEvent({
      deviceId,
      event: {
        kind: 'thread_status',
        threadId: 'thread-route-prompt',
        status: 'idle',
        observationSource: 'connector_app_server',
        controlState: 'available',
      },
    });
    const payload = {
      deviceId,
      threadId: 'thread-route-prompt',
      ttlMs: 60 * 60_000,
      requestedBy: 'webui:admin',
      idempotencyKey: 'route-prompt-card-1',
    };
    const created = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/feishu/${adapter.id}/prompt-cards`,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      success: true,
      created: true,
      card: {
        deviceId,
        threadId: 'thread-route-prompt',
        status: 'pending',
        dispatch: { subjectKind: 'prompt_card', status: 'pending' },
      },
    });
    const cardId = created.json().card.id as string;

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/feishu/${adapter.id}/prompt-cards`,
      payload,
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ created: false, card: { id: cardId } });

    const listed = await app.inject({
      method: 'GET',
      url: `/api/interaction-adapters/prompt-cards?adapterId=${adapter.id}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]).toMatchObject({ id: cardId, status: 'pending' });

    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/interaction-adapters/prompt-cards/${cardId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().card).toMatchObject({
      id: cardId,
      status: 'cancelled',
      dispatch: { status: 'cancelled' },
    });
  });
});
