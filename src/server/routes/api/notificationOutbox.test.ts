import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');
type ConfigModule = typeof import('../../config.js');

describe('notification outbox routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-notification-outbox-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const configModule = await import('../../config.js');
    const routesModule = await import('./notificationOutbox.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    app = Fastify();
    await app.register(routesModule.notificationOutboxRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.notificationOutbox).run();
    config.notifyDeliveryPolicy = 'prefer_delivery';
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns policy, rows and status summary', async () => {
    config.notifyDeliveryPolicy = 'prefer_no_duplicate';
    await db.insert(schema.notificationOutbox).values([
      {
        notificationId: 'notify-1',
        channel: 'feishu',
        title: '失败提醒',
        message: 'unknown delivery',
        level: 'warning',
        occurredAt: new Date().toISOString(),
        deliveryPolicy: 'prefer_no_duplicate',
        status: 'delivery_unknown',
        attemptCount: 2,
        lastError: 'connection reset',
      },
      {
        notificationId: 'notify-2',
        channel: 'smtp',
        title: '已送达',
        message: 'delivered',
        level: 'info',
        occurredAt: new Date().toISOString(),
        status: 'delivered',
        attemptCount: 1,
      },
    ]).run();

    const response = await app.inject({ method: 'GET', url: '/api/notifications/outbox?limit=10' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      policy: 'prefer_no_duplicate',
      summary: { delivery_unknown: 1, delivered: 1 },
      page: { limit: 10, offset: 0, total: 2, hasMore: false },
    });
    expect(response.json().rows).toHaveLength(2);
  });

  it('returns newest rows first and supports bounded pagination', async () => {
    await db.insert(schema.notificationOutbox).values([
      {
        notificationId: 'notify-old',
        channel: 'feishu',
        title: '较早通知',
        message: 'old',
        level: 'info',
        occurredAt: '2026-08-10T08:00:00.000Z',
        status: 'delivered',
        createdAt: '2026-08-10T08:00:00.000Z',
        updatedAt: '2026-08-10T08:00:00.000Z',
      },
      {
        notificationId: 'notify-new',
        channel: 'feishu',
        title: '最新通知',
        message: 'new',
        level: 'info',
        occurredAt: '2026-08-12T08:00:00.000Z',
        status: 'delivered',
        createdAt: '2026-08-12T08:00:00.000Z',
        updatedAt: '2026-08-12T08:00:00.000Z',
      },
    ]).run();

    const first = await app.inject({ method: 'GET', url: '/api/notifications/outbox?limit=1&offset=0' });
    expect(first.json()).toMatchObject({
      rows: [{ title: '最新通知' }],
      page: { limit: 1, offset: 0, total: 2, hasMore: true },
    });

    const second = await app.inject({ method: 'GET', url: '/api/notifications/outbox?limit=1&offset=1' });
    expect(second.json()).toMatchObject({
      rows: [{ title: '较早通知' }],
      page: { limit: 1, offset: 1, total: 2, hasMore: false },
    });
  });

  it('manually requeues one unknown row or all unknown rows', async () => {
    const inserted = await db.insert(schema.notificationOutbox).values([
      {
        notificationId: 'notify-1',
        channel: 'feishu',
        title: '一',
        message: 'one',
        level: 'warning',
        occurredAt: new Date().toISOString(),
        status: 'delivery_unknown',
        attemptCount: 3,
        lastError: 'timeout',
      },
      {
        notificationId: 'notify-2',
        channel: 'smtp',
        title: '二',
        message: 'two',
        level: 'warning',
        occurredAt: new Date().toISOString(),
        status: 'delivery_unknown',
        attemptCount: 4,
        lastError: 'timeout',
      },
    ]).returning().all();

    const one = await app.inject({
      method: 'POST',
      url: '/api/notifications/outbox/retry',
      payload: { id: inserted[0].id },
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ success: true, queued: 1 });

    const first = await db.select().from(schema.notificationOutbox)
      .where(eq(schema.notificationOutbox.id, inserted[0].id)).get();
    expect(first).toMatchObject({ status: 'pending', lastOutcome: 'manual_retry' });

    const all = await app.inject({
      method: 'POST',
      url: '/api/notifications/outbox/retry',
      payload: { all: true },
    });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ success: true, queued: 1 });

    const rows = await db.select().from(schema.notificationOutbox).all();
    expect(rows.every((row) => row.status === 'pending')).toBe(true);
  });

  it('rejects invalid row ids', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/outbox/retry',
      payload: { id: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ success: false });
  });
});
