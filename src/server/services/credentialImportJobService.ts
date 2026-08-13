import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  buildCredentialBatchPreview,
  normalizeCredentialInput,
  type CredentialBatchPreview,
  type CredentialFormatDetection,
  type CredentialIdentity,
  type CredentialTarget,
} from './credentialIngestionService.js';
import {
  CredentialPromotionError,
  promoteCredentialBatch,
  type CredentialConflictPolicy,
  type CredentialPromotionItem,
  type CredentialPromotionResult,
} from './credentialPromotionService.js';

const MAX_IMPORT_CANDIDATES = 500;
const DEFAULT_OPERATOR_ID = 'webui:admin';

type ImportJobRow = typeof schema.credentialImportJobs.$inferSelect;
type ImportItemRow = typeof schema.credentialImportItems.$inferSelect;
type ImportJobStatus = 'previewed' | 'running' | 'completed' | 'partial' | 'failed';

export type CredentialImportPreviewJobResult = CredentialBatchPreview & {
  importJobId: string;
  deduplicated: boolean;
  status: ImportJobStatus;
  detection: CredentialFormatDetection;
  warnings: string[];
};

export type CredentialImportExecutionResult = CredentialPromotionResult & {
  importJobId: string;
  deduplicated: boolean;
  jobStatus: ImportJobStatus;
};

export type CredentialImportJobItemRecord = {
  id: number;
  index: number;
  source: {
    format: string;
    version?: string;
    platform?: string;
  };
  provider?: string;
  kind: string;
  identity: CredentialIdentity;
  secretSummary: Record<string, boolean>;
  compatibleTargets: CredentialTarget[];
  expiresAt?: string;
  disabled: boolean;
  fingerprint: string;
  validation: {
    status: string;
    errors: string[];
    warnings: string[];
  };
  duplicateOfIndex?: number;
  status: string;
  message?: string;
  accountId?: number;
  vaultItemIds?: number[];
};

export type CredentialImportJobRecord = {
  id: string;
  status: ImportJobStatus;
  target?: CredentialTarget;
  siteId?: number;
  operatorId: string;
  conflictPolicy: CredentialConflictPolicy;
  detection: CredentialFormatDetection;
  warnings: string[];
  batchFingerprint: string;
  candidateCount: number;
  duplicateCount: number;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  failureMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  items?: CredentialImportJobItemRecord[];
};

export class CredentialImportJobError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'CredentialImportJobError';
  }
}

function normalizeOptionalText(value: unknown, maximum = 300): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new CredentialImportJobError('文本参数无效');
  }
  return normalized;
}

function normalizeOperatorId(value: unknown): string {
  return normalizeOptionalText(value, 300) || DEFAULT_OPERATOR_ID;
}

function hashNamespaced(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex');
}

function buildIdempotencyKeyHash(operatorId: string, value: unknown): string | null {
  const normalized = normalizeOptionalText(value, 256);
  return normalized
    ? hashNamespaced('credential-import-job-idempotency', `${operatorId}\0${normalized}`)
    : null;
}

