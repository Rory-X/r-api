import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { config, normalizeNotificationDeliveryPolicy } from '../../config.js';
import { db, schema } from '../../db/index.js';

const OUTBOX_STATUSES = ['pending', 'processing', 'delivered', 'delivery_unknown'] as const;
type OutboxStatus = typeof OUTBOX_STATUSES[number];

function normalizeStatus(value: unknown): OutboxStatus | null {
  const normalized = String(value || '').trim().toLowerCase();
  return (OUTBOX_STATUSES as readonly string[]).includes(normalized)
    ? normalized as OutboxStatus
    : null;
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.trunc(parsed))) : 50;
}

function normalizeOffset(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export async function notificationOutboxRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { limit?: string; offset?: string; status?: string };
  }>('/api/notifications/outbox', async (request) => {
    const limit = normalizeLimit(request.query.limit);
    const offset = normalizeOffset(request.query.offset);
    const status = normalizeStatus(request.query.status);
    const rowFilter = status ? eq(schema.notificationOutbox.status, status) : undefined;
    const rows = await db.select().from(schema.notificationOutbox)
      .where(rowFilter)
      .orderBy(
        desc(schema.notificationOutbox.updatedAt),
        desc(schema.notificationOutbox.createdAt),
        desc(schema.notificationOutbox.id),
      )
      .limit(limit)
      .offset(offset)
      .all();

    const totalRow = await db.select({ count: sql<number>`count(*)` })
      .from(schema.notificationOutbox)
      .where(rowFilter)
      .get();
    const total = Number(totalRow?.count || 0);

    const counts = await db.select({
      status: schema.notificationOutbox.status,
      count: sql<number>`count(*)`,
    }).from(schema.notificationOutbox)
      .groupBy(schema.notificationOutbox.status)
      .all();
    const summary: Record<string, number> = {};
    for (const item of counts) summary[item.status] = Number(item.count || 0);

    return {
      policy: normalizeNotificationDeliveryPolicy(config.notifyDeliveryPolicy),
      rows,
      summary,
      page: {
        limit,
        offset,
        total,
        hasMore: offset + rows.length < total,
      },
    };
  });

  app.post<{
    Body: { id?: number | string; all?: boolean };
  }>('/api/notifications/outbox/retry', async (request, reply) => {
    const rawId = request.body?.id;
    const parsedId = rawId === undefined || rawId === null || rawId === ''
      ? null
      : Number(rawId);
    if (parsedId !== null && (!Number.isFinite(parsedId) || parsedId <= 0)) {
      return reply.code(400).send({ success: false, message: 'Outbox id 无效' });
    }

    const nowIso = new Date().toISOString();
    const where = parsedId === null
      ? eq(schema.notificationOutbox.status, 'delivery_unknown')
      : and(
        eq(schema.notificationOutbox.id, Math.trunc(parsedId)),
        inArray(schema.notificationOutbox.status, ['delivery_unknown', 'pending']),
      );
    const updated = await db.update(schema.notificationOutbox).set({
      status: 'pending',
      nextAttemptAt: nowIso,
      lastOutcome: 'manual_retry',
      lastError: null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    }).where(where).run();

    return {
      success: true,
      queued: Number(updated?.changes || 0),
      policy: normalizeNotificationDeliveryPolicy(config.notifyDeliveryPolicy),
    };
  });
}
