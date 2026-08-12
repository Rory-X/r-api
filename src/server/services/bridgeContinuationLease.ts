export type BridgeContinuationLease = Readonly<{
  sessionKey: string;
  ownerId: string;
  leaseToken: string;
  acquiredAtMs: number;
  expiresAtMs: number;
}>;

export type BridgeContinuationLeaseAcquireResult =
  | Readonly<{ acquired: true; reentrant: boolean; lease: BridgeContinuationLease }>
  | Readonly<{ acquired: false; reason: 'held'; retryAtMs: number; lease: BridgeContinuationLease }>;

function normalizedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || normalized.includes('\0')) {
    throw new Error(`Invalid bridge continuation ${label}`);
  }
  return normalized;
}

function normalizedNow(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : Date.now();
}

function normalizedTtl(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Bridge continuation lease TTL must be positive');
  return Math.min(24 * 60 * 60 * 1_000, Math.max(1_000, Math.trunc(value)));
}

function createLease(input: {
  sessionKey: string;
  ownerId: string;
  leaseToken: string;
  nowMs: number;
  ttlMs: number;
  acquiredAtMs?: number;
}): BridgeContinuationLease {
  return Object.freeze({
    sessionKey: normalizedIdentifier(input.sessionKey, 'session key'),
    ownerId: normalizedIdentifier(input.ownerId, 'owner id'),
    leaseToken: normalizedIdentifier(input.leaseToken, 'lease token'),
    acquiredAtMs: input.acquiredAtMs ?? input.nowMs,
    expiresAtMs: input.nowMs + input.ttlMs,
  });
}

export function acquireBridgeContinuationLease(
  current: BridgeContinuationLease | null,
  input: {
    sessionKey: string;
    ownerId: string;
    leaseToken: string;
    ttlMs: number;
    nowMs?: number;
  },
): BridgeContinuationLeaseAcquireResult {
  const nowMs = normalizedNow(input.nowMs);
  const ttlMs = normalizedTtl(input.ttlMs);
  const sessionKey = normalizedIdentifier(input.sessionKey, 'session key');
  const ownerId = normalizedIdentifier(input.ownerId, 'owner id');
  const leaseToken = normalizedIdentifier(input.leaseToken, 'lease token');
  if (current && current.sessionKey !== sessionKey) {
    throw new Error('Bridge continuation lease belongs to another session');
  }
  if (current && current.expiresAtMs > nowMs) {
    if (current.ownerId !== ownerId || current.leaseToken !== leaseToken) {
      return Object.freeze({ acquired: false, reason: 'held', retryAtMs: current.expiresAtMs, lease: current });
    }
    return Object.freeze({
      acquired: true,
      reentrant: true,
      lease: createLease({
        sessionKey,
        ownerId,
        leaseToken,
        nowMs,
        ttlMs,
        acquiredAtMs: current.acquiredAtMs,
      }),
    });
  }
  return Object.freeze({
    acquired: true,
    reentrant: false,
    lease: createLease({ sessionKey, ownerId, leaseToken, nowMs, ttlMs }),
  });
}

export function renewBridgeContinuationLease(
  current: BridgeContinuationLease | null,
  input: {
    sessionKey: string;
    ownerId: string;
    leaseToken: string;
    ttlMs: number;
    nowMs?: number;
  },
): Readonly<
  | { renewed: true; lease: BridgeContinuationLease }
  | { renewed: false; reason: 'missing' | 'expired' | 'stale'; lease: BridgeContinuationLease | null }
> {
  if (!current) return Object.freeze({ renewed: false, reason: 'missing', lease: null });
  const nowMs = normalizedNow(input.nowMs);
  if (current.expiresAtMs <= nowMs) return Object.freeze({ renewed: false, reason: 'expired', lease: current });
  if (
    current.sessionKey !== input.sessionKey.trim()
    || current.ownerId !== input.ownerId.trim()
    || current.leaseToken !== input.leaseToken.trim()
  ) {
    return Object.freeze({ renewed: false, reason: 'stale', lease: current });
  }
  return Object.freeze({
    renewed: true,
    lease: createLease({
      sessionKey: current.sessionKey,
      ownerId: current.ownerId,
      leaseToken: current.leaseToken,
      nowMs,
      ttlMs: normalizedTtl(input.ttlMs),
      acquiredAtMs: current.acquiredAtMs,
    }),
  });
}

export function releaseBridgeContinuationLease(
  current: BridgeContinuationLease | null,
  input: { sessionKey: string; ownerId: string; leaseToken: string },
): Readonly<
  | { released: true; lease: null }
  | { released: false; reason: 'missing' | 'stale'; lease: BridgeContinuationLease | null }
> {
  if (!current) return Object.freeze({ released: false, reason: 'missing', lease: null });
  if (
    current.sessionKey !== input.sessionKey.trim()
    || current.ownerId !== input.ownerId.trim()
    || current.leaseToken !== input.leaseToken.trim()
  ) {
    return Object.freeze({ released: false, reason: 'stale', lease: current });
  }
  return Object.freeze({ released: true, lease: null });
}
