import type { FastifyInstance } from 'fastify';
import {
  CredentialExportError,
  exportCredentials,
} from '../../services/credentialExportService.js';

const EXPORT_BODY_LIMIT_BYTES = 256 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '凭证导出失败';
}

export async function credentialExportRoutes(app: FastifyInstance) {
  app.post<{
    Body: {
      mode?: string;
      siteId?: number | string;
      accountIds?: Array<number | string>;
      vaultItemIds?: Array<number | string>;
      passphrase?: string;
      confirmation?: string;
      expiresInSec?: number | string;
      operatorId?: string;
    };
  }>('/api/credential-exports', { bodyLimit: EXPORT_BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      const exported = await exportCredentials({
        mode: request.body?.mode,
        siteId: request.body?.siteId,
        accountIds: request.body?.accountIds,
        vaultItemIds: request.body?.vaultItemIds,
        passphrase: request.body?.passphrase,
        confirmation: request.body?.confirmation,
        expiresInSec: request.body?.expiresInSec,
        operatorId: request.body?.operatorId,
      });
      return { success: true, export: exported };
    } catch (error) {
      const statusCode = error instanceof CredentialExportError ? error.statusCode : 400;
      return reply.code(statusCode).send({ success: false, message: errorMessage(error) });
    }
  });
}
