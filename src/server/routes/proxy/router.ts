import { FastifyInstance } from 'fastify';
import { proxyAuthMiddleware } from '../../middleware/auth.js';
import { chatProxyRoute, claudeMessagesProxyRoute } from './chat.js';
import { modelsProxyRoute } from './models.js';
import { embeddingsProxyRoute } from './embeddings.js';
import { completionsProxyRoute } from './completions.js';
import { responsesProxyRoute } from './responses.js';
import { imagesProxyRoute } from './images.js';
import { searchProxyRoute } from './search.js';
import { geminiProxyRoute } from './gemini.js';
import { videosProxyRoute } from './videos.js';
import { filesProxyRoute } from './files.js';
import { withProxyRequestAbortScope } from '../../proxy-core/requestAbortContext.js';

export async function proxyRoutes(app: FastifyInstance) {
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function (request, reply) {
      return withProxyRequestAbortScope(request.raw, reply.raw, async () => handler.call(this, request, reply));
    };
  });
  // Auth middleware for all /v1 routes
  app.addHook('onRequest', async (request, reply) => {
    await proxyAuthMiddleware(request, reply);
  });

  await app.register(chatProxyRoute);
  await app.register(claudeMessagesProxyRoute);
  await app.register(completionsProxyRoute);
  await app.register(responsesProxyRoute);
  await app.register(modelsProxyRoute);
  await app.register(embeddingsProxyRoute);
  await app.register(searchProxyRoute);
  await app.register(filesProxyRoute);
  await app.register(imagesProxyRoute);
  await app.register(videosProxyRoute);
  await app.register(geminiProxyRoute);
}
