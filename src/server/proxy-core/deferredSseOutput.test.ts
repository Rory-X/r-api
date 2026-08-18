import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDeferredSseOutput,
  PRE_OUTPUT_RETRY_GRACE_MS,
} from './deferredSseOutput.js';

describe('createDeferredSseOutput', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases buffered output after the brief retry grace period', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const output = createDeferredSseOutput({
      start: () => events.push('start'),
      write: (chunk) => events.push(`write:${chunk}`),
      end: () => events.push('end'),
      maxDelayMs: PRE_OUTPUT_RETRY_GRACE_MS,
    });

    output.write('response.created');
    await vi.advanceTimersByTimeAsync(PRE_OUTPUT_RETRY_GRACE_MS - 1);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['start', 'write:response.created']);
    expect(output.committed).toBe(true);
  });

  it('keeps an immediate failure retryable when auto-commit is cancelled', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const output = createDeferredSseOutput({
      start: () => events.push('start'),
      write: (chunk) => events.push(`write:${chunk}`),
      end: () => events.push('end'),
      maxDelayMs: PRE_OUTPUT_RETRY_GRACE_MS,
    });

    output.write('response.failed');
    output.cancelAutoCommit();
    output.discard();
    await vi.advanceTimersByTimeAsync(PRE_OUTPUT_RETRY_GRACE_MS);

    expect(events).toEqual([]);
    expect(output.committed).toBe(false);
  });
});
