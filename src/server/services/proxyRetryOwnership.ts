import type { RetryErrorScope, RetryOwner } from './proxyRetryContract.js';

export type UpstreamRetryMode = 'unknown' | 'none' | 'internal_retry';

export type ApiChannelRetryPolicy = {
  retryOwner: RetryOwner;
  upstreamRetryMode: UpstreamRetryMode;
};

export type ApiChannelRetryPolicyLike = {
  retryOwner?: unknown;
  upstreamRetryMode?: unknown;
};

const RETRY_OWNERS = new Set<RetryOwner>([
  'local_proxy',
  'upstream_gateway',
  'cooperative',
]);

const UPSTREAM_RETRY_MODES = new Set<UpstreamRetryMode>([
  'unknown',
  'none',
  'internal_retry',
]);

export function normalizeRetryOwner(value: unknown): RetryOwner {
  const normalized = String(value || '').trim().toLowerCase() as RetryOwner;
  return RETRY_OWNERS.has(normalized) ? normalized : 'cooperative';
}

export function normalizeUpstreamRetryMode(value: unknown): UpstreamRetryMode {
  const normalized = String(value || '').trim().toLowerCase() as UpstreamRetryMode;
  return UPSTREAM_RETRY_MODES.has(normalized) ? normalized : 'unknown';
}

export function resolveApiChannelRetryPolicy(
  channel?: ApiChannelRetryPolicyLike | null,
): ApiChannelRetryPolicy {
  return {
    retryOwner: normalizeRetryOwner(channel?.retryOwner),
    upstreamRetryMode: normalizeUpstreamRetryMode(channel?.upstreamRetryMode),
  };
}

/**
 * Internal upstream HA only owns transient gateway failures. Credential,
 * request, model-capability, and ambiguous transport handling stay local
 * unless the channel explicitly assigns all retry ownership upstream.
 */
export function upstreamClaimsRetryForFailure(input: {
  policy: ApiChannelRetryPolicy;
  errorScope: RetryErrorScope;
  explicitUpstreamRetryable?: boolean;
}): boolean {
  if (typeof input.explicitUpstreamRetryable === 'boolean') {
    return input.explicitUpstreamRetryable;
  }
  return input.policy.upstreamRetryMode === 'internal_retry'
    && input.errorScope === 'upstream_gateway';
}

export function localProxyOwnsRetryForFailure(input: {
  channel?: ApiChannelRetryPolicyLike | null;
  errorScope: RetryErrorScope;
  explicitUpstreamRetryable?: boolean;
}): boolean {
  const policy = resolveApiChannelRetryPolicy(input.channel);
  if (policy.retryOwner === 'local_proxy') return true;
  if (policy.retryOwner === 'upstream_gateway') return false;
  return !upstreamClaimsRetryForFailure({
    policy,
    errorScope: input.errorScope,
    explicitUpstreamRetryable: input.explicitUpstreamRetryable,
  });
}
