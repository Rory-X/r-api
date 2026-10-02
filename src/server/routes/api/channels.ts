import type { FastifyInstance } from 'fastify';
import {
  getChannelHealthReadModel,
  getChannelsOverview,
} from '../../services/channelsOverviewService.js';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function channelsRoutes(app: FastifyInstance) {
  app.get('/api/channels/overview', async () => getChannelsOverview());
  app.get<{
    Querystring: {
      siteId?: string;
      scope?: string;
      state?: string;
    };
  }>('/api/channels/health', async (request) => {
    const scope = request.query.scope === 'site' || request.query.scope === 'model'
      ? request.query.scope
      : null;
    const state = ['healthy', 'open', 'recovering'].includes(request.query.state || '')
      ? request.query.state as 'healthy' | 'open' | 'recovering'
      : null;
    return await getChannelHealthReadModel({
      siteId: parsePositiveInteger(request.query.siteId),
      scope,
      state,
    });
  });
}
