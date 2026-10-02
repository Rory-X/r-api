import { describe, expect, it } from 'vitest';
import {
  classifyOperationalFailure,
  isGenericUpstreamBadRequest,
} from './operationalFailureContract.js';

describe('operationalFailureContract', () => {
  it('keeps retry, health and alert vocabulary aligned for rate limits', () => {
    expect(classifyOperationalFailure({ status: 429, rawErrorText: 'rate limit exceeded' })).toEqual({
      code: 'rate_limited',
      errorScope: 'upstream_gateway',
      healthDomain: 'gateway',
      alertCategory: 'capacity',
      alertSeverity: 'warning',
      retryable: true,
    });
  });

  it('distinguishes request errors from generic upstream 400s', () => {
    expect(classifyOperationalFailure({ status: 400, rawErrorText: 'invalid request body' })).toMatchObject({
      code: 'request_invalid',
      errorScope: 'request',
      healthDomain: 'request',
      retryable: false,
    });
    expect(isGenericUpstreamBadRequest(400, '400 Bad Request')).toBe(true);
    expect(classifyOperationalFailure({ status: 400, rawErrorText: '400 Bad Request' })).toMatchObject({
      code: 'unknown_failure',
      errorScope: 'unknown',
      retryable: true,
    });
  });

  it('uses the same credential vocabulary for token expiry and invalid access tokens', () => {
    expect(classifyOperationalFailure({ status: 401, rawErrorText: 'invalid access token' })).toMatchObject({
      code: 'credential_unavailable',
      errorScope: 'credential',
      healthDomain: 'credential',
      alertCategory: 'authentication',
      alertSeverity: 'error',
    });
    expect(classifyOperationalFailure({ status: 403, rawErrorText: 'forbidden' })).toMatchObject({
      code: 'credential_unavailable',
      errorScope: 'credential',
    });
  });

  it('keeps cross-channel model and early-data failures retryable', () => {
    expect(classifyOperationalFailure({ status: 400, rawErrorText: 'unsupported model' })).toMatchObject({
      code: 'model_unavailable',
      errorScope: 'model_capability',
      retryable: true,
    });
    expect(classifyOperationalFailure({ status: 425 })).toMatchObject({
      errorScope: 'upstream_gateway',
      retryable: true,
    });
  });

  it('does not treat upstream transport or gateway text as a stream failure', () => {
    expect(classifyOperationalFailure({ rawErrorText: 'fetch failed: ENOTFOUND upstream host' })).toMatchObject({
      errorScope: 'transport',
      healthDomain: 'endpoint',
    });
    expect(classifyOperationalFailure({ status: 503, rawErrorText: 'upstream unavailable' })).toMatchObject({
      errorScope: 'upstream_gateway',
      healthDomain: 'gateway',
    });
  });

  it('exposes non-proxy lease conflicts without inventing a second alert taxonomy', () => {
    expect(classifyOperationalFailure({ hint: 'lease_conflict' })).toEqual({
      code: 'lease_conflict',
      errorScope: 'unknown',
      healthDomain: 'unknown',
      alertCategory: 'concurrency',
      alertSeverity: 'warning',
      retryable: true,
    });
  });
});
