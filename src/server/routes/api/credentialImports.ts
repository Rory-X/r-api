import type { FastifyInstance } from 'fastify';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import {
  type CredentialTarget,
} from '../../services/credentialIngestionService.js';
import {
  CredentialPromotionError,
  type CredentialConflictPolicy,
} from '../../services/credentialPromotionService.js';
import {
  CredentialImportJobError,
  createCredentialImportPreviewJob,
  executeCredentialImportJob,
  getCredentialImportJob,
  listCredentialImportJobs,
} from '../../services/credentialImportJobService.js';
import {
  CredentialExportError,
  resolveCredentialImportPayload,
} from '../../services/credentialExportService.js';

const MAX_IMPORT_INPUT_BYTES = 2 * 1024 * 1024;
const PREVIEW_BODY_LIMIT_BYTES = MAX_IMPORT_INPUT_BYTES + 64 * 1024;
const CREDENTIAL_TARGETS = new Set<CredentialTarget>([
  'new_api',
  'sub2api',
  'native_oauth',
  'api_key',
  'vault',
]);
const CONFLICT_POLICIES = new Set<CredentialConflictPolicy>([
  'skip',
  'update',
  'create_duplicate',
]);

const limitCredentialImportPreview = createRateLimitGuard({
  bucket: 'credential-import-preview',
  max: 30,
  windowMs: 60_000,
});

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '凭证导入预览失败';
}

function assertInputSize(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (Buffer.byteLength(serialized || '', 'utf8') > MAX_IMPORT_INPUT_BYTES) {
    throw new Error('凭证输入超过 2MB 限制');
  }
}

function parseTarget(value: unknown): CredentialTarget | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!CREDENTIAL_TARGETS.has(normalized as CredentialTarget)) {
    throw new Error('target 无效');
  }
  return normalized as CredentialTarget;
}

function parseConflictPolicy(value: unknown): CredentialConflictPolicy {
  if (value === undefined || value === null || value === '') return 'skip';
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!CONFLICT_POLICIES.has(normalized as CredentialConflictPolicy)) {
    throw new Error('conflictPolicy 无效');
  }
  return normalized as CredentialConflictPolicy;
}

function parseSiteId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('siteId 无效');
  return Math.trunc(parsed);
}

function idempotencyKey(header: string | string[] | undefined, bodyValue?: unknown): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw || bodyValue;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) {
    throw new Error('idempotencyKey 无效');
  }
  return value.trim();
}

function parseOperatorId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 300) {
    throw new Error('operatorId 无效');
  }
  return value.trim();
}

export async function credentialImportRoutes(app: FastifyInstance) {
  app.post<{
    Headers: { 'idempotency-key'?: string };
    Body: {
      input?: unknown;
      target?: string;
      siteId?: number | string;
      conflictPolicy?: string;
      operatorId?: string;
      idempotencyKey?: string;
      passphrase?: string;
    };
  }>(
    '/api/credential-imports/preview',
    {
      bodyLimit: PREVIEW_BODY_LIMIT_BYTES,
      preHandler: [limitCredentialImportPreview],
    },
    async (request, reply) => {
      try {
        if (!request.body || !Object.prototype.hasOwnProperty.call(request.body, 'input')) {
          return reply.code(400).send({ success: false, message: 'input 不能为空' });
        }
        assertInputSize(request.body.input);
        const target = parseTarget(request.body.target);
        const importInput = resolveCredentialImportPayload(request.body.input, request.body.passphrase);
        const preview = await createCredentialImportPreviewJob({
          input: importInput,
          target,
          siteId: parseSiteId(request.body.siteId),
          conflictPolicy: parseConflictPolicy(request.body.conflictPolicy),
          operatorId: parseOperatorId(request.body.operatorId),
          idempotencyKey: idempotencyKey(
            request.headers['idempotency-key'],
            request.body.idempotencyKey,
          ),
        });
        return {
          success: true,
          importJobId: preview.importJobId,
          deduplicated: preview.deduplicated,
          status: preview.status,
          detection: preview.detection,
          warnings: preview.warnings,
          batchFingerprint: preview.batchFingerprint,
          duplicateCount: preview.duplicateCount,
          candidates: preview.candidates,
        };
      } catch (error) {
        const statusCode = error instanceof CredentialImportJobError || error instanceof CredentialExportError
          ? error.statusCode
          : 400;
        return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
      }
    },
  );

  app.post<{
    Body: {
      input?: unknown;
      target?: string;
      siteId?: number | string;
      importJobId?: string;
      batchFingerprint?: string;
      conflictPolicy?: string;
      operatorId?: string;
      passphrase?: string;
    };
  }>(
    '/api/credential-imports/promote',
    {
      bodyLimit: PREVIEW_BODY_LIMIT_BYTES,
      preHandler: [limitCredentialImportPreview],
    },
    async (request, reply) => {
      try {
        if (!request.body || !Object.prototype.hasOwnProperty.call(request.body, 'input')) {
          return reply.code(400).send({ success: false, message: 'input 不能为空' });
        }
        assertInputSize(request.body.input);
        const target = parseTarget(request.body.target);
        if (!target) throw new Error('target 不能为空');
        const importJobId = typeof request.body.importJobId === 'string'
          ? request.body.importJobId.trim()
          : '';
        if (!importJobId) throw new Error('importJobId 不能为空');
        const batchFingerprint = typeof request.body.batchFingerprint === 'string'
          ? request.body.batchFingerprint.trim()
          : '';
        if (!/^[a-f0-9]{64}$/.test(batchFingerprint)) {
          throw new Error('batchFingerprint 无效');
        }
        const importInput = resolveCredentialImportPayload(request.body.input, request.body.passphrase);
        const result = await executeCredentialImportJob({
          importJobId,
          input: importInput,
          target,
          siteId: parseSiteId(request.body.siteId),
          batchFingerprint,
          conflictPolicy: parseConflictPolicy(request.body.conflictPolicy),
          operatorId: parseOperatorId(request.body.operatorId),
        });
        return result;
      } catch (error) {
        const statusCode = error instanceof CredentialPromotionError
          || error instanceof CredentialImportJobError
          || error instanceof CredentialExportError
          ? error.statusCode
          : 400;
        return reply.code(statusCode).send({
          success: false,
          message: errorMessage(error),
        });
      }
    },
  );

  app.get<{
    Querystring: { limit?: number | string; siteId?: number | string };
  }>('/api/credential-imports', async (request, reply) => {
    try {
      return {
        success: true,
        jobs: await listCredentialImportJobs({
          limit: request.query?.limit,
          siteId: request.query?.siteId,
        }),
      };
    } catch (error) {
      const statusCode = error instanceof CredentialImportJobError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
  }>('/api/credential-imports/:id', async (request, reply) => {
    try {
      const job = await getCredentialImportJob(request.params.id);
      if (!job) return reply.code(404).send({ success: false, message: '凭证导入任务不存在' });
      return { success: true, job };
    } catch (error) {
      const statusCode = error instanceof CredentialImportJobError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });
}
