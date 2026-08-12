import { describe, expect, it } from 'vitest';
import {
  evaluateBalanceRoutingPolicy,
  normalizeBalanceRoutingPolicy,
} from './balanceRoutingPolicy.js';

describe('balance routing policy', () => {
  it('keeps observe_only candidates eligible without a refreshed balance', () => {
    expect(evaluateBalanceRoutingPolicy({ balance: 0, policy: { mode: 'observe_only' } })).toMatchObject({
      eligible: true,
      multiplier: 1,
      reason: 'not_configured',
    });
  });

  it('soft avoids a known balance at or below the threshold', () => {
    expect(evaluateBalanceRoutingPolicy({
      balance: 0,
      lastBalanceRefresh: '2026-08-04T00:00:00.000Z',
      policy: { mode: 'soft_avoid', threshold: 1, softAvoidMultiplier: 0.2 },
    })).toMatchObject({
      eligible: true,
      multiplier: 0.2,
      reason: 'soft_avoid',
    });
  });

  it('hard blocks only a known low balance', () => {
    expect(evaluateBalanceRoutingPolicy({
      balance: 0,
      lastBalanceRefresh: '2026-08-04T00:00:00.000Z',
      policy: { mode: 'hard_block', threshold: 0 },
    })).toMatchObject({ eligible: false, reason: 'hard_block' });
    expect(evaluateBalanceRoutingPolicy({
      balance: 0,
      policy: { mode: 'hard_block', threshold: 0 },
    })).toMatchObject({ eligible: true, reason: 'balance_unknown' });
  });

  it('normalizes malformed values to bounded defaults', () => {
    expect(normalizeBalanceRoutingPolicy({
      mode: 'unexpected',
      threshold: -10,
      softAvoidMultiplier: 3,
    })).toEqual({ mode: 'observe_only', threshold: 0, softAvoidMultiplier: 1 });
  });
});
