import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { expireMock } = vi.hoisted(() => ({
  expireMock: vi.fn(),
}));

vi.mock('./interactionRequestService.js', () => ({
  expireInteractionRequests: expireMock,
}));

import {
  __resetInteractionRequestExpirySchedulerForTests,
  startInteractionRequestExpiryScheduler,
  stopInteractionRequestExpiryScheduler,
} from './interactionRequestExpiryScheduler.js';

describe('interaction request expiry scheduler', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    expireMock.mockResolvedValue(0);
    await __resetInteractionRequestExpirySchedulerForTests();
  });

  afterEach(async () => {
    await __resetInteractionRequestExpirySchedulerForTests();
    vi.useRealTimers();
  });

  it('runs at startup, remains single-flight, and stops future passes', async () => {
    let releaseFirstPass!: () => void;
    expireMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    }));

    const starting = startInteractionRequestExpiryScheduler({ intervalMs: 100 });
    await Promise.resolve();
    expect(expireMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(expireMock).toHaveBeenCalledTimes(1);

    releaseFirstPass();
    await starting;
    await vi.advanceTimersByTimeAsync(100);
    expect(expireMock).toHaveBeenCalledTimes(2);

    await stopInteractionRequestExpiryScheduler();
    await vi.advanceTimersByTimeAsync(500);
    expect(expireMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent when startup is requested twice', async () => {
    await startInteractionRequestExpiryScheduler({ intervalMs: 100 });
    await startInteractionRequestExpiryScheduler({ intervalMs: 100 });
    expect(expireMock).toHaveBeenCalledTimes(1);
  });
});
