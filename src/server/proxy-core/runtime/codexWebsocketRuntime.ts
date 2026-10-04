import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { Headers } from 'undici';
import { withSiteCapacityOperation } from '../siteCapacity.js';
import { combineProxySignals } from '../requestAbortContext.js';
import { mergeSiteRequestHeaders, readSiteCustomHeaders } from '../../services/siteCustomHeaders.js';
import {
  extractResponsesTerminalResponseId,
  isResponsesPreviousResponseNotFoundError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  buildCodexWebsocketHandshakeHeaders,
  buildCodexWebsocketRequestBody,
  toCodexWebsocketUrl,
} from './codexWebsocketHeaders.js';
import {
  clearCodexSessionResponseId,
  getCodexSessionResponseId,
  setCodexSessionResponseId,
} from './codexSessionResponseStore.js';
import { createCodexWebsocketSessionStore } from './codexWebsocketSessionStore.js';
import type {
  CodexWebsocketRuntimeResult,
  CodexWebsocketRuntimeAttemptEvent,
  CodexWebsocketRuntimeSendInput,
  CodexWebsocketSession,
  CodexWebsocketSessionStore,
} from './types.js';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalEvent(payload: Record<string, unknown>): boolean {
  const type = asTrimmedString(payload.type);
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'error';
}

function isRuntimeErrorEvent(payload: Record<string, unknown>): boolean {
  const type = asTrimmedString(payload.type);
  return type === 'error';
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractFailureTerminalStatus(payload: Record<string, unknown>): number {
  const response = isRecord(payload.response) ? payload.response : null;
  const responseError = response && isRecord(response.error) ? response.error : null;
  const topLevelError = isRecord(payload.error) ? payload.error : null;
  const candidates = [
    payload.status,
    payload.statusCode,
    payload.code,
    topLevelError?.status,
    topLevelError?.statusCode,
    topLevelError?.code,
    responseError?.status,
    responseError?.statusCode,
    responseError?.code,
  ];
  for (const candidate of candidates) {
    const status = asFiniteNumber(candidate);
    if (status !== undefined) return status;
  }
  return 502;
}

function extractTerminalErrorMessage(payload: Record<string, unknown>): string {
  const type = asTrimmedString(payload.type);
  if (type === 'error' && isRecord(payload.error)) {
    return asTrimmedString(payload.error.message) || 'upstream websocket error';
  }
  if ((type === 'response.failed' || type === 'response.incomplete') && isRecord(payload.response)) {
    if (isRecord(payload.response.error)) {
      return asTrimmedString(payload.response.error.message) || `upstream ${type}`;
    }
    if (isRecord(payload.response.incomplete_details)) {
      return asTrimmedString(payload.response.incomplete_details.reason) || `upstream ${type}`;
    }
  }
  return `upstream ${type || 'websocket error'}`;
}

export class CodexWebsocketRuntimeError extends Error {
  events: Array<Record<string, unknown>>;
  status?: number;
  payload?: unknown;

  constructor(
    message: string,
    options?: {
      events?: Array<Record<string, unknown>>;
      status?: number;
      payload?: unknown;
    },
  ) {
    super(message);
    this.name = 'CodexWebsocketRuntimeError';
    this.events = options?.events ?? [];
    this.status = options?.status;
    this.payload = options?.payload;
  }
}

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

async function readUnexpectedResponseBody(response: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    response.once('error', () => {
      resolve('');
    });
  });
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw new Error('upstream websocket is not open');
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('upstream websocket closed before opening'));
    };
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      void readUnexpectedResponseBody(response).then((body) => {
        cleanup();
        reject(new CodexWebsocketRuntimeError(
          body.trim() || response.statusMessage || `upstream websocket upgrade failed with status ${response.statusCode || 502}`,
          {
            status: response.statusCode || 502,
            payload: tryParseJson(body),
          },
        ));
      });
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

async function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket) return;
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    socket.once('close', onClose);
    try {
      socket.close();
    } catch {
      socket.off('close', onClose);
      resolve();
    }
    setTimeout(() => {
      socket.off('close', onClose);
      resolve();
    }, 200);
  });
}

function clearSessionSocket(session: CodexWebsocketSession, socket: WebSocket): void {
  if (session.socket !== socket) return;
  session.socket = null;
  session.socketUrl = null;
  session.socketSiteHeadersFingerprint = null;
}

function buildContinuationAwareRuntimeBody(
  sessionId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rememberedResponseId = getCodexSessionResponseId(sessionId);
  if (!shouldInferResponsesPreviousResponseId(body, rememberedResponseId)) {
    return body;
  }
  return withResponsesPreviousResponseId(body, rememberedResponseId);
}

function rememberSessionResponseId(sessionId: string, payload: unknown): void {
  const responseId = extractResponsesTerminalResponseId(payload);
  if (!responseId) return;
  setCodexSessionResponseId(sessionId, responseId);
}

