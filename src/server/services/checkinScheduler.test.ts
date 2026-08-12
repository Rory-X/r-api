import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();
const accountRowsMock = vi.fn(() => [] as any[]);

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => accountRowsMock(),
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      accounts: { checkinEnabled: 'checkinEnabled', status: 'status', siteId: 'siteId' },
      sites: { id: 'id', status: 'status' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
    accountRowsMock.mockReset();
    accountRowsMock.mockReturnValue([]);
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');
    const { config } = await import('../config.js');
    config.checkinSchedulePolicy = {
      timeZone: 'UTC',
      windowStart: '08:00',
      windowEnd: '09:00',
      jitterMinutes: 0,
      catchUp: false,
    };

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('does not start a second automatic pass while the first pass is still running', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const { config } = await import('../config.js');
    config.checkinIntervalHours = 6;
    config.checkinSchedulePolicy = {
      timeZone: 'UTC',
      windowStart: '00:00',
      windowEnd: '23:59',
      jitterMinutes: 0,
      catchUp: true,
    };
    accountRowsMock.mockReturnValue([{
      accounts: {
        id: 11,
        siteId: 7,
        checkinEnabled: true,
        status: 'active',
        lastCheckinAt: null,
      },
      sites: { id: 7, status: 'active' },
    }]);

    let resolveFirst: (value: any[]) => void = () => {};
    allMock.mockImplementationOnce(() => new Promise<any[]>((resolve) => {
      resolveFirst = resolve;
    }));

    const now = new Date('2026-08-04T08:00:00.000Z');
    const first = scheduler.__runCheckinPassForTests({ mode: 'interval', now });
    await Promise.resolve();
    const second = scheduler.__runCheckinPassForTests({ mode: 'interval', now });
    await second;

    expect(allMock).toHaveBeenCalledTimes(1);
    resolveFirst([]);
    await first;
  });

  it('suppresses a repeated cron attempt for the same local day', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-08-04T08:00:00.000Z');
    const attemptDays = new Map([[4, '2026-08-04']]);

    expect(scheduler.selectDueCheckinAccountIds([
      { id: 4, lastCheckinAt: '2026-08-03T08:00:00.000Z' },
      { id: 5, lastCheckinAt: '2026-08-03T08:00:00.000Z' },
    ], {
      mode: 'cron',
      intervalHours: 6,
      now,
      attemptDayState: attemptDays,
      policy: {
        timeZone: 'UTC',
        windowStart: '08:00',
        windowEnd: '09:00',
        jitterMinutes: 0,
        catchUp: true,
      },
    })).toEqual([5]);
  });
});
