import { randomUUID } from 'node:crypto';
import type {
  AppServerRequestMetadata,
  NormalizedAppServerControlEvent,
  ServerRequestResponder,
} from './appServerControl.js';
import {
  LocalConnectorHttpError,
  retryDelayForConnectorError,
  type ConnectorInteractionStatus,
  type LocalConnectorClient,
} from './client.js';

export const APP_SERVER_INTERACTION_METHODS = Object.freeze({
  'item/commandExecution/requestApproval': 'command_approval',
  'item/fileChange/requestApproval': 'file_change_approval',
  'item/permissions/requestApproval': 'permissions_approval',
  'item/tool/requestUserInput': 'user_input',
  'tool/requestUserInput': 'user_input',
  'mcpServer/elicitation/request': 'mcp_elicitation',
} as const);

export type AppServerInteractionKind = typeof APP_SERVER_INTERACTION_METHODS[keyof typeof APP_SERVER_INTERACTION_METHODS];

type InteractionClient = Pick<
  LocalConnectorClient,
  'createInteractionRequest' | 'claimInteractionResponse' | 'resolveInteractionRequest'
>;

type PendingInteraction = {
  key: string;
  sourceRequestId: string;
  responder: ServerRequestResponder;
  responseDeliveryId: string;
  resolvedDeliveryId: string;
  interactionId: string | null;
  expiresAtMs: number | null;
  responseSent: boolean;
  sourceResolved: boolean;
  method: string;
  kind: AppServerInteractionKind;
  threadId: string | null;
  turnId: string | null;
  updatedAtMs: number;
};

export type AppServerInteractionBridgeSnapshot = Readonly<{
  sourceRequestId: string;
  interactionId: string | null;
  method: string;
  kind: AppServerInteractionKind;
  threadId: string | null;
  turnId: string | null;
  status: 'publishing' | 'waiting' | 'responding' | 'resolved';
  expiresAt: string | null;
  updatedAt: string;
}>;

const DEFAULT_REQUEST_TTL_MS = 15 * 60_000;
const MAX_REQUEST_TTL_MS = 24 * 60 * 60_000;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const done = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timeout);
      done();
    };
    timeout = setTimeout(done, ms);
    timeout.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sourceRequestId(value: string | number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return typeof value === 'string' ? value.trim() : '';
}

