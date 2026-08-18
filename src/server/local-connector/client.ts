import {
  isBridgeContinuationCommandWire,
  isLocalConnectorActionManifest,
  type BridgeAppServerEventWire,
  type BridgeContinuationCommandWire,
  type LocalConnectorActionWire,
  type LocalConnectorEventKind,
  type LocalConnectorHealthReportWire,
  type LocalConnectorThreadSnapshotSource,
  type LocalConnectorThreadSnapshotWire,
} from './protocol.js';
import { normalizeConnectorServerUrl } from './config.js';

const MAX_RESPONSE_BYTES = 512 * 1024;

export class LocalConnectorHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'LocalConnectorHttpError';
  }
}

function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5 * 60_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.min(date - nowMs, 5 * 60_000));
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const message = (body as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 2_000);
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export type ConnectorInteractionStatus =
  | 'pending'
  | 'response_pending'
  | 'resolved'
  | 'cancelled'
  | 'expired';

export type ConnectorInteractionSnapshot = Readonly<{
  requestId: string;
  status: ConnectorInteractionStatus;
  expiresAtMs: number;
}>;

function parseInteractionSnapshot(value: unknown): ConnectorInteractionSnapshot {
  if (!isRecord(value) || !isRecord(value.state)) throw new Error('Interaction 响应格式无效');
  const requestId = typeof value.state.requestId === 'string' ? value.state.requestId.trim() : '';
  const status = value.state.status;
  const expiresAtMs = Math.trunc(Number(value.state.expiresAtMs));
  if (!requestId
    || (status !== 'pending'
      && status !== 'response_pending'
      && status !== 'resolved'
      && status !== 'cancelled'
      && status !== 'expired')
    || !Number.isFinite(expiresAtMs)) {
    throw new Error('Interaction 响应状态无效');
  }
  return Object.freeze({ requestId, status, expiresAtMs });
}

export class LocalConnectorClient {
  private readonly serverUrl: string;

  constructor(
    serverUrl: string,
    private readonly connectorToken?: string | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.serverUrl = normalizeConnectorServerUrl(serverUrl);
  }

  private endpoint(path: string): URL {
    const base = this.serverUrl.endsWith('/') ? this.serverUrl : `${this.serverUrl}/`;
    return new URL(path.replace(/^\/+/, ''), base);
  }

