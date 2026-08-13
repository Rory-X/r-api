import type { Readable, Writable } from 'node:stream';
import {
  createCodexAppServerTransport,
  type AppServerTransport,
} from './appServerObserver.js';
import type {
  BridgeFailureInput,
  BridgeRouteAction,
  CodexThreadActiveFlag,
  CodexThreadStatus,
} from '../services/bridgeContinuationContract.js';
import { CONNECTOR_VERSION } from './identity.js';

export type BridgeContinuationControlCommand = Readonly<{
  taskId: string;
  method: 'turn/start' | 'turn/steer';
  threadId: string;
  expectedTurnId?: string;
  prompt: string;
  routeAction: BridgeRouteAction;
  continuationNumber: number;
}>;

export type NormalizedAppServerControlEvent =
  | Readonly<{
    kind: 'thread_status';
    threadId: string;
    status: CodexThreadStatus;
    activeFlags: readonly CodexThreadActiveFlag[];
    activeTurnId?: string;
  }>
  | Readonly<{ kind: 'turn_started'; threadId: string; turnId: string }>
  | Readonly<{
    kind: 'turn_completed';
    threadId: string;
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
    assistantMessage: string | null;
    failure: BridgeFailureInput | null;
  }>
  | Readonly<{
    kind: 'error';
    threadId: string;
    turnId: string;
    failure: BridgeFailureInput;
  }>
  | Readonly<{
    kind: 'server_request_resolved';
    threadId: string;
    sourceRequestId: string;
  }>;

export type AppServerRequestMetadata = Readonly<{
  requestId: string | number;
  method: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  params: Readonly<Record<string, unknown>>;
}>;

export type AppServerThreadSnapshot = Readonly<{
  threadId: string;
  title: string;
  cwd: string | null;
  status: CodexThreadStatus;
  activeFlags: readonly CodexThreadActiveFlag[];
  createdAt: string | null;
  updatedAt: string | null;
  ephemeral?: boolean;
}>;

export type AppServerTurnCompletionSnapshot = Readonly<{
  threadId: string;
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  assistantMessage: string | null;
  failure: BridgeFailureInput | null;
}>;

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type ServerRequestResponder = {
  respond(result: unknown): void;
  reject(error: Error): void;
};

type AppServerControlOptions = {
  endpoint?: string | null;
  ownedExecutable?: string | null;
  cwd?: string;
  transportFactory?: () => Promise<AppServerTransport>;
  onNotification?: (event: NormalizedAppServerControlEvent) => void | Promise<void>;
  onServerRequest?: (request: AppServerRequestMetadata, responder: ServerRequestResponder) => void | Promise<void>;
  onError?: (error: Error) => void;
};

export class CodexAppServerResponseError extends Error {
  constructor(
    message: string,
    public readonly responseError: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CodexAppServerResponseError';
  }
}

export class CodexAppServerDispatchUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerDispatchUnknownError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedIdentifier(value: unknown): string {
  const normalized = text(value);
  return /^[a-zA-Z0-9._:-]{1,256}$/.test(normalized) ? normalized : '';
}

function normalizedRequestIdentifier(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return normalizedIdentifier(value);
}

function normalizeThreadStatus(value: unknown): {
  status: CodexThreadStatus;
  activeFlags: readonly CodexThreadActiveFlag[];
} {
  if (typeof value === 'string') {
    if (value === 'notLoaded' || value === 'not_loaded') return { status: 'not_loaded', activeFlags: Object.freeze([]) };
    if (value === 'idle') return { status: 'idle', activeFlags: Object.freeze([]) };
    if (value === 'active') return { status: 'active', activeFlags: Object.freeze([]) };
    if (value === 'systemError' || value === 'system_error') return { status: 'system_error', activeFlags: Object.freeze([]) };
  }
  if (!isRecord(value)) return { status: 'unknown', activeFlags: Object.freeze([]) };
  const type = text(value.type);
  if (type === 'notLoaded') return { status: 'not_loaded', activeFlags: Object.freeze([]) };
  if (type === 'idle') return { status: 'idle', activeFlags: Object.freeze([]) };
  if (type === 'systemError') return { status: 'system_error', activeFlags: Object.freeze([]) };
  if (type !== 'active') return { status: 'unknown', activeFlags: Object.freeze([]) };
  const rawFlags = Array.isArray(value.activeFlags) ? value.activeFlags : [];
  const activeFlags = [...new Set(rawFlags.filter(
    (item): item is CodexThreadActiveFlag => item === 'waitingOnApproval' || item === 'waitingOnUserInput',
  ))];
  return { status: 'active', activeFlags: Object.freeze(activeFlags) };
}

