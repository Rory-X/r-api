import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDownstreamAbortScope } from './downstreamAbort.js';

const requestAbortContext = new AsyncLocalStorage<AbortSignal>();

export function getProxyRequestSignal(): AbortSignal | undefined {
  return requestAbortContext.getStore();
}

export function combineProxySignals(...signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => !!signal);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

/** The adapter owns the scope; transports inherit cancellation across runtime adapters. */
export async function withProxyRequestAbortScope<T>(request: IncomingMessage, response: ServerResponse, operation: () => Promise<T>): Promise<T> {
  const scope = createDownstreamAbortScope(request, response);
  const dispose = () => {
    scope.dispose();
    response.off('finish', dispose);
    response.off('close', dispose);
  };
  response.once('finish', dispose);
  response.once('close', dispose);
  try { return await requestAbortContext.run(scope.signal, operation); }
  finally { if (response.writableEnded || response.destroyed) dispose(); }
}
