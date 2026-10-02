import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { getLivenessReport, getReadinessReport } from '../observability/healthService.js';
import { observabilityRegistry } from '../observability/metrics.js';
import { SERVICE_LEVEL_OBJECTIVES } from '../observability/serviceLevelObjectives.js';
import { getWorkerHealthSnapshot } from '../observability/workerHealth.js';
import { OPERATIONAL_CLASSIFICATION_VOCABULARY } from '../services/operationalFailureContract.js';
import {
  getRetentionPolicies,
  listArchiveManifests,
  previewAllResourceRetention,
  previewResourceRetention,
  RETENTION_RESOURCES,
  runResourceRetention,
  type RetentionResource,
} from '../services/resourceRetentionService.js';
import {
  acknowledgeAlertIncident,
  getAlertIncident,
  listAlertIncidents,
  resolveAlertIncident,
  runAlertEscalationPass,
} from '../services/alertIncidentService.js';

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
  app.get('/api/operations/retention/policies', async () => ({
    resources: getRetentionPolicies(),
  }));
  app.get<{
    Querystring: { resource?: string };
  }>('/api/operations/retention/preview', async (request, reply) => {
    const rawResource = String(request.query.resource || '').trim();
    if (!rawResource) {
      return { previews: await previewAllResourceRetention() };
    }
    if (!(RETENTION_RESOURCES as readonly string[]).includes(rawResource)) {
      return reply.code(400).send({ success: false, message: 'resource 无效' });
    }
    return { previews: [await previewResourceRetention(rawResource as RetentionResource)] };
  });
  app.get<{
    Querystring: { resource?: string; limit?: string };
  }>('/api/operations/retention/manifests', async (request, reply) => {
    const rawResource = String(request.query.resource || '').trim();
    if (rawResource && !(RETENTION_RESOURCES as readonly string[]).includes(rawResource)) {
      return reply.code(400).send({ success: false, message: 'resource 无效' });
    }
    const rawLimit = Number(request.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50;
    return {
      manifests: await listArchiveManifests({
        resource: rawResource ? rawResource as RetentionResource : undefined,
        limit,
      }),
    };
  });
  app.post<{
    Body: { resource?: string; dryRun?: boolean };
  }>('/api/operations/retention/run', async (request, reply) => {
    const rawResource = String(request.body?.resource || '').trim();
    if (!(RETENTION_RESOURCES as readonly string[]).includes(rawResource)) {
      return reply.code(400).send({ success: false, message: 'resource 无效' });
    }
    try {
      return {
        success: true,
        result: await runResourceRetention({
          resource: rawResource as RetentionResource,
          dryRun: request.body?.dryRun === true,
        }),
      };
    } catch (error) {
      return reply.code(409).send({
        success: false,
        message: error instanceof Error ? error.message : String(error || 'retention run failed'),
      });
    }
  });
  app.get<{
    Querystring: { status?: 'open' | 'acknowledged' | 'resolved' | 'suppressed'; limit?: string };
  }>('/api/operations/alerts', async (request) => ({
    incidents: await listAlertIncidents({
      status: request.query.status,
      limit: Number(request.query.limit),
    }),
  }));
  app.get<{ Params: { id: string } }>('/api/operations/alerts/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ success: false, message: 'id 无效' });
    const incident = await getAlertIncident(id);
    if (!incident) return reply.code(404).send({ success: false, message: '告警不存在' });
    return { incident };
  });
  app.post<{ Params: { id: string }; Body: { acknowledgedBy?: string } }>('/api/operations/alerts/:id/acknowledge', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ success: false, message: 'id 无效' });
    const changed = await acknowledgeAlertIncident(id, request.body?.acknowledgedBy || 'admin');
    if (!changed) return reply.code(409).send({ success: false, message: '告警当前状态不支持确认' });
    return { success: true, incident: await getAlertIncident(id) };
  });
  app.post<{ Params: { id: string } }>('/api/operations/alerts/:id/resolve', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ success: false, message: 'id 无效' });
    const changed = await resolveAlertIncident(id);
    if (!changed) return reply.code(409).send({ success: false, message: '告警当前状态不支持恢复' });
    return { success: true, incident: await getAlertIncident(id) };
  });
  app.post('/api/operations/alerts/escalate', async () => ({
    success: true,
    processed: await runAlertEscalationPass(),
  }));
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
