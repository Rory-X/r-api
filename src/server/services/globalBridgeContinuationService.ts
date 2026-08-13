import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { BridgeContinuationPolicyInput } from './bridgeContinuationContract.js';
import {
  GLOBAL_BRIDGE_CONTINUATION_REQUESTED_BY,
  getGlobalBridgeContinuationConfig,
  setGlobalBridgeContinuationConfig,
  type GlobalBridgeContinuationConfig,
} from './globalBridgeContinuationConfigService.js';
import { stopBridgeContinuationTask } from './bridgeContinuationService.js';
import { takeOverLocalConnectorThread } from './localConnectorControlPlaneService.js';

const ACTIVE_STATUSES = new Set(['waiting', 'backoff', 'running']);
const BLOCKING_TERMINAL_REASONS = new Set([
  'unrecoverable_failure',
  'attempt_limit',
  'elapsed_limit',
  'policy_stop',
]);

export type GlobalBridgeContinuationCoverage = Readonly<{
  eligible: number;
  covered: number;
  created: number;
  blocked: number;
}>;

function deviceCanControl(row: typeof schema.localConnectorDevices.$inferSelect): boolean {
  if (row.status !== 'active') return false;
  try {
    const scopes = JSON.parse(row.scopes);
    return Array.isArray(scopes) && scopes.includes('app_server.control');
  } catch {
    return false;
  }
}

function sessionKey(deviceId: string, threadId: string): string {
  return `${deviceId}\0${threadId}`;
}

export async function reconcileGlobalBridgeContinuationTasks(): Promise<GlobalBridgeContinuationCoverage> {
  const config = await getGlobalBridgeContinuationConfig();
  if (!config.enabled) return Object.freeze({ eligible: 0, covered: 0, created: 0, blocked: 0 });

  const [devices, threads, taskRows] = await Promise.all([
    db.select().from(schema.localConnectorDevices).all(),
    db.select().from(schema.localConnectorThreads).all(),
    db.select().from(schema.bridgeContinuationTasks)
      .orderBy(desc(schema.bridgeContinuationTasks.updatedAt), desc(schema.bridgeContinuationTasks.createdAt))
      .all(),
  ]);
  const controllableDevices = new Set(devices.filter(deviceCanControl).map((device) => device.id));
  const eligibleThreads = threads.filter((thread) => (
    controllableDevices.has(thread.deviceId) && thread.controlState === 'available'
  ));
  const activeSessions = new Set(taskRows
    .filter((task) => task.activeSlot === 1 && ACTIVE_STATUSES.has(task.status))
    .map((task) => sessionKey(task.deviceId || '', task.threadId)));
  const latestGlobalTaskBySession = new Map<string, typeof schema.bridgeContinuationTasks.$inferSelect>();
  for (const task of taskRows) {
    if (task.requestedBy !== GLOBAL_BRIDGE_CONTINUATION_REQUESTED_BY || !task.deviceId) continue;
    const key = sessionKey(task.deviceId, task.threadId);
    if (!latestGlobalTaskBySession.has(key)) latestGlobalTaskBySession.set(key, task);
  }

  let covered = 0;
  let created = 0;
  let blocked = 0;
  for (const thread of eligibleThreads) {
    const key = sessionKey(thread.deviceId, thread.threadId);
    if (activeSessions.has(key)) {
      covered += 1;
      continue;
    }
    const latestGlobal = latestGlobalTaskBySession.get(key);
    if (latestGlobal && BLOCKING_TERMINAL_REASONS.has(latestGlobal.reason)) {
      const taskUpdatedAt = Date.parse(latestGlobal.updatedAt || latestGlobal.createdAt || '');
      const threadActiveAt = Date.parse(thread.lastActiveAt || '');
      if (!Number.isFinite(threadActiveAt) || (Number.isFinite(taskUpdatedAt) && threadActiveAt <= taskUpdatedAt)) {
        blocked += 1;
        continue;
      }
    }
    try {
      const result = await takeOverLocalConnectorThread({
        deviceId: thread.deviceId,
        threadId: thread.threadId,
        policy: config.policy,
        creationSource: 'global',
      });
      covered += 1;
      if (result.created) created += 1;
      activeSessions.add(key);
    } catch (error) {
      console.warn(
        `[bridge-continuation] global reconcile skipped ${thread.deviceId}/${thread.threadId}: ${(error as Error)?.message || 'unknown error'}`,
      );
    }
  }
  return Object.freeze({ eligible: eligibleThreads.length, covered, created, blocked });
}

export async function stopGlobalBridgeContinuationTasks(): Promise<number> {
  const rows = await db.select({ id: schema.bridgeContinuationTasks.id })
    .from(schema.bridgeContinuationTasks)
    .where(and(
      eq(schema.bridgeContinuationTasks.requestedBy, GLOBAL_BRIDGE_CONTINUATION_REQUESTED_BY),
      eq(schema.bridgeContinuationTasks.activeSlot, 1),
    )).all();
  for (const row of rows) await stopBridgeContinuationTask(row.id);
  return rows.length;
}

export async function updateGlobalBridgeContinuation(input: {
  enabled: unknown;
  policy?: BridgeContinuationPolicyInput;
}): Promise<Readonly<{
  config: GlobalBridgeContinuationConfig;
  coverage: GlobalBridgeContinuationCoverage;
  stopped: number;
}>> {
  const previous = await getGlobalBridgeContinuationConfig();
  const next = await setGlobalBridgeContinuationConfig(input);
  let stopped = 0;
  if (!next.enabled) {
    stopped = await stopGlobalBridgeContinuationTasks();
    return Object.freeze({
      config: next,
      coverage: Object.freeze({ eligible: 0, covered: 0, created: 0, blocked: 0 }),
      stopped,
    });
  }
  if (previous.enabled && previous.policy.fingerprint !== next.policy.fingerprint) {
    stopped = await stopGlobalBridgeContinuationTasks();
  }
  return Object.freeze({
    config: next,
    coverage: await reconcileGlobalBridgeContinuationTasks(),
    stopped,
  });
}
