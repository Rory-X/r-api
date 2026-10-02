import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type QuotaModule = typeof import('./downstreamKeyQuotaService.js');

describe('downstreamKeyQuotaService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let quota: QuotaModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-downstream-quota-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    quota = await import('./downstreamKeyQuotaService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.downstreamKeyQuotaReservations).run();
    await db.delete(schema.downstreamKeyUsageWindows).run();
    await db.delete(schema.downstreamKeyLimitPolicies).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('atomically reserves and settles hard request quotas', async () => {
    const key = await db.insert(schema.downstreamApiKeys).values({ name: 'quota', key: 'sk-quota', enabled: true }).returning().get();
    const [policy] = await quota.replaceDownstreamKeyLimitPolicies(key.id, [{
      metric: 'requests',
      windowType: 'fixed',
      windowSeconds: 60,
      limitValue: 2,
    }]);
    expect(policy?.metric).toBe('requests');

    const at = new Date('2026-08-20T12:34:10.000Z');
    const first = await quota.reserveDownstreamKeyQuota({ keyId: key.id, amounts: { requests: 1 }, now: at });
    const second = await quota.reserveDownstreamKeyQuota({ keyId: key.id, amounts: { requests: 1 }, now: at });
    const rejected = await quota.reserveDownstreamKeyQuota({ keyId: key.id, amounts: { requests: 1 }, now: at });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(rejected).toMatchObject({ ok: false, statusCode: 429, metric: 'requests', remaining: 0 });
    if (!first.ok || !first.reservation || !second.ok || !second.reservation) return;

    expect(await quota.settleDownstreamKeyQuotaReservation(first.reservation.token, { requests: 1 }, at)).toBe(true);
    expect(await quota.releaseDownstreamKeyQuotaReservation(second.reservation.token, at)).toBe(true);

    const snapshot = await quota.readDownstreamKeyQuotaWindows({ keyId: key.id, now: at });
    expect(snapshot[0]).toMatchObject({ usedValue: 1, reservedValue: 0, remaining: 1 });
    const reservations = await db.select().from(schema.downstreamKeyQuotaReservations).all();
    expect(reservations.map((row) => row.status).sort()).toEqual(['released', 'settled']);
  });

  it('supports calendar-day cost windows and recovers expired reservations', async () => {
    const key = await db.insert(schema.downstreamApiKeys).values({ name: 'daily', key: 'sk-daily', enabled: true }).returning().get();
    await quota.replaceDownstreamKeyLimitPolicies(key.id, [{
      metric: 'cost',
      windowType: 'calendar_day',
      limitValue: 10,
      warningThresholds: [0.7, 0.85, 1],
    }]);
    const at = new Date('2026-08-20T23:59:00.000Z');
    const reservation = await quota.reserveDownstreamKeyQuota({
      keyId: key.id,
      amounts: { cost: 4 },
      now: at,
      ttlMs: 30_000,
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok || !reservation.reservation) return;

    expect(await quota.recoverExpiredDownstreamKeyQuotaReservations(new Date('2026-08-21T00:00:00.000Z'))).toBe(1);
    const windows = await db.select().from(schema.downstreamKeyUsageWindows).all();
    expect(windows[0]).toMatchObject({ usedValue: 0, reservedValue: 0 });
    const stored = await db.select().from(schema.downstreamKeyQuotaReservations)
      .where(eq(schema.downstreamKeyQuotaReservations.reservationToken, reservation.reservation.token)).get();
    expect(stored?.status).toBe('expired');
  });

  it('records post-response cost into every matching policy window', async () => {
    const key = await db.insert(schema.downstreamApiKeys).values({ name: 'cost', key: 'sk-cost', enabled: true }).returning().get();
    await quota.replaceDownstreamKeyLimitPolicies(key.id, [
      { metric: 'cost', windowType: 'calendar_day', limitValue: 10 },
      { metric: 'cost', windowType: 'calendar_month', limitValue: 100 },
    ]);
    await quota.recordDownstreamKeyQuotaUsage(key.id, 'cost', 1.25, new Date('2026-08-20T12:00:00.000Z'));
    const snapshots = await quota.readDownstreamKeyQuotaWindows({ keyId: key.id, now: new Date('2026-08-20T12:00:00.000Z') });
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'cost', usedValue: 1.25 }),
    ]));
    expect(snapshots).toHaveLength(2);
  });
});
