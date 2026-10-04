import { MAX_SITE_CONCURRENCY, MAX_SITE_CONCURRENCY_WAIT_MS, validateSiteConcurrencyConfig } from '../../shared/siteConcurrency.js';
export { MAX_SITE_CONCURRENCY, MAX_SITE_CONCURRENCY_WAIT_MS } from '../../shared/siteConcurrency.js';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, gt, lte } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { claimDatabaseLeaseSlot, DatabaseSlotLease } from './databaseSlotLease.js';


export class SiteConcurrencyError extends Error {
  readonly localProxyAdmissionFailure = true;
  readonly status = 503;
  readonly code = 'site_capacity_unavailable';
  constructor(message = 'Site concurrency limit reached', options?: { cause?: unknown }) {
    super(message, options); this.name = 'SiteConcurrencyError';
  }
}

export function isSiteConcurrencyError(error: unknown): error is SiteConcurrencyError {
  return getSiteConcurrencyError(error) !== null;
}

export function getSiteConcurrencyError(error: unknown): SiteConcurrencyError | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof SiteConcurrencyError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export class SiteConcurrencyLease extends DatabaseSlotLease {
  constructor(readonly siteId: number, leaseToken: string, slot: number, ttlMs: number, heartbeatIntervalMs: number, expiresAt: string) {
    super(leaseToken, slot, ttlMs, heartbeatIntervalMs, expiresAt, {
      async renew(token, now, nextExpiresAt) {
        const result = await db.update(schema.siteConcurrencyLeases).set({ expiresAt: nextExpiresAt, updatedAt: now })
          .where(and(eq(schema.siteConcurrencyLeases.leaseToken, token), gt(schema.siteConcurrencyLeases.expiresAt, now))).run();
        return result.changes > 0;
      },
      async release(token) { await db.delete(schema.siteConcurrencyLeases).where(eq(schema.siteConcurrencyLeases.leaseToken, token)).run(); },
    });
  }
}

async function loadPolicy(siteId: number) {
  const site = await db.select({ maxConcurrency: schema.sites.maxConcurrency, concurrencyWaitTimeoutMs: schema.sites.concurrencyWaitTimeoutMs, status: schema.sites.status })
    .from(schema.sites).where(eq(schema.sites.id, siteId)).get();
  if (!site || site.status !== 'active') throw new SiteConcurrencyError('Site is unavailable');
  if (validateSiteConcurrencyConfig(site)) {
    throw new SiteConcurrencyError('Invalid site concurrency configuration');
  }
  return site;
}

export async function acquireSiteConcurrencyLease(siteId: number, options: {
  signal?: AbortSignal;
  ttlMs?: number;
  heartbeatIntervalMs?: number;
  waitTimeoutMs?: number;
} = {}): Promise<SiteConcurrencyLease | null> {
  const startedAt = Date.now();
  const ttlMs = Math.max(1_000, Math.trunc(options.ttlMs ?? 90_000));
  const heartbeatIntervalMs = Math.max(0, Math.trunc(options.heartbeatIntervalMs ?? 30_000));
  try {
    options.signal?.throwIfAborted();
    const initialPolicy = await loadPolicy(siteId);
    const waitMs = Math.max(0, Math.min(MAX_SITE_CONCURRENCY_WAIT_MS, Math.trunc(options.waitTimeoutMs ?? initialPolicy.concurrencyWaitTimeoutMs)));
    const deadline = startedAt + waitMs;
    let policy = initialPolicy;
    for (;;) {
      options.signal?.throwIfAborted();
      if (policy.maxConcurrency === null) return null;
      const now = new Date().toISOString();
      await db.delete(schema.siteConcurrencyLeases).where(and(eq(schema.siteConcurrencyLeases.siteId, siteId), lte(schema.siteConcurrencyLeases.expiresAt, now))).run();
      const active = await db.select({ slot: schema.siteConcurrencyLeases.slot }).from(schema.siteConcurrencyLeases)
        .where(and(eq(schema.siteConcurrencyLeases.siteId, siteId), gt(schema.siteConcurrencyLeases.expiresAt, now))).all();
      if (active.length < policy.maxConcurrency) {
        const expiresAt = new Date(Date.now() + ttlMs).toISOString();
        const claimed = await claimDatabaseLeaseSlot(policy.maxConcurrency, async (slot, leaseToken) => {
          options.signal?.throwIfAborted();
          await db.insert(schema.siteConcurrencyLeases).values({ siteId, leaseToken, slot, expiresAt, createdAt: now, updatedAt: now }).run();
        }, new Set(active.map((row) => row.slot)));
        if (claimed) {
          const lease = new SiteConcurrencyLease(siteId, claimed.leaseToken, claimed.slot, ttlMs, 0, expiresAt);
          try {
            options.signal?.throwIfAborted();
            const currentPolicy = await loadPolicy(siteId);
            const current = await db.select({ slot: schema.siteConcurrencyLeases.slot }).from(schema.siteConcurrencyLeases)
              .where(and(eq(schema.siteConcurrencyLeases.siteId, siteId), gt(schema.siteConcurrencyLeases.expiresAt, new Date().toISOString()))).all();
            if (currentPolicy.maxConcurrency === null) { await lease.release(); return null; }
            if (current.length <= currentPolicy.maxConcurrency) {
              await lease.renew();
              options.signal?.throwIfAborted();
              return new SiteConcurrencyLease(siteId, claimed.leaseToken, claimed.slot, ttlMs, heartbeatIntervalMs, lease.expiresAt);
            }
          } catch (error) { await lease.release(); throw error; }
          await lease.release();
        }
      }
      if (Date.now() >= deadline) throw new SiteConcurrencyError();
      await delay(Math.min(25, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal });
      policy = await loadPolicy(siteId);
    }
  } catch (error) {
    if (options.signal?.aborted || isSiteConcurrencyError(error)) throw error;
    throw new SiteConcurrencyError('Site concurrency capacity could not be acquired', { cause: error });
  }
}
