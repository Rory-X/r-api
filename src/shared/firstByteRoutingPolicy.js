export const DEFAULT_FIRST_BYTE_ROUTING_POLICY = Object.freeze({
  enabled: true,
  baselineMs: 2_500,
  penaltyWindowMs: 10_000,
  maxPenaltyRatio: 0.65,
  minSamples: 5,
});

function clampNumber(value, min, max, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.min(max, Math.max(min, normalized));
}

export function normalizeFirstByteRoutingPolicy(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    enabled: typeof input.enabled === 'boolean'
      ? input.enabled
      : DEFAULT_FIRST_BYTE_ROUTING_POLICY.enabled,
    baselineMs: Math.trunc(clampNumber(
      input.baselineMs,
      100,
      120_000,
      DEFAULT_FIRST_BYTE_ROUTING_POLICY.baselineMs,
    )),
    penaltyWindowMs: Math.trunc(clampNumber(
      input.penaltyWindowMs,
      100,
      300_000,
      DEFAULT_FIRST_BYTE_ROUTING_POLICY.penaltyWindowMs,
    )),
    maxPenaltyRatio: clampNumber(
      input.maxPenaltyRatio,
      0,
      0.95,
      DEFAULT_FIRST_BYTE_ROUTING_POLICY.maxPenaltyRatio,
    ),
    minSamples: Math.trunc(clampNumber(
      input.minSamples,
      1,
      100,
      DEFAULT_FIRST_BYTE_ROUTING_POLICY.minSamples,
    )),
  };
}

export function resolveFirstByteRoutingMultiplier(input) {
  const policy = normalizeFirstByteRoutingPolicy(input.policy);
  const latencyEmaMs = Number(input.latencyEmaMs);
  const sampleCount = Math.max(0, Math.trunc(Number(input.sampleCount) || 0));
  if (!policy.enabled || !Number.isFinite(latencyEmaMs) || latencyEmaMs <= 0) return 1;
  if (sampleCount < policy.minSamples || latencyEmaMs <= policy.baselineMs) return 1;
  const penaltyProgress = Math.min(
    1,
    Math.max(0, (latencyEmaMs - policy.baselineMs) / policy.penaltyWindowMs),
  );
  return Math.max(0.05, 1 - (penaltyProgress * policy.maxPenaltyRatio));
}
