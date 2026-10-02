import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';
import { sendNotification } from './notifyService.js';
import type { NotificationChannel, NotificationLevel } from './notificationChannelDispatcher.js';

export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';
export type AlertIncidentStatus = 'open' | 'acknowledged' | 'resolved' | 'suppressed';

export type AlertEscalationStep = {
  afterSec: number;
  channels?: NotificationChannel[];
  repeatSec?: number;
};

export type RecordAlertOccurrenceInput = {
  ruleKey: string;
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  entityType?: string | null;
  entityId?: string | number | null;
  value?: unknown;
  occurredAt?: Date;
  channels?: NotificationChannel[];
  groupingWindowSec?: number;
  escalationSteps?: AlertEscalationStep[];
};

export type AlertIncidentView = typeof schema.alertIncidents.$inferSelect & {
  occurrences?: Array<typeof schema.alertOccurrences.$inferSelect>;
};

const WORKER_NAME = 'alert-escalation';
const DEFAULT_GROUPING_WINDOW_SEC = 300;
const DEFAULT_STEPS: AlertEscalationStep[] = [
  { afterSec: 0, repeatSec: 0 },
  { afterSec: 900, repeatSec: 1_800 },
];
let workerTimer: ReturnType<typeof setInterval> | null = null;

function normalizeSeverity(value: unknown): AlertSeverity {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical') return 'critical';
  if (normalized === 'error') return 'error';
  if (normalized === 'warning') return 'warning';
  return 'info';
}

function notificationLevel(severity: AlertSeverity): NotificationLevel {
  return severity === 'info' ? 'info' : severity === 'warning' ? 'warning' : 'error';
}

function normalizeSteps(raw: unknown): AlertEscalationStep[] {
  const source = Array.isArray(raw) ? raw : DEFAULT_STEPS;
  const steps = source.map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const channels = Array.isArray(record.channels)
      ? record.channels.filter((value): value is NotificationChannel => typeof value === 'string')
      : undefined;
    return {
      afterSec: Math.max(0, Math.trunc(Number(record.afterSec) || 0)),
      ...(channels && channels.length > 0 ? { channels } : {}),
      repeatSec: Math.max(0, Math.trunc(Number(record.repeatSec) || 0)),
    };
  }).sort((left, right) => left.afterSec - right.afterSec);
  return steps.length > 0 ? steps.slice(0, 20) : DEFAULT_STEPS;
}

function fingerprintFor(input: Pick<RecordAlertOccurrenceInput, 'ruleKey' | 'fingerprint'>): string {
  const raw = `${input.ruleKey}:${String(input.fingerprint || '').trim()}`;
  return createHash('sha256').update(raw).digest('hex');
}

function normalizeEntityId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function parseSteps(raw: string | null | undefined): AlertEscalationStep[] {
  try {
    return normalizeSteps(raw ? JSON.parse(raw) : DEFAULT_STEPS);
  } catch {
    return DEFAULT_STEPS;
  }
}

async function ensurePolicy(input: {
  ruleKey: string;
  groupingWindowSec?: number;
  steps?: AlertEscalationStep[];
}): Promise<void> {
  const nowIso = new Date().toISOString();
  const values = {
    ruleKey: input.ruleKey,
    enabled: true,
    groupingWindowSec: Math.max(1, Math.trunc(Number(input.groupingWindowSec) || DEFAULT_GROUPING_WINDOW_SEC)),
    stepsJson: JSON.stringify(normalizeSteps(input.steps)),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.alertPolicies).values(values) as any).onDuplicateKeyUpdate({
      set: {
        groupingWindowSec: values.groupingWindowSec,
        stepsJson: values.stepsJson,
        updatedAt: nowIso,
      },
    }).run();
  } else {
    await (db.insert(schema.alertPolicies).values(values) as any).onConflictDoUpdate({
      target: schema.alertPolicies.ruleKey,
      set: {
        groupingWindowSec: values.groupingWindowSec,
        stepsJson: values.stepsJson,
        updatedAt: nowIso,
      },
    }).run();
  }
}

async function notifyIncident(input: {
  incidentId: number;
  ruleKey: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  step: number;
  channels?: NotificationChannel[];
  kind: 'open' | 'escalation' | 'resolved';
  nonce?: string;
}): Promise<void> {
  await sendNotification(input.title, input.message, notificationLevel(input.severity), {
    bypassThrottle: true,
    idempotencyKey: `alert:${input.incidentId}:${input.kind}:${input.step}:${input.nonce || 'stable'}`,
    ...(input.channels && input.channels.length > 0 ? { channels: input.channels } : {}),
  });
}

function nextEscalationAt(steps: AlertEscalationStep[], currentStep: number, now: Date): string | null {
  const next = steps[currentStep + 1];
  return next
    ? new Date(now.getTime() + Math.max(1, next.afterSec - steps[currentStep].afterSec) * 1_000).toISOString()
    : null;
}