function sourceVersion(value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizePositiveId(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(200, Math.trunc(parsed));
}

function buildRequestFingerprint(input: {
  batchFingerprint: string;
  target?: CredentialTarget;
  siteId?: number;
  conflictPolicy: CredentialConflictPolicy;
  detection: CredentialFormatDetection;
  candidateCount: number;
}): string {
  return hashNamespaced('credential-import-request', JSON.stringify({
    batchFingerprint: input.batchFingerprint,
    target: input.target || null,
    siteId: input.siteId || null,
    conflictPolicy: input.conflictPolicy,
    sourceFormat: input.detection.format,
    sourceVersion: input.detection.version ?? null,
    sourceProvider: input.detection.provider ?? null,
    candidateCount: input.candidateCount,
  }));
}

function assertCandidateLimit(count: number): void {
  if (count > MAX_IMPORT_CANDIDATES) {
    throw new CredentialImportJobError(`单次最多支持 ${MAX_IMPORT_CANDIDATES} 条凭证`);
  }
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const entry = error as { code?: unknown; errno?: unknown; message?: unknown } | null;
  const code = String(entry?.code ?? entry?.errno ?? '').toUpperCase();
  const message = String(entry?.message || '').toLowerCase();
  return code === '23505'
    || code === '1062'
    || code === 'ER_DUP_ENTRY'
    || code.startsWith('SQLITE_CONSTRAINT')
    || message.includes('unique constraint')
    || message.includes('duplicate entry')
    || message.includes('duplicate key');
}

function assertIdempotencyMatch(existing: ImportJobRow, requestFingerprint: string): void {
  if (existing.requestFingerprint !== requestFingerprint) {
    throw new CredentialImportJobError('幂等键已用于不同的凭证导入请求', 409);
  }
}

function persistedJobStatus(value: string): ImportJobStatus {
  return ['previewed', 'running', 'completed', 'partial', 'failed'].includes(value)
    ? value as ImportJobStatus
    : 'failed';
}

function detectionFromJob(row: ImportJobRow): CredentialFormatDetection {
  return {
    format: row.sourceFormat as CredentialFormatDetection['format'],
    ...(row.sourceVersion ? { version: row.sourceVersion } : {}),
    ...(row.sourcePlatform ? { provider: row.sourcePlatform } : {}),
    isBatch: row.detectionIsBatch === true,
    confidence: row.detectionConfidence as CredentialFormatDetection['confidence'],
    warnings: parseJson(row.detectionWarnings, []),
  };
}

function itemRecordFromRow(row: ImportItemRow): CredentialImportJobItemRecord {
  return {
    id: row.id,
    index: row.sourceIndex,
    source: {
      format: row.sourceFormat,
      ...(row.sourceVersion ? { version: row.sourceVersion } : {}),
      ...(row.sourcePlatform ? { platform: row.sourcePlatform } : {}),
    },
    ...(row.provider ? { provider: row.provider } : {}),
    kind: row.kind,
    identity: parseJson(row.identitySummary, {}),
    secretSummary: parseJson(row.secretSummary, {}),
    compatibleTargets: parseJson(row.compatibleTargets, []),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    disabled: row.disabled === true,
    fingerprint: row.candidateFingerprint,
    validation: {
      status: row.validationStatus,
      errors: parseJson(row.validationErrors, []),
      warnings: parseJson(row.validationWarnings, []),
    },
    ...(row.duplicateOfIndex === null ? {} : { duplicateOfIndex: row.duplicateOfIndex }),
    status: row.status,
    ...(row.resultMessage ? { message: row.resultMessage } : {}),
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.vaultItemIds ? { vaultItemIds: parseJson(row.vaultItemIds, []) } : {}),
  };
}

