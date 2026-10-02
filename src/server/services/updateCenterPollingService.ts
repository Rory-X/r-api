import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { sendNotification } from './notifyService.js';
import { refreshUpdateCenterStatusCache } from './updateCenterStatusService.js';
import { loadUpdateCenterRuntimeState, saveUpdateCenterRuntimeState } from './updateCenterRuntimeStateService.js';
import type { UpdateReminderCandidate } from './updateCenterReminderService.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';

const DEFAULT_UPDATE_CENTER_INTERVAL_MS = 15 * 60 * 1000;
const WORKER_NAME = 'update-center-polling';

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;

function summarizeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'unknown error');
}

function buildReminderEvent(candidate: UpdateReminderCandidate | null) {
  if (!candidate) return null;
  const title = candidate.kind === 'new-digest'
    ? '更新中心发现新 digest'
    : '更新中心发现新版本';
  const message = candidate.kind === 'new-digest'
    ? `检测到 ${candidate.displayVersion} 指向了新的镜像 digest，可前往更新中心查看并手动部署。`
    : `检测到 ${candidate.displayVersion} 已可部署，可前往更新中心查看并手动部署。`;
  return {
    title,
    message,
  };
}

async function runSyncOnce() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await runObservedWorkerPass(WORKER_NAME, async () => {
      const checkedAt = formatUtcSqlDateTime(new Date());
      try {
        const {
          candidate,
          previousRuntime,
          runtime,
        } = await refreshUpdateCenterStatusCache(checkedAt);

        if (candidate && candidate.candidateKey !== previousRuntime.lastNotifiedCandidateKey) {
          const reminderEvent = buildReminderEvent(candidate);
          if (reminderEvent) {
            await db.insert(schema.events).values({
              type: 'status',
              title: reminderEvent.title,
              message: reminderEvent.message,
              level: 'info',
              relatedType: 'update_center',
              createdAt: checkedAt,
            }).run();
            await saveUpdateCenterRuntimeState({
              ...runtime,
              lastNotifiedCandidateKey: candidate.candidateKey,
              lastNotifiedAt: checkedAt,
            });
            await sendNotification(reminderEvent.title, reminderEvent.message, 'info', {
              bypassThrottle: true,
            });
          }
        }
      } catch (error) {
        const previousRuntime = await loadUpdateCenterRuntimeState();
        await saveUpdateCenterRuntimeState({
          ...previousRuntime,
          lastCheckedAt: checkedAt,
          lastCheckError: summarizeError(error),
        });
        throw error;
      }
    });
  } catch {
    // Failure details are persisted and exposed through worker health.
  } finally {
    syncRunning = false;
  }
}

export function startUpdateCenterPolling(intervalMs = DEFAULT_UPDATE_CENTER_INTERVAL_MS) {
  stopUpdateCenterPolling();
  const safeIntervalMs = Math.max(10_000, intervalMs);
  startObservedWorker({ name: WORKER_NAME, intervalMs: safeIntervalMs });
  pollingTimer = setInterval(() => {
    void runSyncOnce();
  }, safeIntervalMs);
  pollingTimer.unref?.();
  void runSyncOnce();
  return { intervalMs: safeIntervalMs };
}

export function stopUpdateCenterPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  stopObservedWorker(WORKER_NAME);
}
