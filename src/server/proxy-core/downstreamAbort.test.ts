import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createDownstreamAbortScope, withAbortableStreamReader } from './downstreamAbort.js';

describe('downstream abort scope', () => {
  it('aborts on an interrupted connection, ignores normal completion, and removes listeners', () => {
    const request = new EventEmitter() as IncomingMessage;
    const response = new EventEmitter() as ServerResponse;
    const scope = createDownstreamAbortScope(request, response);
    response.emit('close');
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    const completed = new EventEmitter() as ServerResponse;
    Object.defineProperty(completed, 'writableEnded', { value: true });
    const clean = createDownstreamAbortScope(request, completed);
    completed.emit('close');
    expect(clean.signal.aborted).toBe(false);
    clean.dispose();
  });

  it('cancels a blocked stream read once and never interprets disconnect as successful EOF', async () => {
    const cancel = vi.fn();
    const release = vi.fn();
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({ cancel(reason) { cancel(reason); } });
    const original = source.getReader();
    const reader = withAbortableStreamReader({ read: () => original.read(), cancel: (reason) => original.cancel(reason), releaseLock() { original.releaseLock(); release(); } }, controller.signal);
    const read = reader.read();
    controller.abort(new Error('client gone'));
    await expect(read).rejects.toThrow('client gone');
    await reader.cancel();
    reader.releaseLock();
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
