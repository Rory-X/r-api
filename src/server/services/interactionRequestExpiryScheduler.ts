import { expireInteractionRequests } from './interactionRequestService.js';

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepPassPromise: Promise<void> | null = null;
let sweepStarted = false;

function normalizeInterval(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SWEEP_INTERVAL_MS;
  return Math.min(60_000, Math.max(100, parsed));
}

async function runSweepPass(): Promise<void> {
  try {
    const expired = await expireInteractionRequests();
    if (expired > 0) {
      console.warn(`[interaction] expired ${expired} pending request(s)`);
    }
  } catch (error) {
    console.warn(`[interaction] expiry sweep failed: ${(error as Error)?.message || 'unknown error'}`);
  }
}

function scheduleSweepPass(): void {
  if (!sweepStarted || sweepPassPromise) return;
  sweepPassPromise = runSweepPass().finally(() => {
    sweepPassPromise = null;
  });
}

export async function startInteractionRequestExpiryScheduler(
  options: { intervalMs?: number } = {},
): Promise<void> {
  if (sweepStarted) return;
  sweepStarted = true;
  scheduleSweepPass();
  await sweepPassPromise;
  if (!sweepStarted) return;
  sweepTimer = setInterval(scheduleSweepPass, normalizeInterval(options.intervalMs));
  sweepTimer.unref?.();
}

export async function stopInteractionRequestExpiryScheduler(): Promise<void> {
  sweepStarted = false;
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  await sweepPassPromise;
}

export async function __resetInteractionRequestExpirySchedulerForTests(): Promise<void> {
  await stopInteractionRequestExpiryScheduler();
  sweepPassPromise = null;
}
