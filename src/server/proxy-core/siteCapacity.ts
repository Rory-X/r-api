import { Response, fetch, type RequestInit, type Response as RuntimeResponse } from 'undici';
import { acquireSiteConcurrencyLease, SiteConcurrencyError, type SiteConcurrencyLease } from '../services/siteConcurrencyService.js';
import { withoutFirstByteObservation } from './firstByteTimeout.js';
import { combineProxySignals, getProxyRequestSignal } from './requestAbortContext.js';

export type SiteCapacityConfigLike = { id?: number; maxConcurrency?: number | null };

async function acquireCapacity(site: SiteCapacityConfigLike | undefined, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // Standalone runtime utilities have no persisted site. All routed requests
  // pass their site identity; even an unlimited cached record is rechecked.
  if (!site || !Object.prototype.hasOwnProperty.call(site, 'maxConcurrency')) return null;
  if (!Number.isInteger(site.id) || (site.id ?? 0) < 1) throw new SiteConcurrencyError('Site capacity requires a persisted site');
  return withoutFirstByteObservation(() => acquireSiteConcurrencyLease(site.id!, { signal }));
}

function stoppedReason(signal: AbortSignal, lease: SiteConcurrencyLease): unknown {
  return lease.signal.aborted
    ? new SiteConcurrencyError('Site concurrency lease was lost', { cause: lease.signal.reason })
    : signal.reason;
}

function throwIfStopped(signal: AbortSignal, lease: SiteConcurrencyLease) {
  if (signal.aborted) throw stoppedReason(signal, lease);
}

/** One native WebSocket generation, including connecting and terminal response. */
export async function withSiteCapacityOperation<T>(site: SiteCapacityConfigLike | undefined, operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const parentSignal = combineProxySignals(signal, getProxyRequestSignal());
  const lease = await acquireCapacity(site, parentSignal);
  if (!lease) return operation(parentSignal);
  const combined = combineProxySignals(parentSignal, lease.signal)!;
  try { const result = await operation(combined); throwIfStopped(combined, lease); return result; }
  catch (error) { if (combined.aborted) throw stoppedReason(combined, lease); throw error; }
  finally { await lease.release(); }
}

/** Capacity belongs to the response body, not merely to the HTTP headers. */
export async function withSiteCapacityResponse(site: SiteCapacityConfigLike | undefined, dispatch: (signal?: AbortSignal) => Promise<RuntimeResponse>, signal?: AbortSignal): Promise<RuntimeResponse> {
  const parentSignal = combineProxySignals(signal, getProxyRequestSignal());
  const lease = await acquireCapacity(site, parentSignal);
  if (!lease) return dispatch(parentSignal);
  const combined = combineProxySignals(parentSignal, lease.signal)!;
  let response: RuntimeResponse | undefined;
  try { response = await dispatch(combined); throwIfStopped(combined, lease); }
  catch (error) {
    await response?.body?.cancel(error).catch(() => {});
    await lease.release();
    if (combined.aborted) throw stoppedReason(combined, lease);
    throw error;
  }
  if (!response.body) { await lease.release(); return response; }
  const reader = response.body.getReader();
  let releasePromise: Promise<void> | null = null;
  let terminal = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const release = () => {
    if (!releasePromise) {
      combined.removeEventListener('abort', onAbort);
      releasePromise = lease.release().finally(() => { try { reader.releaseLock(); } catch { /* pending reads own the lock */ } });
    }
    return releasePromise;
  };
  const onAbort = () => {
    if (terminal) return;
    terminal = true;
    const reason = stoppedReason(combined, lease);
    controller.error(reason);
    void reader.cancel(reason).catch(() => {}).finally(release).catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) onAbort();
    },
    async pull(streamController) {
      try {
        throwIfStopped(combined, lease);
        const next = await reader.read();
        throwIfStopped(combined, lease);
        if (terminal) return;
        if (next.done) { terminal = true; await release(); streamController.close(); }
        else streamController.enqueue(next.value);
      } catch (error) {
        const shouldError = !terminal;
        terminal = true;
        await release();
        if (shouldError) streamController.error(error);
      }
    },
    async cancel(reason) { terminal = true; try { await reader.cancel(reason); } finally { await release(); } },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function fetchSiteResponse(site: SiteCapacityConfigLike | undefined, url: string, init: RequestInit): Promise<RuntimeResponse> {
  return withSiteCapacityResponse(site, (signal) => fetch(url, { ...init, signal }), init.signal ?? undefined);
}

export function siteCapacityErrorPayload(error: SiteConcurrencyError) {
  return { error: { message: error.message, type: 'server_error', code: error.code } };
}
