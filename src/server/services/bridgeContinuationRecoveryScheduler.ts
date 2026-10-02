import { recoverExpiredBridgeContinuationLeases } from './bridgeContinuationService.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';

const DEFAULT_RECOVERY_INTERVAL_MS = 5_000;
const WORKER_NAME = 'bridge-continuation-recovery';

let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryPassPromise: Promise<void> | null = null;
let recoveryStarted = false;

function normalizeInterval(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECOVERY_INTERVAL_MS;
  return Math.min(60_000, Math.max(100, parsed));
}

async function runRecoveryPass(): Promise<void> {
  try {
    await runObservedWorkerPass(WORKER_NAME, async () => {
      const recovered = await recoverExpiredBridgeContinuationLeases();
      if (recovered > 0) {
        console.warn(`[bridge-continuation] recovered ${recovered} expired lease(s)`);
      }
    });
  } catch (error) {
    console.warn(
      `[bridge-continuation] lease recovery failed: ${(error as Error)?.message || 'unknown error'}`,
    );
  }
}

function scheduleRecoveryPass(): void {
  if (!recoveryStarted || recoveryPassPromise) return;
  recoveryPassPromise = runRecoveryPass().finally(() => {
    recoveryPassPromise = null;
  });
}

export async function startBridgeContinuationRecoveryScheduler(
  options: { intervalMs?: number } = {},
): Promise<void> {
  if (recoveryStarted) return;
  recoveryStarted = true;
  startObservedWorker({ name: WORKER_NAME, intervalMs: normalizeInterval(options.intervalMs) });
  scheduleRecoveryPass();
  await recoveryPassPromise;
  if (!recoveryStarted) return;
  recoveryTimer = setInterval(scheduleRecoveryPass, normalizeInterval(options.intervalMs));
  recoveryTimer.unref?.();
}

export async function stopBridgeContinuationRecoveryScheduler(): Promise<void> {
  recoveryStarted = false;
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  await recoveryPassPromise;
  stopObservedWorker(WORKER_NAME);
}

export async function __resetBridgeContinuationRecoverySchedulerForTests(): Promise<void> {
  await stopBridgeContinuationRecoveryScheduler();
  recoveryPassPromise = null;
}
