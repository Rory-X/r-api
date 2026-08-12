const ADMIN_CSRF_STORAGE_KEY = 'metapi_admin_csrf';
const ADMIN_SESSION_EXPIRES_AT_STORAGE_KEY = 'metapi_admin_session_expires_at';
const LEGACY_AUTH_TOKEN_STORAGE_KEY = 'auth_token';
const LEGACY_AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY = 'auth_token_expires_at';

export const AUTH_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
export const AUTH_SESSION_EXPIRED_EVENT = 'metapi:auth-session-expired';

type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  return null;
}

function parseExpiresAt(value: string | number | Date, nowMs: number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : nowMs + AUTH_SESSION_DURATION_MS;
}

export function clearLegacyAuthSession(storage?: StorageLike | null): void {
  const target = storage
    || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!target || typeof target.removeItem !== 'function') return;
  target.removeItem(LEGACY_AUTH_TOKEN_STORAGE_KEY);
  target.removeItem(LEGACY_AUTH_TOKEN_EXPIRES_AT_STORAGE_KEY);
}

export function clearAuthSession(storage?: StorageLike | null): void {
  const target = resolveStorage(storage);
  target?.removeItem(ADMIN_CSRF_STORAGE_KEY);
  target?.removeItem(ADMIN_SESSION_EXPIRES_AT_STORAGE_KEY);
  clearLegacyAuthSession();
}

export function persistAuthSession(
  storage: StorageLike | null | undefined,
  csrfToken: string,
  expiresAt: string | number | Date,
  nowMs = Date.now(),
): void {
  const target = resolveStorage(storage);
  if (!target) return;

  const normalizedCsrfToken = (csrfToken || '').trim();
  const expiresAtMs = parseExpiresAt(expiresAt, nowMs);
  if (!normalizedCsrfToken || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    clearAuthSession(target);
    return;
  }

  target.setItem(ADMIN_CSRF_STORAGE_KEY, normalizedCsrfToken);
  target.setItem(ADMIN_SESSION_EXPIRES_AT_STORAGE_KEY, String(expiresAtMs));
  clearLegacyAuthSession();
}

export function getCsrfToken(storage?: StorageLike | null, nowMs = Date.now()): string | null {
  const target = resolveStorage(storage);
  if (!target) return null;

  const csrfToken = (target.getItem(ADMIN_CSRF_STORAGE_KEY) || '').trim();
  const expiresAt = Number(target.getItem(ADMIN_SESSION_EXPIRES_AT_STORAGE_KEY));
  if (!csrfToken || !Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    clearAuthSession(target);
    return null;
  }
  return csrfToken;
}

export function hasValidAuthSession(storage?: StorageLike | null, nowMs = Date.now()): boolean {
  return !!getCsrfToken(storage, nowMs);
}

export function notifyAuthSessionExpired(): void {
  clearAuthSession();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
  }
}

export function onAuthSessionExpired(listener: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
}
