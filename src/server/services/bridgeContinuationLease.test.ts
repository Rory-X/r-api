import { describe, expect, it } from 'vitest';

import {
  acquireBridgeContinuationLease,
  releaseBridgeContinuationLease,
  renewBridgeContinuationLease,
} from './bridgeContinuationLease.js';

describe('bridge continuation lease', () => {
  it('allows only one owner per session until the lease expires', () => {
    const first = acquireBridgeContinuationLease(null, {
      sessionKey: 'device-a:thread-a',
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 10_000,
      nowMs: 1_000,
    });
    expect(first).toMatchObject({ acquired: true, reentrant: false });
    if (!first.acquired) return;

    expect(acquireBridgeContinuationLease(first.lease, {
      sessionKey: 'device-a:thread-a',
      ownerId: 'worker-b',
      leaseToken: 'lease-b',
      ttlMs: 10_000,
      nowMs: 2_000,
    })).toMatchObject({ acquired: false, reason: 'held', retryAtMs: 11_000 });

    expect(acquireBridgeContinuationLease(first.lease, {
      sessionKey: 'device-a:thread-a',
      ownerId: 'worker-b',
      leaseToken: 'lease-b',
      ttlMs: 10_000,
      nowMs: 11_000,
    })).toMatchObject({ acquired: true, reentrant: false, lease: { ownerId: 'worker-b' } });
  });

  it('renews reentrantly but rejects stale renew and release tokens', () => {
    const first = acquireBridgeContinuationLease(null, {
      sessionKey: 'thread-a',
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 5_000,
      nowMs: 1_000,
    });
    if (!first.acquired) return;

    const reentrant = acquireBridgeContinuationLease(first.lease, {
      sessionKey: 'thread-a',
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
      ttlMs: 5_000,
      nowMs: 2_000,
    });
    expect(reentrant).toMatchObject({
      acquired: true,
      reentrant: true,
      lease: { acquiredAtMs: 1_000, expiresAtMs: 7_000 },
    });
    if (!reentrant.acquired) return;

    expect(renewBridgeContinuationLease(reentrant.lease, {
      sessionKey: 'thread-a',
      ownerId: 'worker-a',
      leaseToken: 'stale-token',
      ttlMs: 5_000,
      nowMs: 3_000,
    })).toMatchObject({ renewed: false, reason: 'stale' });
    expect(releaseBridgeContinuationLease(reentrant.lease, {
      sessionKey: 'thread-a',
      ownerId: 'worker-b',
      leaseToken: 'lease-a',
    })).toMatchObject({ released: false, reason: 'stale' });
    expect(releaseBridgeContinuationLease(reentrant.lease, {
      sessionKey: 'thread-a',
      ownerId: 'worker-a',
      leaseToken: 'lease-a',
    })).toEqual({ released: true, lease: null });
  });
});
