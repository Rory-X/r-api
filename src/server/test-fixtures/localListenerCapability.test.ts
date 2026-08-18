import { describe, expect, it } from 'vitest';
import { parseLocalListenerOverride } from './localListenerCapability.js';

describe('local test listener capability', () => {
  it('supports explicit force and skip values', () => {
    expect(parseLocalListenerOverride('true')).toBe(true);
    expect(parseLocalListenerOverride('1')).toBe(true);
    expect(parseLocalListenerOverride('false')).toBe(false);
    expect(parseLocalListenerOverride('0')).toBe(false);
  });

  it('falls back to runtime probing for empty or unknown values', () => {
    expect(parseLocalListenerOverride(undefined)).toBeNull();
    expect(parseLocalListenerOverride('auto')).toBeNull();
  });
});
