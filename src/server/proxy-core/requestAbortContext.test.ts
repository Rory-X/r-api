import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { combineProxySignals, getProxyRequestSignal, withProxyRequestAbortScope } from './requestAbortContext.js';

function requestPair() {
  const request = Object.assign(new EventEmitter(), { aborted: false }) as IncomingMessage;
  const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }) as ServerResponse;
  return { request, response };
}

describe('proxy cancellation context', () => {
  it('retains disconnect observation after the handler returns a streaming response', async () => {
    const { request, response } = requestPair();
    const signal = await withProxyRequestAbortScope(request, response, async () => getProxyRequestSignal()!);
    expect(signal.aborted).toBe(false);
    expect(getProxyRequestSignal()).toBeUndefined();
    response.emit('close');
    expect(signal.aborted).toBe(true);
    expect(signal.reason.name).toBe('AbortError');
    expect(request.listenerCount('aborted')).toBe(0);
  });

  it('cleans up a completed response and keeps parallel request contexts isolated', async () => {
    const one = requestPair();
    const two = requestPair();
    const [first, second] = await Promise.all([
      withProxyRequestAbortScope(one.request, one.response, async () => { await Promise.resolve(); return getProxyRequestSignal()!; }),
      withProxyRequestAbortScope(two.request, two.response, async () => { await Promise.resolve(); return getProxyRequestSignal()!; }),
    ]);
    one.response.writableEnded = true;
    one.response.emit('finish');
    one.response.emit('close');
    expect(first.aborted).toBe(false);
    two.request.emit('aborted');
    expect(second.aborted).toBe(true);
    expect(combineProxySignals(first, second)!.aborted).toBe(true);
    two.response.emit('close');
    expect(one.request.listenerCount('aborted')).toBe(0);
    expect(two.request.listenerCount('aborted')).toBe(0);
  });
});
