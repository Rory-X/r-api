import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recoverMock } = vi.hoisted(() => ({
  recoverMock: vi.fn(),
}));

vi.mock('./bridgeContinuationService.js', () => ({
  recoverExpiredBridgeContinuationLeases: recoverMock,
}));

import {
  __resetBridgeContinuationRecoverySchedulerForTests,
  startBridgeContinuationRecoveryScheduler,
  stopBridgeContinuationRecoveryScheduler,
} from './bridgeContinuationRecoveryScheduler.js';

describe('bridge continuation recovery scheduler', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    recoverMock.mockResolvedValue(0);
    await __resetBridgeContinuationRecoverySchedulerForTests();
  });

  afterEach(async () => {
    await __resetBridgeContinuationRecoverySchedulerForTests();
    vi.useRealTimers();
  });

  it('runs at startup, remains single-flight, and stops future passes', async () => {
    let releaseFirstPass!: () => void;
    recoverMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstPass = resolve;
    }));

    const starting = startBridgeContinuationRecoveryScheduler({ intervalMs: 100 });
    await Promise.resolve();
    expect(recoverMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(recoverMock).toHaveBeenCalledTimes(1);

    releaseFirstPass();
    await starting;
    await vi.advanceTimersByTimeAsync(100);
    expect(recoverMock).toHaveBeenCalledTimes(2);

    await stopBridgeContinuationRecoveryScheduler();
    await vi.advanceTimersByTimeAsync(500);
    expect(recoverMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent when startup is requested twice', async () => {
    await startBridgeContinuationRecoveryScheduler({ intervalMs: 100 });
    await startBridgeContinuationRecoveryScheduler({ intervalMs: 100 });
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });
});
