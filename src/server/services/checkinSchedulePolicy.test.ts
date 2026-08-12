import { describe, expect, it } from 'vitest';
import {
  isCheckinDueAt,
  isWithinCheckinWindow,
  normalizeCheckinSchedulePolicy,
  resolveDeterministicJitterMinutes,
} from './checkinSchedulePolicy.js';

describe('checkin schedule policy', () => {
  it('supports windows that cross midnight in an explicit timezone', () => {
    const policy = { timeZone: 'Asia/Shanghai', windowStart: '23:00', windowEnd: '01:00' };
    expect(isWithinCheckinWindow(new Date('2026-08-04T15:30:00.000Z'), policy)).toBe(true);
    expect(isWithinCheckinWindow(new Date('2026-08-04T04:00:00.000Z'), policy)).toBe(false);
  });

  it('assigns stable jitter for the same account and day', () => {
    const first = resolveDeterministicJitterMinutes(42, '2026-08-04', { jitterMinutes: 30 });
    expect(first).toBe(resolveDeterministicJitterMinutes(42, '2026-08-04', { jitterMinutes: 30 }));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(30);
  });

  it('applies first-run jitter relative to the local window start', () => {
    const policy = { timeZone: 'UTC', windowStart: '08:00', windowEnd: '09:00', jitterMinutes: 30, catchUp: true };
    const accountId = Array.from({ length: 100 }, (_, index) => index + 1)
      .find((id) => resolveDeterministicJitterMinutes(id, '2026-08-04', policy) > 0)!;
    const jitter = resolveDeterministicJitterMinutes(accountId, '2026-08-04', policy);

    expect(isCheckinDueAt({
      accountId,
      lastCheckinAt: null,
      now: new Date(`2026-08-04T08:${String(jitter - 1).padStart(2, '0')}:00.000Z`),
      intervalHours: 6,
      policy,
      mode: 'interval',
    })).toBe(false);
    expect(isCheckinDueAt({
      accountId,
      lastCheckinAt: null,
      now: new Date(`2026-08-04T08:${String(jitter).padStart(2, '0')}:00.000Z`),
      intervalHours: 6,
      policy,
      mode: 'interval',
    })).toBe(true);
  });

  it('runs cron accounts at most once per local day', () => {
    const policy = { timeZone: 'Asia/Shanghai', windowStart: '08:00', windowEnd: '10:00', jitterMinutes: 0 };
    expect(isCheckinDueAt({
      accountId: 9,
      lastCheckinAt: '2026-08-04T00:05:00.000Z',
      now: new Date('2026-08-04T00:30:00.000Z'),
      intervalHours: 6,
      policy,
      mode: 'cron',
    })).toBe(false);
    expect(isCheckinDueAt({
      accountId: 9,
      lastCheckinAt: '2026-08-03T00:05:00.000Z',
      now: new Date('2026-08-04T00:30:00.000Z'),
      intervalHours: 6,
      policy,
      mode: 'cron',
    })).toBe(true);
  });

  it('anchors post-midnight times to the previous day for cross-midnight windows', () => {
    const policy = { timeZone: 'Asia/Shanghai', windowStart: '23:00', windowEnd: '01:00', jitterMinutes: 0 };
    expect(isCheckinDueAt({
      accountId: 9,
      lastCheckinAt: '2026-08-03T15:30:00.000Z',
      now: new Date('2026-08-03T16:30:00.000Z'),
      intervalHours: 6,
      policy,
      mode: 'cron',
    })).toBe(false);
  });

  it('only performs missed-run polling when catch-up is enabled', () => {
    const policy = { timeZone: 'UTC', windowStart: '08:00', windowEnd: '09:00', catchUp: false };
    expect(isCheckinDueAt({
      accountId: 3,
      lastCheckinAt: null,
      now: new Date('2026-08-04T08:15:00.000Z'),
      intervalHours: 6,
      policy,
      mode: 'cron',
      catchUpPass: false,
    })).toBe(true);
    expect(isCheckinDueAt({
      accountId: 3,
      lastCheckinAt: null,
      now: new Date('2026-08-04T08:15:00.000Z'),
      intervalHours: 6,
      policy,
      mode: 'cron',
      catchUpPass: true,
    })).toBe(false);
  });

  it('does not run outside the window and waits for interval plus jitter', () => {
    const policy = { timeZone: 'UTC', windowStart: '08:00', windowEnd: '09:00', jitterMinutes: 10 };
    expect(isCheckinDueAt({
      accountId: 7,
      lastCheckinAt: '2026-08-04T06:00:00.000Z',
      now: new Date('2026-08-04T07:30:00.000Z'),
      intervalHours: 1,
      policy,
    })).toBe(false);
    expect(isCheckinDueAt({
      accountId: 7,
      lastCheckinAt: '2026-08-04T06:00:00.000Z',
      now: new Date('2026-08-04T08:30:00.000Z'),
      intervalHours: 1,
      policy,
    })).toBe(true);
  });

  it('normalizes invalid timezone and clocks without throwing', () => {
    expect(normalizeCheckinSchedulePolicy({ timeZone: 'not-a-zone', windowStart: 'bad' })).toMatchObject({
      timeZone: '',
      windowStart: '00:00',
      windowEnd: '23:59',
    });
  });
});
