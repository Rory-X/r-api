import type { IncomingMessage, ServerResponse } from 'node:http';

export function createDownstreamAbortScope(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Downstream client disconnected', 'AbortError'));
  const onClose = () => { if (!response.writableEnded) abort(); };
  request.once('aborted', abort);
  response.once('close', onClose);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    dispose() {
      request.off('aborted', abort);
      response.off('close', onClose);
    },
  };
}

export function withAbortableStreamReader<T extends {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
}>(reader: T, signal: AbortSignal) {
  let cancelled = false;
  const cancel = async (reason?: unknown) => {
    if (cancelled) return;
    cancelled = true;
    await reader.cancel(reason);
  };
  const onAbort = () => { void cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    async read() {
      signal.throwIfAborted();
      const result = await reader.read();
      signal.throwIfAborted();
      return result;
    },
    cancel,
    releaseLock() {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    },
  };
}
