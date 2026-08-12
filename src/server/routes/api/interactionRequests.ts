import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticateLocalConnectorToken } from '../../services/localConnectorService.js';
import {
  cancelInteractionRequest,
  claimInteractionResponse,
  commitInteractionResponse,
  createInteractionRequest,
  getInteractionRequest,
  listInteractionEvents,
  listInteractionRequests,
  resolveInteractionSource,
} from '../../services/interactionRequestService.js';
import {
  INTERACTION_REQUEST_KINDS,
  type InteractionRequestKind,
  type InteractionRequestStatus,
} from '../../services/interactionRequestState.js';

const INTERACTION_STATUSES = new Set<InteractionRequestStatus>([
  'pending',
  'response_pending',
  'resolved',
  'cancelled',
  'expired',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Interaction 操作失败';
}

function bearerToken(request: FastifyRequest): string {
  const raw = request.headers.authorization;
  return typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '').trim() : '';
}

async function requireConnectorControl(request: FastifyRequest, reply: FastifyReply) {
  const identity = await authenticateLocalConnectorToken(bearerToken(request));
  if (!identity) {
    reply.code(401).send({ success: false, message: 'Connector 令牌无效或设备已撤销' });
    return null;
  }
  if (!identity.device.scopes.includes('app_server.control')) {
    reply.code(403).send({ success: false, message: 'Connector 缺少权限: app_server.control' });
    return null;
  }
  return identity;
}

function parseKind(value: unknown): InteractionRequestKind | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return (INTERACTION_REQUEST_KINDS as readonly string[]).includes(normalized)
    ? normalized as InteractionRequestKind
    : undefined;
}

function parseStatus(value: unknown): InteractionRequestStatus | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return INTERACTION_STATUSES.has(normalized as InteractionRequestStatus)
    ? normalized as InteractionRequestStatus
    : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function responseIdempotencyKey(request: FastifyRequest, bodyValue: unknown): string {
  const header = request.headers['idempotency-key'];
  const value = typeof header === 'string' && header.trim()
    ? header.trim()
    : typeof bodyValue === 'string'
      ? bodyValue.trim()
      : '';
  if (!value) throw new Error('Interaction 响应必须提供 Idempotency-Key');
  return value;
}

function requiredDeliveryId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error('Interaction Connector 回报必须提供稳定 deliveryId');
  return normalized;
}

function connectorErrorStatus(error: unknown): number {
  const message = errorMessage(error);
  if (message.includes('不属于此设备')) return 403;
  if (message.includes('不存在')) return 404;
  return 400;
}

export async function interactionRequestRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      deviceId?: string;
      threadId?: string;
      kind?: string;
      status?: string;
      limit?: string;
    };
  }>('/api/interactions', async (request, reply) => {
    const kind = request.query.kind ? parseKind(request.query.kind) : undefined;
    const status = request.query.status ? parseStatus(request.query.status) : undefined;
    if (request.query.kind && !kind) {
      return reply.code(400).send({ success: false, message: 'Interaction kind 无效' });
    }
    if (request.query.status && !status) {
      return reply.code(400).send({ success: false, message: 'Interaction status 无效' });
    }
    try {
      return {
        success: true,
        items: await listInteractionRequests({
          deviceId: request.query.deviceId,
          threadId: request.query.threadId,
          kind,
          status,
          limit: positiveInteger(request.query.limit, 50),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { eventLimit?: string };
  }>('/api/interactions/:id', async (request, reply) => {
    try {
      const interaction = await getInteractionRequest(request.params.id);
      if (!interaction) return reply.code(404).send({ success: false, message: 'Interaction request 不存在' });
      return {
        success: true,
        interaction,
        events: await listInteractionEvents(
          request.params.id,
          positiveInteger(request.query.eventLimit, 100),
        ),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      responsePayload?: unknown;
      operatorId?: string;
      idempotencyKey?: string;
    };
  }>('/api/interactions/:id/respond', async (request, reply) => {
    try {
      return {
        success: true,
        ...await commitInteractionResponse({
          requestId: request.params.id,
          responsePayload: request.body?.responsePayload,
          source: 'webui',
          operatorId: request.body?.operatorId || 'webui:admin',
          idempotencyKey: responseIdempotencyKey(request, request.body?.idempotencyKey),
        }),
      };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes('不存在') ? 404 : message.includes('已由其他响应占用') ? 409 : 400)
        .send({ success: false, message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { operatorId?: string };
  }>('/api/interactions/:id/cancel', async (request, reply) => {
    try {
      return {
        success: true,
        interaction: await cancelInteractionRequest(
          request.params.id,
          request.body?.operatorId || 'webui:admin',
        ),
      };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes('不存在') ? 404 : 400).send({ success: false, message });
    }
  });

  app.post<{
    Body: {
      connectionId?: string;
      sourceRequestId?: string | number;
      kind?: string;
      method?: string;
      threadId?: string | null;
      turnId?: string | null;
      itemId?: string | null;
      requestPayload?: unknown;
      ttlMs?: number;
    };
  }>('/api/local-connector/public/interactions', async (request, reply) => {
    const identity = await requireConnectorControl(request, reply);
    if (!identity) return;
    const kind = parseKind(request.body?.kind);
    if (!kind) return reply.code(400).send({ success: false, message: 'Interaction kind 无效' });
    try {
      const result = await createInteractionRequest({
        deviceId: identity.device.id,
        connectionId: request.body?.connectionId,
        sourceRequestId: request.body?.sourceRequestId,
        kind,
        method: request.body?.method,
        threadId: request.body?.threadId,
        turnId: request.body?.turnId,
        itemId: request.body?.itemId,
        requestPayload: request.body?.requestPayload,
        ttlMs: request.body?.ttlMs,
      });
      return reply.code(result.created ? 201 : 200).send({ success: true, ...result });
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes('内容冲突') ? 409 : 400).send({ success: false, message });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { deliveryId?: string };
  }>('/api/local-connector/public/interactions/:id/response/claim', async (request, reply) => {
    const identity = await requireConnectorControl(request, reply);
    if (!identity) return;
    try {
      return {
        success: true,
        protocol: 'metapi.interaction-response.v1',
        ...await claimInteractionResponse({
          requestId: request.params.id,
          deviceId: identity.device.id,
          deliveryId: requiredDeliveryId(request.body?.deliveryId),
        }),
      };
    } catch (error) {
      return reply.code(connectorErrorStatus(error)).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { deliveryId?: string };
  }>('/api/local-connector/public/interactions/:id/resolved', async (request, reply) => {
    const identity = await requireConnectorControl(request, reply);
    if (!identity) return;
    try {
      return {
        success: true,
        interaction: await resolveInteractionSource({
          requestId: request.params.id,
          deviceId: identity.device.id,
          deliveryId: requiredDeliveryId(request.body?.deliveryId),
        }),
      };
    } catch (error) {
      return reply.code(connectorErrorStatus(error)).send({ success: false, message: errorMessage(error) });
    }
  });
}
