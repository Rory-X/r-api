import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTE_ROUTING_STRATEGY,
  ROUTE_ROUTING_STRATEGIES,
  isRoundRobinRouteRoutingStrategy,
  isRouteRoutingStrategy,
  normalizeRouteRoutingStrategy,
} from './routeRoutingStrategy.js';

describe('route routing strategy contract', () => {
  it('normalizes all supported strategies from one shared vocabulary', () => {
    expect(ROUTE_ROUTING_STRATEGIES).toEqual([
      'weighted',
      'round_robin',
      'stable_first',
      'manual',
    ]);
    expect(DEFAULT_ROUTE_ROUTING_STRATEGY).toBe('weighted');

    for (const strategy of ROUTE_ROUTING_STRATEGIES) {
      expect(isRouteRoutingStrategy(strategy)).toBe(true);
      expect(normalizeRouteRoutingStrategy(` ${strategy.toUpperCase()} `)).toBe(strategy);
    }
  });

  it('falls back to weighted for unknown values', () => {
    expect(normalizeRouteRoutingStrategy(undefined)).toBe('weighted');
    expect(normalizeRouteRoutingStrategy('random')).toBe('weighted');
    expect(isRouteRoutingStrategy('random')).toBe(false);
    expect(isRoundRobinRouteRoutingStrategy('round_robin')).toBe(true);
    expect(isRoundRobinRouteRoutingStrategy('manual')).toBe(false);
  });
});