export async function recordAlertOccurrence(input: RecordAlertOccurrenceInput): Promise<AlertIncidentView> {
  const now = input.occurredAt || new Date();
  const nowIso = now.toISOString();
  const fingerprint = fingerprintFor(input);
  const severity = normalizeSeverity(input.severity);
  const entityId = normalizeEntityId(input.entityId);
  const groupingWindowSec = Math.max(1, Math.trunc(Number(input.groupingWindowSec) || DEFAULT_GROUPING_WINDOW_SEC));
  const steps = normalizeSteps(input.escalationSteps);
  await ensurePolicy({ ruleKey: input.ruleKey, groupingWindowSec, steps });

  let incidentId = 0;
  let shouldNotifyOpen = false;
  await db.transaction(async (tx) => {
    const current = await tx.select().from(schema.alertIncidents)
      .where(eq(schema.alertIncidents.fingerprint, fingerprint)).get();
    if (!current) {
      const inserted = await insertAndGetById<typeof schema.alertIncidents.$inferSelect>({
        txDb: tx,
        table: schema.alertIncidents,
        idColumn: schema.alertIncidents.id,
        values: {
          fingerprint,
          ruleKey: input.ruleKey,
          severity,
          status: 'open',
          entityType: input.entityType || null,
          entityId,
          occurrenceCount: 1,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          escalationStep: 0,
          nextEscalationAt: nextEscalationAt(steps, 0, now),
          lastMessage: input.message,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        insertErrorMessage: '告警事件创建失败',
      });
      incidentId = inserted.id;
      shouldNotifyOpen = true;
    } else {
      incidentId = current.id;
      const wasResolved = current.status === 'resolved' || current.status === 'suppressed';
      await tx.update(schema.alertIncidents).set({
        status: wasResolved ? 'open' : current.status,
        severity,
        lastSeenAt: nowIso,
        lastMessage: input.message,
        occurrenceCount: sql`${schema.alertIncidents.occurrenceCount} + 1`,
        escalationStep: wasResolved ? 0 : current.escalationStep,
        nextEscalationAt: wasResolved
          ? nextEscalationAt(steps, 0, now)
          : current.nextEscalationAt,
        resolvedAt: wasResolved ? null : current.resolvedAt,
        updatedAt: nowIso,
      }).where(eq(schema.alertIncidents.id, current.id)).run();
      shouldNotifyOpen = wasResolved;
    }
    await tx.insert(schema.alertOccurrences).values({
      incidentId,
      observedAt: nowIso,
      valueJson: input.value === undefined ? null : JSON.stringify(input.value),
      message: input.message,
      createdAt: nowIso,
    }).run();
  });

  const incident = await db.select().from(schema.alertIncidents).where(eq(schema.alertIncidents.id, incidentId)).get();
  if (!incident) throw new Error('告警事件创建后无法读取');
  if (shouldNotifyOpen) {
    await notifyIncident({
      incidentId,
      ruleKey: input.ruleKey,
      severity,
      title: input.title,
      message: input.message,
      step: 0,
      channels: input.channels,
      kind: 'open',
      nonce: incident.lastSeenAt,
    });
    await db.update(schema.alertIncidents).set({ lastNotifiedAt: nowIso, updatedAt: nowIso })
      .where(eq(schema.alertIncidents.id, incidentId)).run();
  }
  return incident;
}

export async function acknowledgeAlertIncident(id: number, acknowledgedBy: string): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const updated = await db.update(schema.alertIncidents).set({
    status: 'acknowledged',
    acknowledgedAt: nowIso,
    acknowledgedBy: String(acknowledgedBy || 'admin').slice(0, 160),
    nextEscalationAt: null,
    updatedAt: nowIso,
  }).where(and(eq(schema.alertIncidents.id, id), eq(schema.alertIncidents.status, 'open'))).run();
  return Number(updated?.changes || 0) > 0;
}

export async function resolveAlertIncident(id: number): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const incident = await db.select().from(schema.alertIncidents).where(eq(schema.alertIncidents.id, id)).get();
  if (!incident || !['open', 'acknowledged'].includes(incident.status)) return false;
  const updated = await db.update(schema.alertIncidents).set({
    status: 'resolved',
    resolvedAt: nowIso,
    nextEscalationAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.alertIncidents.id, id),
    or(eq(schema.alertIncidents.status, 'open'), eq(schema.alertIncidents.status, 'acknowledged')),
  )).run();
  if (Number(updated?.changes || 0) <= 0) return false;
  await notifyIncident({
    incidentId: incident.id,
    ruleKey: incident.ruleKey,
    severity: normalizeSeverity(incident.severity),
    title: `告警恢复: ${incident.ruleKey}`,
    message: incident.lastMessage ? `已恢复: ${incident.lastMessage}` : `告警 ${incident.ruleKey} 已恢复`,
    step: incident.escalationStep,
    kind: 'resolved',
    nonce: nowIso,
  });
  return true;
}