  private async request(path: string, options: {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    authenticated?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('Connector 请求超时')), options.timeoutMs ?? this.timeoutMs);
    timeout.unref?.();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body) headers['content-type'] = 'application/json';
    if (options.authenticated !== false) {
      if (!this.connectorToken) throw new Error('Connector 设备令牌缺失');
      headers.authorization = `Bearer ${this.connectorToken}`;
    }
    try {
      const response = await this.fetchImpl(this.endpoint(path), {
        method: options.method || (options.body ? 'POST' : 'GET'),
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error('Connector 服务器响应过大');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Connector 服务器响应过大');
      let body: unknown = {};
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error('Connector 服务器返回了无效 JSON');
        }
      }
      if (!response.ok) {
        throw new LocalConnectorHttpError(
          errorMessageFromBody(body, `Connector 服务器返回 HTTP ${response.status}`),
          response.status,
          parseRetryAfter(response.headers.get('retry-after')),
        );
      }
      if (!isRecord(body)) throw new Error('Connector 服务器响应格式无效');
      return body;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async claimPairing(input: {
    pairingId: string;
    pairingToken: string;
    platform: string;
    version: string;
    capabilities: string[];
  }): Promise<{ deviceId: string; connectorToken: string; device: Record<string, unknown> }> {
    const body = await this.request('/api/local-connector/public/pairings/claim', {
      method: 'POST',
      authenticated: false,
      body: input,
    });
    if (!isRecord(body.device) || typeof body.device.id !== 'string' || typeof body.connectorToken !== 'string') {
      throw new Error('Connector 配对响应格式无效');
    }
    return { deviceId: body.device.id, connectorToken: body.connectorToken, device: body.device };
  }

  async heartbeat(input: Readonly<{
    version?: string;
    capabilities?: readonly string[];
    health?: readonly LocalConnectorHealthReportWire[];
    signal?: AbortSignal;
  }> = {}): Promise<Record<string, unknown>> {
    const version = input.version?.trim() || undefined;
    const capabilities = input.capabilities ? [...input.capabilities] : undefined;
    const health = input.health ? [...input.health] : undefined;
    return this.request('/api/local-connector/public/heartbeat', {
      method: 'POST',
      signal: input.signal,
      ...(version || capabilities || health ? {
        body: {
          ...(version ? { version } : {}),
          ...(capabilities ? { capabilities } : {}),
          ...(health ? { health } : {}),
        },
      } : {}),
    });
  }

  async claimNextAction(signal?: AbortSignal): Promise<LocalConnectorActionWire | null> {
    const body = await this.request('/api/local-connector/public/commands/next', { signal });
    if (body.action === null || body.action === undefined) return null;
    if (!isRecord(body.action) || typeof body.action.id !== 'string'
      || typeof body.action.deviceId !== 'string'
      || typeof body.action.expiresAt !== 'string'
      || !isLocalConnectorActionManifest(body.action.manifest)) {
      throw new Error('Connector 动作响应格式无效');
    }
    return body.action as LocalConnectorActionWire;
  }

  async completeAction(input: {
    actionId: string;
    status: 'succeeded' | 'failed';
    result: Record<string, unknown> | null;
    backupRef: string | null;
    errorMessage: string | null;
  }): Promise<void> {
    await this.request(`/api/local-connector/public/commands/${encodeURIComponent(input.actionId)}/result`, {
      method: 'POST',
      body: {
        status: input.status,
        result: input.result,
        backupRef: input.backupRef,
        errorMessage: input.errorMessage,
      },
    });
  }

  async claimNextBridgeContinuation(signal?: AbortSignal): Promise<BridgeContinuationCommandWire | null> {
    const body = await this.request('/api/local-connector/public/bridge/commands/next', { signal });
    if (body.command === null || body.command === undefined) return null;
    if (!isBridgeContinuationCommandWire(body.command)) {
      throw new Error('Bridge continuation command response is invalid');
    }
    return body.command;
  }

  async renewBridgeContinuationLease(input: {
    taskId: string;
    leaseToken: string;
  }): Promise<Readonly<{ renewed: boolean; expiresAt: string | null }>> {
    const body = await this.request(
      `/api/local-connector/public/bridge/commands/${encodeURIComponent(input.taskId)}/heartbeat`,
      { method: 'POST', body: { leaseToken: input.leaseToken } },
    );
    return Object.freeze({
      renewed: body.renewed === true,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    });
  }

  async completeBridgeContinuation(input: {
    deliveryId: string;
    taskId: string;
    leaseToken: string;
    outcome: 'queued' | 'accepted' | 'rejected' | 'unknown';
    turnId?: string | null;
    failure?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.request(
      `/api/local-connector/public/bridge/commands/${encodeURIComponent(input.taskId)}/result`,
      {
        method: 'POST',
        body: {
          deliveryId: input.deliveryId,
          leaseToken: input.leaseToken,
          outcome: input.outcome,
          turnId: input.turnId || null,
          failure: input.failure || null,
        },
      },
    );
  }

  async emitBridgeAppServerEvent(
    event: BridgeAppServerEventWire,
    taskId?: string | null,
    deliveryId?: string,
  ): Promise<void> {
    await this.request(
      taskId
        ? `/api/local-connector/public/bridge/commands/${encodeURIComponent(taskId)}/events`
        : '/api/local-connector/public/bridge/events',
      { method: 'POST', body: { deliveryId, event } },
    );
  }

  async createInteractionRequest(input: {
    connectionId: string;
    sourceRequestId: string | number;
    kind: 'command_approval' | 'file_change_approval' | 'permissions_approval' | 'user_input' | 'mcp_elicitation';
    method: string;
    threadId: string | null;
    turnId: string | null;
    itemId: string | null;
    requestPayload: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<Readonly<{ created: boolean; interaction: ConnectorInteractionSnapshot }>> {
    const body = await this.request('/api/local-connector/public/interactions', {
      method: 'POST',
      body: input,
    });
    return Object.freeze({
      created: body.created === true,
      interaction: parseInteractionSnapshot(body.request),
    });
  }

  async claimInteractionResponse(input: {
    requestId: string;
    deliveryId: string;
  }): Promise<Readonly<{
    ready: boolean;
    responsePayload: Readonly<Record<string, unknown>> | null;
    interaction: ConnectorInteractionSnapshot;
  }>> {
    const body = await this.request(
      `/api/local-connector/public/interactions/${encodeURIComponent(input.requestId)}/response/claim`,
      { method: 'POST', body: { deliveryId: input.deliveryId } },
    );
    const ready = body.ready === true;
    const responsePayload = isRecord(body.responsePayload)
      ? Object.freeze({ ...body.responsePayload })
      : null;
    if (ready && !responsePayload) throw new Error('Interaction 响应正文无效');
    return Object.freeze({
      ready,
      responsePayload,
      interaction: parseInteractionSnapshot(body.request),
    });
  }

  async resolveInteractionRequest(input: {
    requestId: string;
    deliveryId: string;
  }): Promise<ConnectorInteractionSnapshot> {
    const body = await this.request(
      `/api/local-connector/public/interactions/${encodeURIComponent(input.requestId)}/resolved`,
      { method: 'POST', body: { deliveryId: input.deliveryId } },
    );
    return parseInteractionSnapshot(body.interaction);
  }

  async emitEvent(input: {
    kind: LocalConnectorEventKind;
    title: string;
    message: string;
    level: 'info' | 'warning' | 'error';
    idempotencyKey: string;
  }): Promise<void> {
    await this.request('/api/local-connector/public/events', { method: 'POST', body: input });
  }

  async syncThreadSnapshots(
    source: LocalConnectorThreadSnapshotSource,
    threads: readonly LocalConnectorThreadSnapshotWire[],
  ): Promise<boolean> {
    try {
      await this.request('/api/local-connector/public/threads/snapshot', {
        method: 'POST',
        body: {
          source,
          threads: threads.map((thread) => ({
            threadId: thread.threadId,
            ...(thread.title !== undefined ? { title: thread.title } : {}),
            status: thread.status,
            ...(thread.activeFlags ? { activeFlags: [...thread.activeFlags] } : {}),
            ...(thread.activeTurnId !== undefined ? { activeTurnId: thread.activeTurnId } : {}),
            ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
          })),
        },
      });
      return true;
    } catch (error) {
      if (error instanceof LocalConnectorHttpError && (error.status === 404 || error.status === 405)) {
        return false;
      }
      throw error;
    }
  }
}

export function retryDelayForConnectorError(error: unknown, fallbackMs: number): number {
  return error instanceof LocalConnectorHttpError && error.retryAfterMs !== null
    ? Math.max(500, error.retryAfterMs)
    : fallbackMs;
}
