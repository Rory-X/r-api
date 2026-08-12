import type { FastifyInstance } from 'fastify';
import {
  deleteCredentialVaultItem,
  listCredentialVaultItems,
  revokeCredentialVaultItem,
  storeCredentialVaultItem,
  type CredentialVaultMetadata,
  type CredentialVaultStatus,
} from '../../services/credentialVaultService.js';
import type { SiteCredentialKind } from '../../services/platforms/siteAdapterContract.js';

const STATUSES = new Set<CredentialVaultStatus>(['active', 'revoked', 'expired']);

function parsePositiveId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function parseOptionalId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parsePositiveId(value) ?? undefined;
}

function parseStatus(value: unknown): CredentialVaultStatus | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STATUSES.has(normalized as CredentialVaultStatus)
    ? normalized as CredentialVaultStatus
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '凭证 Vault 操作失败';
}

export async function credentialVaultRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { siteId?: string; accountId?: string; status?: string };
  }>('/api/credential-vault', async (request, reply) => {
    const siteId = parseOptionalId(request.query.siteId);
    const accountId = parseOptionalId(request.query.accountId);
    const status = parseStatus(request.query.status);
    if (request.query.siteId && siteId === undefined) {
      return reply.code(400).send({ success: false, message: 'siteId 无效' });
    }
    if (request.query.accountId && accountId === undefined) {
      return reply.code(400).send({ success: false, message: 'accountId 无效' });
    }
    if (request.query.status && status === undefined) {
      return reply.code(400).send({ success: false, message: 'status 无效' });
    }

    return {
      items: await listCredentialVaultItems({ siteId, accountId, status }),
    };
  });

  app.post<{
    Body: {
      siteId?: number;
      accountId?: number;
      name?: string;
      kind?: SiteCredentialKind;
      secret?: string;
      metadata?: CredentialVaultMetadata;
      expiresAt?: string | null;
    };
  }>('/api/credential-vault', async (request, reply) => {
    try {
      const item = await storeCredentialVaultItem({
        siteId: request.body?.siteId,
        accountId: request.body?.accountId,
        name: request.body?.name || '',
        kind: request.body?.kind as SiteCredentialKind,
        secret: request.body?.secret as string,
        metadata: request.body?.metadata,
        expiresAt: request.body?.expiresAt,
      });
      return { success: true, item };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/credential-vault/:id/revoke', async (request, reply) => {
    const id = parsePositiveId(request.params.id);
    if (id === null) return reply.code(400).send({ success: false, message: '凭证 id 无效' });
    const revoked = await revokeCredentialVaultItem(id);
    if (!revoked) return reply.code(404).send({ success: false, message: '凭证不存在或已失效' });
    return { success: true };
  });

  app.delete<{ Params: { id: string } }>('/api/credential-vault/:id', async (request, reply) => {
    const id = parsePositiveId(request.params.id);
    if (id === null) return reply.code(400).send({ success: false, message: '凭证 id 无效' });
    const deleted = await deleteCredentialVaultItem(id);
    if (!deleted) return reply.code(404).send({ success: false, message: '凭证不存在' });
    return { success: true };
  });
}
