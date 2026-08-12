export type CheckinSchedulePolicy = {
  timeZone: string;
  windowStart: string;
  windowEnd: string;
  jitterMinutes: number;
  catchUp: boolean;
};

export const DEFAULT_CHECKIN_SCHEDULE_POLICY: CheckinSchedulePolicy = {
  timeZone: '',
  windowStart: '00:00',
  windowEnd: '23:59',
  jitterMinutes: 0,
  catchUp: true,
};

function normalizeClock(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeCheckinSchedulePolicy(value: unknown): CheckinSchedulePolicy {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const jitterRaw = Number(raw.jitterMinutes);
  const jitterMinutes = Number.isFinite(jitterRaw)
    ? Math.min(180, Math.max(0, Math.trunc(jitterRaw)))
    : DEFAULT_CHECKIN_SCHEDULE_POLICY.jitterMinutes;
  const timeZone = typeof raw.timeZone === 'string' ? raw.timeZone.trim() : '';
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format();
    } catch {
      return {
        ...DEFAULT_CHECKIN_SCHEDULE_POLICY,
        windowStart: normalizeClock(raw.windowStart, DEFAULT_CHECKIN_SCHEDULE_POLICY.windowStart),
        windowEnd: normalizeClock(raw.windowEnd, DEFAULT_CHECKIN_SCHEDULE_POLICY.windowEnd),
        jitterMinutes,
        catchUp: raw.catchUp !== false,
      };
    }
  }
  return {
    timeZone,
    windowStart: normalizeClock(raw.windowStart, DEFAULT_CHECKIN_SCHEDULE_POLICY.windowStart),
    windowEnd: normalizeClock(raw.windowEnd, DEFAULT_CHECKIN_SCHEDULE_POLICY.windowEnd),
    jitterMinutes,
    catchUp: raw.catchUp !== false,
  };
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour * 60) + minute;
}

function resolveDateParts(now: Date, timeZone: string): { dayKey: string; minutes: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour === '24' ? '00' : parts.hour);
  const minute = Number(parts.minute);
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (hour * 60) + minute,
  };
}

export function resolveCheckinLocalMinutes(now: Date, policyInput?: unknown): number {
  return resolveDateParts(now, normalizeCheckinSchedulePolicy(policyInput).timeZone).minutes;
}

function isAfterJitteredWindowStart(
  currentMinutes: number,
  accountId: number,
  dayKey: string,
  policy: CheckinSchedulePolicy,
): boolean {
  const start = clockMinutes(policy.windowStart);
  const end = clockMinutes(policy.windowEnd);
  const jitter = resolveDeterministicJitterMinutes(accountId, dayKey, policy);
  if (start === end) return currentMinutes >= jitter;
  if (start < end) return currentMinutes >= start + jitter;
  // For a window crossing midnight, the post-midnight portion belongs to the
  // window opened on the previous local day, so its jitter has already elapsed.
  return currentMinutes >= start ? currentMinutes >= start + jitter : currentMinutes <= end;
}

export function isWithinCheckinWindow(now: Date, policyInput?: unknown): boolean {
  const policy = normalizeCheckinSchedulePolicy(policyInput);
  const current = resolveDateParts(now, policy.timeZone);
  const start = clockMinutes(policy.windowStart);
  const end = clockMinutes(policy.windowEnd);
  if (start === end) return true;
  if (start < end) return current.minutes >= start && current.minutes <= end;
  return current.minutes >= start || current.minutes <= end;
}

export function resolveCheckinDayKey(now: Date, policyInput?: unknown): string {
  const policy = normalizeCheckinSchedulePolicy(policyInput);
  const current = resolveDateParts(now, policy.timeZone);
  const start = clockMinutes(policy.windowStart);
  const end = clockMinutes(policy.windowEnd);
  if (start > end && current.minutes <= end) {
    const previous = new Date(`${current.dayKey}T00:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    return previous.toISOString().slice(0, 10);
  }
  return current.dayKey;
}

export function resolveDeterministicJitterMinutes(
  accountId: number,
  dayKey: string,
  policyInput?: unknown,
): number {
  const policy = normalizeCheckinSchedulePolicy(policyInput);
  if (policy.jitterMinutes <= 0) return 0;
  let hash = 2166136261;
  const text = `${Math.trunc(accountId)}:${dayKey}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % (policy.jitterMinutes + 1);
}

export function isCheckinDueAt(input: {
  accountId: number;
  lastCheckinAt?: string | null;
  now?: Date;
  intervalHours: number;
  policy?: unknown;
  mode?: 'cron' | 'interval';
  catchUpPass?: boolean;
}): boolean {
  const now = input.now || new Date();
  const policy = normalizeCheckinSchedulePolicy(input.policy);
  if (!isWithinCheckinWindow(now, policy)) return false;
  const lastCheckinMs = input.lastCheckinAt ? Date.parse(input.lastCheckinAt) : Number.NaN;
  const dayKey = resolveCheckinDayKey(now, policy);
  if (!isAfterJitteredWindowStart(resolveCheckinLocalMinutes(now, policy), input.accountId, dayKey, policy)) {
    return false;
  }
  if (!Number.isFinite(lastCheckinMs)) {
    if ((input.mode === 'interval' || input.catchUpPass) && !policy.catchUp) return false;
    return true;
  }

  if (input.catchUpPass && !policy.catchUp) return false;

  if (input.mode === 'cron') {
    return resolveCheckinDayKey(new Date(lastCheckinMs), policy) !== dayKey;
  }

  const jitterMs = resolveDeterministicJitterMinutes(input.accountId, dayKey, policy) * 60 * 1000;
  const intervalMs = Math.max(1, input.intervalHours) * 60 * 60 * 1000;
  return now.getTime() - lastCheckinMs >= intervalMs + jitterMs;
}
