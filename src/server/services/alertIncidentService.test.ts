import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type AlertModule = typeof import('./alertIncidentService.js');

describe('alertIncidentService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let alerts: AlertModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-alert-incidents-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    alerts = await import('./alertIncidentService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.alertOccurrences).run();
    await db.delete(schema.alertIncidents).run();
    await db.delete(schema.alertPolicies).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('groups repeated occurrences under one stable incident and records a timeline', async () => {
    const at = new Date('2026-08-20T12:00:00.000Z');
    const first = await alerts.recordAlertOccurrence({
      ruleKey: 'proxy_all_failed',
      fingerprint: 'model:gpt-5',
      severity: 'error',
      title: '代理全部失败',
      message: '第一次失败',
      entityType: 'model',
      entityId: 'gpt-5',
      occurredAt: at,
    });
    const second = await alerts.recordAlertOccurrence({
      ruleKey: 'proxy_all_failed',
      fingerprint: 'model:gpt-5',
      severity: 'error',
      title: '代理全部失败',
      message: '第二次失败',
      entityType: 'model',
      entityId: 'gpt-5',
      occurredAt: new Date(at.getTime() + 30_000),
    });
    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(2);
    expect(await alerts.getAlertIncident(first.id)).toMatchObject({
      status: 'open',
      occurrences: expect.arrayContaining([
        expect.objectContaining({ message: '第一次失败' }),
        expect.objectContaining({ message: '第二次失败' }),
      ]),
    });
  });

  it('acknowledges incidents to stop escalation and resolves them once', async () => {
    const incident = await alerts.recordAlertOccurrence({
      ruleKey: 'token_expired',
      fingerprint: 'account:11',
      severity: 'error',
      title: 'Token 已失效',
      message: 'token expired',
      occurredAt: new Date('2026-08-20T12:00:00.000Z'),
      escalationSteps: [{ afterSec: 0 }, { afterSec: 1 }],
    });
    expect(await alerts.acknowledgeAlertIncident(incident.id, 'operator')).toBe(true);
    expect(await alerts.runAlertEscalationPass(new Date('2026-08-20T12:05:00.000Z'))).toBe(0);
    expect(await alerts.resolveAlertIncident(incident.id)).toBe(true);
    expect(await alerts.resolveAlertIncident(incident.id)).toBe(false);
    const stored = await db.select().from(schema.alertIncidents).where(eq(schema.alertIncidents.id, incident.id)).get();
    expect(stored).toMatchObject({ status: 'resolved', acknowledgedBy: 'operator' });
  });

  it('escalates open incidents according to policy steps', async () => {
    const at = new Date('2026-08-20T12:00:00.000Z');
    const incident = await alerts.recordAlertOccurrence({
      ruleKey: 'quota_daily_cost',
      fingerprint: 'key:7',
      severity: 'critical',
      title: '额度告警',
      message: 'daily cost reached 100%',
      occurredAt: at,
      escalationSteps: [{ afterSec: 0 }, { afterSec: 60 }],
    });
    const after = await alerts.runAlertEscalationPass(new Date(at.getTime() + 61_000));
    expect(after).toBe(1);
    const stored = await db.select().from(schema.alertIncidents).where(eq(schema.alertIncidents.id, incident.id)).get();
    expect(stored?.escalationStep).toBe(1);
  });
});
