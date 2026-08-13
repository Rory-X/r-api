import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { reconcileMock } = vi.hoisted(() => ({
  reconcileMock: vi.fn(),
}));

vi.mock('./globalBridgeContinuationService.js', () => ({
  reconcileGlobalBridgeContinuationTasks: reconcileMock,
}));

import {
  __resetGlobalBridgeContinuationSchedulerForTests,
  startGlobalBridgeContinuationScheduler,
  stopGlobalBridgeContinuationScheduler,
} from './globalBridgeContinuationScheduler.js';

describe('global bridge continuation scheduler', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    reconcileMock.mockResolvedValue({ eligible: 0, covered: 0, created: 0, blocked: 0 });
    await __resetGlobalBridgeContinuationSchedulerForTests();
  });

  afterEach(async () => {
    await __resetGlobalBridgeContinuationSchedulerForTests();
    vi.useRealTimers();
  });

  it('runs immediately, remains single-flight, and stops future passes', async () => {
    let releaseFirstPass!: () => void;
    reconcileMock.mockImplementationOnce(() => new Promise((resolve) => {
      releaseFirstPass = () => resolve({ eligible: 0, covered: 0, created: 0, blocked: 0 });
    }));

    const starting = startGlobalBridgeContinuationScheduler({ intervalMs: 100 });
    await Promise.resolve();
    expect(reconcileMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(reconcileMock).toHaveBeenCalledTimes(1);

    releaseFirstPass();
    await starting;
    await vi.advanceTimersByTimeAsync(100);
    expect(reconcileMock).toHaveBeenCalledTimes(2);

    await stopGlobalBridgeContinuationScheduler();
    await vi.advanceTimersByTimeAsync(500);
    expect(reconcileMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent when startup is requested twice', async () => {
    await startGlobalBridgeContinuationScheduler({ intervalMs: 100 });
    await startGlobalBridgeContinuationScheduler({ intervalMs: 100 });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });
});
