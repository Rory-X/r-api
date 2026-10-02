import type { FastifyInstance } from 'fastify';
import {
  CredentialLifecycleError,
  listCredentialLifecycle,
} from '../../services/credentialLifecycleService.js';
import {
  executeCredentialLifecycleBatchWithAudit,
  executeCredentialLifecycleOperationsPass,
  getCredentialLifecyclePolicy,
  listCredentialLifecycleAudits,
  listCredentialRefreshQueue,
  retryCredentialRefreshJob,
  setCredentialRefreshOwner,
  updateCredentialLifecyclePolicy,
} from '../../services/credentialLifecycleOperationsService.js';
import type { CredentialLifecyclePolicyInput } from '../../services/credentialLifecyclePolicyService.js';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '凭证生命周期操作失败';
}

export async function credentialLifecycleRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { siteId?: string; status?: string; entityType?: string };
  }>('/api/credential-lifecycle', async (request, reply) => {
    try {
      return {
        success: true,
        items: await listCredentialLifecycle({
          siteId: request.query?.siteId,
          status: request.query?.status,
          entityType: request.query?.entityType,
          expiringWindowMs: (await getCredentialLifecyclePolicy()).expiryWarningLeadMinutes * 60 * 1_000,
        }),
      };
    } catch (error) {
      const statusCode = error instanceof CredentialLifecycleError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: {
      action?: string;
      items?: Array<{ entityType?: string; entityId?: number | string }>;
      operatorId?: string;
      source?: string;
    };
  }>('/api/credential-lifecycle/actions', async (request, reply) => {
    try {
      return {
        success: true,
        ...(await executeCredentialLifecycleBatchWithAudit({
          action: request.body?.action,
          items: request.body?.items,
          operatorId: request.body?.operatorId,
          source: request.body?.source,
        })),
      };
    } catch (error) {
      const statusCode = error instanceof CredentialLifecycleError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get('/api/credential-lifecycle/policy', async () => ({
    success: true,
    policy: await getCredentialLifecyclePolicy(),
  }));

  app.put<{
    Body: { policy?: CredentialLifecyclePolicyInput; operatorId?: string };
  }>('/api/credential-lifecycle/policy', async (request, reply) => {
    try {
      return {
        success: true,
        policy: await updateCredentialLifecyclePolicy({
          policy: request.body?.policy || {},
          operatorId: request.body?.operatorId,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.put<{
    Params: { accountId: string };
    Body: { refreshOwner?: string; operatorId?: string };
  }>('/api/credential-lifecycle/accounts/:accountId/refresh-owner', async (request, reply) => {
    try {
      return {
        success: true,
        ...(await setCredentialRefreshOwner({
          accountId: request.params.accountId,
          refreshOwner: request.body?.refreshOwner,
          operatorId: request.body?.operatorId,
        })),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Querystring: {
      status?: string;
      provider?: string;
      failureClass?: string;
      failureCode?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/credential-lifecycle/refresh-queue', async (request) => ({
    success: true,
    ...(await listCredentialRefreshQueue(request.query)),
  }));

  app.post<{
    Body: { maxJobs?: number };
  }>('/api/credential-lifecycle/refresh-queue/run', async (request, reply) => {
    try {
      return {
        success: true,
        ...(await executeCredentialLifecycleOperationsPass({
          maxJobs: request.body?.maxJobs,
          forceRefreshQueue: true,
        })),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { jobId: string };
    Body: { operatorId?: string };
  }>('/api/credential-lifecycle/refresh-queue/:jobId/retry', async (request, reply) => {
    try {
      return {
        success: true,
        ...(await retryCredentialRefreshJob({
          jobId: request.params.jobId,
          operatorId: request.body?.operatorId,
        })),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Querystring: {
      source?: string;
      operatorId?: string;
      status?: string;
      action?: string;
      outcome?: string;
      entityType?: string;
      entityId?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/credential-lifecycle/audits', async (request) => ({
    success: true,
    ...(await listCredentialLifecycleAudits(request.query)),
  }));
}
