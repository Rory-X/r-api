import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotificationChannelDispatchResult } from './notificationChannelDispatcher.js';

type DbModule = typeof import('../db/index.js');
type OutboxModule = typeof import('./notificationOutboxService.js');

describe('notificationOutboxService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let outbox: OutboxModule;
  let config: (typeof import('../config.js'))['config'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-notification-outbox-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    outbox = await import('./notificationOutboxService.js');
    ({ config } = await import('../config.js'));
  });

  beforeEach(async () => {
    await outbox.__resetNotificationOutboxWorkerForTests();
    await db.delete(schema.notificationOutbox).run();
    await db.delete(schema.notificationThrottleStates).run();
    config.notifyCooldownSec = 0;
    config.notifyDeliveryPolicy = 'prefer_delivery';
    config.notifyOutboxLeaseTtlMs = 5_000;
    config.notifyOutboxRetryBaseMs = 1_000;
    config.notifyOutboxRetryMaxMs = 10_000;
    config.notifyOutboxRetentionDays = 30;
  });

  afterAll(async () => {
    const dbModule = await import('../db/index.js');
    await dbModule.closeDbConnections();
    delete process.env.DATA_DIR;
  });

  function result(channel: 'webhook' | 'smtp', outcome: NotificationChannelDispatchResult['outcome']): NotificationChannelDispatchResult {
    return { channel, outcome, error: outcome === 'delivered' ? null : `${outcome} ${channel}`, retryAfterMs: null };
  }

  it('persists one row per channel and records partial outcomes', async () => {
    const queued = await outbox.enqueueNotification({
      title: 'partial',
      message: 'message',
      channels: ['webhook', 'smtp'],
    });
    expect(queued.rows).toHaveLength(2);

    const run = await outbox.runNotificationOutboxPass({
      dispatch: async ({ channel }) => channel === 'webhook' ? result(channel, 'delivered') : result(channel, 'failed'),
    });
    expect(run).toMatchObject({ claimed: 2, delivered: 1, failed: 1, deliveryUnknown: 0 });

    const rows = await db.select().from(schema.notificationOutbox).all();
    expect(rows.map((row) => [row.channel, row.status])).toEqual([
      ['webhook', 'delivered'],
      ['smtp', 'pending'],
    ]);
    expect(rows.find((row) => row.channel === 'smtp')?.attemptCount).toBe(1);
  });

  it('does not enqueue or dispatch a repeated idempotency key', async () => {
    const first = await outbox.enqueueNotification({
      title: 'idempotent',
      message: 'same',
      idempotencyKey: 'event-42',
      channels: ['smtp'],
    });
    const second = await outbox.enqueueNotification({
      title: 'idempotent',
      message: 'same',
      idempotencyKey: 'event-42',
      channels: ['smtp'],
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.notificationId).toBe(first.notificationId);
    expect(await db.select().from(schema.notificationOutbox).all()).toHaveLength(1);
  });

  it('accepts connector-bound Feishu channels and keeps turn events idempotent', async () => {
    const channel = 'feishu:device-1' as const;
    const first = await outbox.enqueueNotification({
      title: 'Codex 会话已完成',
      message: 'thread-a / turn-1',
      idempotencyKey: 'connector:device-1:turn-1',
      channels: [channel],
    });
    const second = await outbox.enqueueNotification({
      title: 'Codex 会话已完成',
      message: 'thread-a / turn-1',
      idempotencyKey: 'connector:device-1:turn-1',
      channels: [channel],
    });

    expect(first.rows[0]?.channel).toBe(channel);
    expect(second.deduplicated).toBe(true);
    expect(await db.select().from(schema.notificationOutbox).all()).toHaveLength(1);
  });

  it('persists throttle state and merges suppressed notifications after cooldown', async () => {
    config.notifyCooldownSec = 60;
    const firstAt = new Date('2026-08-03T00:00:00.000Z');
    const first = await outbox.enqueueNotification({
      title: 'throttle',
      message: 'same',
      occurredAt: firstAt,
      channels: ['smtp'],
    });
    const suppressed = await outbox.enqueueNotification({
      title: 'throttle',
      message: 'same',
      occurredAt: new Date('2026-08-03T00:00:10.000Z'),
      channels: ['smtp'],
    });
    const next = await outbox.enqueueNotification({
      title: 'throttle',
      message: 'same',
      occurredAt: new Date('2026-08-03T00:01:01.000Z'),
      channels: ['smtp'],
    });

    expect(first.rows).toHaveLength(1);
    expect(suppressed.throttled).toBe(true);
    expect(next.rows[0]?.message).toContain('已合并 1 条重复告警');
    expect(await db.select().from(schema.notificationThrottleStates).all()).toHaveLength(1);
  });

  it('stops after an unknown outcome when prefer_no_duplicate is selected', async () => {
    config.notifyDeliveryPolicy = 'prefer_no_duplicate';
    const queued = await outbox.enqueueNotification({
      title: 'unknown',
      message: 'x',
      occurredAt: new Date('2026-08-03T00:00:00.000Z'),
      channels: ['smtp'],
    });
    await outbox.runNotificationOutboxPass({
      dispatch: async ({ channel }) => result(channel, 'delivery_unknown'),
    });

    const row = (await db.select().from(schema.notificationOutbox).all())[0];
    expect(row?.status).toBe('delivery_unknown');
    expect(row?.nextAttemptAt).toBeNull();
    expect(queued.rows[0]?.deliveryPolicy).toBe('prefer_no_duplicate');
  });

  it('retries an unknown outcome when prefer_delivery is selected', async () => {
    const queued = await outbox.enqueueNotification({
      title: 'unknown',
      message: 'x',
      occurredAt: new Date('2026-08-03T00:00:00.000Z'),
      channels: ['smtp'],
    });
    await outbox.runNotificationOutboxPass({
      dispatch: async ({ channel }) => result(channel, 'delivery_unknown'),
      now: new Date('2026-08-03T00:00:00.000Z'),
    });
    const pending = (await db.select().from(schema.notificationOutbox).all())[0];
    expect(pending?.status).toBe('pending');
    expect(pending?.lastOutcome).toBe('delivery_unknown');

    await outbox.runNotificationOutboxPass({
      dispatch: async ({ channel }) => result(channel, 'delivered'),
      now: new Date('2026-08-03T00:00:02.000Z'),
    });
    const delivered = (await db.select().from(schema.notificationOutbox).all())[0];
    expect(delivered?.status).toBe('delivered');
    expect(queued.rows[0]?.deliveryPolicy).toBe('prefer_delivery');
  });

  it('allows only one worker to claim a row', async () => {
    await outbox.enqueueNotification({ title: 'race', message: 'x', channels: ['smtp'] });
    let calls = 0;
    const dispatch = async ({ channel }: { channel: 'smtp' }) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return result(channel, 'delivered');
    };
    const [first, second] = await Promise.all([
      outbox.runNotificationOutboxPass({ dispatch: dispatch as any }),
      outbox.runNotificationOutboxPass({ dispatch: dispatch as any }),
    ]);

    expect(first.claimed + second.claimed).toBe(1);
    expect(calls).toBe(1);
  });
});
