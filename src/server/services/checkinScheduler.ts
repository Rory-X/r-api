import cron from 'node-cron';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAll } from './checkinService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import { cleanupConfiguredLogs } from './logCleanupService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';
import {
  isCheckinDueAt,
  normalizeCheckinSchedulePolicy,
  resolveCheckinDayKey,
  type CheckinSchedulePolicy,
} from './checkinSchedulePolicy.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';

export type CheckinScheduleMode = 'cron' | 'interval';

let checkinTask: cron.ScheduledTask | null = null;
let checkinIntervalTimer: ReturnType<typeof setInterval> | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let logCleanupTask: cron.ScheduledTask | null = null;
const intervalAttemptByAccount = new Map<number, number>();
const cronAttemptDayByAccount = new Map<number, string>();
let checkinPassInFlight = false;

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';
const CHECKIN_INTERVAL_POLL_MS = 60_000;
const CRON_WORKER_FRESHNESS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECKIN_WORKER = 'scheduled-checkin';
const BALANCE_WORKER = 'scheduled-balance-refresh';
const DAILY_SUMMARY_WORKER = 'scheduled-daily-summary';
const LOG_CLEANUP_WORKER = 'scheduled-log-cleanup';

async function resolveJsonSetting<T>(
  settingKey: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): Promise<T> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (isValid(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  return resolveJsonSetting(settingKey, (value): value is string => typeof value === 'string' && cron.validate(value), fallback);
}

async function resolveBooleanSetting(settingKey: string, fallback: boolean): Promise<boolean> {
  return resolveJsonSetting(settingKey, (value): value is boolean => typeof value === 'boolean', fallback);
}

async function resolvePositiveIntegerSetting(settingKey: string, fallback: number): Promise<number> {
  return resolveJsonSetting(
    settingKey,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1,
    fallback,
  );
}

type CheckinCandidate = {
  id: number;
  lastCheckinAt?: string | null;
};

export function selectDueCheckinAccountIds(
  rows: CheckinCandidate[],
  input: {
    mode: CheckinScheduleMode;
    intervalHours: number;
    policy?: unknown;
    now?: Date;
    attemptState?: Map<number, number>;
    attemptDayState?: Map<number, string>;
    catchUpPass?: boolean;
  },
) {
  const now = input.now || new Date();
  const attemptState = input.attemptState || new Map<number, number>();
  const intervalMs = Math.max(1, input.intervalHours) * 60 * 60 * 1000;

  return rows
    .filter((row) => {
      const lastAttemptMs = attemptState.get(row.id);
      if (typeof lastAttemptMs === 'number' && now.getTime() - lastAttemptMs < intervalMs) return false;
      if (
        input.mode === 'cron'
        && input.attemptDayState?.get(row.id) === resolveCheckinDayKey(now, input.policy)
      ) return false;
      return isCheckinDueAt({
        accountId: row.id,
        lastCheckinAt: row.lastCheckinAt,
        now,
        intervalHours: input.intervalHours,
        mode: input.mode,
        catchUpPass: input.catchUpPass,
        policy: input.policy,
      });
    })
    .map((row) => row.id);
}

export function selectDueIntervalCheckinAccountIds(
  rows: CheckinCandidate[],
  intervalHours: number,
  now = new Date(),
  attemptState = intervalAttemptByAccount,
) {
  return selectDueCheckinAccountIds(rows, {
    mode: 'interval',
    intervalHours,
    now,
    attemptState,
  });
}

async function loadEligibleCheckinCandidates(): Promise<CheckinCandidate[]> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  return rows
    .filter((row: any) => row.accounts?.checkinEnabled === true && row.accounts?.status === 'active' && row.sites?.status !== 'disabled')
    .map((row: any) => ({
      id: row.accounts.id,
      lastCheckinAt: row.accounts.lastCheckinAt,
    }));
}

async function runCheckinPass(input: {
  mode: CheckinScheduleMode;
  now?: Date;
  catchUpPass?: boolean;
}) {
  if (checkinPassInFlight) return;
  checkinPassInFlight = true;
  const now = input.now || new Date();
  try {
    await runObservedWorkerPass(CHECKIN_WORKER, async () => {
      const candidates = await loadEligibleCheckinCandidates();
      const dueAccountIds = selectDueCheckinAccountIds(candidates, {
        mode: input.mode,
        intervalHours: config.checkinIntervalHours,
        policy: config.checkinSchedulePolicy,
        now,
        attemptState: input.mode === 'interval' ? intervalAttemptByAccount : undefined,
        attemptDayState: input.mode === 'cron' ? cronAttemptDayByAccount : undefined,
        catchUpPass: input.catchUpPass,
      });
      if (dueAccountIds.length === 0) return;

      if (input.mode === 'interval') {
        const nowMs = now.getTime();
        for (const accountId of dueAccountIds) intervalAttemptByAccount.set(accountId, nowMs);
      } else {
        const dayKey = resolveCheckinDayKey(now, config.checkinSchedulePolicy);
        for (const accountId of dueAccountIds) cronAttemptDayByAccount.set(accountId, dayKey);
      }

      const results = await checkinAll({
        accountIds: dueAccountIds,
        scheduleMode: input.mode,
        automatic: true,
      });
      const success = results.filter((r) => r.result.success).length;
      const failed = results.length - success;
      console.log(`[Scheduler] ${input.mode} check-in complete: ${success} success, ${failed} failed`);
    });
  } catch (err) {
    console.error(`[Scheduler] ${input.mode} check-in error:`, err);
  } finally {
    checkinPassInFlight = false;
  }
}

