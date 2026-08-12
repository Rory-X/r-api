import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRetryBudget } from './proxyRetryContract.js';

type DbModule = typeof import('../db/index.js');
type StoreModule = typeof import('./proxyAttemptLedgerStore.js');

describe('proxyAttemptLedgerStore', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let store: StoreModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-proxy-ledger-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    store = await import('./proxyAttemptLedgerStore.js');
  });

  beforeEach(async () => {
    await db.delete(schema.proxyRequestAttempts).run();
    await db.delete(schema.proxyRequests).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  it('persists policy, attempts, commit state, and terminal request status', async () => {
    const policy = {
      retryOwner: 'cooperative' as const,
      replaySafety: 'safe_only' as const,
      retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 3 }),
    };
    const request = await store.insertProxyRequestLedger({
      requestId: 'req-store-1',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      clientKind: 'codex',
      sessionId: 'session-1',
      downstreamApiKeyId: 7,
      policy,
      now: new Date('2026-08-03T00:00:00.000Z'),
    });

    await store.updateProxyRequestRetryOwner({
      requestRowId: request.requestRowId,
      retryOwner: 'local_proxy',
      replaySafety: 'safe_only',
      now: new Date('2026-08-03T00:00:00.500Z'),
    });

    await store.insertProxyRequestAttempt({
      requestRowId: request.requestRowId,
      attemptId: 'attempt-store-1',
      attemptIndex: 0,
      channelId: 11,
      accountId: 21,
      tokenId: 31,
      endpoint: 'responses',
      requestPath: '/v1/responses',
      targetUrl: 'https://upstream.example/v1/responses',
      now: new Date('2026-08-03T00:00:01.000Z'),
    });
    await store.updateProxyRequestAttemptCommit({
      requestRowId: request.requestRowId,
      attemptId: 'attempt-store-1',
      commitState: 'request_sent',
      now: new Date('2026-08-03T00:00:02.000Z'),
    });
    await store.finishProxyRequestAttempt({
      requestRowId: request.requestRowId,
      attemptId: 'attempt-store-1',
      status: 'failed',
      commitState: 'request_sent',
      errorScope: 'upstream_gateway',
      statusCode: 429,
      errorSummary: 'rate limited',
      now: new Date('2026-08-03T00:00:03.000Z'),
    });

    expect(await store.listActiveProxyRequestLedgers()).toHaveLength(1);

    await store.finishProxyRequest({
      requestRowId: request.requestRowId,
      status: 'failed',
      now: new Date('2026-08-03T00:00:04.000Z'),
    });

    const loaded = await store.getProxyRequestLedger('req-store-1');
    expect(loaded).toMatchObject({
      requestId: 'req-store-1',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      status: 'failed',
      policy: {
        retryOwner: 'local_proxy',
        replaySafety: 'safe_only',
        retryBudget: {
          limits: { maxAttempts: 3 },
        },
      },
      attempts: [{
        attemptId: 'attempt-store-1',
        attemptIndex: 0,
        channelId: 11,
        credentialId: 31,
        status: 'failed',
        commitState: 'request_sent',
        errorScope: 'upstream_gateway',
        statusCode: 429,
      }],
    });
    expect(await store.listActiveProxyRequestLedgers()).toEqual([]);
  });

  it('returns defensive JSON policy snapshots when stored JSON is malformed', async () => {
    await db.insert(schema.proxyRequests).values({
      requestId: 'req-store-malformed',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      status: 'active',
      retryOwner: 'cooperative',
      replaySafety: 'safe_only',
      policySnapshotJson: '{broken',
      retryBudgetJson: '{broken',
      createdAt: '2026-08-03 00:00:00',
      updatedAt: '2026-08-03 00:00:00',
    }).run();

    const loaded = await store.getProxyRequestLedger('req-store-malformed');
    expect(loaded?.policy.retryBudget).toMatchObject({
      attempts: 0,
      credentialRotations: 0,
      channelSwitches: 0,
    });
  });

  it('recovers active requests and in-flight attempts as sent_unknown after restart', async () => {
    const request = await store.insertProxyRequestLedger({
      requestId: 'req-store-recovery',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      policy: {
        retryOwner: 'cooperative',
        replaySafety: 'safe_only',
        retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 2 }),
      },
      now: new Date('2026-08-03T01:00:00.000Z'),
    });
    await store.insertProxyRequestAttempt({
      requestRowId: request.requestRowId,
      attemptId: 'attempt-store-recovery',
      attemptIndex: 0,
      channelId: 11,
      now: new Date('2026-08-03T01:00:01.000Z'),
    });

    const recovered = await store.recoverAbandonedProxyRequestLedgers({
      now: new Date('2026-08-03T01:05:00.000Z'),
      reason: 'test restart recovery',
    });

    expect(recovered).toEqual({ recoveredRequests: 1, recoveredAttempts: 1 });
    expect(await store.getProxyRequestLedger('req-store-recovery')).toMatchObject({
      status: 'unknown',
      attempts: [{
        status: 'unknown',
        commitState: 'sent_unknown',
        errorScope: 'transport',
      }],
    });
  });

  it('prefers exact thread history before falling back to newer session history', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ledger-thread-site',
      url: 'https://ledger-thread.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'ledger-thread-user',
      accessToken: '',
      apiToken: 'sk-ledger-thread',
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const threadChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      enabled: true,
    }).returning().get();
    const sessionChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      enabled: true,
    }).returning().get();
    const policy = {
      retryOwner: 'cooperative' as const,
      replaySafety: 'safe_only' as const,
      retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 2 }),
    };

    const threadRequest = await store.insertProxyRequestLedger({
      requestId: 'req-thread-history',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      clientThreadId: 'thread-priority',
      sessionId: 'shared-session',
      downstreamApiKeyId: 17,
      policy,
      now: new Date('2026-08-04T00:00:00.000Z'),
    });
    await store.insertProxyRequestAttempt({
      requestRowId: threadRequest.requestRowId,
      attemptId: 'attempt-thread-history',
      attemptIndex: 0,
      channelId: threadChannel.id,
      accountId: account.id,
      now: new Date('2026-08-04T00:00:01.000Z'),
    });

    const sessionRequest = await store.insertProxyRequestLedger({
      requestId: 'req-newer-session-history',
      requestedModel: 'gpt-5.4',
      downstreamPath: '/v1/responses',
      clientThreadId: 'other-thread',
      sessionId: 'shared-session',
      downstreamApiKeyId: 17,
      policy,
      now: new Date('2026-08-04T00:01:00.000Z'),
    });
    await store.insertProxyRequestAttempt({
      requestRowId: sessionRequest.requestRowId,
      attemptId: 'attempt-newer-session-history',
      attemptIndex: 0,
      channelId: sessionChannel.id,
      accountId: account.id,
      now: new Date('2026-08-04T00:01:01.000Z'),
    });

    await expect(store.findLatestProxySessionRouteSelection({
      clientThreadId: 'thread-priority',
      sessionId: 'shared-session',
      downstreamApiKeyId: 17,
    })).resolves.toMatchObject({
      requestId: 'req-thread-history',
      channelId: threadChannel.id,
    });

    await expect(store.findLatestProxySessionRouteSelection({
      clientThreadId: 'missing-thread',
      sessionId: 'shared-session',
      downstreamApiKeyId: 17,
    })).resolves.toMatchObject({
      requestId: 'req-newer-session-history',
      channelId: sessionChannel.id,
    });
  });

  it('isolates route history by downstream key, including the global key scope', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ledger-key-site',
      url: 'https://ledger-key.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'ledger-key-user',
      accessToken: '',
      apiToken: 'sk-ledger-key',
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const globalChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      enabled: true,
    }).returning().get();
    const managedChannel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      enabled: true,
    }).returning().get();
    const policy = {
      retryOwner: 'cooperative' as const,
      replaySafety: 'safe_only' as const,
      retryBudget: createRetryBudget({ nowMs: 1_000, maxAttempts: 2 }),
    };

    for (const item of [
      {
        requestId: 'req-global-key-history',
        attemptId: 'attempt-global-key-history',
        downstreamApiKeyId: null,
        channelId: globalChannel.id,
        now: new Date('2026-08-04T01:00:00.000Z'),
      },
      {
        requestId: 'req-managed-key-history',
        attemptId: 'attempt-managed-key-history',
        downstreamApiKeyId: 23,
        channelId: managedChannel.id,
        now: new Date('2026-08-04T01:01:00.000Z'),
      },
    ]) {
      const request = await store.insertProxyRequestLedger({
        requestId: item.requestId,
        requestedModel: 'gpt-5.4',
        downstreamPath: '/v1/responses',
        clientThreadId: 'shared-thread',
        sessionId: 'shared-key-session',
        downstreamApiKeyId: item.downstreamApiKeyId,
        policy,
        now: item.now,
      });
      await store.insertProxyRequestAttempt({
        requestRowId: request.requestRowId,
        attemptId: item.attemptId,
        attemptIndex: 0,
        channelId: item.channelId,
        accountId: account.id,
        now: new Date(item.now.getTime() + 1_000),
      });
    }

    await expect(store.findLatestProxySessionRouteSelection({
      clientThreadId: 'shared-thread',
      sessionId: 'shared-key-session',
      downstreamApiKeyId: null,
    })).resolves.toMatchObject({
      requestId: 'req-global-key-history',
      channelId: globalChannel.id,
    });
    await expect(store.findLatestProxySessionRouteSelection({
      clientThreadId: 'shared-thread',
      sessionId: 'shared-key-session',
      downstreamApiKeyId: 23,
    })).resolves.toMatchObject({
      requestId: 'req-managed-key-history',
      channelId: managedChannel.id,
    });
  });
});
