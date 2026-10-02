import {
  classifyOperationalFailure,
  classifyRetryErrorScope,
  isChannelLocalFailure,
  isExplicitRequestFailure,
  isGenericUpstreamBadRequest,
  type ReplaySafety,
  type RetryErrorScope,
  type RetryOwner,
} from './proxyRetryContract.js';

const MODEL_UNSUPPORTED_PATTERNS: RegExp[] = [
  /当前\s*api\s*不支持所选模型/i,
  /不支持所选模型/i,
  /不支持.*模型/i,
  /模型.*不支持/i,
  /unsupported\s+model/i,
  /model\s+not\s+supported/i,
  /does\s+not\s+support(?:\s+the)?\s+model/i,
  /model.*does\s+not\s+exist/i,
  /no\s+such\s+model/i,
  /unknown\s+model/i,
  /unknown\s+provider\s+for\s+model/i,
  /invalid\s+model/i,
  /model[_\s-]?not[_\s-]?found/i,
  /you\s+do\s+not\s+have\s+access\s+to\s+the\s+model/i,
];

export const RETRYABLE_TIMEOUT_PATTERNS: RegExp[] = [
  /(request timed out|connection timed out|read timeout|first byte timeout|\btimed out\b)/i,
];

const RETRYABLE_TRANSIENT_PATTERNS: RegExp[] = [
  /invalid\s+api\s+key/i,
  /invalid\s+access\s+token/i,
  /forbidden/i,
  /rate\s+limit/i,
  /quota/i,
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  /service\s+unavailable/i,
  /cpu\s+overloaded/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
];

const SAME_SITE_ENDPOINT_ABORT_PATTERNS: RegExp[] = [
  /\b429\b/i,
  /too\s+many\s+requests/i,
  /rate\s+limit/i,
  /quota(?:\s+exceeded)?/i,
  /bad\s+gateway/i,
  /gateway\s+time-?out/i,
  /service\s+unavailable/i,
  /temporar(?:y|ily)\s+unavailable/i,
  /cpu\s+overloaded/i,
  /connection\s+reset/i,
  /connection\s+refused/i,
  /econnreset/i,
  /econnrefused/i,
  ...RETRYABLE_TIMEOUT_PATTERNS,
];

function isModelUnsupportedErrorMessage(rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return MODEL_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

function matchesAnyPattern(patterns: RegExp[], rawMessage?: string | null): boolean {
  const text = (rawMessage || '').trim();
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function shouldRetryProxyRequest(status: number, upstreamErrorText?: string | null): boolean {
  if (status >= 500) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status === 401 || status === 403) return true;
  if (isModelUnsupportedErrorMessage(upstreamErrorText)) return true;
  if (isExplicitRequestFailure(upstreamErrorText)) return false;
  if (isChannelLocalFailure(upstreamErrorText)) return true;
  if (matchesAnyPattern(RETRYABLE_TRANSIENT_PATTERNS, upstreamErrorText)) return true;
  if (isGenericUpstreamBadRequest(status, upstreamErrorText)) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return false;
}

export type ProxyRetryClassification = {
  retryable: boolean;
  scope: RetryErrorScope;
  retryOwner: RetryOwner;
  replaySafety: ReplaySafety;
};

/**
 * Keeps the legacy boolean helper stable while exposing the richer contract
 * to Proxy Core callers that need to coordinate local and upstream retries.
 */
export function classifyProxyRetryFailure(
  status: number,
  upstreamErrorText?: string | null,
  options: {
    retryOwner?: RetryOwner;
    replaySafety?: ReplaySafety;
  } = {},
): ProxyRetryClassification {
  const classification = classifyOperationalFailure({ status, rawErrorText: upstreamErrorText });
  return {
    retryable: shouldRetryProxyRequest(status, upstreamErrorText),
    scope: classification.errorScope || classifyRetryErrorScope({ status, rawErrorText: upstreamErrorText }),
    retryOwner: options.retryOwner ?? 'cooperative',
    replaySafety: options.replaySafety ?? 'safe_only',
  };
}

export function shouldAbortSameSiteEndpointFallback(status: number, upstreamErrorText?: string | null): boolean {
  if (status < 500 && status !== 408 && status !== 429) {
    return false;
  }
  return matchesAnyPattern(SAME_SITE_ENDPOINT_ABORT_PATTERNS, upstreamErrorText);
}
