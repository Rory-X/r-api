import { syncSiteAnnouncements } from './siteAnnouncementService.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';

const DEFAULT_SITE_ANNOUNCEMENT_INTERVAL_MS = 15 * 60 * 1000;
const WORKER_NAME = 'site-announcement-polling';

let pollingTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;

async function runSyncOnce() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    await runObservedWorkerPass(WORKER_NAME, syncSiteAnnouncements);
  } catch (error) {
    console.error('[SiteAnnouncementPolling] Sync failed:', error);
  } finally {
    syncRunning = false;
  }
}

export function startSiteAnnouncementPolling(intervalMs = DEFAULT_SITE_ANNOUNCEMENT_INTERVAL_MS) {
  stopSiteAnnouncementPolling();
  const safeIntervalMs = Math.max(10_000, intervalMs);
  startObservedWorker({ name: WORKER_NAME, intervalMs: safeIntervalMs });
  pollingTimer = setInterval(() => {
    void runSyncOnce();
  }, safeIntervalMs);
  pollingTimer.unref?.();
  void runSyncOnce();
  return { intervalMs: safeIntervalMs };
}

export function stopSiteAnnouncementPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  stopObservedWorker(WORKER_NAME);
}
