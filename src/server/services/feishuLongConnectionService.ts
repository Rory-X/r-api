import { createHash } from 'node:crypto';
import {
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  type WSConnectionState,
} from '@larksuiteoapi/node-sdk';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { resolveCredentialVaultSecret } from './credentialVaultService.js';
import { handleFeishuLongConnectionCallback } from './feishuInteractionAdapterService.js';

const CONFIG_REFRESH_MS = 30_000;

export type FeishuLongConnectionConfig = Readonly<{
  adapterId: string;
  appId: string;
  appSecret: string;
  verificationToken: string | null;
  encryptKey: string | null;
  domain: Domain;
  fingerprint: string;
}>;

export type FeishuLongConnectionSnapshot = Readonly<{
  adapterId: string;
  appId: string;
  state: WSConnectionState;
  reconnectAttempts: number;
  lastConnectTime: number | null;
  nextConnectTime: number | null;
}>;

type LongConnectionClient = Readonly<{
  start: () => Promise<void>;
  close: () => void;
  status: () => Readonly<{
    state: WSConnectionState;
    reconnectAttempts: number;
    lastConnectTime?: number;
    nextConnectTime?: number;
  }>;
}>;

type LongConnectionClientFactory = (input: Readonly<{
  config: FeishuLongConnectionConfig;
  onReady: () => void;
  onError: (error: Error) => void;
  onReconnecting: () => void;
  onReconnected: () => void;
  onEvent: (eventType: string, event: Record<string, unknown>, eventId?: string) => Promise<unknown>;
}>) => LongConnectionClient;

type ManagedConnection = {
  config: FeishuLongConnectionConfig;
  client: LongConnectionClient;
};

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error || 'unknown error').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

async function recordConnectionError(adapterId: string, error: unknown): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.update(schema.interactionAdapters).set({
    lastError: `[feishu-ws] ${errorMessage(error)}`,
    updatedAt: nowIso,
  }).where(eq(schema.interactionAdapters.id, adapterId)).run();
}

async function clearConnectionError(adapterId: string): Promise<void> {
  const nowIso = new Date().toISOString();
  await db.update(schema.interactionAdapters).set({
    lastError: sql`case when ${schema.interactionAdapters.lastError} like '[feishu-ws] %' then null else ${schema.interactionAdapters.lastError} end`,
    updatedAt: nowIso,
  }).where(eq(schema.interactionAdapters.id, adapterId)).run();
}

function eventId(value: Record<string, unknown>): string | undefined {
  const raw = typeof value.event_id === 'string' ? value.event_id.trim() : '';
  return raw || undefined;
}

function eventTraceFields(event: Record<string, unknown>): Readonly<{
  messageId: string | null;
  rootMessageId: string | null;
  threadId: string | null;
}> {
  const message = event.message && typeof event.message === 'object' && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : {};
  const identifier = (value: unknown) => {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return /^[a-zA-Z0-9._:-]{1,256}$/.test(normalized) ? normalized : null;
  };
  return Object.freeze({
    messageId: identifier(message.message_id),
    rootMessageId: identifier(message.root_id),
    threadId: identifier(message.thread_id),
  });
}

function logEventOutcome(input: {
  adapterId: string;
  eventType: string;
  event: Record<string, unknown>;
  result: unknown;
}): void {
  const result = input.result && typeof input.result === 'object' && !Array.isArray(input.result)
    ? input.result as Record<string, unknown>
    : {};
  const trace = eventTraceFields(input.event);
  const outcome = result.queued === true
    ? 'queued'
    : result.ignored === true
      ? 'ignored'
      : 'handled';
  const reason = typeof result.reason === 'string' && /^[a-z0-9._:-]{1,128}$/i.test(result.reason)
    ? result.reason
    : null;
  console.warn('[interaction-feishu-ws] event', JSON.stringify({
    adapterId: input.adapterId,
    eventType: input.eventType,
    messageId: trace.messageId,
    rootMessageId: trace.rootMessageId,
    threadId: trace.threadId,
    outcome,
    reason,
  }));
}

function createOfficialClient(input: Parameters<LongConnectionClientFactory>[0]): LongConnectionClient {
  const dispatcher = new EventDispatcher({
    verificationToken: input.config.verificationToken || undefined,
    encryptKey: input.config.encryptKey || undefined,
    loggerLevel: LoggerLevel.warn,
  }).register({
    'im.message.receive_v1': async (data: Record<string, unknown>) => {
      return await input.onEvent('im.message.receive_v1', data, eventId(data));
    },
    'card.action.trigger': async (data: Record<string, unknown>) => {
      return await input.onEvent('card.action.trigger', data, eventId(data));
    },
  });
  const client = new WSClient({
    appId: input.config.appId,
    appSecret: input.config.appSecret,
    domain: input.config.domain,
    autoReconnect: true,
    loggerLevel: LoggerLevel.warn,
    source: 'metapi',
    handshakeTimeoutMs: 20_000,
    wsConfig: { pingTimeout: 15 },
    onReady: input.onReady,
    onError: input.onError,
    onReconnecting: input.onReconnecting,
    onReconnected: input.onReconnected,
  });
  return Object.freeze({
    start: async () => await client.start({ eventDispatcher: dispatcher }),
    close: () => client.close({ force: true }),
    status: () => client.getConnectionStatus(),
  });
}

