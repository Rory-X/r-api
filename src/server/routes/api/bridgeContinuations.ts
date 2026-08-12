import type { FastifyInstance } from 'fastify';
import {
  createBridgeContinuationTask,
  createManualBridgePromptTask,
  getBridgeContinuationTask,
  listBridgeContinuationEvents,
  listBridgeContinuationTasks,
  stopBridgeContinuationTask,
  supersedeBridgeContinuationTask,
} from '../../services/bridgeContinuationService.js';
import type { BridgeContinuationPolicyInput } from '../../services/bridgeContinuationContract.js';
import type { BridgeContinuationTaskStatus } from '../../services/bridgeContinuationState.js';

const STATUSES = new Set<BridgeContinuationTaskStatus>([
  'waiting',
  'backoff',
  'running',
  'stopped',
  'superseded',
  'dead',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Bridge continuation 操作失败';
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function bridgeContinuationRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { deviceId?: string; sessionKey?: string; status?: string; limit?: string };
  }>('/api/bridge-continuations', async (request, reply) => {
    const status = request.query.status?.trim() as BridgeContinuationTaskStatus | undefined;
    if (status && !STATUSES.has(status)) {
      return reply.code(400).send({ success: false, message: 'Bridge continuation status 无效' });
    }
    try {
      return {
        success: true,
        items: await listBridgeContinuationTasks({
          deviceId: request.query.deviceId,
          sessionKey: request.query.sessionKey,
          status,
          limit: positiveInteger(request.query.limit, 50),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Headers: { 'idempotency-key'?: string };
    Body: {
      contextTaskId?: string;
      deviceId?: string;
      threadId?: string;
      threadStatus?: 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
      activeFlags?: Array<'waitingOnApproval' | 'waitingOnUserInput'>;
      activeTurnId?: string | null;
      prompt?: string;
      submissionMode?: 'auto' | 'steer_current' | 'start_next';
      operatorId?: string;
      idempotencyKey?: string;
    };
  }>('/api/bridge-continuations/manual-prompts', async (request, reply) => {
    try {
      const idempotencyKey = request.headers['idempotency-key'] || request.body?.idempotencyKey || '';
      const result = await createManualBridgePromptTask({
        contextTaskId: request.body?.contextTaskId,
        deviceId: request.body?.deviceId,
        threadId: request.body?.threadId,
        threadStatus: request.body?.threadStatus,
        activeFlags: request.body?.activeFlags,
        activeTurnId: request.body?.activeTurnId,
        prompt: request.body?.prompt,
        submissionMode: request.body?.submissionMode || 'auto',
        source: 'webui',
        operatorId: request.body?.operatorId || 'webui:admin',
        idempotencyKey,
      });
      return reply.code(result.created ? 201 : 200).send({ success: true, ...result });
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { eventLimit?: string };
  }>('/api/bridge-continuations/:id', async (request, reply) => {
    try {
      const task = await getBridgeContinuationTask(request.params.id);
      if (!task) return reply.code(404).send({ success: false, message: 'Bridge continuation task 不存在' });
      return {
        success: true,
        task,
        events: await listBridgeContinuationEvents(
          request.params.id,
          positiveInteger(request.query.eventLimit, 100),
        ),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: {
      sessionKey?: string;
      threadId?: string;
      deviceId?: string;
      policy?: BridgeContinuationPolicyInput;
    };
  }>('/api/bridge-continuations', async (request, reply) => {
    try {
      const result = await createBridgeContinuationTask({
        sessionKey: request.body?.sessionKey || '',
        threadId: request.body?.threadId || '',
        deviceId: request.body?.deviceId,
        policy: request.body?.policy,
      });
      return reply.code(result.created ? 201 : 200).send({ success: true, ...result });
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/bridge-continuations/:id/stop', async (request, reply) => {
    try {
      return { success: true, task: await stopBridgeContinuationTask(request.params.id) };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/bridge-continuations/:id/supersede', async (request, reply) => {
    try {
      return { success: true, task: await supersedeBridgeContinuationTask(request.params.id) };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });
}