async function ensureSessionSocket(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput,
): Promise<{ socket: WebSocket; reusedSession: boolean }> {
  input.signal?.throwIfAborted();
  const requestUrl = toCodexWebsocketUrl(input.requestUrl);
  // A handshake is immutable: reconnect after a site header edit, keeping credentials out of session metadata.
  const siteHeadersFingerprint = createHash('sha256').update(JSON.stringify({
    headers: readSiteCustomHeaders(input.site?.customHeaders),
    override: input.site?.customHeadersOverrideRequestHeaders === true,
  })).digest('hex');
  const existing = session.socket;
  if (
    existing
    && session.socketUrl === requestUrl
    && session.socketSiteHeadersFingerprint === siteHeadersFingerprint
    && existing.readyState === WebSocket.OPEN
  ) {
    return {
      socket: existing,
      reusedSession: true,
    };
  }

  if (existing) {
    await closeSocket(existing);
    clearSessionSocket(session, existing);
  }

  input.signal?.throwIfAborted();

  const nextSocket = new WebSocket(requestUrl, {
    headers: Object.fromEntries(new Headers(mergeSiteRequestHeaders(
      input.site,
      buildCodexWebsocketHandshakeHeaders(input.headers),
    )).entries()),
  });
  session.socket = nextSocket;
  // Keep an error owner even when a disconnect interrupts the handshake and
  // waitForSocketOpen removes its temporary listeners.
  nextSocket.on('close', () => clearSessionSocket(session, nextSocket));
  nextSocket.on('error', () => clearSessionSocket(session, nextSocket));
  await waitForSocketOpen(nextSocket);
  input.signal?.throwIfAborted();
  session.socketUrl = requestUrl;
  session.socketSiteHeadersFingerprint = siteHeadersFingerprint;

  return {
    socket: nextSocket,
    reusedSession: false,
  };
}

async function sendSessionRequestAttempt(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput & {
    body: Record<string, unknown>;
  },
  attemptIndex: number,
): Promise<CodexWebsocketRuntimeResult> {
  const { socket, reusedSession } = await ensureSessionSocket(session, input);
  input.signal?.throwIfAborted();
  const events: Array<Record<string, unknown>> = [];
  const requestPath = (() => {
    try {
      return new URL(input.requestUrl).pathname;
    } catch {
      return input.requestUrl;
    }
  })();
  let lifecycleQueue = Promise.resolve();
  const emitAttemptEvent = (event: Omit<CodexWebsocketRuntimeAttemptEvent, 'attemptIndex' | 'requestUrl' | 'requestPath' | 'body'>) => {
    if (!input.onAttemptEvent) return lifecycleQueue;
    lifecycleQueue = lifecycleQueue
      .then(() => input.onAttemptEvent?.({
        ...event,
        attemptIndex,
        requestUrl: input.requestUrl,
        requestPath,
        body: input.body,
      }))
      .catch(() => undefined);
    return lifecycleQueue;
  };

  return new Promise<CodexWebsocketRuntimeResult>((resolve, reject) => {
    let settled = false;
    let requestSent = false;
    let responseStarted = false;
    let messageQueue = Promise.resolve();

    const cleanup = () => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const rejectWith = async (message: string, options?: {
      transportUnknown?: boolean;
      status?: number;
      payload?: Record<string, unknown>;
      terminal?: boolean;
      recoverable?: boolean;
    }) => {
      if (settled) return;
      await emitAttemptEvent({
        type: options?.transportUnknown ? 'transport_unknown' : 'failed',
        message,
        status: options?.status,
        payload: options?.payload,
        responseStarted,
        terminal: options?.terminal === true,
        recoverable: options?.recoverable === true,
      });
      settled = true;
      cleanup();
      if (options?.transportUnknown) {
        reject(new CodexWebsocketRuntimeError(message, {
          events: [...events],
          status: options.status,
          payload: options.payload,
        }));
        return;
      }
      reject(new CodexWebsocketRuntimeError(message, {
        events: [...events],
        status: options?.status,
        payload: options?.payload,
      }));
    };

    const onMessage = (payload: WebSocket.RawData) => {
      try {
        const parsed = JSON.parse(String(payload));
        if (!isRecord(parsed)) return;
        events.push(parsed);
        messageQueue = messageQueue.then(async () => {
          if (settled) return;
          if (!responseStarted) {
            responseStarted = true;
            await emitAttemptEvent({
              type: 'response_started',
              payload: parsed,
              responseStarted: true,
            });
          }
          if (!isTerminalEvent(parsed) || settled) return;
          if (
            isRuntimeErrorEvent(parsed)
            || isResponsesPreviousResponseNotFoundError({
              payload: parsed,
              rawErrText: extractTerminalErrorMessage(parsed),
            })
          ) {
            await rejectWith(extractTerminalErrorMessage(parsed), {
              status: extractFailureTerminalStatus(parsed),
              payload: parsed,
              terminal: true,
              recoverable: isResponsesPreviousResponseNotFoundError({
                payload: parsed,
                rawErrText: extractTerminalErrorMessage(parsed),
              }),
            });
            clearSessionSocket(session, socket);
            void closeSocket(socket);
            return;
          }
          const type = asTrimmedString(parsed.type);
          if (type === 'response.failed' || type === 'response.incomplete') {
            await emitAttemptEvent({
              type: 'failed',
              message: extractTerminalErrorMessage(parsed),
              status: extractFailureTerminalStatus(parsed),
              payload: parsed,
              responseStarted: true,
              terminal: true,
            });
          } else {
            await emitAttemptEvent({
              type: 'completed',
              payload: parsed,
              responseStarted: true,
              terminal: true,
            });
          }
          rememberSessionResponseId(session.sessionId, parsed);
          settled = true;
          cleanup();
          resolve({
            events: [...events],
            reusedSession,
          });
        }).catch((error) => {
          void rejectWith(error instanceof Error ? error.message : 'upstream websocket event processing failed', {
            transportUnknown: true,
          });
        });
      } catch {
        // Ignore malformed frames and wait for a terminal event.
      }
    };

    const onError = (error: Error) => {
      clearSessionSocket(session, socket);
      void rejectWith(error.message || 'upstream websocket error', {
        transportUnknown: requestSent,
      });
    };

    const onClose = () => {
      clearSessionSocket(session, socket);
      void rejectWith('stream closed before response.completed', {
        transportUnknown: requestSent,
      });
    };

    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);

    void emitAttemptEvent({
      type: 'attempt_started',
      reusedSession,
      responseStarted: false,
    }).then(() => {
      try {
        input.signal?.throwIfAborted();
        if (settled) return;
        socket.send(JSON.stringify(buildCodexWebsocketRequestBody(input.body)), (error?: Error) => {
          if (!error) return;
          clearSessionSocket(session, socket);
          void rejectWith(error.message || 'failed to send upstream websocket request', {
            transportUnknown: true,
          });
        });
        requestSent = true;
        void emitAttemptEvent({
          type: 'request_sent',
          reusedSession,
          responseStarted: false,
        });
      } catch (error) {
        clearSessionSocket(session, socket);
        void rejectWith(error instanceof Error ? error.message : 'failed to send upstream websocket request');
      }
    });
  });
}

