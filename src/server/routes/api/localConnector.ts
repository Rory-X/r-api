import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LOCAL_CONNECTOR_ACTION_KINDS,
  LOCAL_CONNECTOR_ACTION_OPERATIONS,
  LOCAL_CONNECTOR_SCOPES,
  cancelLocalConnectorAction,
  cancelLocalConnectorPairing,
  claimLocalConnectorPairing,
  claimNextLocalConnectorAction,
  completeLocalConnectorAction,
  createLocalConnectorAction,
  createLocalConnectorPairing,
  authenticateLocalConnectorToken,
  listLocalConnectorActions,
  listLocalConnectorDevices,
  parseLocalConnectorActionStatus,
  recordLocalConnectorEvent,
  revokeLocalConnectorDevice,
  type LocalConnectorActionKind,
  type LocalConnectorActionOperation,
  type LocalConnectorEventKind,
  type LocalConnectorScope,
  updateLocalConnectorRuntimeMetadata,
} from '../../services/localConnectorService.js';
import {
  claimNextBridgeContinuationTask,
  completeBridgeContinuationDispatch,
  recordBridgeContinuationAppServerEvent,
  renewBridgeContinuationTaskLease,
} from '../../services/bridgeContinuationService.js';
import {
  listLocalConnectorThreads,
  syncLocalConnectorThreadSnapshots,
} from '../../services/localConnectorThreadService.js';
import { takeOverLocalConnectorThread } from '../../services/localConnectorControlPlaneService.js';
import { isGlobalBridgeContinuationConflict } from '../../services/globalBridgeContinuationConfigService.js';
import { getLocalConnectorThreadActivity } from '../../services/localConnectorThreadActivityService.js';
import type { BridgeContinuationPolicyInput } from '../../services/bridgeContinuationContract.js';
import { normalizeBridgeAppServerEventWire } from '../../local-connector/protocol.js';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Local Connector 操作失败';
}

function bearerToken(request: FastifyRequest): string {
  const raw = request.headers.authorization;
  if (typeof raw !== 'string') return '';
  return raw.replace(/^Bearer\s+/i, '').trim();
}

async function requireConnectorIdentity(request: FastifyRequest, reply: any) {
  const identity = await authenticateLocalConnectorToken(bearerToken(request));
  if (!identity) {
    reply.code(401).send({ success: false, message: 'Connector 令牌无效或设备已撤销' });
    return null;
  }
  return identity;
}

function requireConnectorScope(
  identity: Awaited<ReturnType<typeof authenticateLocalConnectorToken>>,
  scope: LocalConnectorScope,
  reply: any,
): boolean {
  if (identity?.device.scopes.includes(scope)) return true;
  reply.code(403).send({ success: false, message: `Connector 缺少权限: ${scope}` });
  return false;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.trunc(number);
}

function parseScopeList(value: unknown): LocalConnectorScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(LOCAL_CONNECTOR_SCOPES);
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item): item is LocalConnectorScope => allowed.has(item)))];
}

function parseActionKind(value: unknown): LocalConnectorActionKind | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (LOCAL_CONNECTOR_ACTION_KINDS as readonly string[]).includes(normalized)
    ? normalized as LocalConnectorActionKind
    : null;
}

function parseActionOperation(value: unknown): LocalConnectorActionOperation | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (LOCAL_CONNECTOR_ACTION_OPERATIONS as readonly string[]).includes(normalized)
    ? normalized as LocalConnectorActionOperation
    : null;
}

