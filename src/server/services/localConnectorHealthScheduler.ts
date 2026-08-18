import { ensureLocalConnectorNotifyRepairAction } from './localConnectorService.js';
import { runLocalConnectorHealthMonitorPass } from './localConnectorHealthService.js';

const DEFAULT_MONITOR_INTERVAL_MS = 30_000;

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorPassPromise: Promise<void> | null = null;
let monitorStarted = false;

function normalizeInterval(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MONITOR_INTERVAL_MS;
  return Math.min(60_000, Math.max(1_000, parsed));
}

async function runMonitorPass(): Promise<void> {
  try {
    await runLocalConnectorHealthMonitorPass({
      requestRepair: ensureLocalConnectorNotifyRepairAction,
    });
  } catch (error) {
    console.warn(`[local-connector-health] monitor pass failed: ${(error as Error)?.message || 'unknown error'}`);
  }
}

function scheduleMonitorPass(): void {
  if (!monitorStarted || monitorPassPromise) return;
  monitorPassPromise = runMonitorPass().finally(() => {
    monitorPassPromise = null;
  });
}

export async function startLocalConnectorHealthScheduler(
  options: { intervalMs?: number } = {},
): Promise<void> {
  if (monitorStarted) return;
  monitorStarted = true;
  scheduleMonitorPass();
  await monitorPassPromise;
  if (!monitorStarted) return;
  monitorTimer = setInterval(scheduleMonitorPass, normalizeInterval(options.intervalMs));
  monitorTimer.unref?.();
}

export async function stopLocalConnectorHealthScheduler(): Promise<void> {
  monitorStarted = false;
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  await monitorPassPromise;
}

export async function __resetLocalConnectorHealthSchedulerForTests(): Promise<void> {
  await stopLocalConnectorHealthScheduler();
  monitorPassPromise = null;
}
