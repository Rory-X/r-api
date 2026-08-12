import type { FastifyInstance } from 'fastify';
import {
  BROWSER_RECOVERY_MODES,
  BROWSER_RECOVERY_STATUSES,
  cancelBrowserRecoveryTask,
  claimBrowserRecoveryTask,
  completeBrowserRecoveryTask,
  createBrowserRecoveryTask,
  listBrowserRecoveryTasks,
  type BrowserRecoveryTaskMode,
  type BrowserRecoveryTaskStatus,
} from '../../services/browserCredentialRecoveryService.js';
import { activateBrowserRecoveryCredential } from '../../services/browserCredentialActivationService.js';

function parsePositiveId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function parseMode(value: unknown): BrowserRecoveryTaskMode | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (BROWSER_RECOVERY_MODES as readonly string[]).includes(normalized)
    ? normalized as BrowserRecoveryTaskMode
    : null;
}

function parseStatus(value: unknown): BrowserRecoveryTaskStatus | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (BROWSER_RECOVERY_STATUSES as readonly string[]).includes(normalized)
    ? normalized as BrowserRecoveryTaskStatus
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '浏览器凭证任务失败';
}

export async function browserCredentialRecoveryRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { siteId?: string; status?: string };
  }>('/api/browser-credential-tasks', async (request, reply) => {
    const siteId = request.query.siteId === undefined || request.query.siteId === ''
      ? undefined
      : parsePositiveId(request.query.siteId);
    const status = parseStatus(request.query.status);
    if (request.query.siteId !== undefined && siteId === null) {
      return reply.code(400).send({ success: false, message: 'siteId 无效' });
    }
    if (request.query.status !== undefined && status === undefined) {
      return reply.code(400).send({ success: false, message: 'status 无效' });
    }
    return { items: await listBrowserRecoveryTasks({ siteId: siteId ?? undefined, status }) };
  });

  app.post<{
    Body: {
      siteId?: number;
      accountId?: number | null;
      mode?: string;
      credentialName?: string;
      ttlSec?: number;
    };
  }>('/api/browser-credential-tasks', async (request, reply) => {
    const siteId = parsePositiveId(request.body?.siteId);
    const mode = parseMode(request.body?.mode);
    if (siteId === null) return reply.code(400).send({ success: false, message: 'siteId 无效' });
    if (!mode) return reply.code(400).send({ success: false, message: 'mode 无效' });
    try {
      const result = await createBrowserRecoveryTask({
        siteId,
        accountId: request.body?.accountId,
        mode,
        credentialName: request.body?.credentialName,
        ttlSec: request.body?.ttlSec,
      });
      return { success: true, ...result };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/browser-credential-tasks/:id/cancel', async (request, reply) => {
    try {
      const cancelled = await cancelBrowserRecoveryTask(request.params.id);
      if (!cancelled) return reply.code(404).send({ success: false, message: '任务不存在或已结束' });
      return { success: true };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { accountId?: number | null };
  }>('/api/browser-credential-tasks/:id/activate', async (request, reply) => {
    try {
      const result = await activateBrowserRecoveryCredential({
        taskId: request.params.id,
        accountId: request.body?.accountId,
      });
      return { success: true, activation: result };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  // Public handoff endpoints authenticate with high-entropy one-time task tokens.
  app.post<{
    Body: { taskId?: string; token?: string; claimedBy?: string };
  }>('/api/browser-credential-tasks/public/claim', async (request, reply) => {
    try {
      const result = await claimBrowserRecoveryTask(
        request.body?.taskId,
        request.body?.token,
        request.body?.claimedBy,
      );
      return { success: true, ...result };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: {
      taskId?: string;
      claimToken?: string;
      origin?: string;
      fields?: Array<{ name?: string; kind?: string; value?: string }>;
      username?: string | null;
    };
  }>('/api/browser-credential-tasks/public/complete', async (request, reply) => {
    try {
      const result = await completeBrowserRecoveryTask({
        taskId: request.body?.taskId || '',
        claimToken: request.body?.claimToken || '',
        origin: request.body?.origin || '',
        fields: (request.body?.fields || []).map((field) => ({
          name: field.name || '',
          kind: field.kind as any,
          value: field.value || '',
        })),
        username: request.body?.username,
      });
      return {
        success: true,
        idempotent: result.idempotent,
        task: result.task,
        credential: result.credential,
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });
}