function jobRecordFromRow(row: ImportJobRow, items?: ImportItemRow[]): CredentialImportJobRecord {
  return {
    id: row.id,
    status: persistedJobStatus(row.status),
    ...(row.target ? { target: row.target as CredentialTarget } : {}),
    ...(row.siteId ? { siteId: row.siteId } : {}),
    operatorId: row.operatorId,
    conflictPolicy: row.conflictPolicy as CredentialConflictPolicy,
    detection: detectionFromJob(row),
    warnings: parseJson(row.normalizationWarnings, []),
    batchFingerprint: row.batchFingerprint,
    candidateCount: row.candidateCount,
    duplicateCount: row.duplicateCount,
    imported: row.importedCount,
    updated: row.updatedCount,
    skipped: row.skippedCount,
    failed: row.failedCount,
    ...(row.failureMessage ? { failureMessage: row.failureMessage } : {}),
    ...(row.startedAt ? { startedAt: row.startedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    ...(items ? { items: items.map(itemRecordFromRow) } : {}),
  };
}

async function loadJobRow(jobId: string): Promise<ImportJobRow | null> {
  return await db.select().from(schema.credentialImportJobs)
    .where(eq(schema.credentialImportJobs.id, jobId)).get() || null;
}

async function loadJobByIdempotencyHash(hash: string): Promise<ImportJobRow | null> {
  return await db.select().from(schema.credentialImportJobs)
    .where(eq(schema.credentialImportJobs.idempotencyKeyHash, hash)).get() || null;
}

export async function createCredentialImportPreviewJob(input: {
  input: unknown;
  target?: CredentialTarget;
  siteId?: number;
  conflictPolicy?: CredentialConflictPolicy;
  operatorId?: unknown;
  idempotencyKey?: unknown;
}): Promise<CredentialImportPreviewJobResult> {
  const operatorId = normalizeOperatorId(input.operatorId);
  const siteId = normalizePositiveId(input.siteId);
  const conflictPolicy = input.conflictPolicy || 'skip';
  const normalized = normalizeCredentialInput(input.input);
  assertCandidateLimit(normalized.candidates.length);
  const preview = buildCredentialBatchPreview(normalized.candidates, input.target);
  const requestFingerprint = buildRequestFingerprint({
    batchFingerprint: preview.batchFingerprint,
    target: input.target,
    siteId,
    conflictPolicy,
    detection: normalized.detection,
    candidateCount: normalized.candidates.length,
  });
  const idempotencyKeyHash = buildIdempotencyKeyHash(operatorId, input.idempotencyKey);

  if (idempotencyKeyHash) {
    const existing = await loadJobByIdempotencyHash(idempotencyKeyHash);
    if (existing) {
      assertIdempotencyMatch(existing, requestFingerprint);
      return {
        importJobId: existing.id,
        deduplicated: true,
        status: persistedJobStatus(existing.status),
        detection: normalized.detection,
        warnings: normalized.warnings,
        ...preview,
      };
    }
  }

  const jobId = randomUUID();
  const now = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      if (idempotencyKeyHash) {
        const existing = await tx.select().from(schema.credentialImportJobs)
          .where(eq(schema.credentialImportJobs.idempotencyKeyHash, idempotencyKeyHash)).get();
        if (existing) {
          assertIdempotencyMatch(existing, requestFingerprint);
          throw new CredentialImportJobError(`__deduplicated__:${existing.id}`, 409);
        }
      }

      await tx.insert(schema.credentialImportJobs).values({
        id: jobId,
        status: 'previewed',
        target: input.target || null,
        siteId: siteId || null,
        operatorId,
        conflictPolicy,
        sourceFormat: normalized.detection.format,
        sourceVersion: sourceVersion(normalized.detection.version),
        sourcePlatform: normalized.detection.provider || null,
        detectionConfidence: normalized.detection.confidence,
        detectionIsBatch: normalized.detection.isBatch,
        detectionWarnings: toJson(normalized.detection.warnings),
        normalizationWarnings: toJson(normalized.warnings),
        batchFingerprint: preview.batchFingerprint,
        requestFingerprint,
        idempotencyKeyHash,
        candidateCount: normalized.candidates.length,
        duplicateCount: preview.duplicateCount,
        createdAt: now,
        updatedAt: now,
      }).run();

      await tx.insert(schema.credentialImportItems).values(
        normalized.candidates.map((candidate, index) => {
          const previewItem = preview.candidates[index]!;
          return {
            jobId,
            sourceIndex: index,
            candidateFingerprint: candidate.fingerprint,
            sourceFormat: candidate.source.format,
            sourceVersion: sourceVersion(candidate.source.version),
            sourcePlatform: candidate.source.platform || null,
            provider: candidate.provider || null,
            kind: candidate.kind,
            identitySummary: toJson(candidate.identity),
            secretSummary: toJson(previewItem.candidate.secretSummary),
            compatibleTargets: toJson(candidate.compatibleTargets),
            expiresAt: candidate.expiresAt ? new Date(candidate.expiresAt).toISOString() : null,
            disabled: candidate.disabled,
            candidateWarnings: toJson(candidate.warnings),
            validationStatus: previewItem.validation.status,
            validationErrors: toJson(previewItem.validation.errors),
            validationWarnings: toJson(previewItem.validation.warnings),
            duplicateOfIndex: previewItem.duplicateOfIndex ?? null,
            status: 'previewed',
            createdAt: now,
            updatedAt: now,
          };
        }),
      ).run();
    });
  } catch (error) {
    if (error instanceof CredentialImportJobError && error.message.startsWith('__deduplicated__:')) {
      const existingId = error.message.slice('__deduplicated__:'.length);
      return {
        importJobId: existingId,
        deduplicated: true,
        status: 'previewed',
        detection: normalized.detection,
        warnings: normalized.warnings,
        ...preview,
      };
    }
    if (idempotencyKeyHash && looksLikeUniqueCollision(error)) {
      const existing = await loadJobByIdempotencyHash(idempotencyKeyHash);
      if (existing) {
        assertIdempotencyMatch(existing, requestFingerprint);
        return {
          importJobId: existing.id,
          deduplicated: true,
          status: persistedJobStatus(existing.status),
          detection: normalized.detection,
          warnings: normalized.warnings,
          ...preview,
        };
      }
    }
    throw error;
  }

  return {
    importJobId: jobId,
    deduplicated: false,
    status: 'previewed',
    detection: normalized.detection,
    warnings: normalized.warnings,
    ...preview,
  };
}

