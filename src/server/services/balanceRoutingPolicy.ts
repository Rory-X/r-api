export type BalanceRoutingPolicyMode = 'observe_only' | 'soft_avoid' | 'hard_block';

export type BalanceRoutingPolicy = {
  mode: BalanceRoutingPolicyMode;
  threshold: number;
  softAvoidMultiplier: number;
};

export type BalanceRoutingDecision = {
  mode: BalanceRoutingPolicyMode;
  balance: number | null;
  known: boolean;
  eligible: boolean;
  multiplier: number;
  reason: 'not_configured' | 'balance_unknown' | 'above_threshold' | 'soft_avoid' | 'hard_block';
};

export const DEFAULT_BALANCE_ROUTING_POLICY: BalanceRoutingPolicy = {
  mode: 'observe_only',
  threshold: 0,
  softAvoidMultiplier: 0.1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFiniteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeBalanceRoutingPolicyMode(value: unknown): BalanceRoutingPolicyMode {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'soft_avoid') return 'soft_avoid';
  if (normalized === 'hard_block') return 'hard_block';
  return 'observe_only';
}

export function normalizeBalanceRoutingPolicy(value: unknown): BalanceRoutingPolicy {
  const raw = isRecord(value) ? value : {};
  const threshold = Math.max(0, normalizeFiniteNumber(raw.threshold, DEFAULT_BALANCE_ROUTING_POLICY.threshold));
  const softAvoidMultiplier = Math.min(
    1,
    Math.max(0.01, normalizeFiniteNumber(raw.softAvoidMultiplier, DEFAULT_BALANCE_ROUTING_POLICY.softAvoidMultiplier)),
  );
  return {
    mode: normalizeBalanceRoutingPolicyMode(raw.mode),
    threshold,
    softAvoidMultiplier,
  };
}

export function evaluateBalanceRoutingPolicy(input: {
  balance?: unknown;
  lastBalanceRefresh?: unknown;
  policy?: unknown;
}): BalanceRoutingDecision {
  const policy = normalizeBalanceRoutingPolicy(input.policy);
  const parsedBalance = normalizeFiniteNumber(input.balance, Number.NaN);
  const known = Number.isFinite(parsedBalance) && (
    typeof input.lastBalanceRefresh === 'string'
      ? input.lastBalanceRefresh.trim().length > 0
      : input.lastBalanceRefresh instanceof Date
  );
  const balance = known ? parsedBalance : null;

  if (policy.mode === 'observe_only') {
    return { mode: policy.mode, balance, known, eligible: true, multiplier: 1, reason: 'not_configured' };
  }
  if (!known || balance == null) {
    return { mode: policy.mode, balance: null, known: false, eligible: true, multiplier: 1, reason: 'balance_unknown' };
  }
  if (balance > policy.threshold) {
    return { mode: policy.mode, balance, known: true, eligible: true, multiplier: 1, reason: 'above_threshold' };
  }
  if (policy.mode === 'hard_block') {
    return { mode: policy.mode, balance, known: true, eligible: false, multiplier: 0, reason: 'hard_block' };
  }
  return {
    mode: policy.mode,
    balance,
    known: true,
    eligible: true,
    multiplier: policy.softAvoidMultiplier,
    reason: 'soft_avoid',
  };
}
