import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { passMock, syncLongConnectionsMock, stopLongConnectionsMock } = vi.hoisted(() => ({
  passMock: vi.fn(),
  syncLongConnectionsMock: vi.fn(),
  stopLongConnectionsMock: vi.fn(),
}));

vi.mock('./feishuInteractionAdapterService.js', () => ({
  runFeishuInteractionDispatchPass: passMock,
}));

vi.mock('./feishuLongConnectionService.js', () => ({
  syncFeishuLongConnections: syncLongConnectionsMock,
  stopFeishuLongConnections: stopLongConnectionsMock,
}));

import {
  __resetFeishuInteractionAdapterSchedulerForTests,
  startFeishuInteractionAdapterScheduler,
  stopFeishuInteractionAdapterScheduler,
} from './feishuInteractionAdapterScheduler.js';

describe('Feishu Interaction Adapter scheduler', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    passMock.mockResolvedValue({ delivered: 0, failed: 0, unknown: 0 });
    syncLongConnectionsMock.mockResolvedValue(undefined);
    await __resetFeishuInteractionAdapterSchedulerForTests();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await __resetFeishuInteractionAdapterSchedulerForTests();
    vi.useRealTimers();
  });

  it('runs at startup and remains single-flight', async () => {
    let release!: () => void;
    passMock.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ delivered: 0, failed: 0, unknown: 0 });
    }));
    const starting = startFeishuInteractionAdapterScheduler({ intervalMs: 250 });
    await Promise.resolve();
    expect(passMock).toHaveBeenCalledTimes(1);
    expect(syncLongConnectionsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(passMock).toHaveBeenCalledTimes(1);
    release();
    await starting;
    await vi.advanceTimersByTimeAsync(250);
    expect(passMock).toHaveBeenCalledTimes(2);
    await stopFeishuInteractionAdapterScheduler();
    expect(stopLongConnectionsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps dispatching when long connection config sync fails', async () => {
    syncLongConnectionsMock.mockRejectedValueOnce(new Error('credential unavailable'));
    await startFeishuInteractionAdapterScheduler({ intervalMs: 250 });
    expect(passMock).toHaveBeenCalledTimes(1);
  });
});
