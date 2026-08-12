const MAX_OAUTH_PROVIDER_ERROR_LENGTH = 2_000;

export function sanitizeOauthProviderErrorMessage(value: unknown): string {
  return String(value || 'OAuth provider request failed')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:access|refresh|id)_token["'\s:=]+)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .slice(0, MAX_OAUTH_PROVIDER_ERROR_LENGTH);
}

export function parseOauthRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.max(0, Math.trunc(seconds * 1_000));
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMs);
}

export class OAuthProviderHttpError extends Error {
  readonly provider: string;
  readonly statusCode: number;
  readonly retryAfterMs: number | null;

  constructor(input: {
    provider: string;
    statusCode: number;
    message: string;
    retryAfterMs?: number | null;
  }) {
    super(sanitizeOauthProviderErrorMessage(input.message));
    this.name = 'OAuthProviderHttpError';
    this.provider = input.provider;
    this.statusCode = Math.trunc(input.statusCode);
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

export function createOauthProviderHttpError(input: {
  provider: string;
  statusCode: number;
  bodyText?: string;
  fallbackMessage: string;
  retryAfter?: string | null;
}): OAuthProviderHttpError {
  return new OAuthProviderHttpError({
    provider: input.provider,
    statusCode: input.statusCode,
    message: input.bodyText?.trim() || input.fallbackMessage,
    retryAfterMs: parseOauthRetryAfterMs(input.retryAfter),
  });
}