export async function __runCheckinPassForTests(input: {
  mode: CheckinScheduleMode;
  now?: Date;
  catchUpPass?: boolean;
}) {
  await runCheckinPass(input);
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check-in at ${new Date().toISOString()}`);
    await runCheckinPass({ mode: 'cron', catchUpPass: false });
  });
}

async function runIntervalCheckinPass(now = new Date()) {
  await runCheckinPass({ mode: 'interval', now });
}

function stopCheckinSchedule() {
  checkinTask?.stop();
  checkinTask = null;
  if (checkinIntervalTimer) {
    clearInterval(checkinIntervalTimer);
    checkinIntervalTimer = null;
  }
  stopObservedWorker(CHECKIN_WORKER);
}

function startCheckinSchedule() {
  stopCheckinSchedule();
  startObservedWorker({
    name: CHECKIN_WORKER,
    intervalMs: config.checkinScheduleMode === 'interval'
      ? CHECKIN_INTERVAL_POLL_MS
      : CRON_WORKER_FRESHNESS_INTERVAL_MS,
  });
  if (config.checkinScheduleMode === 'interval') {
    checkinIntervalTimer = setInterval(() => {
      void runIntervalCheckinPass();
    }, CHECKIN_INTERVAL_POLL_MS);
    return;
  }
  checkinTask = createCheckinTask(config.checkinCron);
  if (config.checkinSchedulePolicy.catchUp) {
    checkinIntervalTimer = setInterval(() => {
      void runCheckinPass({ mode: 'cron', catchUpPass: true });
    }, CHECKIN_INTERVAL_POLL_MS);
  }
}

function createBalanceTask(cronExpr: string) {
  startObservedWorker({ name: BALANCE_WORKER, intervalMs: CRON_WORKER_FRESHNESS_INTERVAL_MS });
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Refreshing balances at ${new Date().toISOString()}`);
    try {
      await runObservedWorkerPass(BALANCE_WORKER, async () => {
        await refreshAllBalances();
        await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
        console.log('[Scheduler] Balance refresh complete');
      });
    } catch (err) {
      console.error('[Scheduler] Balance refresh error:', err);
    }
  });
}

