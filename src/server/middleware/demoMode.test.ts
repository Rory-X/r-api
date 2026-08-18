import { describe, expect, it } from 'vitest';
import { isDemoModeRequestBlocked } from './demoMode.js';

describe('demo mode request policy', () => {
  it('allows static pages and authenticated read APIs', () => {
    expect(isDemoModeRequestBlocked('GET', '/')).toBe(false);
    expect(isDemoModeRequestBlocked('GET', '/assets/index.js')).toBe(false);
    expect(isDemoModeRequestBlocked('GET', '/api/stats/dashboard')).toBe(false);
  });

  it('allows only the authentication writes needed to enter and leave the demo', () => {
    expect(isDemoModeRequestBlocked('POST', '/api/auth/login')).toBe(false);
    expect(isDemoModeRequestBlocked('POST', '/api/auth/totp/verify')).toBe(false);
    expect(isDemoModeRequestBlocked('POST', '/api/auth/logout')).toBe(false);
    expect(isDemoModeRequestBlocked('POST', '/api/sites')).toBe(true);
    expect(isDemoModeRequestBlocked('DELETE', '/api/sites/1')).toBe(true);
  });

  it('blocks every inference surface including websocket and read-shaped proxy routes', () => {
    expect(isDemoModeRequestBlocked('GET', '/v1/responses')).toBe(true);
    expect(isDemoModeRequestBlocked('GET', '/v1/models')).toBe(true);
    expect(isDemoModeRequestBlocked('POST', '/responses')).toBe(true);
    expect(isDemoModeRequestBlocked('POST', '/chat/completions')).toBe(true);
    expect(isDemoModeRequestBlocked('POST', '/v1beta/models/gemini:generateContent')).toBe(true);
    expect(isDemoModeRequestBlocked('POST', '/gemini/v1/models/gemini:generateContent')).toBe(true);
  });
});