function normalizeTurnStatus(value: unknown): 'completed' | 'interrupted' | 'failed' {
  const normalized = text(value);
  if (normalized === 'completed') return 'completed';
  if (normalized === 'interrupted') return 'interrupted';
  return 'failed';
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
  }
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function threadListItems(response: Record<string, unknown>): AppServerThreadSnapshot[] {
  const result = isRecord(response.result) ? response.result : response;
  const rawItems = Array.isArray(result.data)
    ? result.data
    : Array.isArray(result.threads)
      ? result.threads
      : [];
  const items: AppServerThreadSnapshot[] = [];
  for (const value of rawItems) {
    if (!isRecord(value)) continue;
    const threadId = normalizedIdentifier(value.id || value.threadId || value.thread_id);
    if (!threadId) continue;
    const normalizedStatus = normalizeThreadStatus(value.status);
    const preview = text(value.preview || value.firstUserMessage || value.first_user_message);
    const item: AppServerThreadSnapshot = {
      threadId,
      title: text(value.name || value.title || value.threadName || value.thread_name)
        || preview.slice(0, 120)
        || `Codex ${threadId.slice(0, 8)}`,
      cwd: text(value.cwd || value.workdir || value.workingDirectory) || null,
      status: normalizedStatus.status,
      activeFlags: normalizedStatus.activeFlags,
      createdAt: normalizedTimestamp(value.createdAt || value.created_at),
      updatedAt: normalizedTimestamp(value.updatedAt || value.updated_at),
      ...(value.ephemeral === true ? { ephemeral: true } : {}),
    };
    items.push(Object.freeze(item));
  }
  return items;
}

function failureFromTurnError(value: unknown, source: BridgeFailureInput['source'], willRetry?: unknown): BridgeFailureInput {
  const error = isRecord(value) ? value : {};
  return {
    source,
    message: text(error.message),
    codexErrorInfo: error.codexErrorInfo,
    willRetry,
  };
}

function assistantMessageFromTurn(turn: Record<string, unknown>): string | null {
  const agentMessages = (Array.isArray(turn.items) ? turn.items : [])
    .filter(isRecord)
    .filter((item) => item.type === 'agentMessage' && text(item.text))
    .map((item) => ({
      phase: text(item.phase),
      text: text(item.text),
    }));
  if (agentMessages.length === 0) return null;
  for (let index = agentMessages.length - 1; index >= 0; index -= 1) {
    if (agentMessages[index]?.phase === 'final_answer') return agentMessages[index]?.text || null;
  }
  // Older providers may omit phase. At turn completion the last agent message
  // is the compatibility fallback defined by the App Server protocol.
  return agentMessages[agentMessages.length - 1]?.text || null;
}

function latestCompletedTurn(
  response: Record<string, unknown>,
  threadId: string,
): AppServerTurnCompletionSnapshot | null {
  const result = isRecord(response.result) ? response.result : response;
  const thread = isRecord(result.thread) ? result.thread : {};
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = isRecord(turns[index]) ? turns[index] : null;
    if (!turn) continue;
    const turnId = normalizedIdentifier(turn.id || turn.turnId);
    const status = text(turn.status);
    if (!turnId || (status !== 'completed' && status !== 'interrupted' && status !== 'failed')) continue;
    const rawError = turn.error;
    return Object.freeze({
      threadId,
      turnId,
      status,
      assistantMessage: assistantMessageFromTurn(turn),
      failure: status === 'failed' && rawError
        ? failureFromTurnError(rawError, 'turn_completed', false)
        : null,
    });
  }
  return null;
}

export function normalizeAppServerControlNotification(value: unknown): NormalizedAppServerControlEvent | null {
  if (!isRecord(value) || typeof value.method !== 'string' || !isRecord(value.params)) return null;
  const params = value.params;
  const threadId = normalizedIdentifier(params.threadId);
  if (!threadId) return null;

  if (value.method === 'thread/status/changed') {
    const normalized = normalizeThreadStatus(params.status);
    const statusRecord = isRecord(params.status) ? params.status : {};
    const activeTurnId = normalizedIdentifier(
      params.activeTurnId || params.active_turn_id || params.turnId || statusRecord.activeTurnId,
    );
    return Object.freeze({
      kind: 'thread_status',
      threadId,
      ...normalized,
      ...(activeTurnId ? { activeTurnId } : {}),
    });
  }
  if (value.method === 'turn/started') {
    const turn = isRecord(params.turn) ? params.turn : {};
    const turnId = normalizedIdentifier(turn.id || params.turnId);
    return turnId ? Object.freeze({ kind: 'turn_started', threadId, turnId }) : null;
  }
  if (value.method === 'turn/completed') {
    const turn = isRecord(params.turn) ? params.turn : {};
    const turnId = normalizedIdentifier(turn.id || params.turnId);
    if (!turnId) return null;
    const status = normalizeTurnStatus(turn.status || params.status);
    const rawError = turn.error || params.error;
    return Object.freeze({
      kind: 'turn_completed',
      threadId,
      turnId,
      status,
      assistantMessage: assistantMessageFromTurn(turn),
      failure: status === 'failed' && rawError
        ? failureFromTurnError(rawError, 'turn_completed', false)
        : null,
    });
  }
  if (value.method === 'error') {
    const turnId = normalizedIdentifier(params.turnId);
    if (!turnId) return null;
    return Object.freeze({
      kind: 'error',
      threadId,
      turnId,
      failure: failureFromTurnError(params.error, 'error_notification', params.willRetry),
    });
  }
  if (value.method === 'serverRequest/resolved') {
    const sourceRequestId = normalizedRequestIdentifier(params.requestId);
    return sourceRequestId
      ? Object.freeze({ kind: 'server_request_resolved', threadId, sourceRequestId })
      : null;
  }
  return null;
}