function promotionItemFromRow(row: ImportItemRow): CredentialPromotionItem {
  return {
    index: row.sourceIndex,
    status: row.status as CredentialPromotionItem['status'],
    ...(row.provider ? { provider: row.provider } : {}),
    kind: row.kind as CredentialPromotionItem['kind'],
    fingerprint: row.candidateFingerprint,
    ...(row.duplicateOfIndex === null ? {} : { duplicateOfIndex: row.duplicateOfIndex }),
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.vaultItemIds ? { vaultItemIds: parseJson(row.vaultItemIds, []) } : {}),
    ...(row.resultMessage ? { message: row.resultMessage } : {}),
  };
}

async function replayCompletedJob(row: ImportJobRow): Promise<CredentialImportExecutionResult> {
  if (!row.target) throw new CredentialImportJobError('导入任务没有执行目标', 409);
  const items = await db.select().from(schema.credentialImportItems)
    .where(eq(schema.credentialImportItems.jobId, row.id))
    .orderBy(asc(schema.credentialImportItems.sourceIndex)).all();
  return {
    importJobId: row.id,
    deduplicated: true,
    jobStatus: persistedJobStatus(row.status),
    success: row.failedCount === 0,
    target: row.target as CredentialTarget,
    batchFingerprint: row.batchFingerprint,
    imported: row.importedCount,
    updated: row.updatedCount,
    skipped: row.skippedCount,
    failed: row.failedCount,
    items: items.map(promotionItemFromRow),
  };
}

function safeFailureMessage(error: unknown, rawInput: unknown): string {
  let message = error instanceof Error && error.message ? error.message : '凭证导入失败';
  try {
    const normalized = normalizeCredentialInput(rawInput);
    for (const candidate of normalized.candidates) {
      for (const secret of Object.values(candidate.secrets)) {
        if (typeof secret !== 'string' || secret.length < 3) continue;
        message = message.split(secret).join('[REDACTED]');
      }
    }
  } catch {
    // The original validation error is already secret-free.
  }
  return message.slice(0, 2_000);
}