async function sendSessionRequest(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput,
): Promise<CodexWebsocketRuntimeResult> {
  let currentBody = buildContinuationAwareRuntimeBody(session.sessionId, input.body);
  let previousResponseRecoveryTried = false;
  let attemptIndex = 0;

  for (;;) {
    try {
      return await sendSessionRequestAttempt(session, {
        ...input,
        body: currentBody,
      }, attemptIndex++);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (
        previousResponseRecoveryTried
        || !(error instanceof CodexWebsocketRuntimeError)
        || !isResponsesPreviousResponseNotFoundError({
          payload: error.payload ?? error.events[error.events.length - 1],
          rawErrText: error.message,
        })
      ) {
        throw error;
      }

      const previousResponseRecovery = stripResponsesPreviousResponseId(currentBody);
      if (!previousResponseRecovery.removed) {
        throw error;
      }

      previousResponseRecoveryTried = true;
      clearCodexSessionResponseId(session.sessionId);
      currentBody = previousResponseRecovery.body;
    }
  }
}

export function createCodexWebsocketRuntime(input?: {
  sessionStore?: CodexWebsocketSessionStore;
}) {
  const sessionStore = input?.sessionStore || createCodexWebsocketSessionStore();

  return {
    async sendRequest(payload: CodexWebsocketRuntimeSendInput): Promise<CodexWebsocketRuntimeResult> {
      const sessionId = payload.sessionId.trim();
      if (!sessionId) {
        throw new CodexWebsocketRuntimeError('missing websocket session id');
      }

      const session = sessionStore.getOrCreate(sessionId);
      session.controller ??= new AbortController();
      const signal = combineProxySignals(payload.signal, session.controller.signal)!;
      signal.throwIfAborted();
      const run = session.queue
        .catch(() => undefined)
        .then(() => withSiteCapacityOperation(payload.site, async (activeSignal) => {
          activeSignal?.throwIfAborted();
          const onAbort = () => { session.socket?.terminate(); };
          activeSignal?.addEventListener('abort', onAbort, { once: true });
          try { return await sendSessionRequest(session, { ...payload, signal: activeSignal }); }
          finally { activeSignal?.removeEventListener('abort', onAbort); }
        }, signal));
      session.queue = run.then(() => undefined, () => undefined);
      // A queued caller can leave immediately without consuming capacity or
      // waiting for another generation. Its queued task checks the same signal.
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        void run.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    },

    async closeSession(sessionId: string): Promise<void> {
      const session = sessionStore.take(sessionId);
      if (!session) return;
      session.closed = true;
      session.controller?.abort(new Error('Downstream websocket disconnected'));
      // Stop active/connecting sockets before waiting for the generation queue.
      session.socket?.terminate();
      await session.queue.catch(() => undefined);
      await closeSocket(session.socket);
      session.socket = null;
      session.socketUrl = null;
      // Intentionally preserve the remembered previous_response_id across
      // websocket reconnects. Closing a transport session should not sever the
      // logical downstream continuation chain for the same session key.
    },

    async closeAllSessions(): Promise<void> {
      const sessions = sessionStore.list();
      for (const session of sessions) {
        await this.closeSession(session.sessionId);
      }
    },
  };
}
