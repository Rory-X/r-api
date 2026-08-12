import type { FastifyInstance } from 'fastify';

import {
  getProxyRequestLedgerDetail,
  listProxyRequestLedgers,
  type ProxyRequestLedgerListFilters,
} from '../../services/proxyAttemptLedgerStore.js';

function parseIntegerQuery(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function proxyRequestLedgerRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      commitState?: string;
      search?: string;
    };
  }>('/api/proxy-request-ledgers', async (request) => {
    return listProxyRequestLedgers({
      limit: parseIntegerQuery(request.query.limit, 20),
      offset: parseIntegerQuery(request.query.offset, 0),
      status: request.query.status as ProxyRequestLedgerListFilters['status'],
      commitState: request.query.commitState as ProxyRequestLedgerListFilters['commitState'],
      search: request.query.search,
    });
  });

  app.get<{ Params: { requestId: string } }>(
    '/api/proxy-request-ledgers/:requestId',
    async (request, reply) => {
      const requestId = request.params.requestId?.trim() || '';
      if (!requestId || requestId.length > 512) {
        return reply.code(400).send({ message: 'proxy request id is invalid' });
      }
      const detail = await getProxyRequestLedgerDetail(requestId);
      if (!detail) {
        return reply.code(404).send({ message: 'proxy request ledger not found' });
      }
      return detail;
    },
  );
}