export async function localConnectorRoutes(app: FastifyInstance) {
  app.get('/api/local-connector/devices', async () => ({
    items: await listLocalConnectorDevices(),
  }));

  app.get<{
    Querystring: { deviceId?: string; limit?: string };
  }>('/api/local-connector/threads', async (request, reply) => {
    try {
      return {
        success: true,
        items: await listLocalConnectorThreads({
          deviceId: request.query.deviceId,
          limit: request.query.limit,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { deviceId: string; threadId: string };
    Body: { policy?: BridgeContinuationPolicyInput };
  }>('/api/local-connector/devices/:deviceId/sessions/:threadId/takeover', async (request, reply) => {
    try {
      const result = await takeOverLocalConnectorThread({
        deviceId: request.params.deviceId,
        threadId: request.params.threadId,
        policy: request.body?.policy,
      });
      return reply.code(result.created ? 201 : 200).send({ success: true, ...result });
    } catch (error) {
      const message = errorMessage(error);
      const statusCode = isGlobalBridgeContinuationConflict(error)
        ? 409
        : message.includes('不属于')
          ? 404
          : 400;
      return reply.code(statusCode).send({ success: false, message });
    }
  });

  app.get<{
    Params: { deviceId: string; threadId: string };
    Querystring: { limit?: string };
  }>('/api/local-connector/devices/:deviceId/sessions/:threadId/activity', async (request, reply) => {
    try {
      const activity = await getLocalConnectorThreadActivity({
        deviceId: request.params.deviceId,
        threadId: request.params.threadId,
        limit: request.query.limit,
      });
      if (!activity) return reply.code(404).send({ success: false, message: 'Codex 会话不存在' });
      return { success: true, ...activity };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: { deviceName?: string; scopes?: unknown; ttlSec?: number };
  }>('/api/local-connector/pairings', async (request, reply) => {
    try {
      const scopes = parseScopeList(request.body?.scopes);
      return {
        success: true,
        claimPath: '/api/local-connector/public/pairings/claim',
        ...await createLocalConnectorPairing({
          deviceName: request.body?.deviceName || '',
          scopes,
          ttlSec: parsePositiveInteger(request.body?.ttlSec),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/local-connector/pairings/:id/cancel', async (request, reply) => {
    try {
      const cancelled = await cancelLocalConnectorPairing(request.params.id);
      if (!cancelled) return reply.code(404).send({ success: false, message: '配对不存在或已结束' });
      return { success: true };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/local-connector/devices/:id/revoke', async (request, reply) => {
    try {
      const revoked = await revokeLocalConnectorDevice(request.params.id);
      if (!revoked) return reply.code(404).send({ success: false, message: '设备不存在或已撤销' });
      return { success: true };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Querystring: { deviceId?: string; status?: string };
  }>('/api/local-connector/actions', async (request, reply) => {
    const status = request.query.status ? parseLocalConnectorActionStatus(request.query.status) : undefined;
    if (request.query.status && !status) return reply.code(400).send({ success: false, message: '动作 status 无效' });
    return {
      items: await listLocalConnectorActions({ deviceId: request.query.deviceId, status }),
    };
  });

  app.post<{
    Body: {
      deviceId?: string;
      kind?: string;
      operation?: string;
      agent?: 'codex' | 'claude_code';
      backupRef?: string | null;
      eventNames?: string[];
      ttlSec?: number;
    };
  }>('/api/local-connector/actions', async (request, reply) => {
    const kind = parseActionKind(request.body?.kind);
    const operation = parseActionOperation(request.body?.operation);
    if (!kind) return reply.code(400).send({ success: false, message: '动作 kind 无效' });
    if (!operation) return reply.code(400).send({ success: false, message: '动作 operation 无效' });
    try {
      return {
        success: true,
        action: await createLocalConnectorAction({
          deviceId: request.body?.deviceId || '',
          kind,
          operation,
          agent: request.body?.agent,
          backupRef: request.body?.backupRef,
          eventNames: request.body?.eventNames,
          ttlSec: parsePositiveInteger(request.body?.ttlSec),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/local-connector/actions/:id/cancel', async (request, reply) => {
    try {
      const cancelled = await cancelLocalConnectorAction(request.params.id);
      if (!cancelled) return reply.code(404).send({ success: false, message: '动作不存在或已结束' });
      return { success: true };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  // Public device protocol. These routes are explicitly protected by the Connector token,
  // not by the administrator Bearer middleware.
  app.post<{
    Body: { pairingId?: string; pairingToken?: string; platform?: string; version?: string; capabilities?: string[] };
  }>('/api/local-connector/public/pairings/claim', async (request, reply) => {
    try {
      return {
        success: true,
        ...await claimLocalConnectorPairing({
          pairingId: request.body?.pairingId || '',
          pairingToken: request.body?.pairingToken || '',
          platform: request.body?.platform || '',
          version: request.body?.version,
          capabilities: request.body?.capabilities,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: { version?: unknown; capabilities?: unknown; health?: unknown };
  }>('/api/local-connector/public/heartbeat', async (request, reply) => {
    const authenticated = await requireConnectorIdentity(request, reply);
    if (!authenticated) return;
    try {
      const identity = await updateLocalConnectorRuntimeMetadata(authenticated, request.body || {});
      return { success: true, device: identity.device, serverTime: new Date().toISOString() };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: { source?: string; threads?: unknown };
  }>('/api/local-connector/public/threads/snapshot', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity) return;
    const requiredScope = request.body?.source === 'connector_app_server'
      ? 'app_server.control'
      : 'app_server.observe';
    if (!requireConnectorScope(identity, requiredScope, reply)) return;
    try {
      return {
        success: true,
        ...await syncLocalConnectorThreadSnapshots({
          deviceId: identity.device.id,
          source: request.body?.source,
          threads: request.body?.threads,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get('/api/local-connector/public/commands/next', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity) return;
    try {
      const action = await claimNextLocalConnectorAction(identity);
      return { success: true, action };
    } catch (error) {
      return reply.code(403).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { status?: string; result?: Record<string, unknown> | null; backupRef?: string | null; errorMessage?: string | null };
  }>('/api/local-connector/public/commands/:id/result', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity) return;
    const status = request.body?.status === 'succeeded' || request.body?.status === 'failed'
      ? request.body.status
      : null;
    if (!status) return reply.code(400).send({ success: false, message: '动作结果 status 必须是 succeeded 或 failed' });
    try {
      return {
        success: true,
        ...await completeLocalConnectorAction({
          identity,
          actionId: request.params.id,
          status,
          result: request.body?.result,
          backupRef: request.body?.backupRef,
          errorMessage: request.body?.errorMessage,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get('/api/local-connector/public/bridge/commands/next', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity || !requireConnectorScope(identity, 'app_server.control', reply)) return;
    const claim = await claimNextBridgeContinuationTask({
      deviceId: identity.device.id,
      ownerId: `connector:${identity.device.id}`,
    });
    if (!claim) return { success: true, command: null };
    return {
      success: true,
      command: {
        protocol: 'metapi.bridge-continuation.command.v1',
        taskId: claim.task.state.taskId,
        leaseToken: claim.leaseToken,
        leaseExpiresAt: claim.leaseExpiresAt,
        ...claim.command,
      },
    };
  });

  app.post<{
    Params: { id: string };
    Body: { leaseToken?: string };
  }>('/api/local-connector/public/bridge/commands/:id/heartbeat', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity || !requireConnectorScope(identity, 'app_server.control', reply)) return;
    try {
      const result = await renewBridgeContinuationTaskLease({
        taskId: request.params.id,
        leaseToken: request.body?.leaseToken || '',
        deviceId: identity.device.id,
      });
      if (!result.renewed) return reply.code(409).send({ success: false, message: 'Bridge Lease 已失效' });
      return { success: true, ...result };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      deliveryId?: string;
      leaseToken?: string;
      outcome?: string;
      turnId?: string | null;
      failure?: Record<string, unknown> | null;
    };
  }>('/api/local-connector/public/bridge/commands/:id/result', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity || !requireConnectorScope(identity, 'app_server.control', reply)) return;
    const outcome = request.body?.outcome;
    if (outcome !== 'queued' && outcome !== 'accepted' && outcome !== 'rejected' && outcome !== 'unknown') {
      return reply.code(400).send({ success: false, message: 'Bridge 结果 outcome 无效' });
    }
    try {
      const result = await completeBridgeContinuationDispatch({
        taskId: request.params.id,
        deliveryId: request.body?.deliveryId,
        leaseToken: request.body?.leaseToken || '',
        deviceId: identity.device.id,
        outcome,
        turnId: request.body?.turnId,
        failure: request.body?.failure || undefined,
      });
      if (!result.updated) {
        return reply.code(409).send({ success: false, message: 'Bridge Lease 已失效或结果已被调和', ...result });
      }
      return { success: true, ...result };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { deliveryId?: string; event?: unknown };
  }>('/api/local-connector/public/bridge/commands/:id/events', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity || !requireConnectorScope(identity, 'app_server.control', reply)) return;
    const event = normalizeBridgeAppServerEventWire(request.body?.event);
    if (!event) return reply.code(400).send({ success: false, message: 'App Server Bridge 事件无效' });
    try {
      return {
        success: true,
        task: await recordBridgeContinuationAppServerEvent({
          taskId: request.params.id,
          deliveryId: request.body?.deliveryId,
          deviceId: identity.device.id,
          event,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: { deliveryId?: string; event?: unknown };
  }>('/api/local-connector/public/bridge/events', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity || !requireConnectorScope(identity, 'app_server.control', reply)) return;
    const event = normalizeBridgeAppServerEventWire(request.body?.event);
    if (!event) return reply.code(400).send({ success: false, message: 'App Server Bridge 事件无效' });
    try {
      return {
        success: true,
        task: await recordBridgeContinuationAppServerEvent({
          deliveryId: request.body?.deliveryId,
          deviceId: identity.device.id,
          event,
        }),
      };
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('No active bridge continuation task')) {
        return reply.code(202).send({ success: true, ignored: true });
      }
      return reply.code(400).send({ success: false, message });
    }
  });

  app.post<{
    Body: {
      kind?: string;
      title?: string;
      message?: string;
      level?: 'info' | 'warning' | 'error';
      idempotencyKey?: string;
    };
  }>('/api/local-connector/public/events', async (request, reply) => {
    const identity = await requireConnectorIdentity(request, reply);
    if (!identity) return;
    const kind = request.body?.kind as LocalConnectorEventKind;
    if (!['hook', 'notify', 'app_server', 'browser_recovery'].includes(kind)) {
      return reply.code(400).send({ success: false, message: '事件 kind 无效' });
    }
    try {
      return {
        success: true,
        ...await recordLocalConnectorEvent({
          identity,
          kind,
          title: request.body?.title || '',
          message: request.body?.message || '',
          level: request.body?.level,
          idempotencyKey: request.body?.idempotencyKey,
        }),
      };
    } catch (error) {
      return reply.code(403).send({ success: false, message: errorMessage(error) });
    }
  });
}