function retryable(error: unknown): boolean {
  if (!(error instanceof LocalConnectorHttpError)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

function terminal(status: ConnectorInteractionStatus): boolean {
  return status === 'resolved' || status === 'cancelled' || status === 'expired';
}

function requestTtlMs(request: AppServerRequestMetadata): number {
  const autoResolutionMs = Math.trunc(Number(request.params.autoResolutionMs));
  if (!Number.isFinite(autoResolutionMs) || autoResolutionMs <= 0) return DEFAULT_REQUEST_TTL_MS;
  return Math.min(MAX_REQUEST_TTL_MS, Math.max(1_000, autoResolutionMs + 30_000));
}

export function interactionKindForAppServerMethod(method: string): AppServerInteractionKind | null {
  return APP_SERVER_INTERACTION_METHODS[method as keyof typeof APP_SERVER_INTERACTION_METHODS] || null;
}

export class AppServerInteractionBridge {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly client: InteractionClient,
    readonly connectionId: string = `app-server:${randomUUID()}`,
    private readonly pollIntervalMs = 2_000,
  ) {}

  handleRequest(request: AppServerRequestMetadata, responder: ServerRequestResponder): Promise<void> {
    const task = this.runRequest(request, responder).finally(() => {
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    return task;
  }

  handleNotification(event: NormalizedAppServerControlEvent): boolean {
    if (event.kind !== 'server_request_resolved') return false;
    const pending = this.pending.get(this.pendingKey(event.sourceRequestId));
    if (pending) {
      pending.sourceResolved = true;
      pending.updatedAtMs = Date.now();
    }
    return true;
  }

  snapshot(): readonly AppServerInteractionBridgeSnapshot[] {
    return Object.freeze([...this.pending.values()].map((pending) => Object.freeze({
      sourceRequestId: pending.sourceRequestId,
      interactionId: pending.interactionId,
      method: pending.method,
      kind: pending.kind,
      threadId: pending.threadId,
      turnId: pending.turnId,
      status: pending.sourceResolved
        ? 'resolved'
        : pending.responseSent
          ? 'responding'
          : pending.interactionId
            ? 'waiting'
            : 'publishing',
      expiresAt: pending.expiresAtMs === null ? null : new Date(pending.expiresAtMs).toISOString(),
      updatedAt: new Date(pending.updatedAtMs).toISOString(),
    })));
  }

  private pendingKey(requestId: string): string {
    return `${this.connectionId}\0${requestId}`;
  }

  private async runRequest(request: AppServerRequestMetadata, responder: ServerRequestResponder): Promise<void> {
    if (this.closed) {
      responder.reject(new Error('Metapi Interaction Bridge 已关闭'));
      return;
    }
    const kind = interactionKindForAppServerMethod(request.method);
    if (!kind) {
      responder.reject(new Error(`Metapi 不支持 App Server 请求: ${request.method}`));
      return;
    }
    const normalizedSourceRequestId = sourceRequestId(request.requestId);
    if (!normalizedSourceRequestId) {
      responder.reject(new Error('App Server Request ID 无效'));
      return;
    }
    const key = this.pendingKey(normalizedSourceRequestId);
    if (this.pending.has(key)) {
      responder.reject(new Error('App Server Request ID 在同一连接中重复'));
      return;
    }
    const pending: PendingInteraction = {
      key,
      sourceRequestId: normalizedSourceRequestId,
      responder,
      responseDeliveryId: `interaction-response:${randomUUID()}`,
      resolvedDeliveryId: `interaction-resolved:${randomUUID()}`,
      interactionId: null,
      expiresAtMs: null,
      responseSent: false,
      sourceResolved: false,
      method: request.method,
      kind,
      threadId: request.threadId,
      turnId: request.turnId,
      updatedAtMs: Date.now(),
    };
    this.pending.set(key, pending);
    let consecutiveFailures = 0;

    try {
      while (!this.controller.signal.aborted) {
        if (pending.sourceResolved && !pending.interactionId) return;
        try {
          if (!pending.interactionId) {
            const created = await this.client.createInteractionRequest({
              connectionId: this.connectionId,
              sourceRequestId: request.requestId,
              kind,
              method: request.method,
              threadId: request.threadId,
              turnId: request.turnId,
              itemId: request.itemId,
              requestPayload: request.params,
              ttlMs: requestTtlMs(request),
            });
            pending.interactionId = created.interaction.requestId;
            pending.expiresAtMs = created.interaction.expiresAtMs;
            pending.updatedAtMs = Date.now();
          }

          if (pending.sourceResolved) {
            await this.client.resolveInteractionRequest({
              requestId: pending.interactionId,
              deliveryId: pending.resolvedDeliveryId,
            });
            return;
          }

          if (!pending.responseSent) {
            const claimed = await this.client.claimInteractionResponse({
              requestId: pending.interactionId,
              deliveryId: pending.responseDeliveryId,
            });
            pending.expiresAtMs = claimed.interaction.expiresAtMs;
            if (claimed.ready && claimed.responsePayload) {
              if (!pending.sourceResolved) {
                responder.respond(claimed.responsePayload);
                pending.responseSent = true;
                pending.updatedAtMs = Date.now();
              }
            } else if (terminal(claimed.interaction.status)) {
              responder.reject(new Error(`Interaction 已结束: ${claimed.interaction.status}`));
              return;
            }
          }

          consecutiveFailures = 0;
          if (!pending.responseSent && pending.expiresAtMs !== null && Date.now() >= pending.expiresAtMs) {
            responder.reject(new Error('Interaction 已过期'));
            return;
          }
          await wait(Math.max(250, this.pollIntervalMs), this.controller.signal);
        } catch (error) {
          if (!retryable(error)) {
            responder.reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          consecutiveFailures += 1;
          const fallback = Math.min(30_000, 1_000 * (2 ** Math.min(consecutiveFailures - 1, 5)));
          await wait(retryDelayForConnectorError(error, fallback), this.controller.signal);
        }
      }
    } finally {
      this.pending.delete(key);
      if (this.controller.signal.aborted && !pending.responseSent && !pending.sourceResolved) {
        responder.reject(new Error('Metapi Interaction Bridge 已停止'));
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    await Promise.allSettled([...this.tasks]);
    this.pending.clear();
  }
}