export async function listAlertIncidents(input: { status?: AlertIncidentStatus; limit?: number } = {}): Promise<AlertIncidentView[]> {
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(input.limit) || 50)));
  const conditions = input.status ? [eq(schema.alertIncidents.status, input.status)] : [];
  const rows = await db.select().from(schema.alertIncidents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(sql`${schema.alertIncidents.lastSeenAt} desc`)
    .limit(limit)
    .all();
  return rows;
}

export async function getAlertIncident(id: number): Promise<AlertIncidentView | null> {
  const incident = await db.select().from(schema.alertIncidents).where(eq(schema.alertIncidents.id, id)).get();
  if (!incident) return null;
  const occurrences = await db.select().from(schema.alertOccurrences)
    .where(eq(schema.alertOccurrences.incidentId, id))
    .orderBy(asc(schema.alertOccurrences.observedAt)).all();
  return { ...incident, occurrences };
}

async function claimEscalationIncident(nowIso: string): Promise<typeof schema.alertIncidents.$inferSelect | null> {
  const owner = `${process.pid}:${randomUUID()}`;
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
  const candidate = await db.select().from(schema.alertIncidents).where(and(
    or(eq(schema.alertIncidents.status, 'open')),
    lte(schema.alertIncidents.nextEscalationAt, nowIso),
    or(sql`${schema.alertIncidents.leaseExpiresAt} is null`, lte(schema.alertIncidents.leaseExpiresAt, nowIso)),
  )).orderBy(asc(schema.alertIncidents.nextEscalationAt)).limit(1).get();
  if (!candidate) return null;
  const claimed = await db.update(schema.alertIncidents).set({
    leaseOwner: owner,
    leaseToken,
    leaseExpiresAt,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.alertIncidents.id, candidate.id),
    eq(schema.alertIncidents.status, 'open'),
    or(sql`${schema.alertIncidents.leaseExpiresAt} is null`, lte(schema.alertIncidents.leaseExpiresAt, nowIso)),
  )).run();
  return Number(claimed?.changes || 0) > 0
    ? { ...candidate, leaseOwner: owner, leaseToken, leaseExpiresAt }
    : null;
}

export async function runAlertEscalationPass(now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  let processed = 0;
  while (true) {
    const incident = await claimEscalationIncident(nowIso);
    if (!incident) break;
    const policy = await db.select().from(schema.alertPolicies).where(eq(schema.alertPolicies.ruleKey, incident.ruleKey)).get();
    const steps = parseSteps(policy?.stepsJson);
    const nextStep = Math.min(incident.escalationStep + 1, steps.length - 1);
    const step = steps[nextStep];
    const isRepeat = nextStep === incident.escalationStep && (step.repeatSec || 0) > 0;
    const shouldNotify = nextStep > incident.escalationStep || isRepeat || incident.lastNotifiedAt === null;
    if (shouldNotify) {
      await notifyIncident({
        incidentId: incident.id,
        ruleKey: incident.ruleKey,
        severity: normalizeSeverity(incident.severity),
        title: `告警升级: ${incident.ruleKey}`,
        message: incident.lastMessage || `告警 ${incident.ruleKey} 仍未恢复`,
        step: nextStep,
        channels: step.channels,
        kind: 'escalation',
        nonce: nowIso,
      });
    }
    const repeatSec = Math.max(0, step.repeatSec || 0);
    const nextEscalationAt = repeatSec > 0
      ? new Date(now.getTime() + repeatSec * 1_000).toISOString()
      : (nextStep < steps.length - 1 ? new Date(now.getTime() + Math.max(1, steps[nextStep + 1].afterSec - step.afterSec) * 1_000).toISOString() : null);
    await db.update(schema.alertIncidents).set({
      escalationStep: nextStep,
      nextEscalationAt,
      lastNotifiedAt: shouldNotify ? nowIso : incident.lastNotifiedAt,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    }).where(and(eq(schema.alertIncidents.id, incident.id), eq(schema.alertIncidents.leaseToken, incident.leaseToken || ''))).run();
    processed += 1;
  }
  return processed;
}

export async function startAlertEscalationWorker(options: { intervalMs?: number } = {}): Promise<void> {
  if (workerTimer) return;
  const intervalMs = Math.max(10_000, Math.trunc(Number(options.intervalMs) || 30_000));
  startObservedWorker({ name: WORKER_NAME, intervalMs, critical: false });
  await runObservedWorkerPass(WORKER_NAME, async () => { await runAlertEscalationPass(); });
  workerTimer = setInterval(() => {
    void runObservedWorkerPass(WORKER_NAME, async () => { await runAlertEscalationPass(); }).catch(() => undefined);
  }, intervalMs);
}

export function stopAlertEscalationWorker(): void {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  stopObservedWorker(WORKER_NAME);
}
