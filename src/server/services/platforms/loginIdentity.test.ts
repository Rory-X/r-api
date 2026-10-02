import { describe, expect, it, vi } from 'vitest';
import { NewApiAdapter } from './newApi.js';
import { VeloeraAdapter } from './veloera.js';

describe('login identity contract', () => {
  it.each([500123, '500123'])('retains a valid ID from the inherited login implementation: %s', async (id) => {
    const adapter = new VeloeraAdapter();
    vi.spyOn(adapter as any, 'fetchJson').mockResolvedValue({ success: true, data: { id, token: 'session' } });
    expect(await adapter.login('https://example.com', 'alice_1999', 'password'))
      .toMatchObject({ success: true, accessToken: 'session', platformUserId: 500123 });
  });

  it.each(['500123abc', '500123.9', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed login IDs: %s', async (id) => {
    const adapter = new VeloeraAdapter();
    vi.spyOn(adapter as any, 'fetchJson').mockResolvedValue({ success: true, data: { id, token: 'session' } });
    expect((await adapter.login('https://example.com', 'alice', 'password')).platformUserId).toBeUndefined();
  });

  it.each(['token', 'cookie'])('retains New API identity with %s credentials', async (kind) => {
    const adapter = new NewApiAdapter();
    vi.spyOn(adapter as any, 'fetchJsonRawWithCookie').mockResolvedValue({
      data: { success: true, data: { id: '500123', ...(kind === 'token' ? { token: 'session' } : {}) } },
      cookieHeader: 'session=cookie-session',
    });
    expect(await adapter.login('https://example.com', 'alice@example.com', 'password'))
      .toMatchObject({ success: true, platformUserId: 500123 });
  });
});
