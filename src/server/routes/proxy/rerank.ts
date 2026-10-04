import type { FastifyInstance } from 'fastify';
import { parseRerankRequest } from '../../contracts/rerank.js';
import { handleRerankSurfaceRequest } from '../../proxy-core/surfaces/rerankSurface.js';

export async function rerankProxyRoute(app: FastifyInstance) {
  app.post('/v1/rerank', async (request, reply) => {
    const parsed = parseRerankRequest(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: { message: parsed.error, type: 'invalid_request_error' } });
    return handleRerankSurfaceRequest(request, reply, parsed.body);
  });
}
