import { describe, expect, it } from 'vitest';

import {
  localProxyOwnsRetryForFailure,
  normalizeRetryOwner,
  normalizeUpstreamRetryMode,
  resolveApiChannelRetryPolicy,
  upstreamClaimsRetryForFailure,
} from './proxyRetryOwnership.js';

describe('proxyRetryOwnership', () => {
  it('normalizes stored channel policy without trusting arbitrary values', () => {
    expect(normalizeRetryOwner('LOCAL_PROXY')).toBe('local_proxy');
    expect(normalizeRetryOwner('invalid')).toBe('cooperative');
    expect(normalizeUpstreamRetryMode('internal_retry')).toBe('internal_retry');
    expect(normalizeUpstreamRetryMode(true)).toBe('unknown');
    expect(resolveApiChannelRetryPolicy(null)).toEqual({
      retryOwner: 'cooperative',
      upstreamRetryMode: 'unknown',
    });
  });

  it('lets cooperative channels defer transient gateway retry to declared upstream HA', () => {
    const policy = resolveApiChannelRetryPolicy({
      retryOwner: 'cooperative',
      upstreamRetryMode: 'internal_retry',
    });

    expect(upstreamClaimsRetryForFailure({
      policy,
      errorScope: 'upstream_gateway',
    })).toBe(true);
    expect(upstreamClaimsRetryForFailure({
      policy,
      errorScope: 'credential',
    })).toBe(false);
    expect(upstreamClaimsRetryForFailure({
      policy,
      errorScope: 'transport',
    })).toBe(false);
  });

  it('honors an explicit runtime signal over the static channel declaration', () => {
    const policy = resolveApiChannelRetryPolicy({
      retryOwner: 'cooperative',
      upstreamRetryMode: 'internal_retry',
    });

    expect(upstreamClaimsRetryForFailure({
      policy,
      errorScope: 'upstream_gateway',
      explicitUpstreamRetryable: false,
    })).toBe(false);
  });

  it('resolves the retry owner independently from replay safety and retry budgets', () => {
    expect(localProxyOwnsRetryForFailure({
      channel: { retryOwner: 'upstream_gateway' },
      errorScope: 'credential',
    })).toBe(false);
    expect(localProxyOwnsRetryForFailure({
      channel: {
        retryOwner: 'cooperative',
        upstreamRetryMode: 'internal_retry',
      },
      errorScope: 'upstream_gateway',
    })).toBe(false);
    expect(localProxyOwnsRetryForFailure({
      channel: {
        retryOwner: 'local_proxy',
        upstreamRetryMode: 'internal_retry',
      },
      errorScope: 'upstream_gateway',
    })).toBe(true);
  });
});