export function bridgeFailureFromResponseError(error: CodexAppServerResponseError): BridgeFailureInput {
  const data = isRecord(error.responseError.data) ? error.responseError.data : {};
  const nested = isRecord(data.error) ? data.error : data;
  return {
    source: 'control_error',
    message: text(nested.message) || error.message,
    codexErrorInfo: nested.codexErrorInfo,
    httpStatusCode: nested.httpStatusCode,
    willRetry: false,
  };
}

function extractTurnId(response: Record<string, unknown>): string {
  const result = isRecord(response.result) ? response.result : {};
  const turn = isRecord(result.turn) ? result.turn : isRecord(response.turn) ? response.turn : {};
  return normalizedIdentifier(turn.id || turn.turnId || result.turnId);
}

function requestMetadata(value: Record<string, unknown>): AppServerRequestMetadata {
  const params = isRecord(value.params) ? value.params : {};
  const item = isRecord(params.item) ? params.item : {};
  return Object.freeze({
    requestId: value.id as string | number,
    method: text(value.method),
    threadId: normalizedIdentifier(params.threadId) || null,
    turnId: normalizedIdentifier(params.turnId) || null,
    itemId: normalizedIdentifier(params.itemId || item.id) || null,
    params: Object.freeze({ ...params }),
  });
}

export class CodexAppServerControlClient {
  private transport: AppServerTransport | null = null;
  private connectPromise: Promise<void> | null = null;
  private readonly pending = new Map<string | number, PendingRequest>();
  private buffer = '';
  private nextRequestId = 1;
  private closed = false;
  private transportListeners: Readonly<{
    transport: AppServerTransport;
    onData: (chunk: string | Buffer) => void;
    onReadableError: (error: Error) => void;
    onReadableClose: () => void;
    onWritableError: (error: Error) => void;
  }> | null = null;

