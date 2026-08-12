import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';

const refreshAccessTokenMock = vi.fn();

vi.mock('./providers.js', () => ({
  getOAuthProviderDefinition: (provider: string) => (
    provider === 'codex'
      ? {
        metadata: { provider: 'codex' },
        refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
      }
      : undefined
  ),
}));

type DbModule = typeof import('../../db/index.js');
type RefreshCoordinatorModule = typeof import('./refreshCoordinator.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('refreshOauthAccessTokenCoordinated', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshOauthAccessTokenCoordinated: RefreshCoordinatorModule['refreshOauthAccessTokenCoordinated'];
  let OAuthRefreshCoordinatorError: typeof RefreshCoordinatorModule['OAuthRefreshCoordinatorError'];
  let OAuthProviderHttpError: typeof import('./providerError.js')['OAuthProviderHttpError'];
  let dataDir = '';
  let originalDataDir: string | undefined;
  const originalMinInterval = process.env.OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS;
  const originalLeaseWait = process.env.OAUTH_REFRESH_LEASE_WAIT_MS;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-oauth-refresh-coordinator-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    process.env.OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS = '0';
    process.env.OAUTH_REFRESH_LEASE_WAIT_MS = '2000';

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const coordinatorModule = await import('./refreshCoordinator.js');
    const providerErrorModule = await import('./providerError.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshOauthAccessTokenCoordinated = coordinatorModule.refreshOauthAccessTokenCoordinated;
    OAuthRefreshCoordinatorError = coordinatorModule.OAuthRefreshCoordinatorError;
    OAuthProviderHttpError = providerErrorModule.OAuthProviderHttpError;
  });

  beforeEach(async () => {
    refreshAccessTokenMock.mockReset();
    await db.run(sql`DROP TRIGGER IF EXISTS fail_oauth_access_token_update`);
    await db.delete(schema.oauthRefreshLeases).run();
    await db.delete(schema.oauthRefreshProviderStates).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    if (originalMinInterval === undefined) delete process.env.OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS;
    else process.env.OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS = originalMinInterval;
    if (originalLeaseWait === undefined) delete process.env.OAUTH_REFRESH_LEASE_WAIT_MS;
    else process.env.OAUTH_REFRESH_LEASE_WAIT_MS = originalLeaseWait;
  });

  async function createOauthAccount(input: {
    accessToken?: string;
    refreshToken?: string;
    credentialVersion?: number;
    refreshState?: string;
  } = {}) {
    const site = await db.insert(schema.sites).values({
      name: 'Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();
    const accessToken = input.accessToken ?? 'access-old';
    const refreshToken = input.refreshToken ?? 'refresh-old';
    return await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken,
      status: 'active',
      checkinEnabled: false,
      oauthProvider: 'codex',
      oauthAccountKey: 'account-1',
      oauthCredentialPayload: JSON.stringify({
        email: 'codex-user@example.com',
        refreshToken,
        tokenExpiresAt: Date.now() + 60_000,
      }),
      oauthCredentialVersion: input.credentialVersion ?? 1,
      oauthRefreshState: input.refreshState ?? 'ready',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        proxyUrl: 'http://127.0.0.1:8080',
        oauth: {
          provider: 'codex',
          accountId: 'account-1',
          accountKey: 'account-1',
          email: 'codex-user@example.com',
          refreshToken,
        },
      }),
    }).returning().get();
  }

  function buildRefreshResult(accessToken = 'access-new') {
    return {
      accessToken,
      refreshToken: 'refresh-new',
      accountId: 'account-1',
      accountKey: 'account-1',
      email: 'codex-user@example.com',
      tokenExpiresAt: Date.now() + 3_600_000,
    };
  }

  it('serializes direct coordinator calls through the database lease and reuses the rotated token', async () => {
    const account = await createOauthAccount();
    const providerResult = deferred<ReturnType<typeof buildRefreshResult>>();
    refreshAccessTokenMock.mockReturnValue(providerResult.promise);

    const first = refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'unauthorized',
      failedAccessToken: 'access-old',
      leaseWaitMs: 2_000,
    });
    await vi.waitFor(() => expect(refreshAccessTokenMock).toHaveBeenCalledOnce());

    const second = refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'unauthorized',
      failedAccessToken: 'access-old',
      leaseWaitMs: 2_000,
    });
    providerResult.resolve(buildRefreshResult());

    const results = await Promise.all([first, second]);
    expect(refreshAccessTokenMock).toHaveBeenCalledOnce();
    expect(results.map((result) => result.accessToken)).toEqual(['access-new', 'access-new']);
    expect(results.filter((result) => result.refreshed)).toHaveLength(1);
    expect(results.filter((result) => result.reused)).toHaveLength(1);

    const durable = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(durable).toMatchObject({
      accessToken: 'access-new',
      oauthCredentialVersion: 2,
      oauthRefreshState: 'ready',
      oauthRefreshFailureCount: 0,
    });
    expect(await db.select().from(schema.oauthRefreshLeases).all()).toEqual([]);
  });

  it('recovers an expired lease left by a crashed worker', async () => {
    const account = await createOauthAccount();
    await db.insert(schema.oauthRefreshLeases).values({
      accountId: account.id,
      provider: 'codex',
      providerSlot: 1,
      leaseToken: 'crashed-worker-lease',
      leaseOwner: 'crashed-worker',
      credentialVersion: 1,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).run();
    refreshAccessTokenMock.mockResolvedValue(buildRefreshResult());

    const result = await refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'scheduled',
      leaseWaitMs: 0,
    });

    expect(result).toMatchObject({ accessToken: 'access-new', refreshed: true, reused: false });
    expect(refreshAccessTokenMock).toHaveBeenCalledOnce();
    expect(await db.select().from(schema.oauthRefreshLeases).all()).toEqual([]);
  });

  it('lets a concurrent reauthorization win the credential CAS', async () => {
    const account = await createOauthAccount();
    const providerResult = deferred<ReturnType<typeof buildRefreshResult>>();
    refreshAccessTokenMock.mockReturnValue(providerResult.promise);

    const refreshPromise = refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'unauthorized',
      failedAccessToken: 'access-old',
    });
    await vi.waitFor(() => expect(refreshAccessTokenMock).toHaveBeenCalledOnce());

    await db.update(schema.accounts).set({
      accessToken: 'access-from-reauthorization',
      oauthCredentialPayload: JSON.stringify({
        email: 'codex-user@example.com',
        refreshToken: 'refresh-from-reauthorization',
        tokenExpiresAt: Date.now() + 7_200_000,
      }),
      oauthCredentialVersion: 2,
      oauthRefreshState: 'ready',
    }).where(eq(schema.accounts.id, account.id)).run();
    providerResult.resolve(buildRefreshResult('access-from-stale-refresh'));

    const result = await refreshPromise;
    expect(result).toMatchObject({
      accessToken: 'access-from-reauthorization',
      refreshed: false,
      reused: true,
      credentialVersion: 2,
    });
    const durable = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(durable?.accessToken).toBe('access-from-reauthorization');
  });

  it('recovers invalid_grant when another worker has already rotated the credential', async () => {
    const account = await createOauthAccount();
    const providerResult = deferred<ReturnType<typeof buildRefreshResult>>();
    refreshAccessTokenMock.mockReturnValue(providerResult.promise);

    const refreshPromise = refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'unauthorized',
      failedAccessToken: 'access-old',
    });
    await vi.waitFor(() => expect(refreshAccessTokenMock).toHaveBeenCalledOnce());

    await db.update(schema.accounts).set({
      accessToken: 'access-from-other-worker',
      oauthCredentialPayload: JSON.stringify({
        email: 'codex-user@example.com',
        refreshToken: 'refresh-from-other-worker',
      }),
      oauthCredentialVersion: 2,
      oauthRefreshState: 'ready',
    }).where(eq(schema.accounts.id, account.id)).run();
    providerResult.reject(new Error('invalid_grant: refresh token already rotated'));

    const result = await refreshPromise;
    expect(result).toMatchObject({
      accessToken: 'access-from-other-worker',
      refreshed: false,
      reused: true,
    });
    const durable = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(durable).toMatchObject({
      accessToken: 'access-from-other-worker',
      oauthRefreshState: 'ready',
      oauthRefreshFailureCount: 0,
    });
  });

  it('requires reauthorization when invalid_grant has no competing credential rotation', async () => {
    const account = await createOauthAccount();
    refreshAccessTokenMock.mockRejectedValue(new Error('invalid_grant: refresh token expired'));

    await expect(refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'scheduled',
      leaseWaitMs: 0,
    })).rejects.toMatchObject({
      code: 'reauthorization_required',
      retryAfterMs: null,
      refreshState: 'reauthorization_required',
      transient: false,
    });

    const durable = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(durable).toMatchObject({
      accessToken: 'access-old',
      oauthRefreshState: 'reauthorization_required',
      oauthRefreshFailureCount: 1,
      oauthRefreshRetryAt: null,
    });
  });

  it('persists Retry-After cooldown and exponential account backoff for provider 429 responses', async () => {
    const account = await createOauthAccount();
    refreshAccessTokenMock.mockRejectedValue(new OAuthProviderHttpError({
      provider: 'codex',
      statusCode: 429,
      message: 'rate limited refresh_token=super-secret',
      retryAfterMs: 120_000,
    }));
    const startedAt = Date.now();

    await expect(refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'scheduled',
      leaseWaitMs: 0,
    })).rejects.toMatchObject({
      code: 'provider_failure',
      retryAfterMs: 120_000,
      refreshState: 'transient_error',
      transient: true,
    });

    const durable = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    const providerState = await db.select().from(schema.oauthRefreshProviderStates)
      .where(eq(schema.oauthRefreshProviderStates.provider, 'codex'))
      .get();
    expect(durable).toMatchObject({
      accessToken: 'access-old',
      oauthRefreshState: 'transient_error',
      oauthRefreshFailureCount: 1,
    });
    expect(durable?.oauthRefreshLastError).not.toContain('super-secret');
    expect(Date.parse(durable?.oauthRefreshRetryAt || '')).toBeGreaterThanOrEqual(startedAt + 120_000);
    expect(Date.parse(providerState?.nextAllowedAt || '')).toBeGreaterThanOrEqual(startedAt + 120_000);

    await expect(refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'scheduled',
      leaseWaitMs: 0,
    })).rejects.toMatchObject({
      code: 'refresh_deferred',
      refreshState: 'transient_error',
      transient: true,
    });
    expect(refreshAccessTokenMock).toHaveBeenCalledOnce();
  });

  it('marks the account refresh_unknown when provider success cannot be durably persisted', async () => {
    const account = await createOauthAccount();
    refreshAccessTokenMock.mockResolvedValue(buildRefreshResult());
    await db.run(sql`
      CREATE TRIGGER fail_oauth_access_token_update
      BEFORE UPDATE OF access_token ON accounts
      WHEN NEW.access_token <> OLD.access_token
      BEGIN
        SELECT RAISE(ABORT, 'simulated oauth credential persistence failure');
      END
    `);

    await expect(refreshOauthAccessTokenCoordinated(account.id, {
      reason: 'unauthorized',
      failedAccessToken: 'access-old',
    })).rejects.toBeInstanceOf(OAuthRefreshCoordinatorError);

    const durable = await db.select().from(schema.accounts).where(eq(schema.accounts.id, account.id)).get();
    expect(durable).toMatchObject({
      accessToken: 'access-old',
      oauthCredentialVersion: 1,
      oauthRefreshState: 'refresh_unknown',
      oauthRefreshFailureCount: 1,
      oauthRefreshRetryAt: null,
    });
    expect(durable?.oauthRefreshLastError).toContain('persistence is unknown');
  });
});
