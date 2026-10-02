import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const refreshManagedMock = vi.fn();
const sendNotificationMock = vi.fn();

vi.mock('./managedCredentialRefreshService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./managedCredentialRefreshService.js')>();
  return {
    ...actual,
    refreshManagedAccountCredential: (...args: unknown[]) => refreshManagedMock(...args),
  };
});

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type OperationsModule = typeof import('./credentialLifecycleOperationsService.js');
type PolicyModule = typeof import('./credentialLifecyclePolicyService.js');
type VaultModule = typeof import('./credentialVaultService.js');

describe('credential lifecycle operations service', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let operations: OperationsModule;
  let policyService: PolicyModule;
  let vault: VaultModule;
  let dataDir = '';
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-lifecycle-operations-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    operations = await import('./credentialLifecycleOperationsService.js');
    policyService = await import('./credentialLifecyclePolicyService.js');
    vault = await import('./credentialVaultService.js');
  });

  beforeEach(async () => {
    refreshManagedMock.mockReset();
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ attempted: 0, succeeded: 0, failed: 0 });
    await db.delete(schema.credentialLifecycleAudits).run();
    await db.delete(schema.credentialRefreshJobs).run();
    await db.delete(schema.oauthRefreshLeases).run();
    await db.delete(schema.oauthRefreshProviderStates).run();
    await db.delete(schema.credentialImportProvenance).run();
    await db.delete(schema.credentialImportItems).run();
    await db.delete(schema.credentialImportJobs).run();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    const site = await db.insert(schema.sites).values({
      name: 'Credential Operations Site',
      url: 'https://credential-operations.example.com',
      platform: 'new-api',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    await operations.stopCredentialLifecycleScheduler();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  it('persists configurable expiry lead and retry policy', async () => {
    const policy = await policyService.setCredentialLifecyclePolicy({
      expiryWarningLeadMinutes: 180,
      retryBaseSeconds: 12,
      retryMaxSeconds: 90,
      retryMaxAttempts: 4,
      providerRefreshLeadMinutes: { codex: 360 },
    }, new Date('2026-08-18T00:00:00.000Z'));

    expect(policy).toMatchObject({
      expiryWarningLeadMinutes: 180,
      retryBaseSeconds: 12,
      retryMaxSeconds: 90,
      retryMaxAttempts: 4,
      providerRefreshLeadMinutes: { codex: 360 },
      updatedAt: '2026-08-18T00:00:00.000Z',
    });
    await expect(policyService.getCredentialLifecyclePolicy()).resolves.toMatchObject({
      expiryWarningLeadMinutes: 180,
      retryBaseSeconds: 12,
      retryMaxSeconds: 90,
    });
  });

  it('emits one reminder per expiry window and records a queryable audit', async () => {
    const nowMs = Date.parse('2026-08-18T02:00:00.000Z');
    await policyService.setCredentialLifecyclePolicy({
      expiryWarningLeadMinutes: 120,
      automaticRemindersEnabled: true,
      automaticRefreshEnabled: false,
    });
    const item = await vault.storeCredentialVaultItem({
      siteId,
      name: 'expiring browser session',
      kind: 'browser_storage',
      secret: 'expiry-reminder-secret',
      expiresAt: new Date(nowMs + 60 * 60 * 1_000).toISOString(),
    });

    const first = await operations.executeCredentialLifecycleOperationsPass({ nowMs });
    const second = await operations.executeCredentialLifecycleOperationsPass({ nowMs: nowMs + 1_000 });

    expect(first.reminders).toBe(1);
    expect(second.reminders).toBe(0);
    expect(sendNotificationMock).toHaveBeenCalledOnce();
    const audits = await operations.listCredentialLifecycleAudits({
      source: 'vault',
      operatorId: 'system:credential-lifecycle',
      status: 'expiring',
    });
    expect(audits.total).toBe(1);
    expect(audits.items[0]).toMatchObject({
      entityType: 'vault_item',
      entityId: item.id,
      action: 'expiry_reminder',
      outcome: 'notified',
    });
  });

  it('classifies provider throttling and schedules exponential retry', async () => {
    const nowMs = Date.now();
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'rate-limited@example.com',
      accessToken: 'rate-limited-access',
      oauthProvider: 'codex',
      oauthAccountKey: 'rate-limited-account',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'rate-limited-refresh',
        tokenExpiresAt: nowMs + 60_000,
      }),
      oauthRefreshState: 'ready',
    }).returning().get();
    await policyService.setCredentialLifecyclePolicy({
      automaticRemindersEnabled: false,
      automaticRefreshEnabled: true,
      retryBaseSeconds: 10,
      retryMaxSeconds: 120,
      retryMaxAttempts: 5,
    });
    const { OAuthRefreshCoordinatorError } = await import('./oauth/refreshCoordinator.js');
    refreshManagedMock.mockRejectedValueOnce(new OAuthRefreshCoordinatorError({
      code: 'provider_rate_limited',
      message: 'provider rate limited',
      retryAfterMs: 45_000,
      transient: true,
    }));

    const result = await operations.executeCredentialLifecycleOperationsPass({ nowMs });
    const queue = await operations.listCredentialRefreshQueue({ failureCode: 'rate_limited' });

    expect(result).toMatchObject({ claimed: 1, succeeded: 0, failed: 0, deferred: 1 });
    expect(queue.total).toBe(1);
    expect(queue.items[0]).toMatchObject({
      entityId: account.id,
      status: 'retry_wait',
      failureClass: 'rate_limited',
      attemptCount: 1,
      maxAttempts: 5,
      failureClassification: {
        code: 'rate_limited',
        errorScope: 'upstream_gateway',
        healthDomain: 'gateway',
        alertCategory: 'capacity',
        alertSeverity: 'warning',
        retryable: true,
      },
    });
    expect(Date.parse(queue.items[0]!.nextAttemptAt!)).toBeGreaterThanOrEqual(nowMs + 45_000);
  });

  it('keeps exhausted jobs terminal until an operator explicitly requeues them', async () => {
    const nowMs = Date.now();
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'terminal-retry@example.com',
      accessToken: 'terminal-retry-access',
      oauthProvider: 'codex',
      oauthAccountKey: 'terminal-retry-account',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'terminal-retry-refresh',
        tokenExpiresAt: nowMs + 60_000,
      }),
      oauthRefreshState: 'ready',
    }).returning().get();
    await policyService.setCredentialLifecyclePolicy({
      automaticRemindersEnabled: false,
      automaticRefreshEnabled: true,
      retryMaxAttempts: 1,
    });
    refreshManagedMock.mockRejectedValueOnce(new Error('HTTP 503 provider unavailable'));

    const first = await operations.executeCredentialLifecycleOperationsPass({ nowMs });
    const terminalQueue = await operations.listCredentialRefreshQueue({ status: 'failed_terminal' });
    const second = await operations.executeCredentialLifecycleOperationsPass({ nowMs: nowMs + 1_000 });

    expect(first).toMatchObject({ claimed: 1, failed: 1 });
    expect(terminalQueue.items[0]).toMatchObject({
      entityId: account.id,
      failureClass: 'provider_unavailable',
      attemptCount: 1,
    });
    expect(second.claimed).toBe(0);

    await operations.retryCredentialRefreshJob({
      jobId: terminalQueue.items[0]!.id,
      operatorId: 'admin:retry-test',
    });
    refreshManagedMock.mockResolvedValueOnce('OAuth 凭证刷新完成');
    const retried = await operations.executeCredentialLifecycleOperationsPass({
      nowMs: nowMs + 2_000,
      forceRefreshQueue: true,
    });
    const succeeded = await operations.listCredentialRefreshQueue({ status: 'succeeded' });

    expect(retried.succeeded).toBe(1);
    expect(succeeded.items[0]).toMatchObject({ entityId: account.id, attemptCount: 1 });
    const audits = await operations.listCredentialLifecycleAudits({
      operatorId: 'admin:retry-test',
      action: 'refresh_retry_enqueue',
    });
    expect(audits.total).toBe(1);
  });

  it('stops r-api work when Refresh Owner is assigned externally', async () => {
    const nowMs = Date.now();
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'external-owner@example.com',
      accessToken: 'external-owner-access',
      oauthProvider: 'codex',
      oauthAccountKey: 'external-owner-account',
      oauthCredentialPayload: JSON.stringify({
        refreshToken: 'external-owner-refresh',
        tokenExpiresAt: nowMs + 60_000,
      }),
      oauthRefreshState: 'ready',
    }).returning().get();

    await operations.setCredentialRefreshOwner({
      accountId: account.id,
      refreshOwner: 'external',
      operatorId: 'admin:owner-test',
    });
    const result = await operations.executeCredentialLifecycleOperationsPass({ nowMs, forceRefreshQueue: true });
    const queue = await operations.listCredentialRefreshQueue({ status: 'owner_conflict' });
    const audits = await operations.listCredentialLifecycleAudits({
      operatorId: 'admin:owner-test',
      status: 'external',
    });

    expect(result.claimed).toBe(0);
    expect(refreshManagedMock).not.toHaveBeenCalled();
    expect(queue.items[0]).toMatchObject({
      entityId: account.id,
      refreshOwner: 'external',
      failureClass: 'owner_conflict',
    });
    expect(audits.items[0]).toMatchObject({
      action: 'refresh_owner_change',
      outcome: 'succeeded',
    });
  });
});
