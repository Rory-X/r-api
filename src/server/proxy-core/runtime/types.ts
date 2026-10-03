import type WebSocket from 'ws';
import type { SiteCustomHeadersConfigLike } from '../../services/siteCustomHeaders.js';

export type CodexWebsocketRuntimeSendInput = {
  sessionId: string;
  requestUrl: string;
  headers: Record<string, string>;
  site?: SiteCustomHeadersConfigLike;
  body: Record<string, unknown>;
  onAttemptEvent?: (event: CodexWebsocketRuntimeAttemptEvent) => void | Promise<void>;
};

export type CodexWebsocketRuntimeAttemptEvent = {
  type: 'attempt_started' | 'request_sent' | 'response_started' | 'completed' | 'failed' | 'transport_unknown';
  attemptIndex: number;
  requestUrl: string;
  requestPath: string;
  body: Record<string, unknown>;
  reusedSession?: boolean;
  payload?: Record<string, unknown>;
  status?: number;
  message?: string;
  responseStarted?: boolean;
  terminal?: boolean;
  recoverable?: boolean;
};

export type CodexWebsocketRuntimeResult = {
  events: Array<Record<string, unknown>>;
  reusedSession: boolean;
};

export type CodexWebsocketSession = {
  sessionId: string;
  socket: WebSocket | null;
  socketUrl: string | null;
  socketSiteHeadersFingerprint: string | null;
  queue: Promise<unknown>;
};

export type CodexWebsocketSessionStore = {
  getOrCreate(sessionId: string): CodexWebsocketSession;
  take(sessionId: string): CodexWebsocketSession | null;
  list(): CodexWebsocketSession[];
};
