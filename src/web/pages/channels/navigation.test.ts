import { describe, expect, it } from 'vitest';
import { resolveChannelPath, resolveChannelTransitionKey } from './navigation.js';

describe('channel navigation', () => {
  it('keeps nested navigation inside the unified channel surface', () => {
    expect(resolveChannelPath('/official-credentials', 'official')).toBe('/channels/official');
    expect(resolveChannelPath('/channels/sites', 'connections')).toBe('/channels/connections');
    expect(resolveChannelPath('/channels/connections', 'overview')).toBe('/channels');
  });

  it('canonicalizes navigation from legacy route contexts', () => {
    expect(resolveChannelPath('/accounts', 'sites')).toBe('/channels/sites');
  });

  it('keeps one page transition key while switching channel tabs', () => {
    expect(resolveChannelTransitionKey('/channels')).toBe('/channels');
    expect(resolveChannelTransitionKey('/channels/sites')).toBe('/channels');
    expect(resolveChannelTransitionKey('/channels/oauth')).toBe('/channels');
    expect(resolveChannelTransitionKey('/channels/official')).toBe('/channels');
    expect(resolveChannelTransitionKey('/official-credentials')).toBe('/official-credentials');
    expect(resolveChannelTransitionKey('/models')).toBe('/models');
  });
});
