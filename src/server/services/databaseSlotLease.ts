import { randomUUID } from 'node:crypto';

export function isDatabaseLeaseCollision(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const entry = current as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    const code = String(entry.code ?? entry.errno ?? '').toUpperCase();
    const message = String(entry.message || '').toLowerCase();
    if (['23505', '1062', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(code)
      || /unique constraint|duplicate entry|duplicate key/.test(message)) return true;
    current = entry.cause;
  }
  return false;
}

/** The database unique constraint, rather than a process-local counter, arbitrates ownership. */
export async function claimDatabaseLeaseSlot(
  maxSlots: number,
  claim: (slot: number, leaseToken: string) => Promise<void>,
  occupiedSlots: ReadonlySet<number> = new Set(),
): Promise<{ slot: number; leaseToken: string } | null> {
  for (let slot = 1; slot <= maxSlots; slot += 1) {
    if (occupiedSlots.has(slot)) continue;
    const leaseToken = randomUUID();
    try { await claim(slot, leaseToken); return { slot, leaseToken }; }
    catch (error) { if (!isDatabaseLeaseCollision(error)) throw error; }
  }
  return null;
}

export class DatabaseLeaseLostError extends Error {
  constructor() { super('Database concurrency lease was lost or expired'); this.name = 'DatabaseLeaseLostError'; }
}

export class DatabaseSlotLease {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private renewal: Promise<void> | null = null;
  private releasePromise: Promise<void> | null = null;
  private controller = new AbortController();
  private currentExpiresAt: string;
  private released = false;

  constructor(
    readonly leaseToken: string,
    readonly slot: number,
    private readonly ttlMs: number,
    heartbeatIntervalMs: number,
    initialExpiresAt: string,
    private readonly store: {
      renew: (leaseToken: string, now: string, expiresAt: string) => Promise<boolean>;
      release: (leaseToken: string) => Promise<void>;
    },
  ) {
    this.currentExpiresAt = initialExpiresAt;
    if (heartbeatIntervalMs > 0) {
      this.heartbeat = setInterval(() => { void this.renew().catch(() => {}); }, Math.min(heartbeatIntervalMs, Math.max(1, Math.trunc(ttlMs / 3))));
      this.heartbeat.unref?.();
    }
  }

  get expiresAt(): string { return this.currentExpiresAt; }
  get signal(): AbortSignal { return this.controller.signal; }

  renew(): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    if (this.renewal) return this.renewal;
    this.renewal = (async () => {
      try {
        const now = Date.now();
        const expiresAt = new Date(now + this.ttlMs).toISOString();
        if (!await this.store.renew(this.leaseToken, new Date(now).toISOString(), expiresAt)) throw new DatabaseLeaseLostError();
        this.currentExpiresAt = expiresAt;
      } catch (error) {
        this.controller.abort(error);
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        throw error;
      } finally { this.renewal = null; }
    })();
    return this.renewal;
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.released = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.releasePromise = (async () => {
      await this.renewal?.catch(() => {});
      await this.store.release(this.leaseToken);
    })();
    return this.releasePromise;
  }
}