export class FeishuLongConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();

  constructor(private readonly createClient: LongConnectionClientFactory = createOfficialClient) {}

  async sync(configs: readonly FeishuLongConnectionConfig[]): Promise<void> {
    const desired = new Map(configs.map((config) => [config.adapterId, config]));
    for (const [adapterId, managed] of this.connections) {
      const config = desired.get(adapterId);
      const state = managed.client.status().state;
      if (config
        && config.fingerprint === managed.config.fingerprint
        && state !== 'failed'
        && state !== 'idle') continue;
      managed.client.close();
      this.connections.delete(adapterId);
    }

    for (const config of configs) {
      if (this.connections.has(config.adapterId)) continue;
      const client = this.createClient({
        config,
        onReady: () => {
          console.warn(`[interaction-feishu-ws] connected adapter=${config.adapterId}`);
          void clearConnectionError(config.adapterId).catch(() => undefined);
        },
        onError: (error) => {
          console.warn(`[interaction-feishu-ws] failed adapter=${config.adapterId}: ${errorMessage(error)}`);
          void recordConnectionError(config.adapterId, error).catch(() => undefined);
        },
        onReconnecting: () => {
          console.warn(`[interaction-feishu-ws] reconnecting adapter=${config.adapterId}`);
        },
        onReconnected: () => {
          console.warn(`[interaction-feishu-ws] reconnected adapter=${config.adapterId}`);
          void clearConnectionError(config.adapterId).catch(() => undefined);
        },
        onEvent: async (eventType, event, receivedEventId) => {
          try {
            const result = await handleFeishuLongConnectionCallback({
              adapterId: config.adapterId,
              eventType,
              event,
              eventId: receivedEventId,
            });
            logEventOutcome({
              adapterId: config.adapterId,
              eventType,
              event,
              result,
            });
            return result;
          } catch (error) {
            await recordConnectionError(config.adapterId, error).catch(() => undefined);
            throw error;
          }
        },
      });
      this.connections.set(config.adapterId, { config, client });
      try {
        void client.start().catch((error) => {
          void recordConnectionError(config.adapterId, error).catch(() => undefined);
        });
      } catch (error) {
        client.close();
        this.connections.delete(config.adapterId);
        await recordConnectionError(config.adapterId, error).catch(() => undefined);
      }
    }
  }

  stop(): void {
    for (const managed of this.connections.values()) managed.client.close();
    this.connections.clear();
  }

  snapshots(): readonly FeishuLongConnectionSnapshot[] {
    return Object.freeze([...this.connections.values()].map(({ config, client }) => {
      const status = client.status();
      return Object.freeze({
        adapterId: config.adapterId,
        appId: config.appId,
        state: status.state,
        reconnectAttempts: status.reconnectAttempts,
        lastConnectTime: status.lastConnectTime || null,
        nextConnectTime: status.nextConnectTime || null,
      });
    }));
  }
}

async function resolveSecret(id: number | null, label: string, required: boolean): Promise<string | null> {
  if (id === null) {
    if (required) throw new Error(`${label}未配置`);
    return null;
  }
  const resolved = await resolveCredentialVaultSecret(id);
  if (!resolved) {
    if (required) throw new Error(`${label}已失效`);
    return null;
  }
  return resolved.secret;
}

async function loadEnabledConfigs(): Promise<readonly FeishuLongConnectionConfig[]> {
  const rows = await db.select().from(schema.interactionAdapters).where(and(
    eq(schema.interactionAdapters.kind, 'feishu'),
    eq(schema.interactionAdapters.enabled, true),
  )).all();
  const configs: FeishuLongConnectionConfig[] = [];
  for (const row of rows) {
    try {
      if (!/^cli_[0-9a-fA-F]{16}$/.test(row.appId)) {
        throw new Error('飞书 App ID 格式无效');
      }
      const appSecret = await resolveSecret(row.appSecretCredentialId, '飞书 App Secret', true);
      const verificationToken = await resolveSecret(row.verificationTokenCredentialId, '飞书 Verification Token', false);
      const encryptKey = await resolveSecret(row.encryptKeyCredentialId, '飞书 Encrypt Key', false);
      const domain = row.apiBaseUrl.includes('larksuite') ? Domain.Lark : Domain.Feishu;
      const fingerprint = createHash('sha256')
        .update(row.appId)
        .update('\0')
        .update(appSecret || '')
        .update('\0')
        .update(verificationToken || '')
        .update('\0')
        .update(encryptKey || '')
        .update('\0')
        .update(String(domain))
        .digest('hex');
      configs.push(Object.freeze({
        adapterId: row.id,
        appId: row.appId,
        appSecret: appSecret!,
        verificationToken,
        encryptKey,
        domain,
        fingerprint,
      }));
    } catch (error) {
      await recordConnectionError(row.id, error).catch(() => undefined);
    }
  }
  return Object.freeze(configs);
}

const manager = new FeishuLongConnectionManager();
let nextConfigRefreshAtMs = 0;

export async function syncFeishuLongConnections(input: { force?: boolean; nowMs?: number } = {}): Promise<void> {
  const nowMs = Number.isFinite(input.nowMs) ? Math.trunc(input.nowMs as number) : Date.now();
  if (!input.force && nowMs < nextConfigRefreshAtMs) return;
  nextConfigRefreshAtMs = nowMs + CONFIG_REFRESH_MS;
  await manager.sync(await loadEnabledConfigs());
}

export function stopFeishuLongConnections(): void {
  manager.stop();
  nextConfigRefreshAtMs = 0;
}

export function listFeishuLongConnectionSnapshots(): readonly FeishuLongConnectionSnapshot[] {
  return manager.snapshots();
}

export function requestFeishuLongConnectionRefresh(): void {
  nextConfigRefreshAtMs = 0;
}

export function __resetFeishuLongConnectionsForTests(): void {
  stopFeishuLongConnections();
}
