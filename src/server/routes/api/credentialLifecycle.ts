import type { FastifyInstance } from 'fastify';
import {
  CredentialLifecycleError,
  executeCredentialLifecycleBatch,
  listCredentialLifecycle,
} from '../../services/credentialLifecycleService.js';

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
        }),
      };
    } catch (error) {
      const statusCode = error instanceof CredentialLifecycleError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: { action?: string; items?: Array<{ entityType?: string; entityId?: number | string }> };
  }>('/api/credential-lifecycle/actions', async (request, reply) => {
    try {
      return {
        success: true,
        ...(await executeCredentialLifecycleBatch({
          action: request.body?.action,
          items: request.body?.items,
        })),
      };
    } catch (error) {
      const statusCode = error instanceof CredentialLifecycleError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });
}