  constructor(private readonly options: AppServerControlOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error('Codex App Server control client is closed');
    if (this.connectPromise) return this.connectPromise;
    if (this.transport) return;

    const connecting = this.openTransport();
    this.connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectPromise === connecting) this.connectPromise = null;
    }
  }

  private async openTransport(): Promise<void> {
    const transport = this.options.transportFactory
      ? await this.options.transportFactory()
      : await createCodexAppServerTransport(this.options);
    if (this.closed) {
      await transport.close().catch(() => undefined);
      throw new Error('Codex App Server control client is closed');
    }

    this.transport = transport;
    this.buffer = '';
    const listeners = Object.freeze({
      transport,
      onData: (chunk: string | Buffer) => {
        if (this.transport === transport) this.handleData(chunk);
      },
      onReadableError: (error: Error) => this.handleTransportFailure(transport, error),
      onReadableClose: () => this.handleTransportFailure(
        transport,
        new Error('Codex App Server control connection closed'),
      ),
      onWritableError: (error: Error) => this.handleTransportFailure(transport, error),
    });
    this.transportListeners = listeners;
    transport.readable.setEncoding('utf8');
    transport.readable.on('data', listeners.onData);
    transport.readable.once('error', listeners.onReadableError);
    transport.readable.once('close', listeners.onReadableClose);
    transport.writable.once('error', listeners.onWritableError);

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'metapi-local-connector',
          title: 'r-api Local Connector',
          version: CONNECTOR_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: true,
        },
      }, 15_000);
      if (this.transport !== transport) {
        throw new CodexAppServerDispatchUnknownError('Codex App Server control connection closed during initialization');
      }
      this.notify('initialized', {});
    } catch (error) {
      if (this.transport === transport) this.detachTransport(transport);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async continueThread(command: BridgeContinuationControlCommand): Promise<{ turnId: string }> {
    await this.connect();
    await this.request('thread/resume', { threadId: command.threadId }, 20_000);
    const response = command.method === 'turn/steer'
      ? await this.request('turn/steer', {
        threadId: command.threadId,
        input: [{ type: 'text', text: command.prompt }],
        expectedTurnId: command.expectedTurnId,
      }, 30_000)
      : await this.request('turn/start', {
        threadId: command.threadId,
        input: [{ type: 'text', text: command.prompt }],
        clientUserMessageId: `metapi:${command.taskId}:${command.continuationNumber}`,
        responsesapiClientMetadata: {
          metapi_bridge_task_id: command.taskId,
          metapi_bridge_route_action: command.routeAction,
          metapi_bridge_continuation_number: String(command.continuationNumber),
        },
      }, 30_000);
    const turnId = extractTurnId(response);
    if (!turnId) {
      throw new CodexAppServerDispatchUnknownError(`Codex App Server accepted ${command.method} without a turn id`);
    }
    return { turnId };
  }

  async listThreads(limit = 50): Promise<readonly AppServerThreadSnapshot[]> {
    await this.connect();
    const response = await this.request('thread/list', {
      limit: Math.max(1, Math.min(100, Math.trunc(limit))),
      sortKey: 'updated_at',
    }, 20_000);
    return Object.freeze(threadListItems(response));
  }

  async readLatestCompletedTurn(threadId: string): Promise<AppServerTurnCompletionSnapshot | null> {
    await this.connect();
    const normalizedThreadId = normalizedIdentifier(threadId);
    if (!normalizedThreadId) throw new Error('Codex App Server thread id is invalid');
    const response = await this.request('thread/read', {
      threadId: normalizedThreadId,
      includeTurns: true,
    }, 20_000);
    return latestCompletedTurn(response, normalizedThreadId);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed || !this.transport) return Promise.reject(new Error('Codex App Server control client is closed'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerDispatchUnknownError(`Codex App Server ${method} request timed out`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (this.closed || !this.transport) return;
    this.write({ method, params });
  }

  private write(message: Record<string, unknown>): void {
    const transport = this.transport;
    if (!transport || transport.writable.destroyed || !transport.writable.writable) {
      throw new CodexAppServerDispatchUnknownError('Codex App Server control connection is not writable');
    }
    transport.writable.write(`${JSON.stringify(message)}\n`);
  }

  private readonly handleData = (chunk: string | Buffer) => {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  };

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      const transport = this.transport;
      const error = new Error('Codex App Server returned invalid JSON');
      if (transport) this.handleTransportFailure(transport, error);
      else this.fail(error);
      return;
    }
    if (!isRecord(message)) return;
    if (message.id !== undefined && typeof message.method === 'string') {
      const requestTransport = this.transport;
      if (!requestTransport) return;
      const metadata = requestMetadata(message);
      let settled = false;
      const writeResponse = (response: Record<string, unknown>) => {
        if (this.transport !== requestTransport) return;
        try {
          this.write(response);
        } catch (error) {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const responder: ServerRequestResponder = {
        respond: (result) => {
          if (settled) return;
          settled = true;
          writeResponse({ jsonrpc: '2.0', id: message.id, result });
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          writeResponse({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: error.message },
          });
        },
      };
      if (this.options.onServerRequest) {
        void Promise.resolve(this.options.onServerRequest(metadata, responder)).catch((error) => responder.reject(error as Error));
      } else {
        responder.reject(new Error('r-api interaction adapter is not configured'));
      }
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id as string | number);
      if (!pending) return;
      this.pending.delete(message.id as string | number);
      clearTimeout(pending.timeout);
      if (isRecord(message.error)) {
        pending.reject(new CodexAppServerResponseError(
          text(message.error.message) || 'Codex App Server request failed',
          message.error,
        ));
      } else {
        pending.resolve(message);
      }
      return;
    }
    const event = normalizeAppServerControlNotification(message);
    if (event && this.options.onNotification) {
      void Promise.resolve(this.options.onNotification(event)).catch((error) => this.options.onError?.(error as Error));
    }
  }

  private detachTransport(transport: AppServerTransport): void {
    const listeners = this.transportListeners;
    if (listeners?.transport === transport) {
      transport.readable.removeListener('data', listeners.onData);
      transport.readable.removeListener('error', listeners.onReadableError);
      transport.readable.removeListener('close', listeners.onReadableClose);
      transport.writable.removeListener('error', listeners.onWritableError);
      this.transportListeners = null;
    }
    if (this.transport === transport) this.transport = null;
  }

  private handleTransportFailure(transport: AppServerTransport, error: Error): void {
    if (this.transport !== transport) return;
    this.detachTransport(transport);
    void transport.close().catch(() => undefined);
    this.fail(error);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerDispatchUnknownError(error.message));
    }
    this.pending.clear();
    this.options.onError?.(error);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const transport = this.transport;
    if (transport) {
      this.detachTransport(transport);
      await transport.close();
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerDispatchUnknownError('Codex App Server control client closed'));
    }
    this.pending.clear();
  }
}

export type { AppServerTransport, Readable, Writable };
