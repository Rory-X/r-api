import {
  Agent as UndiciAgent,
  setGlobalDispatcher,
  type Agent,
  type Dispatcher,
} from 'undici';

import { config } from '../config.js';

let configuredDispatcher: Dispatcher | null = null;

export function buildUpstreamAgentOptions(): Agent.Options {
  const keepAliveTimeout = Math.max(1_000, config.upstreamHttpKeepAliveTimeoutMs);
  const keepAliveMaxTimeout = Math.max(
    keepAliveTimeout,
    config.upstreamHttpKeepAliveMaxTimeoutMs,
  );

  return {
    allowH2: config.upstreamHttp2Enabled,
    connections: config.upstreamHttpConnectionsPerOrigin,
    keepAliveTimeout,
    keepAliveMaxTimeout,
    pipelining: 1,
    autoSelectFamily: config.upstreamHttpAutoSelectFamily,
    autoSelectFamilyAttemptTimeout: config.upstreamHttpAutoSelectFamilyAttemptTimeoutMs,
  };
}

export function configureUpstreamHttpTransport(): Dispatcher {
  if (configuredDispatcher) return configuredDispatcher;

  configuredDispatcher = new UndiciAgent(buildUpstreamAgentOptions());
  setGlobalDispatcher(configuredDispatcher);
  return configuredDispatcher;
}
