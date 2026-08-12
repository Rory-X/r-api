import type { FastifyInstance } from 'fastify';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { getProxyFileContentByPublicId } from '../../services/proxyFileStore.js';

const limitProxyFileContentRead = createRateLimitGuard({
  bucket: 'admin-proxy-file-content-read',
  max: 120,
  windowMs: 60_000,
});

export async function proxyFileAdminRoutes(app: FastifyInstance) {
  app.get<{ Params: { fileId: string } }>(
    '/api/proxy-files/:fileId/content',
    { preHandler: [limitProxyFileContentRead] },
    async (request, reply) => {
      const file = await getProxyFileContentByPublicId(request.params.fileId);
      if (!file) {
        return reply.code(404).send({ error: 'File not found' });
      }
      reply.type(file.mimeType);
      reply.header('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
      return reply.send(file.buffer);
    },
  );
}