async function persistPromotionResult(
  job: ImportJobRow,
  result: CredentialPromotionResult,
): Promise<ImportJobStatus> {
  const now = new Date().toISOString();
  const status: ImportJobStatus = result.failed === 0
    ? 'completed'
    : 'partial';
  const itemRows = await db.select().from(schema.credentialImportItems)
    .where(eq(schema.credentialImportItems.jobId, job.id)).all() as ImportItemRow[];
  const itemByIndex = new Map<number, ImportItemRow>(
    itemRows.map((row) => [row.sourceIndex, row] as const),
  );

  await db.transaction(async (tx) => {
    for (const resultItem of result.items) {
      const item = itemByIndex.get(resultItem.index);
      if (!item) continue;
      await tx.update(schema.credentialImportItems).set({
        status: resultItem.status,
        resultMessage: resultItem.message || null,
        accountId: resultItem.accountId || null,
        vaultItemIds: resultItem.vaultItemIds ? toJson(resultItem.vaultItemIds) : null,
        completedAt: now,
        updatedAt: now,
      }).where(eq(schema.credentialImportItems.id, item.id)).run();

      const targets: Array<{ type: 'account' | 'vault_item'; id: number }> = [];
      if (resultItem.accountId) targets.push({ type: 'account', id: resultItem.accountId });
      for (const vaultItemId of resultItem.vaultItemIds || []) {
        targets.push({ type: 'vault_item', id: vaultItemId });
      }
      for (const target of targets) {
        await tx.insert(schema.credentialImportProvenance).values({
          jobId: job.id,
          itemId: item.id,
          targetEntityType: target.type,
          targetEntityId: target.id,
          siteId: job.siteId || null,
          candidateFingerprint: item.candidateFingerprint,
          sourceFormat: item.sourceFormat,
          sourceVersion: item.sourceVersion,
          sourcePlatform: item.sourcePlatform,
          provider: item.provider,
          operatorId: job.operatorId,
          conflictPolicy: job.conflictPolicy,
          importAction: resultItem.status,
          createdAt: now,
        }).run();
      }
    }

    await tx.update(schema.credentialImportJobs).set({
      status,
      importedCount: result.imported,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      failedCount: result.failed,
      failureMessage: result.failed > 0 ? '部分凭证导入失败，请查看逐条结果' : null,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.credentialImportJobs.id, job.id),
      eq(schema.credentialImportJobs.status, 'running'),
    )).run();
  });
  return status;
}

