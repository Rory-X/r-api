import { describe, expect, it } from 'vitest';
import { normalizeRouteRoutingStrategy } from './routeRoutingStrategy.js';

describe('route routing strategy', () => {
  it('recognizes manual scheduling without changing existing defaults', () => {
    expect(normalizeRouteRoutingStrategy('manual')).toBe('manual');
    expect(normalizeRouteRoutingStrategy('stable_first')).toBe('stable_first');
    expect(normalizeRouteRoutingStrategy('unknown')).toBe('weighted');
  });
});
