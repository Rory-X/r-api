import { runFeishuInteractionDispatchPass } from './feishuInteractionAdapterService.js';
import {
  stopFeishuLongConnections,
  syncFeishuLongConnections,
} from './feishuLongConnectionService.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';

const DEFAULT_DISPATCH_INTERVAL_MS = 5_000;
const WORKER_NAME = 'feishu-interaction-dispatch';

let dispatchTimer: ReturnType<typeof setInterval> | null = null;
let dispatchPassPromise: Promise<void> | null = null;
let dispatchStarted = false;

function normalizeInterval(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPATCH_INTERVAL_MS;
  return Math.min(60_000, Math.max(250, parsed));
}

async function runDispatchPass(): Promise<void> {
  try {
    await runObservedWorkerPass(WORKER_NAME, async () => {
      let passError: unknown = null;
      try {
        await syncFeishuLongConnections();
      } catch (error) {
        passError = error;
        console.warn(`[interaction-feishu-ws] config sync failed: ${(error as Error)?.message || 'unknown error'}`);
      }
      try {
        const result = await runFeishuInteractionDispatchPass();
        if (result.delivered > 0
          || result.unknown > 0
          || result.failed > 0
          || result.cardUpdated > 0
          || result.cardUpdateUnknown > 0
          || result.cardUpdateFailed > 0) {
          console.warn(
            `[interaction-feishu] delivered=${result.delivered} failed=${result.failed} unknown=${result.unknown}`
            + ` card_updated=${result.cardUpdated} card_failed=${result.cardUpdateFailed}`
            + ` card_unknown=${result.cardUpdateUnknown}`,
          );
        }
      } catch (error) {
        passError ??= error;
        console.warn(`[interaction-feishu] dispatch pass failed: ${(error as Error)?.message || 'unknown error'}`);
      }
      if (passError) throw passError;
    });
  } catch {}
}

function scheduleDispatchPass(): void {
  if (!dispatchStarted || dispatchPassPromise) return;
  dispatchPassPromise = runDispatchPass().finally(() => {
    dispatchPassPromise = null;
  });
}

export async function startFeishuInteractionAdapterScheduler(
  options: { intervalMs?: number } = {},
): Promise<void> {
  if (dispatchStarted) return;
  dispatchStarted = true;
  startObservedWorker({ name: WORKER_NAME, intervalMs: normalizeInterval(options.intervalMs) });
  scheduleDispatchPass();
  await dispatchPassPromise;
  if (!dispatchStarted) return;
  dispatchTimer = setInterval(scheduleDispatchPass, normalizeInterval(options.intervalMs));
  dispatchTimer.unref?.();
}

export async function stopFeishuInteractionAdapterScheduler(): Promise<void> {
  dispatchStarted = false;
  if (dispatchTimer) {
    clearInterval(dispatchTimer);
    dispatchTimer = null;
  }
  await dispatchPassPromise;
  stopFeishuLongConnections();
  stopObservedWorker(WORKER_NAME);
}

export async function __resetFeishuInteractionAdapterSchedulerForTests(): Promise<void> {
  await stopFeishuInteractionAdapterScheduler();
  dispatchPassPromise = null;
}
