import type { FastifyInstance } from 'fastify';
import {
  listModelCapabilityMatrix,
  listModelSyncStates,
  type ModelSyncStatePublic,
} from '../../services/modelSyncPolicyService.js';

function parsePositiveId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function parseStatus(value: unknown): ModelSyncStatePublic['status'] | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'active' || normalized === 'candidate_retired'
    ? normalized
    : undefined;
}

function parseMatrixStatus(value: unknown): 'active' | 'candidate_retired' | 'manual_override' | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'active' || normalized === 'candidate_retired' || normalized === 'manual_override'
    ? normalized
    : undefined;
}

export async function modelSyncRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { accountId?: string; status?: string };
  }>('/api/model-sync/states', async (request, reply) => {
    const accountId = parsePositiveId(request.query.accountId);
    const status = parseStatus(request.query.status);
    if (request.query.accountId !== undefined && accountId === undefined) {
      return reply.code(400).send({ success: false, message: 'accountId 无效' });
    }
    if (request.query.status !== undefined && status === undefined) {
      return reply.code(400).send({ success: false, message: 'status 无效' });
    }
    return {
      success: true,
      items: await listModelSyncStates({ accountId, status }),
    };
  });

  app.get<{
    Querystring: { accountId?: string; status?: string };
  }>('/api/model-sync/matrix', async (request, reply) => {
    const accountId = parsePositiveId(request.query.accountId);
    const status = parseMatrixStatus(request.query.status);
    if (request.query.accountId !== undefined && accountId === undefined) {
      return reply.code(400).send({ success: false, message: 'accountId 无效' });
    }
    if (request.query.status !== undefined && status === undefined) {
      return reply.code(400).send({ success: false, message: 'status 无效' });
    }
    return {
      success: true,
      items: await listModelCapabilityMatrix({ accountId, status }),
    };
  });
}