function createDailySummaryTask(cronExpr: string) {
  startObservedWorker({ name: DAILY_SUMMARY_WORKER, intervalMs: CRON_WORKER_FRESHNESS_INTERVAL_MS });
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Sending daily summary at ${new Date().toISOString()}`);
    try {
      await runObservedWorkerPass(DAILY_SUMMARY_WORKER, async () => {
        const metrics = await collectDailySummaryMetrics();
        const { title, message } = buildDailySummaryNotification(metrics);
        await sendNotification(title, message, 'info', {
          bypassThrottle: true,
          requireChannel: true,
          throwOnFailure: true,
        });
        console.log(`[Scheduler] Daily summary sent: ${title}`);
      });
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
  });
}

function createLogCleanupTask(cronExpr: string) {
  startObservedWorker({ name: LOG_CLEANUP_WORKER, intervalMs: CRON_WORKER_FRESHNESS_INTERVAL_MS });
  return cron.schedule(cronExpr, async () => {
    try {
      await runObservedWorkerPass(LOG_CLEANUP_WORKER, async () => {
        if (!config.logCleanupConfigured) {
          console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
          return;
        }
        console.log(`[Scheduler] Running log cleanup at ${new Date().toISOString()}`);
        const result = await cleanupConfiguredLogs();
        if (!result.enabled) {
          console.log('[Scheduler] Log cleanup skipped: no log target enabled');
          return;
        }
      console.log(
        `[Scheduler] Log cleanup complete: usage=${result.usageLogsDeleted}, program=${result.programLogsDeleted}, cutoff=${result.cutoffUtc}`,
      );
      });
    } catch (err) {
      console.error('[Scheduler] Log cleanup error:', err);
    }
  });
}

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeCheckinScheduleMode = await resolveJsonSetting<CheckinScheduleMode>(
    'checkin_schedule_mode',
    (value): value is CheckinScheduleMode => value === 'cron' || value === 'interval',
    config.checkinScheduleMode as CheckinScheduleMode,
  );
  const activeCheckinIntervalHours = await resolvePositiveIntegerSetting(
    'checkin_interval_hours',
    config.checkinIntervalHours,
  );
  const activeCheckinSchedulePolicy = normalizeCheckinSchedulePolicy(
    await resolveJsonSetting<CheckinSchedulePolicy>(
      'checkin_schedule_policy',
      (value): value is CheckinSchedulePolicy => !!value && typeof value === 'object' && !Array.isArray(value),
      config.checkinSchedulePolicy,
    ),
  );
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeLogCleanupCron = await resolveCronSetting('log_cleanup_cron', config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON);
  const activeLogCleanupUsageLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_usage_logs_enabled',
    config.logCleanupUsageLogsEnabled,
  );
  const activeLogCleanupProgramLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_program_logs_enabled',
    config.logCleanupProgramLogsEnabled,
  );
  const activeLogCleanupRetentionDays = await resolvePositiveIntegerSetting(
    'log_cleanup_retention_days',
    normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays),
  );
  config.checkinCron = activeCheckinCron;
  config.checkinScheduleMode = activeCheckinScheduleMode;
  config.checkinIntervalHours = Math.min(24, Math.max(1, activeCheckinIntervalHours));
  config.checkinSchedulePolicy = activeCheckinSchedulePolicy;
  config.balanceRefreshCron = activeBalanceCron;
  config.logCleanupCron = activeLogCleanupCron;
  config.logCleanupUsageLogsEnabled = activeLogCleanupUsageLogsEnabled;
  config.logCleanupProgramLogsEnabled = activeLogCleanupProgramLogsEnabled;
  config.logCleanupRetentionDays = activeLogCleanupRetentionDays;

  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  startCheckinSchedule();
  balanceTask = createBalanceTask(activeBalanceCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  logCleanupTask = createLogCleanupTask(activeLogCleanupCron);

  console.log(`[Scheduler] Check-in schedule: ${config.checkinScheduleMode} (${config.checkinScheduleMode === 'cron' ? activeCheckinCron : `${config.checkinIntervalHours}h`})`);
  console.log(
    `[Scheduler] Check-in window: ${config.checkinSchedulePolicy.windowStart}-${config.checkinSchedulePolicy.windowEnd} (${config.checkinSchedulePolicy.timeZone || 'server timezone'}, jitter<=${config.checkinSchedulePolicy.jitterMinutes}m, catchUp=${config.checkinSchedulePolicy.catchUp})`,
  );
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(
    `[Scheduler] Log cleanup cron: ${activeLogCleanupCron} (configured=${config.logCleanupConfigured}, usage=${activeLogCleanupUsageLogsEnabled}, program=${activeLogCleanupProgramLogsEnabled}, retentionDays=${activeLogCleanupRetentionDays})`,
  );
}

export function stopScheduler() {
  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  balanceTask = null;
  dailySummaryTask = null;
  logCleanupTask = null;
  stopObservedWorker(BALANCE_WORKER);
  stopObservedWorker(DAILY_SUMMARY_WORKER);
  stopObservedWorker(LOG_CLEANUP_WORKER);
}

export function updateCheckinCron(cronExpr: string) {
  updateCheckinSchedule({
    mode: 'cron',
    cronExpr,
    intervalHours: config.checkinIntervalHours,
  });
}

export function updateCheckinSchedule(input: {
  mode: CheckinScheduleMode;
  cronExpr?: string;
  intervalHours?: number;
}) {
  const nextMode = input.mode;
  if (nextMode !== 'cron' && nextMode !== 'interval') {
    throw new Error(`Invalid checkin schedule mode: ${String(nextMode)}`);
  }

  const nextCronExpr = input.cronExpr ?? config.checkinCron;
  if (!cron.validate(nextCronExpr)) throw new Error(`Invalid cron: ${nextCronExpr}`);

  const nextIntervalHours = input.intervalHours ?? config.checkinIntervalHours;
  if (!Number.isFinite(nextIntervalHours) || nextIntervalHours < 1 || nextIntervalHours > 24) {
    throw new Error(`Invalid interval hours: ${String(nextIntervalHours)}`);
  }

  config.checkinScheduleMode = nextMode;
  config.checkinCron = nextCronExpr;
  config.checkinIntervalHours = Math.trunc(nextIntervalHours);
  startCheckinSchedule();
}

export function updateCheckinSchedulePolicy(input: unknown) {
  config.checkinSchedulePolicy = normalizeCheckinSchedulePolicy(input);
  startCheckinSchedule();
}

export function updateBalanceRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.balanceRefreshCron = cronExpr;
  balanceTask?.stop();
  balanceTask = createBalanceTask(cronExpr);
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);

  const retentionDays = normalizeLogCleanupRetentionDays(input.retentionDays ?? config.logCleanupRetentionDays);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = retentionDays;

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

export function __resetCheckinSchedulerForTests() {
  stopScheduler();
  intervalAttemptByAccount.clear();
  cronAttemptDayByAccount.clear();
  checkinPassInFlight = false;
}