export async function executeCredentialImportJob(input: {
  importJobId: string;
  input: unknown;
  target: CredentialTarget;
  siteId?: number;
  batchFingerprint: string;
  conflictPolicy?: CredentialConflictPolicy;
  operatorId?: unknown;
}): Promise<CredentialImportExecutionResult> {
  const jobId = normalizeOptionalText(input.importJobId, 100);
  if (!jobId) throw new CredentialImportJobError('importJobId 不能为空');
  const operatorId = normalizeOperatorId(input.operatorId);
  const siteId = normalizePositiveId(input.siteId);
  const conflictPolicy = input.conflictPolicy || 'skip';
  let job = await loadJobRow(jobId);
  if (!job) throw new CredentialImportJobError('凭证导入任务不存在', 404);
  if (job.operatorId !== operatorId) throw new CredentialImportJobError('凭证导入任务操作者不匹配', 403);
  if (!job.target) throw new CredentialImportJobError('该任务未指定 target，请重新预览');
  if (job.target !== input.target || (job.siteId || undefined) !== siteId || job.conflictPolicy !== conflictPolicy) {
    throw new CredentialImportJobError('执行参数与预览任务不一致，请重新预览');
  }
  if (job.batchFingerprint !== input.batchFingerprint) {
    throw new CredentialImportJobError('batchFingerprint 与预览任务不一致，请重新预览');
  }

  const normalized = normalizeCredentialInput(input.input);
  assertCandidateLimit(normalized.candidates.length);
  const preview = buildCredentialBatchPreview(normalized.candidates, input.target);
  const requestFingerprint = buildRequestFingerprint({
    batchFingerprint: preview.batchFingerprint,
    target: input.target,
    siteId,
    conflictPolicy,
    detection: normalized.detection,
    candidateCount: normalized.candidates.length,
  });
  if (preview.batchFingerprint !== input.batchFingerprint || requestFingerprint !== job.requestFingerprint) {
    throw new CredentialImportJobError('凭证输入已变化，请重新预览后再执行');
  }

  if (['completed', 'partial'].includes(job.status)) return replayCompletedJob(job);
  if (job.status === 'failed') {
    throw new CredentialImportJobError(job.failureMessage || '凭证导入任务已失败，请创建新任务重试', 409);
  }
  if (job.status === 'running') {
    throw new CredentialImportJobError('凭证导入任务正在执行，请稍后查询任务状态', 409);
  }

  const now = new Date().toISOString();
  const claim = await db.update(schema.credentialImportJobs).set({
    status: 'running',
    startedAt: now,
    updatedAt: now,
  }).where(and(
    eq(schema.credentialImportJobs.id, job.id),
    eq(schema.credentialImportJobs.status, 'previewed'),
  )).run();
  if (Number((claim as { changes?: number }).changes || 0) !== 1) {
    job = await loadJobRow(job.id);
    if (job && ['completed', 'partial'].includes(job.status)) return replayCompletedJob(job);
    throw new CredentialImportJobError('凭证导入任务已被其他请求执行', 409);
  }

  job = { ...job, status: 'running', startedAt: now, updatedAt: now };
  try {
    const result = await promoteCredentialBatch({
      input: input.input,
      target: input.target,
      siteId,
      batchFingerprint: input.batchFingerprint,
      conflictPolicy,
      importJobId: job.id,
    });
    const jobStatus = await persistPromotionResult(job, result);
    return {
      ...result,
      importJobId: job.id,
      deduplicated: false,
      jobStatus,
    };
  } catch (error) {
    const failureMessage = safeFailureMessage(error, input.input);
    const completedAt = new Date().toISOString();
    await db.update(schema.credentialImportJobs).set({
      status: 'failed',
      failedCount: job.candidateCount,
      failureMessage,
      completedAt,
      updatedAt: completedAt,
    }).where(and(
      eq(schema.credentialImportJobs.id, job.id),
      eq(schema.credentialImportJobs.status, 'running'),
    )).run();
    if (error instanceof CredentialPromotionError) throw error;
    if (error instanceof CredentialImportJobError) throw error;
    throw new CredentialImportJobError(failureMessage);
  }
}

export async function getCredentialImportJob(jobId: unknown): Promise<CredentialImportJobRecord | null> {
  const normalized = normalizeOptionalText(jobId, 100);
  if (!normalized) throw new CredentialImportJobError('importJobId 不能为空');
  const row = await loadJobRow(normalized);
  if (!row) return null;
  const items = await db.select().from(schema.credentialImportItems)
    .where(eq(schema.credentialImportItems.jobId, normalized))
    .orderBy(asc(schema.credentialImportItems.sourceIndex)).all();
  return jobRecordFromRow(row, items);
}

export async function listCredentialImportJobs(input: {
  limit?: unknown;
  siteId?: unknown;
} = {}): Promise<CredentialImportJobRecord[]> {
  const limit = normalizeLimit(input.limit);
  const siteId = normalizePositiveId(input.siteId);
  const rows = siteId
    ? await db.select().from(schema.credentialImportJobs)
      .where(eq(schema.credentialImportJobs.siteId, siteId))
      .orderBy(desc(schema.credentialImportJobs.createdAt)).limit(limit).all()
    : await db.select().from(schema.credentialImportJobs)
      .orderBy(desc(schema.credentialImportJobs.createdAt)).limit(limit).all();
  return rows.map((row) => jobRecordFromRow(row));
}
