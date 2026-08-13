import { reconcileGlobalBridgeContinuationTasks } from './globalBridgeContinuationService.js';

const DEFAULT_RECONCILIATION_INTERVAL_MS = 5_000;

let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
let reconciliationPassPromise: Promise<void> | null = null;
let reconciliationStarted = false;

function normalizeInterval(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECONCILIATION_INTERVAL_MS;
  return Math.min(60_000, Math.max(100, parsed));
}

async function runReconciliationPass(): Promise<void> {
  try {
    const coverage = await reconcileGlobalBridgeContinuationTasks();
    if (coverage.created > 0) {
      console.info(`[bridge-continuation] global mode covered ${coverage.created} new session(s)`);
    }
  } catch (error) {
    console.warn(
      `[bridge-continuation] global reconciliation failed: ${(error as Error)?.message || 'unknown error'}`,
    );
  }
}

function scheduleReconciliationPass(): void {
  if (!reconciliationStarted || reconciliationPassPromise) return;
  reconciliationPassPromise = runReconciliationPass().finally(() => {
    reconciliationPassPromise = null;
  });
}

export async function startGlobalBridgeContinuationScheduler(
  options: { intervalMs?: number } = {},
): Promise<void> {
  if (reconciliationStarted) return;
  reconciliationStarted = true;
  scheduleReconciliationPass();
  await reconciliationPassPromise;
  if (!reconciliationStarted) return;
  reconciliationTimer = setInterval(scheduleReconciliationPass, normalizeInterval(options.intervalMs));
  reconciliationTimer.unref?.();
}

export async function stopGlobalBridgeContinuationScheduler(): Promise<void> {
  reconciliationStarted = false;
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }
  await reconciliationPassPromise;
}

export async function __resetGlobalBridgeContinuationSchedulerForTests(): Promise<void> {
  await stopGlobalBridgeContinuationScheduler();
  reconciliationPassPromise = null;
}
