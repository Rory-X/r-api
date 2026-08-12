import { describe, expect, it } from 'vitest';
import {
  clearAuthSession,
  clearLegacyAuthSession,
  getCsrfToken,
  hasValidAuthSession,
  persistAuthSession,
} from './authSession.js';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    entries() {
      return [...store.entries()];
    },
  };
}

describe('authSession', () => {
  it('stores only CSRF/session metadata and reads it before expiry', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'mac_csrf-1', 61_000, 1_000);

    expect(getCsrfToken(storage, 10_000)).toBe('mac_csrf-1');
    expect(hasValidAuthSession(storage, 10_000)).toBe(true);
    expect(storage.entries()).toEqual(expect.arrayContaining([
      ['metapi_admin_csrf', 'mac_csrf-1'],
      ['metapi_admin_session_expires_at', '61000'],
    ]));
    expect(storage.entries().some(([key]) => key === 'auth_token')).toBe(false);
  });

  it('clears expired session metadata automatically', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'mac_csrf-2', 61_000, 1_000);

    expect(getCsrfToken(storage, 100_000)).toBeNull();
    expect(hasValidAuthSession(storage, 100_000)).toBe(false);
    expect(storage.entries()).toEqual([]);
  });

  it('supports explicit logout without retaining browser credentials', () => {
    const storage = createMemoryStorage();
    persistAuthSession(storage, 'mac_csrf-3', 61_000, 1_000);

    clearAuthSession(storage);

    expect(getCsrfToken(storage, 2_000)).toBeNull();
  });

  it('removes legacy localStorage bearer credentials', () => {
    const storage = createMemoryStorage({
      auth_token: 'legacy-admin-secret',
      auth_token_expires_at: '999999',
      theme: 'dark',
    });

    clearLegacyAuthSession(storage);

    expect(storage.entries()).toEqual([['theme', 'dark']]);
  });
});
