import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getLivenessReport, getReadinessReport } from '../observability/healthService.js';
import { observabilityRegistry } from '../observability/metrics.js';
import { SERVICE_LEVEL_OBJECTIVES } from '../observability/serviceLevelObjectives.js';
import { getWorkerHealthSnapshot } from '../observability/workerHealth.js';
import { OPERATIONAL_CLASSIFICATION_VOCABULARY } from '../services/operationalFailureContract.js';

export async function operationsRoutes(app: FastifyInstance): Promise<void> {
  const live = async () => getLivenessReport();
  const ready = async (_request: unknown, reply: { code(statusCode: number): unknown }) => {
    const report = await getReadinessReport();
    if (report.status !== 'ready') reply.code(503);
    return report;
  };

  app.get('/livez', live);
  app.get('/health/live', live);
  app.get('/readyz', ready);
  app.get('/health/ready', ready);
  app.get('/health/workers', async () => getWorkerHealthSnapshot());
  app.get('/health/slo', async () => SERVICE_LEVEL_OBJECTIVES);
  app.get('/health/vocabulary', async () => OPERATIONAL_CLASSIFICATION_VOCABULARY);
  app.get('/metrics', async (request, reply) => {
    if (config.metricsAuthToken) {
      const authorization = String(request.headers.authorization || '');
      if (authorization !== `Bearer ${config.metricsAuthToken}`) {
        return reply.code(401).send({ error: 'Missing or invalid metrics credentials' });
      }
    }
    reply.header('content-type', observabilityRegistry.contentType);
    return await observabilityRegistry.metrics();
  });
}
