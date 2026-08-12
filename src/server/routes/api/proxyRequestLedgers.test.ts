import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRetryBudget } from '../../services/proxyRetryContract.js';

type DbModule = typeof import('../../db/index.js');
type StoreModule = typeof import('../../services/proxyAttemptLedgerStore.js');

describe('proxy request ledger admin routes', () => {
  const app = Fastify();
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-proxy-ledger-route-'));
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routeModule = await import('./proxyRequestLedgers.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = await import('../../services/proxyAttemptLedgerStore.js');
    await app.register(routeModule.proxyRequestLedgerRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    await db.delete(schema.proxyRequestAttempts).run();
    await db.delete(schema.proxyRequests).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(async () => {
    await app.close();
    const dbModule = await import('../../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('filters durable requests and returns a global sent_unknown summary', async () => {
    const riskyRequest = await store.insertProxyRequestLedger({
      requestId: 'req-risk-001',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      sessionId: 'session-risk',
      policy: {
        retryOwner: 'cooperative',
        replaySafety: 'safe_only',
        retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 3 }),
      },
      now: new Date('2026-08-04T01:00:00.000Z'),
    });
    await store.insertProxyRequestAttempt({
      requestRowId: riskyRequest.requestRowId,
      attemptId: 'attempt-risk-001',
      attemptIndex: 0,
      channelId: 11,
      now: new Date('2026-08-04T01:00:01.000Z'),
    });
    await store.finishProxyRequestAttempt({
      requestRowId: riskyRequest.requestRowId,
      attemptId: 'attempt-risk-001',
      status: 'unknown',
      commitState: 'sent_unknown',
      errorScope: 'transport',
      errorSummary: 'connection ended after the request was sent',
      now: new Date('2026-08-04T01:00:02.000Z'),
    });
    await store.finishProxyRequest({
      requestRowId: riskyRequest.requestRowId,
      status: 'unknown',
      now: new Date('2026-08-04T01:00:03.000Z'),
    });

    const successfulRequest = await store.insertProxyRequestLedger({
      requestId: 'req-success-001',
      requestedModel: 'gpt-5.4-mini',
      downstreamPath: '/v1/responses',
      policy: {
        retryOwner: 'local_proxy',
        replaySafety: 'safe_only',
        retryBudget: createRetryBudget({ nowMs: 2_000, maxAttempts: 2 }),
      },
      now: new Date('2026-08-04T02:00:00.000Z'),
    });
    await store.finishProxyRequest({
      requestRowId: successfulRequest.requestRowId,
      status: 'succeeded',
      now: new Date('2026-08-04T02:00:01.000Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy-request-ledgers?status=unknown&commitState=sent_unknown&search=req-risk&limit=10',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      limit: 10,
      offset: 0,
      summary: {
        total: 2,
        succeeded: 1,
        unknown: 1,
        sentUnknown: 1,
      },
      items: [{
        requestId: 'req-risk-001',
        status: 'unknown',
        clientKind: 'codex',
        sessionId: 'session-risk',
        attemptCount: 1,
        latestCommitState: 'sent_unknown',
        hasSentUnknown: true,
        retryOwner: 'cooperative',
        replaySafety: 'safe_only',
      }],
    });
  });

  it('returns joined attempt context while redacting URL credentials', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Ledger upstream',
      url: 'https://ledger.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'ledger-user',
      accessToken: '',
      apiToken: 'sk-upstream-secret',
      status: 'active',
    }).returning().get();
    const credential = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'credential-a',
      token: 'sk-credential-secret',
      enabled: true,
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: credential.id,
      enabled: true,
    }).returning().get();
    const downstreamKey = await db.insert(schema.downstreamApiKeys).values({
      name: 'Local Codex',
      key: 'sk-local-ledger-test',
      enabled: true,
    }).returning().get();

    const request = await store.insertProxyRequestLedger({
      requestId: 'req-detail-001',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      clientThreadId: 'thread-001',
      downstreamApiKeyId: downstreamKey.id,
      policy: {
        retryOwner: 'local_proxy',
        replaySafety: 'safe_only',
        retryBudget: createRetryBudget({ nowMs: 3_000, maxAttempts: 4 }),
      },
      now: new Date('2026-08-04T03:00:00.000Z'),
    });
    await store.insertProxyRequestAttempt({
      requestRowId: request.requestRowId,
      attemptId: 'attempt-detail-001',
      attemptIndex: 0,
      channelId: channel.id,
      accountId: account.id,
      tokenId: credential.id,
      endpoint: 'responses',
      requestPath: '/v1/responses?access_token=request-secret&safe=1',
      targetUrl: 'https://user:password@ledger.example.com/v1/responses?key=query-secret&safe=1',
      now: new Date('2026-08-04T03:00:01.000Z'),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy-request-ledgers/req-detail-001',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      requestId: 'req-detail-001',
      downstreamApiKeyName: 'Local Codex',
      clientThreadId: 'thread-001',
      attempts: [{
        attemptId: 'attempt-detail-001',
        channelId: channel.id,
        routeId: route.id,
        routeModelPattern: 'gpt-5.4',
        accountUsername: 'ledger-user',
        siteName: 'Ledger upstream',
        credentialName: 'credential-a',
      }],
    });
    expect(body.attempts[0].requestPath).toContain('access_token=redacted');
    expect(body.attempts[0].targetUrl).toContain('redacted:redacted@');
    expect(body.attempts[0].targetUrl).toContain('key=redacted');
    expect(JSON.stringify(body)).not.toContain('request-secret');
    expect(JSON.stringify(body)).not.toContain('query-secret');
    expect(JSON.stringify(body)).not.toContain('password');
  });

  it('returns 404 for an unknown request id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/proxy-request-ledgers/missing-request',
    });
    expect(response.statusCode).toBe(404);
  });
});
