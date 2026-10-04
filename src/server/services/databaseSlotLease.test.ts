import { describe, expect, it, vi } from 'vitest';
import { claimDatabaseLeaseSlot, DatabaseSlotLease, isDatabaseLeaseCollision } from './databaseSlotLease.js';

describe('shared database slot lease contract', () => {
  it('retries unique-slot collisions across dialects while preserving other storage errors', async () => {
    for (const code of ['SQLITE_CONSTRAINT_UNIQUE', '23505', 'ER_DUP_ENTRY']) expect(isDatabaseLeaseCollision({ cause: { code } })).toBe(true);
    expect(isDatabaseLeaseCollision({ code: 'SQLITE_CONSTRAINT_NOTNULL' })).toBe(false);
    expect(isDatabaseLeaseCollision({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })).toBe(false);
    const claim = vi.fn(async (slot: number) => { if (slot === 2) throw Object.assign(new Error('occupied'), { code: '23505' }); });
    expect(await claimDatabaseLeaseSlot(3, claim, new Set([1]))).toMatchObject({ slot: 3 });
    expect(claim.mock.calls.map(([slot]) => slot)).toEqual([2, 3]);
    await expect(claimDatabaseLeaseSlot(1, async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
  });

  it('serializes renewals and waits for renewal before an idempotent release', async () => {
    let resolveRenew!: (value: boolean) => void;
    const renew = vi.fn(() => new Promise<boolean>((resolve) => { resolveRenew = resolve; }));
    const release = vi.fn(async () => {});
    const lease = new DatabaseSlotLease('owner', 1, 1_000, 0, new Date(Date.now() + 1_000).toISOString(), { renew, release });
    const first = lease.renew();
    const second = lease.renew();
    const releasing = lease.release();
    expect(renew).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    resolveRenew(true);
    await Promise.all([first, second, releasing, lease.release()]);
    expect(release).toHaveBeenCalledOnce();
    await lease.renew();
    expect(renew).toHaveBeenCalledOnce();
  });

  it('aborts when a heartbeat loses ownership and stops renewing', async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.fn(async () => false);
      const lease = new DatabaseSlotLease('owner', 1, 1_000, 10, new Date(Date.now() + 1_000).toISOString(), { renew, release: async () => {} });
      await vi.advanceTimersByTimeAsync(50);
      expect(lease.signal.aborted).toBe(true);
      expect(renew).toHaveBeenCalledOnce();
      await expect(lease.renew()).rejects.toThrow('lost or expired');
      await lease.release();
    } finally { vi.useRealTimers(); }
  });
});
