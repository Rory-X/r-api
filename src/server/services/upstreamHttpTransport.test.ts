import { describe, expect, it } from 'vitest';

import { config } from '../config.js';
import { buildUpstreamAgentOptions } from './upstreamHttpTransport.js';

describe('upstreamHttpTransport', () => {
  it('builds a long-lived, HTTP/2-capable upstream connection pool', () => {
    const options = buildUpstreamAgentOptions();

    expect(options).toMatchObject({
      allowH2: config.upstreamHttp2Enabled,
      connections: config.upstreamHttpConnectionsPerOrigin,
      keepAliveTimeout: config.upstreamHttpKeepAliveTimeoutMs,
      keepAliveMaxTimeout: config.upstreamHttpKeepAliveMaxTimeoutMs,
      pipelining: 1,
      autoSelectFamily: config.upstreamHttpAutoSelectFamily,
      autoSelectFamilyAttemptTimeout: config.upstreamHttpAutoSelectFamilyAttemptTimeoutMs,
    });
  });
});
