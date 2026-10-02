import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';

export type CredentialLifecycleAuditOutcome = 'succeeded' | 'failed' | 'deferred' | 'notified';

export type CredentialLifecycleAuditRecord = {
  id: number;
  entityType: string;
  entityId: number;
  siteId: number | null;
  provider: string | null;
  credentialSource: string;
  operatorId: string;
  action: string;
  status: string;
  outcome: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
};

function normalizedText(value: unknown, fallback = ''): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || fallback;
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
}

function normalizeOffset(value: unknown): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || error || '').toLowerCase();
  return message.includes('unique constraint')
    || message.includes('duplicate entry')
    || message.includes('duplicate key');
}

export async function recordCredentialLifecycleAudit(input: {
  entityType: string;
  entityId: number;
  siteId?: number | null;
  provider?: string | null;
  credentialSource?: string | null;
  operatorId: string;
  action: string;
  status: string;
  outcome: CredentialLifecycleAuditOutcome;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  createdAt?: Date;
}, executor: typeof db = db): Promise<number | null> {
  const dedupeKey = normalizedText(input.dedupeKey) || null;
  if (dedupeKey) {
    const existing = await executor.select({ id: schema.credentialLifecycleAudits.id })
      .from(schema.credentialLifecycleAudits)
      .where(eq(schema.credentialLifecycleAudits.dedupeKey, dedupeKey))
      .get();
    if (existing) return null;
  }
  try {
    const row = await insertAndGetById<typeof schema.credentialLifecycleAudits.$inferSelect>({
      txDb: executor,
      table: schema.credentialLifecycleAudits,
      idColumn: schema.credentialLifecycleAudits.id,
      values: {
        entityType: normalizedText(input.entityType, 'unknown'),
        entityId: Math.max(0, Math.trunc(input.entityId)),
        siteId: input.siteId && input.siteId > 0 ? Math.trunc(input.siteId) : null,
        provider: normalizedText(input.provider) || null,
        credentialSource: normalizedText(input.credentialSource, 'unknown'),
        operatorId: normalizedText(input.operatorId, 'system:unknown'),
        action: normalizedText(input.action, 'unknown'),
        status: normalizedText(input.status, 'unknown'),
        outcome: input.outcome,
        message: input.message ? String(input.message).slice(0, 2_000) : null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        dedupeKey,
        createdAt: (input.createdAt ?? new Date()).toISOString(),
      },
      insertErrorMessage: '凭证生命周期审计记录写入失败',
    });
    return row.id;
  } catch (error) {
    if (dedupeKey && looksLikeUniqueCollision(error)) return null;
    throw error;
  }
}

export async function listCredentialLifecycleAudits(input: {
  source?: unknown;
  operatorId?: unknown;
  status?: unknown;
  action?: unknown;
  outcome?: unknown;
  entityType?: unknown;
  entityId?: unknown;
  limit?: unknown;
  offset?: unknown;
} = {}): Promise<{ items: CredentialLifecycleAuditRecord[]; total: number }> {
  const filters: SQL[] = [];
  const source = normalizedText(input.source);
  const operatorId = normalizedText(input.operatorId);
  const status = normalizedText(input.status);
  const action = normalizedText(input.action);
  const outcome = normalizedText(input.outcome);
  const entityType = normalizedText(input.entityType);
  const entityId = Math.trunc(Number(input.entityId));
  if (source) filters.push(eq(schema.credentialLifecycleAudits.credentialSource, source));
  if (operatorId) filters.push(eq(schema.credentialLifecycleAudits.operatorId, operatorId));
  if (status) filters.push(eq(schema.credentialLifecycleAudits.status, status));
  if (action) filters.push(eq(schema.credentialLifecycleAudits.action, action));
  if (outcome) filters.push(eq(schema.credentialLifecycleAudits.outcome, outcome));
  if (entityType) filters.push(eq(schema.credentialLifecycleAudits.entityType, entityType));
  if (Number.isFinite(entityId) && entityId > 0) filters.push(eq(schema.credentialLifecycleAudits.entityId, entityId));
  const where = filters.length > 0 ? and(...filters) : undefined;
  const limit = normalizeLimit(input.limit, 100, 500);
  const offset = normalizeOffset(input.offset);
  const [rows, count] = await Promise.all([
    db.select().from(schema.credentialLifecycleAudits)
      .where(where)
      .orderBy(desc(schema.credentialLifecycleAudits.createdAt), desc(schema.credentialLifecycleAudits.id))
      .limit(limit)
      .offset(offset)
      .all(),
    db.select({ count: sql<number>`count(*)` })
      .from(schema.credentialLifecycleAudits)
      .where(where)
      .get(),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      siteId: row.siteId ?? null,
      provider: row.provider ?? null,
      credentialSource: row.credentialSource,
      operatorId: row.operatorId,
      action: row.action,
      status: row.status,
      outcome: row.outcome,
      message: row.message ?? null,
      metadata: parseMetadata(row.metadata),
      createdAt: row.createdAt ?? null,
    })),
    total: Number(count?.count || 0),
  };
}
