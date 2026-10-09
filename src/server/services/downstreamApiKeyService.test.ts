import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./downstreamApiKeyService.js');

describe('downstreamApiKeyService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-downstream-key-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./downstreamApiKeyService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    service = serviceModule;
  });

  beforeEach(async () => {
    await db.delete(schema.downstreamApiKeyLeases).run();
    await db.delete(schema.downstreamApiKeyRateWindows).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.tokenRoutes).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('rejects unknown tokens instead of falling back to a global credential', async () => {
    const result = await service.authorizeDownstreamToken('sk-legacy-proxy-token');
    expect(result).toMatchObject({ ok: false, statusCode: 403, reason: 'invalid' });
  });

  it('rejects managed keys by lifecycle guards (disabled, expired, over budget, over requests)', async () => {
    const now = Date.now();

    const disabled = await db.insert(schema.downstreamApiKeys).values({
      name: 'disabled',
      key: 'sk-disabled',
      enabled: false,
    }).returning().get();

    const expired = await db.insert(schema.downstreamApiKeys).values({
      name: 'expired',
      key: 'sk-expired',
      enabled: true,
      expiresAt: new Date(now - 60_000).toISOString(),
    }).returning().get();

    const overBudget = await db.insert(schema.downstreamApiKeys).values({
      name: 'over-budget',
      key: 'sk-over-budget',
      enabled: true,
      maxCost: 1,
      usedCost: 1.2,
    }).returning().get();

    const overRequests = await db.insert(schema.downstreamApiKeys).values({
      name: 'over-requests',
      key: 'sk-over-requests',
      enabled: true,
      maxRequests: 10,
      usedRequests: 10,
    }).returning().get();

    const r1 = await service.authorizeDownstreamToken(disabled.key);
    const r2 = await service.authorizeDownstreamToken(expired.key);
    const r3 = await service.authorizeDownstreamToken(overBudget.key);
    const r4 = await service.authorizeDownstreamToken(overRequests.key);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(r4.ok).toBe(false);
  });

  it('atomically reserves requests inside a UTC minute window', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'rpm-key',
      key: 'sk-rpm-key',
      enabled: true,
      requestsPerMinute: 2,
    }).returning().get();
    const firstAt = new Date('2026-08-20T12:34:10.000Z');

    const first = await service.reserveManagedKeyRequest(row.id, row.requestsPerMinute, firstAt);
    const second = await service.reserveManagedKeyRequest(row.id, row.requestsPerMinute, new Date('2026-08-20T12:34:20.000Z'));
    const third = await service.reserveManagedKeyRequest(row.id, row.requestsPerMinute, new Date('2026-08-20T12:34:30.000Z'));
    const nextWindow = await service.reserveManagedKeyRequest(row.id, row.requestsPerMinute, new Date('2026-08-20T12:35:00.000Z'));

    expect(first).toMatchObject({ ok: true, remaining: 1, resetAt: '2026-08-20T12:35:00.000Z' });
    expect(second).toMatchObject({ ok: true, remaining: 0, resetAt: '2026-08-20T12:35:00.000Z' });
    expect(third).toMatchObject({
      ok: false,
      statusCode: 429,
      reason: 'requests_per_minute',
      remaining: 0,
      resetAt: '2026-08-20T12:35:00.000Z',
    });
    expect(nextWindow).toMatchObject({ ok: true, remaining: 1, resetAt: '2026-08-20T12:36:00.000Z' });

    const windows = await db.select().from(schema.downstreamApiKeyRateWindows)
      .where(eq(schema.downstreamApiKeyRateWindows.downstreamApiKeyId, row.id)).all();
    expect(windows).toHaveLength(2);
    expect(windows.map((window) => window.reservedRequests)).toEqual([2, 1]);
  });

  it('parses policy fields and supports model matching patterns', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'project-a',
      key: 'sk-project-a',
      enabled: true,
      supportedModels: JSON.stringify(['re:^claude-(opus|sonnet)-4-6$', 'gpt-4o-mini']),
      allowedRouteIds: JSON.stringify([101, 102]),
      siteWeightMultipliers: JSON.stringify({ '1': 2.5, '7': 0.4 }),
      allowedCredentialRefs: JSON.stringify([
        { kind: 'default_api_key', siteId: 1, accountId: 11 },
      ]),
    }).returning().get();

    const result = await service.authorizeDownstreamToken(row.key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.key?.id).toBe(row.id);
    expect(result.policy.allowedRouteIds).toEqual([101, 102]);
    expect(result.policy.siteWeightMultipliers[1]).toBeCloseTo(2.5);
    expect(result.policy.siteWeightMultipliers[7]).toBeCloseTo(0.4);
    expect(result.policy.allowedCredentialRefs).toEqual([
      { kind: 'default_api_key', siteId: 1, accountId: 11 },
    ]);

    expect(service.isModelAllowedByPolicy('claude-opus-4-6', result.policy)).toBe(true);
    expect(service.isModelAllowedByPolicy('gpt-4o-mini', result.policy)).toBe(true);
    expect(service.isModelAllowedByPolicy('gemini-2.0-flash', result.policy)).toBe(false);
  });

  it('keeps all explicitly selected supported models when list exceeds 200 items', () => {
    const selectedModels = Array.from({ length: 260 }, (_, index) => `model-${String(index + 1).padStart(3, '0')}`);

    expect(service.normalizeSupportedModelsInput(selectedModels)).toEqual(selectedModels);
  });

  it('treats selected groups as additional allowed exposed route scope (union semantics)', async () => {
    const claudeGroup = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      displayName: 'claude-4-6-group',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: ['gpt-4o-mini'],
      allowedRouteIds: [claudeGroup.id],
      siteWeightMultipliers: {},
    };

    expect(service.isModelAllowedByPolicy('claude-4-6-group', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-4-6-group', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gemini-2.0-flash', policy)).toBe(false);
  });

  it('denies all models when both supportedModels and allowedRouteIds are empty', async () => {
    const policy = {
      supportedModels: [],
      allowedRouteIds: [],
      siteWeightMultipliers: {},
      denyAllWhenEmpty: true,
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(false);
  });

  it('treats empty managed-key selections as runtime-wide access by default', async () => {
    const policy = service.toPolicyFromView({
      supportedModels: [],
      allowedRouteIds: [],
      siteWeightMultipliers: {},
      excludedSiteIds: [],
      excludedCredentialRefs: [],
    });

    expect(policy.denyAllWhenEmpty).not.toBe(true);
    await expect(service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).resolves.toBe(true);
    await expect(service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).resolves.toBe(true);
  });

  it('authorizes by selected group model pattern only, not arbitrary internal models', async () => {
    const virtualModelGroup = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [virtualModelGroup.id],
      siteWeightMultipliers: {},
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-sonnet-4-6', policy)).toBe(false);
  });

  it('only authorizes selected route display name alias, not models covered by group pattern', async () => {
    const aliasRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-5$',
      displayName: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [aliasRoute.id],
      siteWeightMultipliers: {},
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-sonnet-4-5', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-5', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(false);
  });

  it('accumulates managed key request/cost usage and applies limits', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'metered-key',
      key: 'sk-metered-key',
      enabled: true,
      maxRequests: 2,
      maxCost: 1,
      usedRequests: 0,
      usedCost: 0,
    }).returning().get();

    await service.consumeManagedKeyRequest(row.id);
    await service.consumeManagedKeyRequest(row.id);
    await service.recordManagedKeyCostUsage(row.id, 0.4);
    await service.recordManagedKeyCostUsage(row.id, 0.6);

    const latest = await service.getDownstreamApiKeyById(row.id);
    expect(latest?.usedRequests).toBe(2);
    expect(latest?.usedCost).toBeCloseTo(1);

    const authResult = await service.authorizeDownstreamToken(row.key);
    expect(authResult.ok).toBe(false);
  });

  it('captures an immutable policy snapshot that survives ordinary policy edits', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'snapshot-key',
      key: 'sk-snapshot-key',
      enabled: true,
      maxConcurrency: 2,
      policyVersion: 4,
      supportedModels: JSON.stringify(['gpt-4.1']),
      allowedRouteIds: JSON.stringify([11]),
      siteWeightMultipliers: JSON.stringify({ 7: 1.5 }),
    }).returning().get();

    const first = await service.authorizeDownstreamToken(row.key);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.snapshot.policyVersion).toBe(4);
    expect(first.snapshot.maxConcurrency).toBe(2);
    expect(first.snapshot.policy.supportedModels).toEqual(['gpt-4.1']);
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.policy)).toBe(true);
    expect(Object.isFrozen(first.snapshot.policy.supportedModels)).toBe(true);

    await db.update(schema.downstreamApiKeys).set({
      supportedModels: JSON.stringify(['gpt-5.4']),
      maxConcurrency: 5,
      policyVersion: 5,
    }).where(eq(schema.downstreamApiKeys.id, row.id)).run();

    expect(first.snapshot.policy.supportedModels).toEqual(['gpt-4.1']);
    expect(first.snapshot.maxConcurrency).toBe(2);
    expect(await service.verifyDownstreamPolicySnapshotActive(first.snapshot)).toEqual({ ok: true });

    const second = await service.authorizeDownstreamToken(row.key);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.snapshot.policyVersion).toBe(5);
    expect(second.snapshot.maxConcurrency).toBe(5);
    expect(second.snapshot.policy.supportedModels).toEqual(['gpt-5.4']);
  });

  it('detects disable, expiry, key rotation, and deletion without invalidating ordinary edits', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'revocable-key',
      key: 'sk-revocable-key',
      enabled: true,
    }).returning().get();
    const authorized = await service.authorizeDownstreamToken(row.key);
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    await db.update(schema.downstreamApiKeys).set({
      name: 'ordinary-edit',
      policyVersion: 2,
    }).where(eq(schema.downstreamApiKeys.id, row.id)).run();
    expect(await service.verifyDownstreamPolicySnapshotActive(authorized.snapshot)).toEqual({ ok: true });

    await db.update(schema.downstreamApiKeys).set({ enabled: false })
      .where(eq(schema.downstreamApiKeys.id, row.id)).run();
    expect(await service.verifyDownstreamPolicySnapshotActive(authorized.snapshot)).toMatchObject({
      ok: false,
      reason: 'disabled',
    });

    await db.update(schema.downstreamApiKeys).set({
      enabled: true,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }).where(eq(schema.downstreamApiKeys.id, row.id)).run();
    expect(await service.verifyDownstreamPolicySnapshotActive(authorized.snapshot)).toMatchObject({
      ok: false,
      reason: 'expired',
    });

    await db.update(schema.downstreamApiKeys).set({
      expiresAt: null,
      key: 'sk-revocable-key-rotated',
    }).where(eq(schema.downstreamApiKeys.id, row.id)).run();
    expect(await service.verifyDownstreamPolicySnapshotActive(authorized.snapshot)).toMatchObject({
      ok: false,
      reason: 'rotated',
    });

    await db.delete(schema.downstreamApiKeys).where(eq(schema.downstreamApiKeys.id, row.id)).run();
    expect(await service.verifyDownstreamPolicySnapshotActive(authorized.snapshot)).toMatchObject({
      ok: false,
      reason: 'deleted',
    });
  });

  it('enforces managed-key concurrency with durable slots and releases them idempotently', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'single-flight-key',
      key: 'sk-single-flight-key',
      enabled: true,
      maxConcurrency: 1,
    }).returning().get();
    const authorized = await service.authorizeDownstreamToken(row.key);
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    const [first, second] = await Promise.all([
      service.acquireDownstreamConcurrencyLease(authorized.snapshot, { heartbeatIntervalMs: 0 }),
      service.acquireDownstreamConcurrencyLease(authorized.snapshot, { heartbeatIntervalMs: 0 }),
    ]);
    const acquired = [first, second].find((result) => result.ok && result.lease);
    const rejected = [first, second].find((result) => !result.ok);
    expect(acquired?.ok).toBe(true);
    expect(rejected).toMatchObject({ ok: false, reason: 'max_concurrency', statusCode: 429 });
    if (!acquired?.ok || !acquired.lease) return;

    expect(await db.select().from(schema.downstreamApiKeyLeases).all()).toHaveLength(1);
    await acquired.lease.release();
    await acquired.lease.release();
    expect(await db.select().from(schema.downstreamApiKeyLeases).all()).toHaveLength(0);

    const next = await service.acquireDownstreamConcurrencyLease(authorized.snapshot, { heartbeatIntervalMs: 0 });
    expect(next.ok).toBe(true);
    if (next.ok) await next.lease?.release();
  });

  it('reclaims expired concurrency slots after an unclean shutdown', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'stale-lease-key',
      key: 'sk-stale-lease-key',
      enabled: true,
      maxConcurrency: 1,
    }).returning().get();
    await db.insert(schema.downstreamApiKeyLeases).values({
      downstreamApiKeyId: row.id,
      leaseToken: 'stale-lease',
      slot: 1,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }).run();
    const authorized = await service.authorizeDownstreamToken(row.key);
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;

    const acquired = await service.acquireDownstreamConcurrencyLease(authorized.snapshot, { heartbeatIntervalMs: 0 });
    expect(acquired.ok).toBe(true);
    expect(await db.select().from(schema.downstreamApiKeyLeases).all()).toHaveLength(1);
    if (acquired.ok) await acquired.lease?.release();
  });
});
