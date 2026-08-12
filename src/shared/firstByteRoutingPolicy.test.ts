import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FIRST_BYTE_ROUTING_POLICY,
  resolveFirstByteRoutingMultiplier,
} from './firstByteRoutingPolicy.js';

describe('first-byte routing policy', () => {
  it('does not affect routing before the minimum sample count', () => {
    expect(resolveFirstByteRoutingMultiplier({
      latencyEmaMs: 12_500,
      sampleCount: DEFAULT_FIRST_BYTE_ROUTING_POLICY.minSamples - 1,
      policy: DEFAULT_FIRST_BYTE_ROUTING_POLICY,
    })).toBe(1);
  });

  it('keeps full weight at or below the baseline', () => {
    expect(resolveFirstByteRoutingMultiplier({
      latencyEmaMs: DEFAULT_FIRST_BYTE_ROUTING_POLICY.baselineMs,
      sampleCount: DEFAULT_FIRST_BYTE_ROUTING_POLICY.minSamples,
      policy: DEFAULT_FIRST_BYTE_ROUTING_POLICY,
    })).toBe(1);
  });

  it('applies a linear penalty above the baseline', () => {
    expect(resolveFirstByteRoutingMultiplier({
      latencyEmaMs: 7_500,
      sampleCount: 5,
      policy: DEFAULT_FIRST_BYTE_ROUTING_POLICY,
    })).toBeCloseTo(0.675, 6);
  });

  it('stops at the configured maximum penalty', () => {
    expect(resolveFirstByteRoutingMultiplier({
      latencyEmaMs: 120_000,
      sampleCount: 20,
      policy: DEFAULT_FIRST_BYTE_ROUTING_POLICY,
    })).toBeCloseTo(0.35, 6);
  });

  it('keeps full weight when learning is disabled', () => {
    expect(resolveFirstByteRoutingMultiplier({
      latencyEmaMs: 120_000,
      sampleCount: 20,
      policy: { ...DEFAULT_FIRST_BYTE_ROUTING_POLICY, enabled: false },
    })).toBe(1);
  });
});
