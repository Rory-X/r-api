import type { FastifyInstance } from 'fastify';
import {
  cancelFeishuBridgePromptCard,
  createFeishuBridgePromptCard,
  createFeishuInteractionAdapter,
  FeishuCallbackUserError,
  getFeishuInteractionAdapter,
  handleFeishuInteractionCallback,
  listFeishuInteractionAdapters,
  listFeishuInteractionDispatches,
  listFeishuBridgePromptCards,
  retryFeishuCardUpdate,
  retryFeishuInteractionDispatch,
  runFeishuInteractionDispatchPass,
  updateFeishuInteractionAdapter,
  type FeishuReceiveIdType,
} from '../../services/feishuInteractionAdapterService.js';
import {
  listFeishuLongConnectionSnapshots,
  requestFeishuLongConnectionRefresh,
} from '../../services/feishuLongConnectionService.js';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Interaction Adapter 操作失败';
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function interactionAdapterRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { deviceId?: string };
  }>('/api/interaction-adapters', async (request, reply) => {
    try {
      return {
        success: true,
        items: await listFeishuInteractionAdapters({ deviceId: request.query.deviceId }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get('/api/interaction-adapters/connections', async () => ({
    success: true,
    items: listFeishuLongConnectionSnapshots(),
  }));

  app.get<{ Params: { id: string } }>('/api/interaction-adapters/:id', async (request, reply) => {
    try {
      const adapter = await getFeishuInteractionAdapter(request.params.id);
      if (!adapter) return reply.code(404).send({ success: false, message: 'Interaction Adapter 不存在' });
      return { success: true, adapter };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Body: {
      deviceId?: string;
      name?: string;
      enabled?: boolean;
      appId?: string;
      appSecret?: string;
      verificationToken?: string;
      encryptKey?: string;
      apiBaseUrl?: string;
      receiveIdType?: FeishuReceiveIdType;
      receiveId?: string;
      consoleBaseUrl?: string | null;
      operatorAllowlist?: string[];
    };
  }>('/api/interaction-adapters/feishu', async (request, reply) => {
    try {
      const adapter = await createFeishuInteractionAdapter({
        deviceId: request.body?.deviceId,
        name: request.body?.name,
        enabled: request.body?.enabled,
        appId: request.body?.appId,
        appSecret: request.body?.appSecret,
        verificationToken: request.body?.verificationToken,
        encryptKey: request.body?.encryptKey,
        apiBaseUrl: request.body?.apiBaseUrl,
        receiveIdType: request.body?.receiveIdType,
        receiveId: request.body?.receiveId,
        consoleBaseUrl: request.body?.consoleBaseUrl,
        operatorAllowlist: request.body?.operatorAllowlist,
      });
      requestFeishuLongConnectionRefresh();
      return reply.code(201).send({ success: true, adapter });
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.put<{
    Params: { id: string };
    Body: {
      deviceId?: string;
      name?: string;
      enabled?: boolean;
      appId?: string;
      appSecret?: string;
      verificationToken?: string;
      encryptKey?: string;
      apiBaseUrl?: string;
      receiveIdType?: FeishuReceiveIdType;
      receiveId?: string;
      consoleBaseUrl?: string | null;
      operatorAllowlist?: string[];
    };
  }>('/api/interaction-adapters/feishu/:id', async (request, reply) => {
    try {
      const adapter = await updateFeishuInteractionAdapter(request.params.id, request.body || {});
      requestFeishuLongConnectionRefresh();
      return {
        success: true,
        adapter,
      };
    } catch (error) {
      const message = errorMessage(error);
      return reply.code(message.includes('不存在') ? 404 : 400).send({ success: false, message });
    }
  });

  app.get<{
    Querystring: {
      adapterId?: string;
      interactionId?: string;
      promptCardId?: string;
      subjectKind?: string;
      limit?: string;
    };
  }>('/api/interaction-adapters/dispatches', async (request, reply) => {
    try {
      return {
        success: true,
        items: await listFeishuInteractionDispatches({
          adapterId: request.query.adapterId,
          interactionId: request.query.interactionId,
          promptCardId: request.query.promptCardId,
          subjectKind: request.query.subjectKind,
          limit: positiveInteger(request.query.limit, 50),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{
    Params: { id: string };
    Body: {
      contextTaskId?: string;
      deviceId?: string;
      threadId?: string;
      ttlMs?: number;
      requestedBy?: string;
      idempotencyKey?: string;
    };
  }>('/api/interaction-adapters/feishu/:id/prompt-cards', async (request, reply) => {
    try {
      const result = await createFeishuBridgePromptCard({
        adapterId: request.params.id,
        contextTaskId: request.body?.contextTaskId,
        deviceId: request.body?.deviceId,
        threadId: request.body?.threadId,
        ttlMs: request.body?.ttlMs,
        requestedBy: request.body?.requestedBy,
        idempotencyKey: request.body?.idempotencyKey,
      });
      return reply.code(result.created ? 201 : 200).send({ success: true, ...result });
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.get<{
    Querystring: { adapterId?: string; status?: string; limit?: string };
  }>('/api/interaction-adapters/prompt-cards', async (request, reply) => {
    try {
      return {
        success: true,
        items: await listFeishuBridgePromptCards({
          adapterId: request.query.adapterId,
          status: request.query.status,
          limit: positiveInteger(request.query.limit, 50),
        }),
      };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/interaction-adapters/prompt-cards/:id/cancel',
    async (request, reply) => {
      try {
        const card = await cancelFeishuBridgePromptCard(request.params.id);
        if (!card) return reply.code(404).send({ success: false, message: 'Prompt 卡片不存在' });
        return { success: true, card };
      } catch (error) {
        return reply.code(400).send({ success: false, message: errorMessage(error) });
      }
    },
  );

  app.post('/api/interaction-adapters/dispatch/run', async (request, reply) => {
    try {
      return { success: true, result: await runFeishuInteractionDispatchPass() };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/interaction-adapters/dispatches/:id/retry', async (request, reply) => {
    try {
      const queued = await retryFeishuInteractionDispatch(request.params.id);
      if (!queued) return reply.code(404).send({ success: false, message: '投递不存在或当前状态不可重试' });
      return { success: true };
    } catch (error) {
      return reply.code(400).send({ success: false, message: errorMessage(error) });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/interaction-adapters/card-updates/:id/retry',
    async (request, reply) => {
      try {
        const queued = await retryFeishuCardUpdate(request.params.id);
        if (!queued) {
          return reply.code(404).send({
            success: false,
            message: '卡片更新不存在、已过期、已被新状态替代或当前状态不可重试',
          });
        }
        return { success: true };
      } catch (error) {
        return reply.code(400).send({ success: false, message: errorMessage(error) });
      }
    },
  );

  await app.register(async (callbackApp) => {
    callbackApp.removeContentTypeParser('application/json');
    callbackApp.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          const rawBody = typeof body === 'string' ? body : body.toString('utf8');
          done(null, {
            rawBody,
            parsedBody: JSON.parse(rawBody),
          });
        } catch (error) {
          done(error as Error, undefined);
        }
      },
    );
    callbackApp.post<{
      Params: { id: string };
      Body: { rawBody: string; parsedBody: unknown };
    }>('/api/interaction-adapters/public/feishu/:id/callback', async (request, reply) => {
      try {
        return await handleFeishuInteractionCallback(
          request.params.id,
          request.body?.parsedBody,
          new Date(),
          {
            rawBody: request.body?.rawBody,
            timestamp: request.headers['x-lark-request-timestamp'],
            nonce: request.headers['x-lark-request-nonce'],
            signature: request.headers['x-lark-signature'],
          },
        );
      } catch (error) {
        const message = errorMessage(error);
        const parsedBody = request.body?.parsedBody;
        const bodyRecord = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
          ? parsedBody as Record<string, unknown>
          : null;
        request.log.warn({
          adapterId: request.params.id,
          error: message,
          callbackShape: {
            bodyKeys: bodyRecord ? Object.keys(bodyRecord).slice(0, 20) : [],
            type: typeof bodyRecord?.type === 'string' ? bodyRecord.type : null,
            hasChallenge: typeof bodyRecord?.challenge === 'string',
            hasEncrypt: typeof bodyRecord?.encrypt === 'string',
            hasTimestampHeader: Boolean(request.headers['x-lark-request-timestamp']),
            hasNonceHeader: Boolean(request.headers['x-lark-request-nonce']),
            hasSignatureHeader: Boolean(request.headers['x-lark-signature']),
          },
        }, 'Feishu callback rejected');
        if (error instanceof FeishuCallbackUserError) {
          return reply.code(200).send({ toast: { type: 'error', content: message } });
        }
        const status = message.includes('Verification Token') || message.includes('签名') ? 401 : 400;
        return reply.code(status).send({ success: false, message });
      }
    });
  });
}
