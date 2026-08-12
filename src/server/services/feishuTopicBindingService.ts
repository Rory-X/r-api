import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

type DbExecutor = typeof db;
type TopicBindingRow = typeof schema.feishuTopicBindings.$inferSelect;

export type FeishuTopicBinding = Readonly<{
  id: string;
  adapterId: string;
  deviceId: string;
  codexThreadId: string;
  rootMessageId: string | null;
  feishuThreadId: string | null;
  lastMessageId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

function normalizeText(value: unknown, label: string, maximum = 512): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, label: string, maximum = 512): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizeText(value, label, maximum);
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || '').toLowerCase();
  const code = String((error as { code?: unknown })?.code || '').toUpperCase();
  return code === '23505'
    || code === '1062'
    || code === 'ER_DUP_ENTRY'
    || code.startsWith('SQLITE_CONSTRAINT')
    || message.includes('unique constraint')
    || message.includes('duplicate entry')
    || message.includes('duplicate key');
}

function toPublic(row: TopicBindingRow): FeishuTopicBinding {
  return Object.freeze({
    id: row.id,
    adapterId: row.adapterId,
    deviceId: row.deviceId,
    codexThreadId: row.codexThreadId,
    rootMessageId: row.rootMessageId,
    feishuThreadId: row.feishuThreadId,
    lastMessageId: row.lastMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

async function loadByCodexThread(
  executor: DbExecutor,
  input: { adapterId: string; deviceId: string; codexThreadId: string },
): Promise<TopicBindingRow | null> {
  return await executor.select().from(schema.feishuTopicBindings).where(and(
    eq(schema.feishuTopicBindings.adapterId, input.adapterId),
    eq(schema.feishuTopicBindings.deviceId, input.deviceId),
    eq(schema.feishuTopicBindings.codexThreadId, input.codexThreadId),
  )).get() || null;
}

export async function getFeishuTopicBindingById(input: {
  adapterId: unknown;
  bindingId: unknown;
}): Promise<FeishuTopicBinding | null> {
  const adapterId = normalizeText(input.adapterId, '飞书 Adapter ID', 128);
  const bindingId = normalizeText(input.bindingId, '飞书话题绑定 ID', 128);
  const row = await db.select().from(schema.feishuTopicBindings).where(and(
    eq(schema.feishuTopicBindings.id, bindingId),
    eq(schema.feishuTopicBindings.adapterId, adapterId),
  )).get();
  return row ? toPublic(row) : null;
}

export async function getFeishuTopicBindingForMessage(input: {
  adapterId: unknown;
  rootMessageId?: unknown;
  feishuThreadId?: unknown;
}): Promise<FeishuTopicBinding | null> {
  const adapterId = normalizeText(input.adapterId, '飞书 Adapter ID', 128);
  const rootMessageId = normalizeOptionalText(input.rootMessageId, '飞书根消息 ID', 256);
  const feishuThreadId = normalizeOptionalText(input.feishuThreadId, '飞书 Thread ID', 256);
  if (!rootMessageId && !feishuThreadId) return null;
  const byThread = feishuThreadId
    ? await db.select().from(schema.feishuTopicBindings).where(and(
      eq(schema.feishuTopicBindings.adapterId, adapterId),
      eq(schema.feishuTopicBindings.feishuThreadId, feishuThreadId),
    )).get() || null
    : null;
  const byRoot = rootMessageId
    ? await db.select().from(schema.feishuTopicBindings).where(and(
      eq(schema.feishuTopicBindings.adapterId, adapterId),
      eq(schema.feishuTopicBindings.rootMessageId, rootMessageId),
    )).get() || null
    : null;
  if (byThread && byRoot && byThread.id !== byRoot.id) {
    throw new Error('飞书话题 Thread 与根消息绑定冲突');
  }
  const row = byThread || byRoot;
  return row ? toPublic(row) : null;
}

export async function getOrCreateFeishuTopicBinding(input: {
  adapterId: unknown;
  deviceId: unknown;
  codexThreadId: unknown;
  now?: Date | number;
}): Promise<Readonly<{ created: boolean; binding: FeishuTopicBinding }>> {
  const adapterId = normalizeText(input.adapterId, '飞书 Adapter ID', 128);
  const deviceId = normalizeText(input.deviceId, 'Connector 设备 ID', 128);
  const codexThreadId = normalizeText(input.codexThreadId, 'Codex Thread ID', 256);
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const nowIso = now.toISOString();
  const lookup = { adapterId, deviceId, codexThreadId };
  const existing = await loadByCodexThread(db, lookup);
  if (existing) return Object.freeze({ created: false, binding: toPublic(existing) });

  try {
    const id = randomUUID();
    await db.insert(schema.feishuTopicBindings).values({
      id,
      adapterId,
      deviceId,
      codexThreadId,
      rootMessageId: null,
      feishuThreadId: null,
      lastMessageId: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
    const inserted = await db.select().from(schema.feishuTopicBindings)
      .where(eq(schema.feishuTopicBindings.id, id)).get();
    if (!inserted) throw new Error('飞书话题绑定创建失败');
    return Object.freeze({ created: true, binding: toPublic(inserted) });
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    const raced = await loadByCodexThread(db, lookup);
    if (!raced) throw error;
    return Object.freeze({ created: false, binding: toPublic(raced) });
  }
}

export async function bindFeishuTopicRoot(input: {
  adapterId: unknown;
  bindingId: unknown;
  rootMessageId: unknown;
  feishuThreadId?: unknown;
  now?: Date | number;
}): Promise<FeishuTopicBinding> {
  const adapterId = normalizeText(input.adapterId, '飞书 Adapter ID', 128);
  const bindingId = normalizeText(input.bindingId, '飞书话题绑定 ID', 128);
  const rootMessageId = normalizeText(input.rootMessageId, '飞书根消息 ID', 256);
  const feishuThreadId = normalizeOptionalText(input.feishuThreadId, '飞书 Thread ID', 256);
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const existing = await db.select().from(schema.feishuTopicBindings).where(and(
    eq(schema.feishuTopicBindings.id, bindingId),
    eq(schema.feishuTopicBindings.adapterId, adapterId),
  )).get();
  if (!existing) throw new Error('飞书话题绑定不存在');
  if (existing.rootMessageId && existing.rootMessageId !== rootMessageId) {
    throw new Error('Codex 会话已绑定其他飞书话题根消息');
  }
  if (existing.feishuThreadId && feishuThreadId && existing.feishuThreadId !== feishuThreadId) {
    throw new Error('Codex 会话已绑定其他飞书 Thread');
  }
  try {
    await db.update(schema.feishuTopicBindings).set({
      rootMessageId,
      feishuThreadId: existing.feishuThreadId || feishuThreadId,
      lastMessageId: rootMessageId,
      updatedAt: now.toISOString(),
    }).where(and(
      eq(schema.feishuTopicBindings.id, bindingId),
      eq(schema.feishuTopicBindings.adapterId, adapterId),
    )).run();
  } catch (error) {
    if (looksLikeUniqueCollision(error)) throw new Error('该飞书话题已绑定其他 Codex 会话', { cause: error });
    throw error;
  }
  const updated = await db.select().from(schema.feishuTopicBindings)
    .where(eq(schema.feishuTopicBindings.id, bindingId)).get();
  if (!updated) throw new Error('飞书话题绑定更新失败');
  return toPublic(updated);
}

export async function recordFeishuTopicReply(input: {
  adapterId: unknown;
  bindingId: unknown;
  rootMessageId: unknown;
  messageId: unknown;
  feishuThreadId?: unknown;
  now?: Date | number;
}): Promise<FeishuTopicBinding> {
  const adapterId = normalizeText(input.adapterId, '飞书 Adapter ID', 128);
  const bindingId = normalizeText(input.bindingId, '飞书话题绑定 ID', 128);
  const rootMessageId = normalizeText(input.rootMessageId, '飞书根消息 ID', 256);
  const messageId = normalizeText(input.messageId, '飞书消息 ID', 256);
  const feishuThreadId = normalizeOptionalText(input.feishuThreadId, '飞书 Thread ID', 256);
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const existing = await db.select().from(schema.feishuTopicBindings).where(and(
    eq(schema.feishuTopicBindings.id, bindingId),
    eq(schema.feishuTopicBindings.adapterId, adapterId),
  )).get();
  if (!existing) throw new Error('飞书话题绑定不存在');
  if (existing.rootMessageId !== rootMessageId) throw new Error('飞书话题根消息与 Codex 会话绑定不一致');
  if (existing.feishuThreadId && feishuThreadId && existing.feishuThreadId !== feishuThreadId) {
    throw new Error('飞书 Thread 与 Codex 会话绑定不一致');
  }
  try {
    await db.update(schema.feishuTopicBindings).set({
      feishuThreadId: existing.feishuThreadId || feishuThreadId,
      lastMessageId: messageId,
      updatedAt: now.toISOString(),
    }).where(and(
      eq(schema.feishuTopicBindings.id, bindingId),
      eq(schema.feishuTopicBindings.adapterId, adapterId),
    )).run();
  } catch (error) {
    if (looksLikeUniqueCollision(error)) throw new Error('该飞书话题已绑定其他 Codex 会话', { cause: error });
    throw error;
  }
  const updated = await db.select().from(schema.feishuTopicBindings)
    .where(eq(schema.feishuTopicBindings.id, bindingId)).get();
  if (!updated) throw new Error('飞书话题回复状态更新失败');
  return toPublic(updated);
}
