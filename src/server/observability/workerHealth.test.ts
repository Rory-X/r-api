import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkerHealthSnapshot,
  resetWorkerHealthForTests,
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from './workerHealth.js';

describe('worker health registry', () => {
  afterEach(() => {
    resetWorkerHealthForTests();
    vi.useRealTimers();
  });

  it('reports successful passes and stale workers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T00:00:00.000Z'));
    startObservedWorker({ name: 'example', intervalMs: 1_000, critical: true });
    await runObservedWorkerPass('example', async () => 'ok');

    expect(getWorkerHealthSnapshot().workers[0]).toMatchObject({
      name: 'example',
      status: 'healthy',
      consecutiveFailures: 0,
    });

    vi.advanceTimersByTime(30_001);
    const stale = getWorkerHealthSnapshot();
    expect(stale.workers[0]?.status).toBe('degraded');
    expect(stale.blockingWorkers).toEqual(['example']);
  });

  it('records failures without hiding the original error', async () => {
    startObservedWorker({ name: 'failing', intervalMs: 5_000 });
    await expect(runObservedWorkerPass('failing', async () => {
      throw new Error('dependency unavailable');
    })).rejects.toThrow('dependency unavailable');

    expect(getWorkerHealthSnapshot().workers[0]).toMatchObject({
      status: 'degraded',
      consecutiveFailures: 1,
      lastError: 'dependency unavailable',
    });
  });

  it('redacts credentials from health errors and trace-safe summaries', async () => {
    startObservedWorker({ name: 'redaction', intervalMs: 5_000 });
    await expect(runObservedWorkerPass('redaction', async () => {
      throw new Error('request failed https://alice:secret@example.com/path?token=abc api_key=xyz');
    })).rejects.toThrow('api_key=xyz');

    const error = getWorkerHealthSnapshot().workers[0]?.lastError || '';
    expect(error).toContain('redacted');
    expect(error).not.toContain('secret');
    expect(error).not.toContain('abc');
    expect(error).not.toContain('xyz');
  });

  it('distinguishes disabled and stopped workers', () => {
    startObservedWorker({ name: 'disabled', intervalMs: 5_000, enabled: false });
    startObservedWorker({ name: 'stopped', intervalMs: 5_000 });
    stopObservedWorker('stopped');

    const snapshot = getWorkerHealthSnapshot();
    expect(snapshot.summary).toMatchObject({ disabled: 1, stopped: 1 });
  });
});
