import {
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { fetch as undiciFetch } from 'undici';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import {
  resolveCredentialVaultSecret,
  storeSystemCredentialVaultItem,
} from './credentialVaultService.js';
import {
  commitInteractionResponseWithExecutor,
  expireInteractionRequests,
  getInteractionRequest,
  type InteractionRequestRecord,
} from './interactionRequestService.js';
import {
  createManualBridgePromptTask,
  getBridgeContinuationTask,
} from './bridgeContinuationService.js';
import type {
  CodexThreadActiveFlag,
  CodexThreadStatus,
} from './bridgeContinuationContract.js';
import {
  bindFeishuTopicRoot,
  getFeishuTopicBindingById,
  getFeishuTopicBindingForMessage,
  getOrCreateFeishuTopicBinding,
  recordFeishuTopicReply,
  type FeishuTopicBinding,
} from './feishuTopicBindingService.js';
import { requireActiveLocalConnectorDevice } from './localConnectorService.js';

type DbExecutor = typeof db;
type AdapterRow = typeof schema.interactionAdapters.$inferSelect;
type DispatchRow = typeof schema.interactionDispatches.$inferSelect;
type CardUpdateRow = typeof schema.interactionCardUpdates.$inferSelect;
type TicketRow = typeof schema.interactionActionTickets.$inferSelect;
type PromptCardRow = typeof schema.interactionPromptCards.$inferSelect;
type FetchLike = typeof undiciFetch;

const FEISHU_RECEIVE_ID_TYPES = ['chat_id', 'open_id', 'user_id', 'union_id', 'email'] as const;
export type FeishuReceiveIdType = typeof FEISHU_RECEIVE_ID_TYPES[number];
const ACTION_TICKET_PREFIX = 'mit_';
const ACTION_TICKET_MAX_AGE_MS = 24 * 60 * 60_000;
const DISPATCH_LEASE_MS = 30_000;
const DEFAULT_DISPATCH_LIMIT = 20;
const CARD_UPDATE_WINDOW_MS = 14 * 24 * 60 * 60_000;
const BRIDGE_PROMPT_ACTION_PREFIX = 'bridge_prompt:';
const BRIDGE_PROMPT_INPUT_NAME = 'metapi_prompt';
const PROMPT_CARD_IDEMPOTENCY_NAMESPACE = 'feishu-bridge-prompt-card-idempotency';
const PROMPT_CARD_REQUEST_NAMESPACE = 'feishu-bridge-prompt-card-request';
const FEISHU_TOPIC_PROMPT_PREFIX = 'mtp_topic_';
const DEFAULT_PROMPT_CARD_TTL_MS = 60 * 60_000;
const MIN_PROMPT_CARD_TTL_MS = 5 * 60_000;
const MAX_PROMPT_CARD_TTL_MS = 24 * 60 * 60_000;
const PROMPT_CARD_STATUSES = new Set(['pending', 'consumed', 'expired', 'cancelled']);

const tenantTokenCache = new Map<string, {
  fingerprint: string;
  token: string;
  expiresAtMs: number;
}>();

export type FeishuInteractionAdapterPublic = Readonly<{
  id: string;
  deviceId: string | null;
  kind: 'feishu';
  name: string;
  enabled: boolean;
  appId: string;
  apiBaseUrl: string;
  receiveIdType: FeishuReceiveIdType;
  receiveId: string;
  consoleBaseUrl: string | null;
  operatorAllowlist: string[];
  secretsConfigured: {
    appSecret: boolean;
    verificationToken: boolean;
    encryptKey: boolean;
  };
  callbackPath: string;
  lastDispatchAt: string | null;
  lastCallbackAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export type FeishuInteractionDispatchPublic = Readonly<{
  id: string;
  subjectKind: 'interaction' | 'prompt_card';
  interactionId: string | null;
  promptCardId: string | null;
  adapterId: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  externalMessageId: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  cardUpdate: FeishuCardUpdatePublic | null;
}>;

export type FeishuCardUpdatePublic = Readonly<{
  id: string;
  dispatchId: string;
  subjectRevision: number;
  targetStatus: string;
  cardFingerprint: string;
  status: string;
  attemptCount: number;
  nextAttemptAt: string;
  deadlineAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}>;

export type FeishuBridgePromptCardPublic = Readonly<{
  id: string;
  adapterId: string;
  deviceId: string;
  threadId: string;
  contextTaskId: string | null;
  status: 'pending' | 'consumed' | 'expired' | 'cancelled';
  expiresAt: string;
  requestedBy: string;
  consumedTaskId: string | null;
  consumedBy: string | null;
  consumedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dispatch: FeishuInteractionDispatchPublic | null;
}>;

type ActionSpec = Readonly<{
  key: string;
  label: string;
  tone: 'primary' | 'default' | 'danger';
  responsePayload: Record<string, unknown>;
}>;

class KnownFeishuDeliveryError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = 'KnownFeishuDeliveryError';
  }
}

class UnknownFeishuDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnknownFeishuDeliveryError';
  }
}

export class FeishuCallbackUserError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FeishuCallbackUserError';
  }
}

function affectedRows(result: any): number {
  return Number(result?.changes ?? result?.rowCount ?? result?.affectedRows ?? 0);
}

function looksLikeUniqueCollision(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message || '').toLowerCase();
  const code = String((error as { code?: unknown })?.code || '').toUpperCase();
  return code === '23505'
    || code === '1062'
    || code === 'ER_DUP_ENTRY'
    || code.startsWith('SQLITE_CONSTRAINT')
    || message.includes('unique constraint')
    || message.includes('duplicate entry')
    || message.includes('duplicate key');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new Error(`${label}无效`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  return normalizeText(value, label, maximum);
}

function hashNamespaced(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex');
}

function normalizePromptCardTtlMs(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_PROMPT_CARD_TTL_MS;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed < MIN_PROMPT_CARD_TTL_MS || parsed > MAX_PROMPT_CARD_TTL_MS) {
    throw new Error('Prompt 卡片 TTL 必须在 5 分钟到 24 小时之间');
  }
  return parsed;
}

function normalizeApiBaseUrl(value: unknown): string {
  const raw = normalizeText(value || 'https://open.feishu.cn', '飞书 API Base URL', 2_048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('飞书 API Base URL 格式无效');
  }
  if (parsed.protocol !== 'https:'
    || (parsed.hostname !== 'open.feishu.cn' && parsed.hostname !== 'open.larksuite.com')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error('飞书 API Base URL 只允许 open.feishu.cn 或 open.larksuite.com');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeConsoleBaseUrl(value: unknown): string | null {
  const raw = normalizeOptionalText(value, '控制台公开 URL', 2_048);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('控制台公开 URL 格式无效');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash) {
    throw new Error('控制台公开 URL 必须是无凭据的 HTTP(S) URL');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeReceiveIdType(value: unknown): FeishuReceiveIdType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(FEISHU_RECEIVE_ID_TYPES as readonly string[]).includes(normalized)) {
    throw new Error('飞书 receive_id_type 无效');
  }
  return normalized as FeishuReceiveIdType;
}

function normalizeOperatorAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('飞书操作者白名单必须是数组');
  const allowedPrefixes = new Set(['open_id', 'union_id', 'user_id']);
  const normalized = value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const trimmed = entry.trim();
    const separator = trimmed.indexOf(':');
    if (separator <= 0 || trimmed.length > 300) return [];
    const prefix = trimmed.slice(0, separator);
    const id = trimmed.slice(separator + 1).trim();
    return allowedPrefixes.has(prefix) && id ? [`${prefix}:${id}`] : [];
  });
  const unique = [...new Set(normalized)];
  if (unique.length === 0) throw new Error('至少配置一个飞书操作者白名单 ID');
  return unique.slice(0, 200);
}

function parseOperatorAllowlist(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function observedThreadStatus(value: unknown): CodexThreadStatus {
  return value === 'not_loaded' || value === 'idle' || value === 'active' || value === 'system_error'
    ? value
    : 'unknown';
}

function observedThreadActiveFlags(raw: string): CodexThreadActiveFlag[] {
  return parseStringArray(raw).filter((flag): flag is CodexThreadActiveFlag => (
    flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
  ));
}

function promptCardRequestFingerprint(input: {
  adapterId: string;
  deviceId: string;
  threadId: string;
  contextTaskId: string | null;
  requestedBy: string;
  ttlMs: number;
}): string {
  return hashNamespaced(PROMPT_CARD_REQUEST_NAMESPACE, JSON.stringify(input));
}

function toPublicAdapter(row: AdapterRow): FeishuInteractionAdapterPublic {
  return Object.freeze({
    id: row.id,
    deviceId: row.deviceId,
    kind: 'feishu',
    name: row.name,
    enabled: row.enabled,
    appId: row.appId,
    apiBaseUrl: row.apiBaseUrl,
    receiveIdType: row.receiveIdType as FeishuReceiveIdType,
    receiveId: row.receiveId,
    consoleBaseUrl: row.consoleBaseUrl,
    operatorAllowlist: parseOperatorAllowlist(row.operatorAllowlist),
    secretsConfigured: {
      appSecret: row.appSecretCredentialId !== null,
      verificationToken: row.verificationTokenCredentialId !== null,
      encryptKey: row.encryptKeyCredentialId !== null,
    },
    callbackPath: `/api/interaction-adapters/public/feishu/${encodeURIComponent(row.id)}/callback`,
    lastDispatchAt: row.lastDispatchAt,
    lastCallbackAt: row.lastCallbackAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toPublicCardUpdate(row: CardUpdateRow): FeishuCardUpdatePublic {
  return Object.freeze({
    id: row.id,
    dispatchId: row.dispatchId,
    subjectRevision: row.subjectRevision,
    targetStatus: row.targetStatus,
    cardFingerprint: row.cardFingerprint,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    deadlineAt: row.deadlineAt,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toPublicDispatch(
  row: DispatchRow,
  cardUpdate: CardUpdateRow | null = null,
): FeishuInteractionDispatchPublic {
  return Object.freeze({
    id: row.id,
    subjectKind: row.subjectKind === 'prompt_card' ? 'prompt_card' : 'interaction',
    interactionId: row.interactionId,
    promptCardId: row.promptCardId,
    adapterId: row.adapterId,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    externalMessageId: row.externalMessageId,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cardUpdate: cardUpdate ? toPublicCardUpdate(cardUpdate) : null,
  });
}

function toPublicPromptCard(
  row: PromptCardRow,
  dispatch: DispatchRow | null = null,
  cardUpdate: CardUpdateRow | null = null,
): FeishuBridgePromptCardPublic {
  const status = row.status === 'consumed'
    || row.status === 'expired'
    || row.status === 'cancelled'
    ? row.status
    : 'pending';
  return Object.freeze({
    id: row.id,
    adapterId: row.adapterId,
    deviceId: row.deviceId,
    threadId: row.threadId,
    contextTaskId: row.contextTaskId,
    status,
    expiresAt: row.expiresAt,
    requestedBy: row.requestedBy,
    consumedTaskId: row.consumedTaskId,
    consumedBy: row.consumedBy,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dispatch: dispatch ? toPublicDispatch(dispatch, cardUpdate) : null,
  });
}

async function storeAdapterSecret(
  executor: DbExecutor,
  adapterId: string,
  adapterName: string,
  purpose: 'app_secret' | 'verification_token' | 'encrypt_key',
  secret: unknown,
) {
  return await storeSystemCredentialVaultItem({
    name: `${adapterName} · ${purpose}`,
    secret: normalizeText(secret, `飞书 ${purpose}`, 8_192),
    metadata: {
      source: 'manual',
      adapterPlatform: 'feishu',
      adapterId,
      purpose,
    },
  }, executor);
}

export async function createFeishuInteractionAdapter(input: {
  deviceId: unknown;
  name: unknown;
  enabled?: boolean;
  appId: unknown;
  appSecret: unknown;
  verificationToken?: unknown;
  encryptKey?: unknown;
  apiBaseUrl?: unknown;
  receiveIdType: unknown;
  receiveId: unknown;
  consoleBaseUrl?: unknown;
  operatorAllowlist: unknown;
}): Promise<FeishuInteractionAdapterPublic> {
  const id = randomUUID();
  const device = await requireActiveLocalConnectorDevice(input.deviceId, 'app_server.control');
  const name = normalizeText(input.name, '飞书 Adapter 名称', 120);
  const appId = normalizeText(input.appId, '飞书 App ID', 256);
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const receiveIdType = normalizeReceiveIdType(input.receiveIdType);
  const receiveId = normalizeText(input.receiveId, '飞书接收目标', 512);
  const consoleBaseUrl = normalizeConsoleBaseUrl(input.consoleBaseUrl);
  const operatorAllowlist = normalizeOperatorAllowlist(input.operatorAllowlist);
  const nowIso = new Date().toISOString();

  const row = await db.transaction(async (tx: DbExecutor) => {
    const appSecret = await storeAdapterSecret(tx, id, name, 'app_secret', input.appSecret);
    const verificationToken = input.verificationToken === undefined || input.verificationToken === ''
      ? null
      : await storeAdapterSecret(tx, id, name, 'verification_token', input.verificationToken);
    const encryptKey = input.encryptKey === undefined || input.encryptKey === ''
      ? null
      : await storeAdapterSecret(tx, id, name, 'encrypt_key', input.encryptKey);
    await tx.insert(schema.interactionAdapters).values({
      id,
      deviceId: device.id,
      kind: 'feishu',
      name,
      enabled: input.enabled !== false,
      appId,
      appSecretCredentialId: appSecret.id,
      verificationTokenCredentialId: verificationToken?.id || null,
      encryptKeyCredentialId: encryptKey?.id || null,
      apiBaseUrl,
      receiveIdType,
      receiveId,
      consoleBaseUrl,
      operatorAllowlist: JSON.stringify(operatorAllowlist),
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
    const inserted = await tx.select().from(schema.interactionAdapters)
      .where(eq(schema.interactionAdapters.id, id)).get();
    if (!inserted) throw new Error('飞书 Interaction Adapter 创建失败');
    return inserted;
  });
  return toPublicAdapter(row);
}

export async function updateFeishuInteractionAdapter(adapterIdInput: unknown, input: {
  deviceId?: unknown;
  name?: unknown;
  enabled?: boolean;
  appId?: unknown;
  appSecret?: unknown;
  verificationToken?: unknown;
  encryptKey?: unknown;
  apiBaseUrl?: unknown;
  receiveIdType?: unknown;
  receiveId?: unknown;
  consoleBaseUrl?: unknown;
  operatorAllowlist?: unknown;
}): Promise<FeishuInteractionAdapterPublic> {
  const adapterId = normalizeText(adapterIdInput, 'Adapter ID', 128);
  const existing = await db.select().from(schema.interactionAdapters)
    .where(eq(schema.interactionAdapters.id, adapterId)).get();
  if (!existing || existing.kind !== 'feishu') throw new Error('飞书 Interaction Adapter 不存在');
  const requestedDeviceId = input.deviceId === undefined
    ? existing.deviceId
    : (await requireActiveLocalConnectorDevice(input.deviceId, 'app_server.control')).id;
  if (existing.deviceId && requestedDeviceId !== existing.deviceId) {
    throw new Error('飞书 Interaction Adapter 绑定后不能迁移到其他 Connector');
  }
  const deviceId = requestedDeviceId;
  const name = input.name === undefined ? existing.name : normalizeText(input.name, '飞书 Adapter 名称', 120);
  const nowIso = new Date().toISOString();
  const oldSecretIds: number[] = [];

  const row = await db.transaction(async (tx: DbExecutor) => {
    let appSecretCredentialId = existing.appSecretCredentialId;
    let verificationTokenCredentialId = existing.verificationTokenCredentialId;
    let encryptKeyCredentialId = existing.encryptKeyCredentialId;
    if (input.appSecret !== undefined && input.appSecret !== '') {
      const stored = await storeAdapterSecret(tx, adapterId, name, 'app_secret', input.appSecret);
      if (appSecretCredentialId) oldSecretIds.push(appSecretCredentialId);
      appSecretCredentialId = stored.id;
    }
    if (input.verificationToken !== undefined && input.verificationToken !== '') {
      const stored = await storeAdapterSecret(tx, adapterId, name, 'verification_token', input.verificationToken);
      if (verificationTokenCredentialId) oldSecretIds.push(verificationTokenCredentialId);
      verificationTokenCredentialId = stored.id;
    }
    if (input.encryptKey !== undefined && input.encryptKey !== '') {
      const stored = await storeAdapterSecret(tx, adapterId, name, 'encrypt_key', input.encryptKey);
      if (encryptKeyCredentialId) oldSecretIds.push(encryptKeyCredentialId);
      encryptKeyCredentialId = stored.id;
    }
    await tx.update(schema.interactionAdapters).set({
      deviceId,
      name,
      enabled: input.enabled === undefined ? existing.enabled : input.enabled,
      appId: input.appId === undefined ? existing.appId : normalizeText(input.appId, '飞书 App ID', 256),
      appSecretCredentialId,
      verificationTokenCredentialId,
      encryptKeyCredentialId,
      apiBaseUrl: input.apiBaseUrl === undefined ? existing.apiBaseUrl : normalizeApiBaseUrl(input.apiBaseUrl),
      receiveIdType: input.receiveIdType === undefined ? existing.receiveIdType : normalizeReceiveIdType(input.receiveIdType),
      receiveId: input.receiveId === undefined ? existing.receiveId : normalizeText(input.receiveId, '飞书接收目标', 512),
      consoleBaseUrl: input.consoleBaseUrl === undefined ? existing.consoleBaseUrl : normalizeConsoleBaseUrl(input.consoleBaseUrl),
      operatorAllowlist: input.operatorAllowlist === undefined
        ? existing.operatorAllowlist
        : JSON.stringify(normalizeOperatorAllowlist(input.operatorAllowlist)),
      lastError: null,
      updatedAt: nowIso,
    }).where(eq(schema.interactionAdapters.id, adapterId)).run();
    if (oldSecretIds.length > 0) {
      await tx.update(schema.credentialVaultItems).set({
        status: 'revoked',
        revokedAt: nowIso,
        updatedAt: nowIso,
      }).where(inArray(schema.credentialVaultItems.id, oldSecretIds)).run();
    }
    const updated = await tx.select().from(schema.interactionAdapters)
      .where(eq(schema.interactionAdapters.id, adapterId)).get();
    if (!updated) throw new Error('飞书 Interaction Adapter 更新失败');
    return updated;
  });
  tenantTokenCache.delete(adapterId);
  return toPublicAdapter(row);
}

export async function listFeishuInteractionAdapters(input: {
  deviceId?: unknown;
} = {}): Promise<FeishuInteractionAdapterPublic[]> {
  const filters: SQL<unknown>[] = [eq(schema.interactionAdapters.kind, 'feishu')];
  if (input.deviceId !== undefined && input.deviceId !== '') {
    const deviceId = normalizeText(input.deviceId, 'Connector 设备 ID', 128);
    filters.push(eq(schema.interactionAdapters.deviceId, deviceId));
  }
  const rows = await db.select().from(schema.interactionAdapters)
    .where(and(...filters))
    .orderBy(desc(schema.interactionAdapters.createdAt), desc(schema.interactionAdapters.id))
    .all();
  return rows.map(toPublicAdapter);
}

export async function getFeishuInteractionAdapter(adapterIdInput: unknown): Promise<FeishuInteractionAdapterPublic | null> {
  const adapterId = normalizeText(adapterIdInput, 'Adapter ID', 128);
  const row = await db.select().from(schema.interactionAdapters)
    .where(and(eq(schema.interactionAdapters.id, adapterId), eq(schema.interactionAdapters.kind, 'feishu')))
    .get();
  return row ? toPublicAdapter(row) : null;
}

async function resolvePromptCardContext(input: {
  contextTaskId?: unknown;
  deviceId?: unknown;
  threadId?: unknown;
}): Promise<Readonly<{
  contextTaskId: string | null;
  deviceId: string;
  threadId: string;
  threadStatus: CodexThreadStatus;
  activeFlags: readonly CodexThreadActiveFlag[];
  activeTurnId: string | null;
}>> {
  const contextTaskId = input.contextTaskId == null || input.contextTaskId === ''
    ? null
    : normalizeText(input.contextTaskId, 'Bridge 上下文任务 ID', 128);
  const contextTask = contextTaskId ? await getBridgeContinuationTask(contextTaskId) : null;
  if (contextTaskId && !contextTask) throw new Error('Bridge 上下文任务不存在');
  if (contextTask && !contextTask.deviceId) throw new Error('Bridge 上下文任务缺少 Connector 设备');
  const explicitDeviceId = input.deviceId == null || input.deviceId === ''
    ? null
    : normalizeText(input.deviceId, 'Connector 设备 ID', 128);
  const explicitThreadId = input.threadId == null || input.threadId === ''
    ? null
    : normalizeText(input.threadId, 'Codex Thread ID', 512);
  const deviceId = explicitDeviceId || contextTask?.deviceId || '';
  const threadId = explicitThreadId || contextTask?.state.threadId || '';
  if (!deviceId || !threadId) throw new Error('必须选择 Bridge 上下文或同时填写 Connector 设备与 Thread ID');
  if (contextTask && contextTask.deviceId !== deviceId) throw new Error('Bridge 上下文设备不匹配');
  if (contextTask && contextTask.state.threadId !== threadId) throw new Error('Bridge 上下文 Thread 不匹配');
  const device = await db.select().from(schema.localConnectorDevices)
    .where(eq(schema.localConnectorDevices.id, deviceId)).get();
  if (!device || device.status !== 'active') throw new Error('Connector 设备不存在或已撤销');
  if (!parseStringArray(device.scopes).includes('app_server.control')) {
    throw new Error('Connector 设备缺少 app_server.control 权限');
  }
  const observed = await db.select().from(schema.localConnectorThreads).where(and(
    eq(schema.localConnectorThreads.deviceId, deviceId),
    eq(schema.localConnectorThreads.threadId, threadId),
  )).get();
  if (!observed) throw new Error('Codex 会话不属于此 Connector，或尚未被本地 Connector 观测到');
  return Object.freeze({
    contextTaskId,
    deviceId,
    threadId,
    threadStatus: observedThreadStatus(observed.threadStatus),
    activeFlags: Object.freeze(observedThreadActiveFlags(observed.activeFlags)),
    activeTurnId: observed.activeTurnId,
  });
}

async function promptCardDispatch(
  executor: DbExecutor,
  promptCardId: string,
): Promise<DispatchRow | null> {
  return await executor.select().from(schema.interactionDispatches).where(and(
    eq(schema.interactionDispatches.subjectKind, 'prompt_card'),
    eq(schema.interactionDispatches.promptCardId, promptCardId),
  )).get() || null;
}

async function latestCardUpdate(
  executor: DbExecutor,
  dispatchId: string,
): Promise<CardUpdateRow | null> {
  return await executor.select().from(schema.interactionCardUpdates)
    .where(eq(schema.interactionCardUpdates.dispatchId, dispatchId))
    .orderBy(
      desc(schema.interactionCardUpdates.subjectRevision),
      desc(schema.interactionCardUpdates.createdAt),
      desc(schema.interactionCardUpdates.id),
    )
    .get() || null;
}

async function publicPromptCard(
  executor: DbExecutor,
  row: PromptCardRow,
): Promise<FeishuBridgePromptCardPublic> {
  const dispatch = await promptCardDispatch(executor, row.id);
  return toPublicPromptCard(
    row,
    dispatch,
    dispatch ? await latestCardUpdate(executor, dispatch.id) : null,
  );
}

function assertPromptCardIdempotencyMatch(row: PromptCardRow, requestFingerprint: string): void {
  if (row.requestFingerprint !== requestFingerprint) {
    throw new Error('同一 Prompt 卡片幂等键不能用于不同请求');
  }
}

export async function createFeishuBridgePromptCard(input: {
  adapterId: unknown;
  contextTaskId?: unknown;
  deviceId?: unknown;
  threadId?: unknown;
  ttlMs?: unknown;
  requestedBy?: unknown;
  idempotencyKey: unknown;
  now?: Date | number;
}): Promise<Readonly<{
  created: boolean;
  card: FeishuBridgePromptCardPublic;
}>> {
  const adapterId = normalizeText(input.adapterId, 'Adapter ID', 128);
  const adapter = await db.select().from(schema.interactionAdapters).where(and(
    eq(schema.interactionAdapters.id, adapterId),
    eq(schema.interactionAdapters.kind, 'feishu'),
    eq(schema.interactionAdapters.enabled, true),
  )).get();
  if (!adapter) throw new Error('飞书 Interaction Adapter 不存在或已停用');
  const context = await resolvePromptCardContext(input);
  if (!adapter.deviceId) throw new Error('飞书 Interaction Adapter 尚未绑定 Connector');
  if (adapter.deviceId !== context.deviceId) throw new Error('飞书 Interaction Adapter 与 Connector 设备不匹配');
  const ttlMs = normalizePromptCardTtlMs(input.ttlMs);
  const requestedBy = input.requestedBy == null || input.requestedBy === ''
    ? 'webui:admin'
    : normalizeText(input.requestedBy, 'Prompt 卡片操作者', 300);
  const idempotencyKey = normalizeText(input.idempotencyKey, 'Prompt 卡片幂等键', 256);
  const requestIdempotencyKeyHash = hashNamespaced(PROMPT_CARD_IDEMPOTENCY_NAMESPACE, idempotencyKey);
  const requestFingerprint = promptCardRequestFingerprint({
    adapterId,
    deviceId: context.deviceId,
    threadId: context.threadId,
    contextTaskId: context.contextTaskId,
    requestedBy,
    ttlMs,
  });
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const id = randomUUID();

  try {
    return await db.transaction(async (tx: DbExecutor) => {
      const existing = await tx.select().from(schema.interactionPromptCards)
        .where(eq(schema.interactionPromptCards.requestIdempotencyKeyHash, requestIdempotencyKeyHash)).get();
      if (existing) {
        assertPromptCardIdempotencyMatch(existing, requestFingerprint);
        return Object.freeze({
          created: false,
          card: await publicPromptCard(tx, existing),
        });
      }
      await tx.insert(schema.interactionPromptCards).values({
        id,
        adapterId,
        deviceId: context.deviceId,
        threadId: context.threadId,
        contextTaskId: context.contextTaskId,
        status: 'pending',
        expiresAt,
        requestedBy,
        requestIdempotencyKeyHash,
        requestFingerprint,
        stateVersion: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      await tx.insert(schema.interactionDispatches).values({
        id: randomUUID(),
        subjectKind: 'prompt_card',
        interactionId: null,
        promptCardId: id,
        adapterId,
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).run();
      const inserted = await tx.select().from(schema.interactionPromptCards)
        .where(eq(schema.interactionPromptCards.id, id)).get();
      if (!inserted) throw new Error('飞书 Prompt 卡片创建失败');
      return Object.freeze({
        created: true,
        card: await publicPromptCard(tx, inserted),
      });
    });
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    const existing = await db.select().from(schema.interactionPromptCards)
      .where(eq(schema.interactionPromptCards.requestIdempotencyKeyHash, requestIdempotencyKeyHash)).get();
    if (!existing) throw error;
    assertPromptCardIdempotencyMatch(existing, requestFingerprint);
    return Object.freeze({
      created: false,
      card: await publicPromptCard(db, existing),
    });
  }
}

export async function expireFeishuBridgePromptCards(nowInput: Date | number = new Date()): Promise<number> {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowIso = now.toISOString();
  const candidates = await db.select().from(schema.interactionPromptCards).where(and(
    eq(schema.interactionPromptCards.status, 'pending'),
    lte(schema.interactionPromptCards.expiresAt, nowIso),
  )).orderBy(asc(schema.interactionPromptCards.expiresAt)).limit(500).all();
  let expired = 0;
  for (const candidate of candidates) {
    const changed = await db.transaction(async (tx: DbExecutor) => {
      const result = await tx.update(schema.interactionPromptCards).set({
        status: 'expired',
        updatedAt: nowIso,
        stateVersion: sql`${schema.interactionPromptCards.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionPromptCards.id, candidate.id),
        eq(schema.interactionPromptCards.status, 'pending'),
        eq(schema.interactionPromptCards.stateVersion, candidate.stateVersion),
      )).run();
      if (affectedRows(result) <= 0) return false;
      await tx.update(schema.interactionActionTickets).set({
        status: 'expired',
        updatedAt: nowIso,
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionActionTickets.promptCardId, candidate.id),
        eq(schema.interactionActionTickets.status, 'pending'),
      )).run();
      await tx.update(schema.interactionDispatches).set({
        status: 'cancelled',
        lastError: 'prompt card expired',
        updatedAt: nowIso,
      }).where(and(
        eq(schema.interactionDispatches.promptCardId, candidate.id),
        inArray(schema.interactionDispatches.status, ['pending', 'failed', 'delivery_unknown']),
      )).run();
      return true;
    });
    if (changed) expired += 1;
  }
  return expired;
}

export async function listFeishuBridgePromptCards(input: {
  adapterId?: unknown;
  status?: unknown;
  limit?: number;
  now?: Date | number;
} = {}): Promise<FeishuBridgePromptCardPublic[]> {
  await expireFeishuBridgePromptCards(input.now);
  const conditions: SQL<unknown>[] = [];
  if (input.adapterId !== undefined) {
    conditions.push(eq(schema.interactionPromptCards.adapterId, normalizeText(input.adapterId, 'Adapter ID', 128)));
  }
  if (input.status !== undefined && input.status !== '') {
    const status = normalizeText(input.status, 'Prompt 卡片状态', 32);
    if (!PROMPT_CARD_STATUSES.has(status)) throw new Error('Prompt 卡片状态无效');
    conditions.push(eq(schema.interactionPromptCards.status, status));
  }
  const rows = await db.select().from(schema.interactionPromptCards)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.interactionPromptCards.createdAt), desc(schema.interactionPromptCards.id))
    .limit(Math.min(200, Math.max(1, Math.trunc(input.limit || 50))))
    .all();
  return await Promise.all(rows.map(async (row) => await publicPromptCard(db, row)));
}

export async function cancelFeishuBridgePromptCard(
  promptCardIdInput: unknown,
  nowInput: Date | number = new Date(),
): Promise<FeishuBridgePromptCardPublic | null> {
  const promptCardId = normalizeText(promptCardIdInput, 'Prompt 卡片 ID', 128);
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowIso = now.toISOString();
  return await db.transaction(async (tx: DbExecutor) => {
    const row = await tx.select().from(schema.interactionPromptCards)
      .where(eq(schema.interactionPromptCards.id, promptCardId)).get();
    if (!row) return null;
    if (row.status === 'pending') {
      const result = await tx.update(schema.interactionPromptCards).set({
        status: 'cancelled',
        updatedAt: nowIso,
        stateVersion: sql`${schema.interactionPromptCards.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionPromptCards.id, row.id),
        eq(schema.interactionPromptCards.status, 'pending'),
        eq(schema.interactionPromptCards.stateVersion, row.stateVersion),
      )).run();
      if (affectedRows(result) <= 0) throw new Error('Prompt 卡片已被并发处理');
      await tx.update(schema.interactionActionTickets).set({
        status: 'cancelled',
        updatedAt: nowIso,
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionActionTickets.promptCardId, row.id),
        eq(schema.interactionActionTickets.status, 'pending'),
      )).run();
      await tx.update(schema.interactionDispatches).set({
        status: 'cancelled',
        lastError: 'prompt card cancelled',
        updatedAt: nowIso,
      }).where(and(
        eq(schema.interactionDispatches.promptCardId, row.id),
        inArray(schema.interactionDispatches.status, ['pending', 'failed', 'delivery_unknown']),
      )).run();
    }
    const updated = await tx.select().from(schema.interactionPromptCards)
      .where(eq(schema.interactionPromptCards.id, row.id)).get();
    return updated ? await publicPromptCard(tx, updated) : null;
  });
}

export async function listFeishuInteractionDispatches(input: {
  adapterId?: unknown;
  interactionId?: unknown;
  promptCardId?: unknown;
  subjectKind?: unknown;
  limit?: number;
} = {}): Promise<FeishuInteractionDispatchPublic[]> {
  const conditions: SQL<unknown>[] = [];
  if (input.adapterId !== undefined) {
    conditions.push(eq(schema.interactionDispatches.adapterId, normalizeText(input.adapterId, 'Adapter ID', 128)));
  }
  if (input.interactionId !== undefined) {
    conditions.push(eq(schema.interactionDispatches.interactionId, normalizeText(input.interactionId, 'Interaction ID', 128)));
  }
  if (input.promptCardId !== undefined) {
    conditions.push(eq(schema.interactionDispatches.promptCardId, normalizeText(input.promptCardId, 'Prompt 卡片 ID', 128)));
  }
  if (input.subjectKind !== undefined && input.subjectKind !== '') {
    const subjectKind = normalizeText(input.subjectKind, '投递 Subject 类型', 32);
    if (subjectKind !== 'interaction' && subjectKind !== 'prompt_card') throw new Error('投递 Subject 类型无效');
    conditions.push(eq(schema.interactionDispatches.subjectKind, subjectKind));
  }
  const rows = await db.select().from(schema.interactionDispatches)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.interactionDispatches.createdAt), desc(schema.interactionDispatches.id))
    .limit(Math.min(200, Math.max(1, Math.trunc(input.limit || 50))))
    .all();
  return await Promise.all(rows.map(async (row) => toPublicDispatch(
    row,
    await latestCardUpdate(db, row.id),
  )));
}

export async function reconcileFeishuInteractionDispatches(nowInput: Date | number = new Date()): Promise<number> {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowIso = now.toISOString();
  await expireInteractionRequests(now);
  await expireFeishuBridgePromptCards(now);
  const [adapters, interactions] = await Promise.all([
    db.select({ id: schema.interactionAdapters.id, deviceId: schema.interactionAdapters.deviceId })
      .from(schema.interactionAdapters)
      .where(and(eq(schema.interactionAdapters.kind, 'feishu'), eq(schema.interactionAdapters.enabled, true))).all(),
    db.select({ id: schema.interactionRequests.id, deviceId: schema.interactionRequests.deviceId })
      .from(schema.interactionRequests)
      .where(and(
        eq(schema.interactionRequests.status, 'pending'),
        gt(schema.interactionRequests.expiresAt, nowIso),
      )).orderBy(asc(schema.interactionRequests.createdAt)).limit(200).all(),
  ]);
  let created = 0;
  for (const adapter of adapters) {
    if (!adapter.deviceId) continue;
    for (const interaction of interactions) {
      if (interaction.deviceId !== adapter.deviceId) continue;
      const existing = await db.select({ id: schema.interactionDispatches.id })
        .from(schema.interactionDispatches)
        .where(and(
          eq(schema.interactionDispatches.adapterId, adapter.id),
          eq(schema.interactionDispatches.interactionId, interaction.id),
        )).get();
      if (existing) continue;
      try {
        await db.insert(schema.interactionDispatches).values({
          id: randomUUID(),
          subjectKind: 'interaction',
          interactionId: interaction.id,
          promptCardId: null,
          adapterId: adapter.id,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: nowIso,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).run();
        created += 1;
      } catch (error) {
        if (!looksLikeUniqueCollision(error)) throw error;
      }
    }
  }
  return created;
}

async function closePendingTicketsForCardTarget(
  dispatch: DispatchRow,
  targetStatus: string,
  nowIso: string,
): Promise<void> {
  const ticketStatus = targetStatus === 'expired' ? 'expired' : 'cancelled';
  await db.update(schema.interactionActionTickets).set({
    status: ticketStatus,
    updatedAt: nowIso,
    stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
  }).where(and(
    eq(schema.interactionActionTickets.dispatchId, dispatch.id),
    eq(schema.interactionActionTickets.status, 'pending'),
  )).run();
}

async function ensureCardUpdateForDispatch(
  dispatch: DispatchRow,
  now: Date,
): Promise<boolean> {
  if (dispatch.status !== 'delivered' || !dispatch.externalMessageId || !dispatch.deliveredAt) return false;
  const target = await currentCardUpdateTarget(dispatch);
  if (!target) return false;
  const nowIso = now.toISOString();
  await closePendingTicketsForCardTarget(dispatch, target.targetStatus, nowIso);
  const adapter = await db.select({ enabled: schema.interactionAdapters.enabled })
    .from(schema.interactionAdapters)
    .where(eq(schema.interactionAdapters.id, dispatch.adapterId)).get();
  if (!adapter?.enabled) return false;
  const fingerprint = cardFingerprint(target.card);
  const deliveredAtMs = Date.parse(dispatch.deliveredAt);
  if (!Number.isFinite(deliveredAtMs)) return false;
  const deadlineAt = new Date(deliveredAtMs + CARD_UPDATE_WINDOW_MS).toISOString();

  await db.update(schema.interactionCardUpdates).set({
    status: 'cancelled',
    lastError: `superseded by ${target.targetStatus}`,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionCardUpdates.dispatchId, dispatch.id),
    ne(schema.interactionCardUpdates.cardFingerprint, fingerprint),
    inArray(schema.interactionCardUpdates.status, ['pending', 'failed', 'delivery_unknown']),
  )).run();

  const existing = await db.select().from(schema.interactionCardUpdates).where(and(
    eq(schema.interactionCardUpdates.dispatchId, dispatch.id),
    eq(schema.interactionCardUpdates.cardFingerprint, fingerprint),
  )).get();
  if (existing) {
    if (existing.status === 'cancelled' && deadlineAt > nowIso) {
      const requeued = await db.update(schema.interactionCardUpdates).set({
        status: 'pending',
        subjectRevision: target.subjectRevision,
        targetStatus: target.targetStatus,
        nextAttemptAt: nowIso,
        deadlineAt,
        lastError: null,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: nowIso,
      }).where(and(
        eq(schema.interactionCardUpdates.id, existing.id),
        eq(schema.interactionCardUpdates.status, 'cancelled'),
      )).run();
      return affectedRows(requeued) > 0;
    }
    return false;
  }

  try {
    await db.insert(schema.interactionCardUpdates).values({
      id: randomUUID(),
      dispatchId: dispatch.id,
      subjectRevision: target.subjectRevision,
      targetStatus: target.targetStatus,
      cardFingerprint: fingerprint,
      status: deadlineAt > nowIso ? 'pending' : 'failed',
      attemptCount: 0,
      nextAttemptAt: nowIso,
      deadlineAt,
      lastError: deadlineAt > nowIso ? null : '飞书卡片已超过 14 天更新期限',
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();
    return true;
  } catch (error) {
    if (!looksLikeUniqueCollision(error)) throw error;
    return false;
  }
}

export async function reconcileFeishuCardUpdates(nowInput: Date | number = new Date()): Promise<number> {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const dispatches = await db.select().from(schema.interactionDispatches).where(and(
    eq(schema.interactionDispatches.status, 'delivered'),
    sql`${schema.interactionDispatches.externalMessageId} is not null`,
    sql`${schema.interactionDispatches.deliveredAt} is not null`,
  )).orderBy(asc(schema.interactionDispatches.deliveredAt)).all();
  let reconciled = 0;
  for (const dispatch of dispatches) {
    if (await ensureCardUpdateForDispatch(dispatch, now)) reconciled += 1;
  }
  return reconciled;
}

function signingKey(): Buffer {
  const secret = (config.accountCredentialSecret || '').trim()
    || (config.authToken || '').trim()
    || 'change-me-admin-token';
  return createHash('sha256').update('metapi-interaction-action\0').update(secret).digest();
}

function topicPromptSignature(adapterId: string, bindingId: string): string {
  return createHmac('sha256', signingKey())
    .update('feishu-topic-prompt\0')
    .update(adapterId)
    .update('\0')
    .update(bindingId)
    .digest('base64url');
}

function buildTopicPromptToken(adapterId: string, bindingId: string): string {
  return `${FEISHU_TOPIC_PROMPT_PREFIX}${bindingId}.${topicPromptSignature(adapterId, bindingId)}`;
}

function parseTopicPromptToken(tokenInput: unknown): { bindingId: string; token: string } {
  const token = normalizeText(tokenInput, '飞书话题 Prompt 票据', 512);
  const match = new RegExp(`^${FEISHU_TOPIC_PROMPT_PREFIX}([a-f0-9-]{36})\.([a-zA-Z0-9_-]{20,128})$`).exec(token);
  if (!match) throw new Error('飞书话题 Prompt 票据格式无效');
  return { bindingId: match[1]!, token };
}

function verifyTopicPromptToken(adapterId: string, tokenInput: unknown): string {
  const parsed = parseTopicPromptToken(tokenInput);
  const expected = topicPromptSignature(adapterId, parsed.bindingId);
  if (!safeEqualSecret(parsed.token.slice(parsed.token.indexOf('.') + 1), expected)) {
    throw new Error('飞书话题 Prompt 票据签名无效');
  }
  return parsed.bindingId;
}

function ticketSignature(ticketId: string, expiresAtSec: number): string {
  return createHmac('sha256', signingKey())
    .update(ticketId)
    .update('.')
    .update(String(expiresAtSec))
    .digest('base64url');
}

function buildTicketToken(ticketId: string, expiresAtMs: number): string {
  const expiresAtSec = Math.floor(expiresAtMs / 1_000);
  return `${ACTION_TICKET_PREFIX}${ticketId}.${expiresAtSec}.${ticketSignature(ticketId, expiresAtSec)}`;
}

function parseAndVerifyTicketToken(tokenInput: unknown, nowMs = Date.now()): {
  ticketId: string;
  token: string;
  expiresAtMs: number;
  expired: boolean;
} {
  const token = normalizeText(tokenInput, 'Interaction 动作票据', 512);
  const match = /^mit_([a-f0-9-]{36})\.(\d{1,12})\.([a-zA-Z0-9_-]{20,128})$/.exec(token);
  if (!match) throw new Error('Interaction 动作票据格式无效');
  const ticketId = match[1];
  const expiresAtSec = Number(match[2]);
  const expiresAtMs = expiresAtSec * 1_000;
  const expected = ticketSignature(ticketId, expiresAtSec);
  const providedBuffer = Buffer.from(match[3]);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new Error('Interaction 动作票据签名无效');
  }
  if (!Number.isFinite(expiresAtMs)) throw new Error('Interaction 动作票据过期时间无效');
  return { ticketId, token, expiresAtMs, expired: expiresAtMs <= nowMs };
}

function tokenHash(token: string): string {
  return createHash('sha256').update('interaction-action-ticket\0').update(token).digest('hex');
}

function safeActionKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 120) || 'action';
}

function actionSpecs(interaction: InteractionRequestRecord): ActionSpec[] {
  const kind = interaction.state.kind;
  const payload = interaction.requestPayload;
  if (kind === 'command_approval' || kind === 'file_change_approval') {
    const available = Array.isArray(payload.availableDecisions)
      ? payload.availableDecisions.filter((item): item is string => typeof item === 'string')
      : ['accept', 'acceptForSession', 'decline', 'cancel'];
    const labels: Record<string, { label: string; tone: ActionSpec['tone'] }> = {
      accept: { label: '允许', tone: 'primary' },
      acceptForSession: { label: '本会话允许', tone: 'default' },
      decline: { label: '拒绝', tone: 'danger' },
      cancel: { label: '取消', tone: 'default' },
    };
    return [...new Set(available)].flatMap((decision) => {
      const meta = labels[decision];
      return meta ? [{
        key: `decision:${decision}`,
        label: meta.label,
        tone: meta.tone,
        responsePayload: { decision },
      }] : [];
    }).slice(0, 4);
  }
  if (kind === 'permissions_approval') {
    const permissions = isRecord(payload.permissions)
      ? payload.permissions
      : isRecord(payload.requestedPermissions)
        ? payload.requestedPermissions
        : {};
    return [
      { key: 'permissions:turn', label: '允许本次', tone: 'primary', responsePayload: { permissions, scope: 'turn' } },
      { key: 'permissions:session', label: '允许本会话', tone: 'default', responsePayload: { permissions, scope: 'session' } },
      { key: 'permissions:deny', label: '不授权', tone: 'danger', responsePayload: { permissions: {}, scope: 'turn' } },
    ];
  }
  if (kind === 'user_input') {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    if (questions.length !== 1 || !isRecord(questions[0]) || typeof questions[0].id !== 'string') return [];
    const question = questions[0];
    const questionId = question.id as string;
    const options = Array.isArray(question.options) ? question.options : [];
    return options.flatMap((option) => {
      if (!isRecord(option) || typeof option.label !== 'string' || option.isOther === true) return [];
      return [{
        key: safeActionKey(`answer:${questionId}:${option.label}`),
        label: option.label.slice(0, 40),
        tone: 'default' as const,
        responsePayload: { answers: { [questionId]: { answers: [option.label] } } },
      }];
    }).slice(0, 4);
  }
  return [
    { key: 'mcp:decline', label: '拒绝', tone: 'danger', responsePayload: { action: 'decline', content: null } },
    { key: 'mcp:cancel', label: '取消', tone: 'default', responsePayload: { action: 'cancel', content: null } },
  ];
}

function bridgePromptActionSpecs(enabled = true): ActionSpec[] {
  if (!enabled) return [];
  return [
    {
      key: `${BRIDGE_PROMPT_ACTION_PREFIX}steer_current`,
      label: '补充当前轮',
      tone: 'primary',
      responsePayload: { metapiAction: 'bridge_prompt', submissionMode: 'steer_current' },
    },
    {
      key: `${BRIDGE_PROMPT_ACTION_PREFIX}start_next`,
      label: '下一轮发送',
      tone: 'default',
      responsePayload: { metapiAction: 'bridge_prompt', submissionMode: 'start_next' },
    },
  ];
}

function truncateText(value: unknown, maximum: number): string {
  const normalized = typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').trim()
    : '';
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 3))}...`;
}

function compactCardHeader(subjectInput: unknown, statusInput: unknown, maximum = 72): string {
  const subject = truncateText(subjectInput, maximum) || 'Codex 会话';
  const status = truncateText(statusInput, 24);
  if (!status) return truncateText(subject, maximum);
  const suffix = ` · ${status}`;
  return `${truncateText(subject, Math.max(12, maximum - suffix.length))}${suffix}`;
}

function formatCardDateTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function observedThreadTitle(deviceId: string, threadId: string | null): Promise<string | null> {
  if (!threadId) return null;
  const row = await db.select({ title: schema.localConnectorThreads.title })
    .from(schema.localConnectorThreads)
    .where(and(
      eq(schema.localConnectorThreads.deviceId, deviceId),
      eq(schema.localConnectorThreads.threadId, threadId),
    ))
    .get();
  return truncateText(row?.title, 120) || null;
}

function interactionSummary(interaction: InteractionRequestRecord): string {
  const payload = interaction.requestPayload;
  if (interaction.state.kind === 'command_approval') {
    const command = Array.isArray(payload.command)
      ? payload.command.filter((part): part is string => typeof part === 'string').join(' ')
      : payload.command;
    return truncateText(command, 800) || 'Codex 请求执行命令';
  }
  if (interaction.state.kind === 'file_change_approval') {
    return truncateText(payload.reason, 800) || 'Codex 请求应用文件变更';
  }
  if (interaction.state.kind === 'permissions_approval') {
    return truncateText(payload.reason, 800) || 'Codex 请求运行权限';
  }
  if (interaction.state.kind === 'user_input') {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const first = isRecord(questions[0]) ? questions[0] : {};
    return truncateText(first.question, 800) || 'Codex 等待用户输入';
  }
  return truncateText(payload.message, 800) || 'MCP Server 请求交互';
}

function kindTitle(kind: InteractionRequestRecord['state']['kind']): string {
  return {
    command_approval: '命令审批',
    file_change_approval: '文件变更审批',
    permissions_approval: '权限审批',
    user_input: 'Codex 等待输入',
    mcp_elicitation: 'MCP 交互',
  }[kind];
}

function interactionSummaryLabel(kind: InteractionRequestRecord['state']['kind']): string {
  return {
    command_approval: '待执行命令',
    file_change_approval: '变更说明',
    permissions_approval: '权限用途',
    user_input: '等待回答',
    mcp_elicitation: '交互内容',
  }[kind];
}

function interactionContextLines(interaction: InteractionRequestRecord): string[] {
  const payload = interaction.requestPayload;
  const cwd = truncateText(
    payload.cwd || payload.workingDirectory || payload.working_directory,
    240,
  );
  const reason = interaction.state.kind === 'command_approval'
    ? truncateText(payload.reason, 320)
    : '';
  return [
    cwd ? `**工作目录**  ${escapeNotificationMarkdown(cwd)}` : null,
    reason ? `**申请原因**  ${escapeNotificationMarkdown(reason)}` : null,
    `**有效至**  ${formatCardDateTime(interaction.state.expiresAtMs)}`,
  ].filter((line): line is string => Boolean(line));
}

async function prepareActionTicketsForSubject(
  dispatch: DispatchRow,
  subject: { interactionId: string | null; promptCardId: string | null },
  specs: ActionSpec[],
  subjectExpiresAtMs: number,
): Promise<Array<ActionSpec & { token: string }>> {
  const expiresAtMs = Math.min(
    subjectExpiresAtMs,
    Date.now() + ACTION_TICKET_MAX_AGE_MS,
  );
  const nowIso = new Date().toISOString();
  return await db.transaction(async (tx: DbExecutor) => {
    const prepared: Array<ActionSpec & { token: string }> = [];
    for (const spec of specs) {
      const actionKey = safeActionKey(spec.key);
      const existing = await tx.select().from(schema.interactionActionTickets)
        .where(and(
          eq(schema.interactionActionTickets.dispatchId, dispatch.id),
          eq(schema.interactionActionTickets.actionKey, actionKey),
        )).get();
      const ticketId = existing?.id || randomUUID();
      const token = buildTicketToken(ticketId, expiresAtMs);
      const values = {
        interactionId: subject.interactionId,
        promptCardId: subject.promptCardId,
        adapterId: dispatch.adapterId,
        actionKey,
        tokenHash: tokenHash(token),
        responsePayload: JSON.stringify(spec.responsePayload),
        status: 'pending',
        expiresAt: new Date(expiresAtMs).toISOString(),
        consumedAt: null,
        consumedBy: null,
        updatedAt: nowIso,
      };
      if (existing) {
        await tx.update(schema.interactionActionTickets).set({
          ...values,
          stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
        }).where(eq(schema.interactionActionTickets.id, ticketId)).run();
      } else {
        await tx.insert(schema.interactionActionTickets).values({
          id: ticketId,
          dispatchId: dispatch.id,
          ...values,
          stateVersion: 1,
          createdAt: nowIso,
        }).run();
      }
      prepared.push({ ...spec, token });
    }
    return prepared;
  });
}

async function prepareInteractionActionTickets(
  dispatch: DispatchRow,
  interaction: InteractionRequestRecord,
): Promise<Array<ActionSpec & { token: string }>> {
  return await prepareActionTicketsForSubject(
    dispatch,
    { interactionId: interaction.state.requestId, promptCardId: null },
    [...actionSpecs(interaction), ...bridgePromptActionSpecs(Boolean(interaction.state.threadId))],
    interaction.state.expiresAtMs,
  );
}

async function preparePromptCardActionTickets(
  dispatch: DispatchRow,
  promptCard: PromptCardRow,
): Promise<Array<ActionSpec & { token: string }>> {
  return await prepareActionTicketsForSubject(
    dispatch,
    { interactionId: null, promptCardId: promptCard.id },
    bridgePromptActionSpecs(),
    Date.parse(promptCard.expiresAt),
  );
}

function buildBridgePromptForm(
  promptActions: Array<ActionSpec & { token: string }>,
  options: { label?: string; placeholder?: string } = {},
): Record<string, unknown> | null {
  if (promptActions.length === 0) return null;
  return {
    tag: 'form',
    name: 'metapi_prompt_form',
    elements: [
      {
        tag: 'input',
        name: BRIDGE_PROMPT_INPUT_NAME,
        input_type: 'multiline_text',
        required: true,
        // Feishu interactive card inputs default to a 1,000-character limit.
        // Keep the card contract within that limit; console/API prompts still
        // retain their independent 4,000-character validation.
        max_length: 1_000,
        placeholder: { tag: 'plain_text', content: options.placeholder || '输入要发送给 Codex 的消息' },
        label: { tag: 'plain_text', content: options.label || '补充消息（可选）' },
      },
      ...promptActions.map((action) => ({
        tag: 'button',
        action_type: 'form_submit',
        name: action.key.endsWith('steer_current') ? 'metapi_prompt_steer' : 'metapi_prompt_next',
        text: { tag: 'lark_md', content: action.label },
        type: action.tone === 'primary' ? 'primary' : 'default',
        value: { metapi_ticket: action.token },
      })),
    ],
    fallback: {
      tag: 'fallback_text',
      text: { tag: 'plain_text', content: '请升级飞书客户端后使用 Prompt 表单' },
    },
  };
}

function buildFeishuInteractionCard(
  adapter: AdapterRow,
  interaction: InteractionRequestRecord,
  actions: Array<ActionSpec & { token: string }>,
  threadTitle: string | null,
): Record<string, unknown> {
  const consoleUrl = adapter.consoleBaseUrl
    ? `${adapter.consoleBaseUrl}/interactions?request=${encodeURIComponent(interaction.state.requestId)}`
    : null;
  const responseActions = actions.filter((action) => !action.key.startsWith(BRIDGE_PROMPT_ACTION_PREFIX));
  const promptActions = actions.filter((action) => action.key.startsWith(BRIDGE_PROMPT_ACTION_PREFIX));
  const responseButtons = responseActions.map((action) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: action.label },
    type: action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : 'default',
    value: { metapi_ticket: action.token },
  }));
  const promptForm = buildBridgePromptForm(promptActions, {
    label: '补充给 Codex（可选）',
    placeholder: '输入补充说明或下一步要求',
  });
  const sessionTitle = threadTitle || 'Codex 会话';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: interaction.state.kind === 'command_approval' || interaction.state.kind === 'permissions_approval'
        ? 'orange'
        : 'blue',
      title: {
        tag: 'plain_text',
        content: compactCardHeader(sessionTitle, kindTitle(interaction.state.kind)),
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**${interactionSummaryLabel(interaction.state.kind)}**`,
            escapeNotificationMarkdown(interactionSummary(interaction)),
            '',
            ...interactionContextLines(interaction),
          ].join('\n').trim(),
        },
      },
      ...(responseButtons.length > 0 ? [{ tag: 'action', actions: responseButtons.slice(0, 4) }] : []),
      ...(promptForm ? [promptForm] : []),
      ...(consoleUrl ? [{
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '在控制台查看' },
          type: 'default',
          url: consoleUrl,
          value: {},
        }],
      }] : []),
    ],
  };
}

function buildFeishuPromptCard(
  adapter: AdapterRow,
  promptCard: PromptCardRow,
  actions: Array<ActionSpec & { token: string }>,
  threadTitle: string | null,
): Record<string, unknown> {
  const consoleUrl = adapter.consoleBaseUrl
    ? `${adapter.consoleBaseUrl}/bridge-continuations${promptCard.contextTaskId
      ? `?task=${encodeURIComponent(promptCard.contextTaskId)}`
      : ''}`
    : null;
  const promptForm = buildBridgePromptForm(actions, {
    label: '发送消息',
    placeholder: '输入下一条要发送给 Codex 的消息',
  });
  const sessionTitle = threadTitle || 'Codex 会话';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: compactCardHeader(sessionTitle, '继续对话') },
    },
    elements: [
      ...(promptForm ? [promptForm] : []),
      ...(consoleUrl ? [{
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '在控制台查看' },
          type: 'default',
          url: consoleUrl,
          value: {},
        }],
      }] : []),
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `有效至 ${formatCardDateTime(promptCard.expiresAt)}` }],
      },
    ],
  };
}

type CardUpdateTarget = Readonly<{
  subjectRevision: number;
  targetStatus: string;
  card: Record<string, unknown>;
}>;

function interactionStatusPresentation(status: InteractionRequestRecord['state']['status']): {
  label: string;
  detail: string;
  template: string;
} | null {
  return {
    response_pending: {
      label: '已提交',
      detail: '操作已提交，正在送回 Codex。',
      template: 'blue',
    },
    resolved: {
      label: '已完成',
      detail: 'Codex 已处理该操作。',
      template: 'green',
    },
    cancelled: {
      label: '已取消',
      detail: '该请求已取消或由其他入口关闭。',
      template: 'grey',
    },
    expired: {
      label: '已过期',
      detail: '该请求已超过有效期，不能再提交操作。',
      template: 'grey',
    },
    pending: null,
  }[status];
}

function buildFeishuInteractionStatusCard(
  interaction: InteractionRequestRecord,
  threadTitle: string | null,
): Record<string, unknown> | null {
  const presentation = interactionStatusPresentation(interaction.state.status);
  if (!presentation) return null;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: presentation.template,
      title: {
        tag: 'plain_text',
        content: compactCardHeader(threadTitle || kindTitle(interaction.state.kind), presentation.label),
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**${kindTitle(interaction.state.kind)}**`,
            escapeNotificationMarkdown(interactionSummary(interaction)),
            '',
            presentation.detail,
            ...interactionContextLines(interaction).filter((line) => !line.startsWith('**有效至**')),
          ].join('\n').trim(),
        },
      },
    ],
  };
}

function promptCardStatusPresentation(status: PromptCardRow['status']): {
  label: string;
  detail: string;
  template: string;
} | null {
  return {
    consumed: {
      label: '已提交',
      detail: '消息已进入 Codex 会话队列。',
      template: 'green',
    },
    cancelled: {
      label: '已取消',
      detail: '该 Prompt 卡片已由管理员取消。',
      template: 'grey',
    },
    expired: {
      label: '已过期',
      detail: '该 Prompt 卡片已超过有效期。',
      template: 'grey',
    },
    pending: null,
  }[status] || null;
}

function buildFeishuPromptStatusCard(
  promptCard: PromptCardRow,
  threadTitle: string | null,
): Record<string, unknown> | null {
  const presentation = promptCardStatusPresentation(promptCard.status);
  if (!presentation) return null;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: presentation.template,
      title: {
        tag: 'plain_text',
        content: compactCardHeader(threadTitle || 'Codex 会话', presentation.label),
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `**${presentation.detail}**`,
          ].join('\n'),
        },
      },
    ],
  };
}

async function currentCardUpdateTarget(dispatch: DispatchRow): Promise<CardUpdateTarget | null> {
  if (dispatch.subjectKind === 'prompt_card') {
    if (!dispatch.promptCardId || dispatch.interactionId) return null;
    const promptCard = await db.select().from(schema.interactionPromptCards)
      .where(eq(schema.interactionPromptCards.id, dispatch.promptCardId)).get();
    if (!promptCard) return null;
    const threadTitle = await observedThreadTitle(promptCard.deviceId, promptCard.threadId);
    const card = buildFeishuPromptStatusCard(promptCard, threadTitle);
    return card ? Object.freeze({
      subjectRevision: promptCard.stateVersion,
      targetStatus: promptCard.status,
      card,
    }) : null;
  }
  if (!dispatch.interactionId || dispatch.promptCardId) return null;
  const interaction = await getInteractionRequest(dispatch.interactionId);
  if (!interaction) return null;
  const threadTitle = await observedThreadTitle(
    interaction.state.deviceId,
    interaction.state.threadId,
  );
  const card = buildFeishuInteractionStatusCard(interaction, threadTitle);
  return card ? Object.freeze({
    subjectRevision: interaction.stateVersion,
    targetStatus: interaction.state.status,
    card,
  }) : null;
}

function cardFingerprint(card: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

function parseRetryAfterMs(headers: { get(name: string): string | null } | undefined): number | null {
  const raw = headers?.get('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5 * 60_000, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(5 * 60_000, date - Date.now())) : null;
}

async function responseJson(response: Awaited<ReturnType<FetchLike>>): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function tenantAccessToken(adapter: AdapterRow, fetchImpl: FetchLike): Promise<string> {
  if (!adapter.appSecretCredentialId) throw new KnownFeishuDeliveryError('飞书 App Secret 未配置');
  const resolved = await resolveCredentialVaultSecret(adapter.appSecretCredentialId);
  if (!resolved) throw new KnownFeishuDeliveryError('飞书 App Secret 已失效');
  const fingerprint = createHash('sha256')
    .update(adapter.appId)
    .update('\0')
    .update(resolved.item.fingerprint)
    .digest('hex');
  const cached = tenantTokenCache.get(adapter.id);
  if (cached && cached.fingerprint === fingerprint && cached.expiresAtMs > Date.now() + 60_000) return cached.token;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${adapter.apiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: adapter.appId, app_secret: resolved.secret }),
    });
  } catch (error) {
    throw new KnownFeishuDeliveryError(`获取飞书 tenant_access_token 失败: ${String((error as Error)?.message || error)}`);
  }
  const payload = await responseJson(response);
  const code = Number(payload.code);
  const token = typeof payload.tenant_access_token === 'string' ? payload.tenant_access_token : '';
  const expire = Math.max(60, Math.trunc(Number(payload.expire) || 7_200));
  if (!response.ok || code !== 0 || !token) {
    throw new KnownFeishuDeliveryError(
      `飞书 tenant_access_token 错误 ${Number.isFinite(code) ? code : response.status}: ${String(payload.msg || 'unknown error')}`,
      parseRetryAfterMs(response.headers),
    );
  }
  tenantTokenCache.set(adapter.id, {
    fingerprint,
    token,
    expiresAtMs: Date.now() + expire * 1_000,
  });
  return token;
}

type FeishuMessageSendResult = Readonly<{
  messageId: string;
  rootId: string | null;
  threadId: string | null;
}>;

async function parseFeishuMessageSendResult(
  response: Awaited<ReturnType<FetchLike>>,
  operation: string,
): Promise<FeishuMessageSendResult> {
  const payload = await responseJson(response);
  const code = Number(payload.code);
  const data = isRecord(payload.data) ? payload.data : {};
  const messageId = typeof data.message_id === 'string' ? data.message_id : '';
  const rootId = typeof data.root_id === 'string' ? data.root_id : null;
  const threadId = typeof data.thread_id === 'string' ? data.thread_id : null;
  if (!response.ok || code !== 0 || !messageId) {
    throw new KnownFeishuDeliveryError(
      `飞书${operation}接口错误 ${Number.isFinite(code) ? code : response.status}: ${String(payload.msg || 'unknown error')}`,
      parseRetryAfterMs(response.headers),
    );
  }
  return Object.freeze({ messageId, rootId, threadId });
}

async function sendFeishuCard(input: {
  adapter: AdapterRow;
  card: Record<string, unknown>;
  fetchImpl: FetchLike;
  uuid?: string;
}): Promise<FeishuMessageSendResult> {
  const token = await tenantAccessToken(input.adapter, input.fetchImpl);
  const url = new URL(`${input.adapter.apiBaseUrl}/open-apis/im/v1/messages`);
  url.searchParams.set('receive_id_type', input.adapter.receiveIdType);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await input.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: input.adapter.receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(input.card),
        ...(input.uuid ? { uuid: input.uuid } : {}),
      }),
    });
  } catch (error) {
    throw new UnknownFeishuDeliveryError(
      `飞书消息投递结果未知: ${String((error as Error)?.message || error)}`,
      { cause: error },
    );
  }
  return await parseFeishuMessageSendResult(response, '消息');
}

async function replyFeishuCard(input: {
  adapter: AdapterRow;
  rootMessageId: string;
  card: Record<string, unknown>;
  fetchImpl: FetchLike;
  uuid?: string;
}): Promise<FeishuMessageSendResult> {
  const token = await tenantAccessToken(input.adapter, input.fetchImpl);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await input.fetchImpl(
      `${input.adapter.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(input.rootMessageId)}/reply`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msg_type: 'interactive',
          content: JSON.stringify(input.card),
          reply_in_thread: true,
          ...(input.uuid ? { uuid: input.uuid } : {}),
        }),
      },
    );
  } catch (error) {
    throw new UnknownFeishuDeliveryError(
      `飞书话题回复投递结果未知: ${String((error as Error)?.message || error)}`,
      { cause: error },
    );
  }
  return await parseFeishuMessageSendResult(response, '话题回复');
}

function truncateNotificationDetail(value: string, maxLength = 6_000): string {
  const normalized = value.trim() || '没有更多详情。';
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}\n...(内容过长，已截断)`;
}

function truncateNotificationPreview(value: string, maxLength = 700, maxLines = 8): string {
  const normalized = value.replace(/\0/g, '').trim();
  if (!normalized) return '';
  const lines = normalized.split(/\r?\n/);
  const lineLimited = lines.length > maxLines
    ? `${lines.slice(0, maxLines).join('\n')}\n...`
    : normalized;
  return lineLimited.length <= maxLength
    ? lineLimited
    : `${lineLimited.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function escapeNotificationMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function notificationHeaderTemplate(level: 'info' | 'warning' | 'error', title: string): string {
  if (level === 'error') return 'red';
  if (level === 'warning') return 'orange';
  return /完成|成功|completed/i.test(title) ? 'green' : 'blue';
}

type NotificationMessageParts = Readonly<{
  sessionTitle: string | null;
  status: string | null;
  assistantReply: string | null;
  failure: string | null;
}>;

function notificationMessageParts(message: string): NotificationMessageParts {
  const field = (pattern: RegExp): string | null => truncateText(message.match(pattern)?.[1], 240) || null;
  const section = (pattern: RegExp): string | null => {
    const value = message.match(pattern)?.[1]?.trim() || '';
    return value || null;
  };
  return Object.freeze({
    sessionTitle: field(/^(?:会话名称|Session(?:\s+(?:name|title))?)\s*[：:]\s*(.+)$/im),
    status: field(/^(?:状态|Status)\s*[：:]\s*(.+)$/im),
    assistantReply: section(
      /(?:^|\n)(?:助手回复|Assistant(?:\s+(?:reply|response))?)\s*[：:]\s*\n?([\s\S]*?)(?=\n(?:错误|Error)\s*[：:]|$)/i,
    ),
    failure: section(/(?:^|\n)(?:错误|Error)\s*[：:]\s*\n?([\s\S]*?)$/i),
  });
}

function notificationStatusLabel(
  status: string | null,
  level: 'info' | 'warning' | 'error',
): string {
  const normalized = status?.trim().toLowerCase() || '';
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'success') return '已完成';
  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') return '已中断';
  if (normalized === 'failed' || normalized === 'error') return '失败';
  return level === 'error' ? '异常' : level === 'warning' ? '需关注' : '已完成';
}

function notificationCardHeader(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
): string {
  const parts = notificationMessageParts(message);
  const codexTitle = title.match(/^(.*?)\s*(?:·\s*)?Codex\s*(?:会话|任务)\s*(已完成|已中断|失败)\s*$/i);
  if (codexTitle) {
    const subject = parts.sessionTitle || truncateText(codexTitle[1], 120) || 'Codex 会话';
    return compactCardHeader(subject, codexTitle[2]);
  }
  if (parts.sessionTitle) {
    return compactCardHeader(parts.sessionTitle, notificationStatusLabel(parts.status, level));
  }
  return truncateText(title.replace(/^\[(?:Metapi|r-api)\]\s*/i, ''), 72) || 'r-api 通知';
}

function notificationSummary(message: string, level: 'info' | 'warning' | 'error'): string {
  const parts = notificationMessageParts(message);
  const failurePreview = parts.failure ? truncateNotificationPreview(parts.failure, 700, 8) : '';
  if (failurePreview) {
    return `**运行异常**\n${escapeNotificationMarkdown(failurePreview)}`;
  }
  const replyPreview = parts.assistantReply
    ? truncateNotificationPreview(parts.assistantReply, 700, 8)
    : '';
  if (replyPreview) {
    return `**最终回复**\n${escapeNotificationMarkdown(replyPreview)}`;
  }
  return `**状态**  ${notificationStatusLabel(parts.status, level)}`;
}

function codexThreadIdFromNotification(title: string, message: string): string | null {
  if (!/Codex\s*(?:会话|任务)|Codex\s*(?:session|task)/i.test(title)) return null;
  const threadId = message.match(/(?:线程 ID|Thread(?:\s+ID)?)\s*[：:]?\s*([^\s\n]+)/i)?.[1]?.trim() || '';
  return /^[a-zA-Z0-9._:-]{1,256}$/.test(threadId) ? threadId : null;
}

function feishuNotificationUuid(input: {
  adapterId: string;
  title: string;
  message: string;
  occurredAt: string;
}): string {
  return createHash('sha256')
    .update('metapi-feishu-notification\0')
    .update(input.adapterId)
    .update('\0')
    .update(input.title)
    .update('\0')
    .update(input.message)
    .update('\0')
    .update(input.occurredAt)
    .digest('hex')
    .slice(0, 50);
}

function buildFeishuTopicPromptForm(topicPromptToken: string): Record<string, unknown> {
  return {
    tag: 'form',
    name: 'metapi_topic_prompt_form',
    elements: [
      {
        tag: 'input',
        name: BRIDGE_PROMPT_INPUT_NAME,
        input_type: 'multiline_text',
        required: true,
        max_length: 1_000,
        placeholder: { tag: 'plain_text', content: '输入下一条要发送给 Codex 的消息' },
        label: { tag: 'plain_text', content: '继续对话' },
      },
      {
        tag: 'button',
        form_action_type: 'submit',
        name: 'metapi_topic_prompt_next',
        text: { tag: 'plain_text', content: '发送到同一会话' },
        type: 'primary',
        behaviors: [{
          type: 'callback',
          value: { metapi_topic_prompt: topicPromptToken },
        }],
      },
    ],
  };
}

function buildFeishuNotificationCard(
  title: string,
  message: string,
  level: 'info' | 'warning' | 'error',
  occurredAt: string,
  topicPromptToken?: string | null,
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      template: notificationHeaderTemplate(level, title),
      title: { tag: 'plain_text', content: notificationCardHeader(title, message, level) },
    },
    body: {
      direction: 'vertical',
      elements: [
        {
          tag: 'markdown',
          content: notificationSummary(message, level),
        },
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: { tag: 'plain_text', content: '完整回复与会话信息' },
          },
          elements: [
            {
              tag: 'markdown',
              content: escapeNotificationMarkdown(truncateNotificationDetail(message)),
            },
          ],
        },
        ...(topicPromptToken ? [buildFeishuTopicPromptForm(topicPromptToken)] : []),
        {
          tag: 'markdown',
          content: `<font color='grey'>${formatCardDateTime(occurredAt)}</font>`,
        },
      ],
    },
  };
}

export async function hasEnabledFeishuAdapterForDevice(deviceIdInput: unknown): Promise<boolean> {
  const deviceId = normalizeText(deviceIdInput, 'Connector 设备 ID', 128);
  const adapter = await db.select({ id: schema.interactionAdapters.id })
    .from(schema.interactionAdapters)
    .where(and(
      eq(schema.interactionAdapters.kind, 'feishu'),
      eq(schema.interactionAdapters.enabled, true),
      eq(schema.interactionAdapters.deviceId, deviceId),
    ))
    .get();
  return Boolean(adapter);
}

export async function sendFeishuCardNotification(input: {
  deviceId: string | null;
  title: string;
  message: string;
  level: 'info' | 'warning' | 'error';
  occurredAt: string;
  fetchImpl?: FetchLike;
}): Promise<{ adapterId: string; messageIds: string[] }> {
  const fetchImpl = input.fetchImpl || undiciFetch;
  const filters: SQL<unknown>[] = [
    eq(schema.interactionAdapters.kind, 'feishu'),
    eq(schema.interactionAdapters.enabled, true),
  ];
  if (input.deviceId) filters.push(eq(schema.interactionAdapters.deviceId, input.deviceId));
  const adapters = await db.select().from(schema.interactionAdapters)
    .where(and(...filters))
    .orderBy(desc(schema.interactionAdapters.createdAt), desc(schema.interactionAdapters.id))
    .limit(1)
    .all();
  if (adapters.length === 0) {
    throw new KnownFeishuDeliveryError(
      input.deviceId
        ? '当前 Connector 没有启用的飞书应用 Adapter'
        : '没有启用的飞书应用 Adapter',
    );
  }

  const codexThreadId = codexThreadIdFromNotification(input.title, input.message);
  const messageIds: string[] = [];
  for (const adapter of adapters) {
    let topicBinding: FeishuTopicBinding | null = null;
    try {
      if (codexThreadId && adapter.deviceId) {
        const resolved = await getOrCreateFeishuTopicBinding({
          adapterId: adapter.id,
          deviceId: adapter.deviceId,
          codexThreadId,
        });
        topicBinding = resolved.binding;
      }
      const uuid = feishuNotificationUuid({
        adapterId: adapter.id,
        title: input.title,
        message: input.message,
        occurredAt: input.occurredAt,
      });
      const card = buildFeishuNotificationCard(
        input.title,
        input.message,
        input.level,
        input.occurredAt,
        topicBinding ? buildTopicPromptToken(adapter.id, topicBinding.id) : null,
      );
      if (topicBinding?.rootMessageId) {
        const sent = await replyFeishuCard({
          adapter,
          rootMessageId: topicBinding.rootMessageId,
          card,
          fetchImpl,
          uuid,
        });
        await recordFeishuTopicReply({
          adapterId: adapter.id,
          bindingId: topicBinding.id,
          rootMessageId: topicBinding.rootMessageId,
          messageId: sent.messageId,
          feishuThreadId: sent.threadId,
        });
        messageIds.push(sent.messageId);
      } else {
        const sent = await sendFeishuCard({ adapter, card, fetchImpl, uuid });
        if (topicBinding) {
          await bindFeishuTopicRoot({
            adapterId: adapter.id,
            bindingId: topicBinding.id,
            rootMessageId: sent.messageId,
            feishuThreadId: sent.threadId,
          });
        }
        messageIds.push(sent.messageId);
      }
    } catch (error) {
      await db.update(schema.interactionAdapters).set({
        lastError: String((error as Error)?.message || error),
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.interactionAdapters.id, adapter.id)).run();
      throw error;
    }
    const deliveredAt = new Date().toISOString();
    await db.update(schema.interactionAdapters).set({
      lastDispatchAt: deliveredAt,
      lastError: null,
      updatedAt: deliveredAt,
    }).where(eq(schema.interactionAdapters.id, adapter.id)).run();
  }
  return { adapterId: adapters[0]!.id, messageIds };
}

// Keep the old export for integrations compiled against the 1.0 connector API.
export const sendFeishuTextNotification = sendFeishuCardNotification;

async function updateFeishuCard(input: {
  adapter: AdapterRow;
  messageId: string;
  card: Record<string, unknown>;
  fetchImpl: FetchLike;
}): Promise<void> {
  const token = await tenantAccessToken(input.adapter, input.fetchImpl);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await input.fetchImpl(
      `${input.adapter.apiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: JSON.stringify(input.card) }),
      },
    );
  } catch (error) {
    throw new UnknownFeishuDeliveryError(
      `飞书卡片更新结果未知: ${String((error as Error)?.message || error)}`,
      { cause: error },
    );
  }
  const payload = await responseJson(response);
  const code = Number(payload.code);
  if (!response.ok || code !== 0) {
    throw new KnownFeishuDeliveryError(
      `飞书卡片更新接口错误 ${Number.isFinite(code) ? code : response.status}: ${String(payload.msg || 'unknown error')}`,
      parseRetryAfterMs(response.headers),
    );
  }
}

async function recoverExpiredDispatchLeases(now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db.update(schema.interactionDispatches).set({
    status: 'pending',
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionDispatches.status, 'processing'),
    lte(schema.interactionDispatches.leaseExpiresAt, nowIso),
  )).run();
  return affectedRows(result);
}

async function claimNextDispatch(now: Date): Promise<{ dispatch: DispatchRow; leaseToken: string } | null> {
  const nowIso = now.toISOString();
  const candidate = await db.select().from(schema.interactionDispatches)
    .where(and(
      eq(schema.interactionDispatches.status, 'pending'),
      lte(schema.interactionDispatches.nextAttemptAt, nowIso),
    )).orderBy(asc(schema.interactionDispatches.nextAttemptAt), asc(schema.interactionDispatches.createdAt))
    .get();
  if (!candidate) return null;
  const leaseToken = randomBytes(24).toString('base64url');
  const updated = await db.update(schema.interactionDispatches).set({
    status: 'processing',
    leaseOwner: `worker:${process.pid}`,
    leaseToken,
    leaseExpiresAt: new Date(now.getTime() + DISPATCH_LEASE_MS).toISOString(),
    attemptCount: sql`${schema.interactionDispatches.attemptCount} + 1`,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionDispatches.id, candidate.id),
    eq(schema.interactionDispatches.status, 'pending'),
  )).run();
  if (affectedRows(updated) <= 0) return null;
  const claimed = await db.select().from(schema.interactionDispatches)
    .where(eq(schema.interactionDispatches.id, candidate.id)).get();
  return claimed ? { dispatch: claimed, leaseToken } : null;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(5 * 60_000, 5_000 * (2 ** Math.min(Math.max(0, attemptCount - 1), 6)));
}

async function finishDispatch(
  dispatch: DispatchRow,
  leaseToken: string,
  values: Partial<typeof schema.interactionDispatches.$inferInsert>,
): Promise<void> {
  await db.update(schema.interactionDispatches).set({
    ...values,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(schema.interactionDispatches.id, dispatch.id),
    eq(schema.interactionDispatches.status, 'processing'),
    eq(schema.interactionDispatches.leaseToken, leaseToken),
  )).run();
}

async function deliverClaimedDispatch(
  claimed: { dispatch: DispatchRow; leaseToken: string },
  fetchImpl: FetchLike,
): Promise<'delivered' | 'failed' | 'delivery_unknown' | 'cancelled'> {
  const { dispatch, leaseToken } = claimed;
  const adapter = await db.select().from(schema.interactionAdapters)
    .where(eq(schema.interactionAdapters.id, dispatch.adapterId)).get();
  if (!adapter || !adapter.enabled || !adapter.deviceId) {
    await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'adapter disabled, missing, or unassigned' });
    return 'cancelled';
  }
  let expiresAtMs = 0;
  try {
    let card: Record<string, unknown>;
    if (dispatch.subjectKind === 'prompt_card') {
      if (!dispatch.promptCardId || dispatch.interactionId) {
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'prompt card dispatch subject is invalid' });
        return 'cancelled';
      }
      const promptCard = await db.select().from(schema.interactionPromptCards)
        .where(eq(schema.interactionPromptCards.id, dispatch.promptCardId)).get();
      if (!promptCard || promptCard.adapterId !== adapter.id || promptCard.status !== 'pending') {
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'prompt card no longer pending' });
        return 'cancelled';
      }
      if (promptCard.deviceId !== adapter.deviceId) {
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'prompt card Connector does not match adapter' });
        return 'cancelled';
      }
      expiresAtMs = Date.parse(promptCard.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        await expireFeishuBridgePromptCards(new Date());
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'prompt card expired' });
        return 'cancelled';
      }
      await resolvePromptCardContext({
        contextTaskId: promptCard.contextTaskId,
        deviceId: promptCard.deviceId,
        threadId: promptCard.threadId,
      });
      const actions = await preparePromptCardActionTickets(dispatch, promptCard);
      const threadTitle = await observedThreadTitle(promptCard.deviceId, promptCard.threadId);
      card = buildFeishuPromptCard(adapter, promptCard, actions, threadTitle);
    } else {
      if (!dispatch.interactionId || dispatch.promptCardId) {
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'interaction dispatch subject is invalid' });
        return 'cancelled';
      }
      const interaction = await getInteractionRequest(dispatch.interactionId);
      if (!interaction || interaction.state.status !== 'pending') {
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'interaction no longer pending' });
        return 'cancelled';
      }
      if (interaction.state.deviceId !== adapter.deviceId) {
        await finishDispatch(dispatch, leaseToken, { status: 'cancelled', lastError: 'interaction Connector does not match adapter' });
        return 'cancelled';
      }
      expiresAtMs = interaction.state.expiresAtMs;
      const actions = await prepareInteractionActionTickets(dispatch, interaction);
      const threadTitle = await observedThreadTitle(
        interaction.state.deviceId,
        interaction.state.threadId,
      );
      card = buildFeishuInteractionCard(adapter, interaction, actions, threadTitle);
    }
    const cardFingerprint = createHash('sha256').update(JSON.stringify(card)).digest('hex');
    const message = await sendFeishuCard({ adapter, card, fetchImpl });
    const nowIso = new Date().toISOString();
    await finishDispatch(dispatch, leaseToken, {
      status: 'delivered',
      externalMessageId: message.messageId,
      cardFingerprint,
      lastError: null,
      deliveredAt: nowIso,
    });
    await db.update(schema.interactionAdapters).set({
      lastDispatchAt: nowIso,
      lastError: null,
      updatedAt: nowIso,
    }).where(eq(schema.interactionAdapters.id, adapter.id)).run();
    return 'delivered';
  } catch (error) {
    const now = new Date();
    const message = String((error as Error)?.message || error || 'unknown error').slice(0, 2_000);
    if (error instanceof UnknownFeishuDeliveryError) {
      await finishDispatch(dispatch, leaseToken, { status: 'delivery_unknown', lastError: message });
      await db.update(schema.interactionAdapters).set({ lastError: message, updatedAt: now.toISOString() })
        .where(eq(schema.interactionAdapters.id, adapter.id)).run();
      return 'delivery_unknown';
    }
    const delay = error instanceof KnownFeishuDeliveryError && error.retryAfterMs !== null
      ? Math.max(500, error.retryAfterMs)
      : retryDelayMs(dispatch.attemptCount);
    const canRetry = Number.isFinite(expiresAtMs) && now.getTime() + delay < expiresAtMs;
    await finishDispatch(dispatch, leaseToken, {
      status: canRetry ? 'pending' : 'failed',
      nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
      lastError: message,
    });
    await db.update(schema.interactionAdapters).set({ lastError: message, updatedAt: now.toISOString() })
      .where(eq(schema.interactionAdapters.id, adapter.id)).run();
    return 'failed';
  }
}

async function recoverExpiredCardUpdateLeases(now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db.update(schema.interactionCardUpdates).set({
    status: 'delivery_unknown',
    lastError: '卡片更新 worker 租约过期，PATCH 结果未知',
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionCardUpdates.status, 'processing'),
    lte(schema.interactionCardUpdates.leaseExpiresAt, nowIso),
  )).run();
  return affectedRows(result);
}

async function expirePendingCardUpdates(now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db.update(schema.interactionCardUpdates).set({
    status: 'failed',
    lastError: '飞书卡片已超过 14 天更新期限',
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionCardUpdates.status, 'pending'),
    lte(schema.interactionCardUpdates.deadlineAt, nowIso),
  )).run();
  return affectedRows(result);
}

async function claimNextCardUpdate(now: Date): Promise<{
  update: CardUpdateRow;
  leaseToken: string;
} | null> {
  const nowIso = now.toISOString();
  const candidates = await db.select().from(schema.interactionCardUpdates).where(and(
    eq(schema.interactionCardUpdates.status, 'pending'),
    lte(schema.interactionCardUpdates.nextAttemptAt, nowIso),
    gt(schema.interactionCardUpdates.deadlineAt, nowIso),
  )).orderBy(
    asc(schema.interactionCardUpdates.nextAttemptAt),
    asc(schema.interactionCardUpdates.createdAt),
  ).limit(25).all();
  for (const candidate of candidates) {
    const active = await db.select({ id: schema.interactionCardUpdates.id })
      .from(schema.interactionCardUpdates)
      .where(and(
        eq(schema.interactionCardUpdates.dispatchId, candidate.dispatchId),
        eq(schema.interactionCardUpdates.status, 'processing'),
      )).get();
    if (active) continue;
    const leaseToken = randomBytes(24).toString('base64url');
    const updated = await db.update(schema.interactionCardUpdates).set({
      status: 'processing',
      leaseOwner: `worker:${process.pid}`,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + DISPATCH_LEASE_MS).toISOString(),
      attemptCount: sql`${schema.interactionCardUpdates.attemptCount} + 1`,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.interactionCardUpdates.id, candidate.id),
      eq(schema.interactionCardUpdates.status, 'pending'),
    )).run();
    if (affectedRows(updated) <= 0) continue;
    const claimed = await db.select().from(schema.interactionCardUpdates)
      .where(eq(schema.interactionCardUpdates.id, candidate.id)).get();
    if (claimed) return { update: claimed, leaseToken };
  }
  return null;
}

async function finishCardUpdate(
  update: CardUpdateRow,
  leaseToken: string,
  values: Partial<typeof schema.interactionCardUpdates.$inferInsert>,
): Promise<void> {
  await db.update(schema.interactionCardUpdates).set({
    ...values,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: new Date().toISOString(),
  }).where(and(
    eq(schema.interactionCardUpdates.id, update.id),
    eq(schema.interactionCardUpdates.status, 'processing'),
    eq(schema.interactionCardUpdates.leaseToken, leaseToken),
  )).run();
}

async function deliverClaimedCardUpdate(
  claimed: { update: CardUpdateRow; leaseToken: string },
  fetchImpl: FetchLike,
): Promise<'delivered' | 'failed' | 'delivery_unknown' | 'cancelled'> {
  const { update, leaseToken } = claimed;
  const dispatch = await db.select().from(schema.interactionDispatches)
    .where(eq(schema.interactionDispatches.id, update.dispatchId)).get();
  if (!dispatch || dispatch.status !== 'delivered' || !dispatch.externalMessageId) {
    await finishCardUpdate(update, leaseToken, {
      status: 'cancelled',
      lastError: '原始飞书卡片投递不存在或未确认送达',
    });
    return 'cancelled';
  }
  const adapter = await db.select().from(schema.interactionAdapters)
    .where(eq(schema.interactionAdapters.id, dispatch.adapterId)).get();
  if (!adapter || !adapter.enabled || !adapter.deviceId) {
    await finishCardUpdate(update, leaseToken, {
      status: 'cancelled',
      lastError: 'adapter disabled, missing, or unassigned',
    });
    return 'cancelled';
  }
  const target = await currentCardUpdateTarget(dispatch);
  if (!target || cardFingerprint(target.card) !== update.cardFingerprint) {
    await finishCardUpdate(update, leaseToken, {
      status: 'cancelled',
      lastError: '卡片目标状态已被更新版本替代',
    });
    return 'cancelled';
  }
  const deadlineAtMs = Date.parse(update.deadlineAt);
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= Date.now()) {
    await finishCardUpdate(update, leaseToken, {
      status: 'failed',
      lastError: '飞书卡片已超过 14 天更新期限',
    });
    return 'failed';
  }
  try {
    await updateFeishuCard({
      adapter,
      messageId: dispatch.externalMessageId,
      card: target.card,
      fetchImpl,
    });
    const nowIso = new Date().toISOString();
    await finishCardUpdate(update, leaseToken, {
      status: 'delivered',
      subjectRevision: target.subjectRevision,
      targetStatus: target.targetStatus,
      lastError: null,
      deliveredAt: nowIso,
    });
    await db.update(schema.interactionAdapters).set({
      lastDispatchAt: nowIso,
      lastError: null,
      updatedAt: nowIso,
    }).where(eq(schema.interactionAdapters.id, adapter.id)).run();
    return 'delivered';
  } catch (error) {
    const now = new Date();
    const message = String((error as Error)?.message || error || 'unknown error').slice(0, 2_000);
    if (error instanceof UnknownFeishuDeliveryError) {
      await finishCardUpdate(update, leaseToken, { status: 'delivery_unknown', lastError: message });
      await db.update(schema.interactionAdapters).set({ lastError: message, updatedAt: now.toISOString() })
        .where(eq(schema.interactionAdapters.id, adapter.id)).run();
      return 'delivery_unknown';
    }
    const delay = error instanceof KnownFeishuDeliveryError && error.retryAfterMs !== null
      ? Math.max(500, error.retryAfterMs)
      : retryDelayMs(update.attemptCount);
    const canRetry = now.getTime() + delay < deadlineAtMs;
    await finishCardUpdate(update, leaseToken, {
      status: canRetry ? 'pending' : 'failed',
      nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
      lastError: message,
    });
    await db.update(schema.interactionAdapters).set({ lastError: message, updatedAt: now.toISOString() })
      .where(eq(schema.interactionAdapters.id, adapter.id)).run();
    return 'failed';
  }
}

export async function runFeishuInteractionDispatchPass(options: {
  now?: Date | number;
  maxItems?: number;
  maxUpdateItems?: number;
  fetchImpl?: FetchLike;
} = {}): Promise<Readonly<{
  reconciled: number;
  recovered: number;
  delivered: number;
  failed: number;
  unknown: number;
  cancelled: number;
  cardUpdatesReconciled: number;
  cardUpdatesRecovered: number;
  cardUpdated: number;
  cardUpdateFailed: number;
  cardUpdateUnknown: number;
  cardUpdateCancelled: number;
}>> {
  const now = options.now instanceof Date
    ? options.now
    : typeof options.now === 'number'
      ? new Date(options.now)
      : new Date();
  const fetchImpl = options.fetchImpl || undiciFetch;
  const recovered = await recoverExpiredDispatchLeases(now);
  const reconciled = await reconcileFeishuInteractionDispatches(now);
  const cardUpdatesRecovered = await recoverExpiredCardUpdateLeases(now);
  await expirePendingCardUpdates(now);
  const cardUpdatesReconciled = await reconcileFeishuCardUpdates(now);
  const counts = { delivered: 0, failed: 0, unknown: 0, cancelled: 0 };
  const maxItems = Math.min(100, Math.max(1, Math.trunc(options.maxItems || DEFAULT_DISPATCH_LIMIT)));
  for (let index = 0; index < maxItems; index += 1) {
    const claimed = await claimNextDispatch(new Date());
    if (!claimed) break;
    const outcome = await deliverClaimedDispatch(claimed, fetchImpl);
    if (outcome === 'delivery_unknown') counts.unknown += 1;
    else counts[outcome] += 1;
  }
  const updateCounts = {
    cardUpdated: 0,
    cardUpdateFailed: 0,
    cardUpdateUnknown: 0,
    cardUpdateCancelled: 0,
  };
  const maxUpdateItems = Math.min(
    100,
    Math.max(1, Math.trunc(options.maxUpdateItems || DEFAULT_DISPATCH_LIMIT)),
  );
  for (let index = 0; index < maxUpdateItems; index += 1) {
    const claimed = await claimNextCardUpdate(new Date());
    if (!claimed) break;
    const outcome = await deliverClaimedCardUpdate(claimed, fetchImpl);
    if (outcome === 'delivered') updateCounts.cardUpdated += 1;
    else if (outcome === 'delivery_unknown') updateCounts.cardUpdateUnknown += 1;
    else if (outcome === 'cancelled') updateCounts.cardUpdateCancelled += 1;
    else updateCounts.cardUpdateFailed += 1;
  }
  return Object.freeze({
    reconciled,
    recovered,
    ...counts,
    cardUpdatesReconciled,
    cardUpdatesRecovered,
    ...updateCounts,
  });
}

export async function retryFeishuInteractionDispatch(dispatchIdInput: unknown): Promise<boolean> {
  const dispatchId = normalizeText(dispatchIdInput, 'Interaction Dispatch ID', 128);
  const nowIso = new Date().toISOString();
  const result = await db.update(schema.interactionDispatches).set({
    status: 'pending',
    nextAttemptAt: nowIso,
    lastError: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionDispatches.id, dispatchId),
    inArray(schema.interactionDispatches.status, ['failed', 'delivery_unknown']),
  )).run();
  return affectedRows(result) > 0;
}

export async function retryFeishuCardUpdate(updateIdInput: unknown): Promise<boolean> {
  const updateId = normalizeText(updateIdInput, '飞书卡片更新 ID', 128);
  const row = await db.select().from(schema.interactionCardUpdates)
    .where(eq(schema.interactionCardUpdates.id, updateId)).get();
  if (!row || (row.status !== 'failed' && row.status !== 'delivery_unknown')) return false;
  const now = new Date();
  const deadlineAtMs = Date.parse(row.deadlineAt);
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= now.getTime()) return false;
  const dispatch = await db.select().from(schema.interactionDispatches)
    .where(eq(schema.interactionDispatches.id, row.dispatchId)).get();
  if (!dispatch) return false;
  const target = await currentCardUpdateTarget(dispatch);
  if (!target || cardFingerprint(target.card) !== row.cardFingerprint) return false;
  const nowIso = now.toISOString();
  const result = await db.update(schema.interactionCardUpdates).set({
    status: 'pending',
    nextAttemptAt: nowIso,
    lastError: null,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.interactionCardUpdates.id, row.id),
    inArray(schema.interactionCardUpdates.status, ['failed', 'delivery_unknown']),
  )).run();
  return affectedRows(result) > 0;
}

function safeEqualSecret(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export type FeishuCallbackSecurityInput = Readonly<{
  rawBody: unknown;
  timestamp: unknown;
  nonce: unknown;
  signature: unknown;
}>;

function callbackSecurityText(value: unknown, label: string, maximum: number): string {
  const normalized = Array.isArray(value) ? value[0] : value;
  return normalizeText(normalized, label, maximum);
}

function callbackRawBody(value: unknown): string {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized !== 'string'
    || normalized.length === 0
    || normalized.length > 2 * 1024 * 1024
    || normalized.includes('\0')) {
    throw new Error('飞书回调原始正文无效');
  }
  return normalized;
}

function callbackSecurityValuePresent(value: unknown): boolean {
  const normalized = Array.isArray(value) ? value[0] : value;
  return typeof normalized === 'string' && normalized.trim() !== '';
}

async function resolveEncryptKey(adapter: AdapterRow): Promise<string | null> {
  if (!adapter.encryptKeyCredentialId) return null;
  const resolved = await resolveCredentialVaultSecret(adapter.encryptKeyCredentialId);
  if (!resolved) throw new Error('飞书 Encrypt Key 已失效');
  return resolved.secret;
}

function verifyFeishuCallbackSignature(
  encryptKey: string,
  securityInput: FeishuCallbackSecurityInput | undefined,
): void {
  if (!securityInput) throw new Error('飞书加密回调缺少签名上下文');
  const rawBody = callbackRawBody(securityInput.rawBody);
  const timestamp = callbackSecurityText(securityInput.timestamp, 'X-Lark-Request-Timestamp', 128);
  const nonce = callbackSecurityText(securityInput.nonce, 'X-Lark-Request-Nonce', 512);
  const signature = callbackSecurityText(securityInput.signature, 'X-Lark-Signature', 256).toLowerCase();
  const expected = createHash('sha256')
    .update(timestamp)
    .update(nonce)
    .update(encryptKey)
    .update(rawBody)
    .digest('hex');
  if (!safeEqualSecret(signature, expected)) throw new Error('飞书回调签名无效');
}

function decryptFeishuCallbackBody(encryptKey: string, encryptedInput: unknown): Record<string, unknown> {
  const encrypted = callbackSecurityText(encryptedInput, '飞书加密回调正文', 2 * 1024 * 1024);
  if (encrypted.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encrypted)) {
    throw new Error('飞书加密回调 Base64 无效');
  }
  let encryptedBuffer: Buffer;
  try {
    encryptedBuffer = Buffer.from(encrypted, 'base64');
  } catch (error) {
    throw new Error('飞书加密回调 Base64 无效', { cause: error });
  }
  if (encryptedBuffer.length <= 16) throw new Error('飞书加密回调正文过短');
  try {
    const key = createHash('sha256').update(encryptKey).digest();
    const decipher = createDecipheriv('aes-256-cbc', key, encryptedBuffer.subarray(0, 16));
    const plaintext = Buffer.concat([
      decipher.update(encryptedBuffer.subarray(16)),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (!isRecord(parsed)) throw new Error('飞书解密正文不是 JSON object');
    return parsed;
  } catch (error) {
    throw new Error('飞书加密回调解密失败', { cause: error });
  }
}

async function prepareFeishuCallbackBody(
  adapter: AdapterRow,
  body: Record<string, unknown>,
  securityInput: FeishuCallbackSecurityInput | undefined,
): Promise<Record<string, unknown>> {
  const encryptKey = await resolveEncryptKey(adapter);
  const hasEncryptedBody = typeof body.encrypt === 'string' && body.encrypt.trim() !== '';
  if (!encryptKey) {
    if (hasEncryptedBody) throw new Error('飞书回调已加密，但当前 Adapter 未配置 Encrypt Key');
    return body;
  }
  // The initial Feishu URL verification is a plain challenge request. It is
  // authenticated by Verification Token below and may not carry the signed
  // callback headers used by interactive card actions.
  const plainUrlVerification = body.type === 'url_verification'
    && typeof body.challenge === 'string'
    && body.challenge.trim() !== ''
    && !hasEncryptedBody;
  if (plainUrlVerification) return body;
  if (hasEncryptedBody) {
    const hasSignature = callbackSecurityValuePresent(securityInput?.signature);
    if (hasSignature) verifyFeishuCallbackSignature(encryptKey, securityInput);
    const decrypted = decryptFeishuCallbackBody(encryptKey, body.encrypt);
    const encryptedUrlVerification = decrypted.type === 'url_verification'
      && typeof decrypted.challenge === 'string'
      && decrypted.challenge.trim() !== '';
    if (!hasSignature && !encryptedUrlVerification) {
      throw new Error('飞书加密回调缺少签名上下文');
    }
    return decrypted;
  }
  verifyFeishuCallbackSignature(encryptKey, securityInput);
  return body;
}

function callbackVerificationToken(body: Record<string, unknown>): string {
  if (typeof body.token === 'string') return body.token;
  const header = isRecord(body.header) ? body.header : {};
  return typeof header.token === 'string' ? header.token : '';
}

function callbackEvent(body: Record<string, unknown>): Record<string, unknown> {
  return isRecord(body.event) ? body.event : body;
}

function callbackMessage(body: Record<string, unknown>): Record<string, unknown> {
  const event = callbackEvent(body);
  return isRecord(event.message) ? event.message : {};
}

function callbackMessageId(body: Record<string, unknown>): string {
  const message = callbackMessage(body);
  return typeof message.message_id === 'string' ? message.message_id.trim() : '';
}

function callbackMessageTopic(body: Record<string, unknown>): {
  rootMessageId: string | null;
  feishuThreadId: string | null;
} {
  const event = callbackEvent(body);
  const message = callbackMessage(body);
  const rootMessageId = typeof message.root_id === 'string'
    ? message.root_id.trim()
    : typeof message.parent_id === 'string'
      ? message.parent_id.trim()
      : '';
  const feishuThreadId = typeof message.thread_id === 'string'
    ? message.thread_id.trim()
    : typeof event.thread_id === 'string'
      ? event.thread_id.trim()
      : '';
  return {
    rootMessageId: rootMessageId || null,
    feishuThreadId: feishuThreadId || null,
  };
}

function callbackMessageText(body: Record<string, unknown>): string {
  const message = callbackMessage(body);
  if (message.message_type && message.message_type !== 'text') return '';
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) {
    try {
      const parsed = JSON.parse(content);
      if (isRecord(parsed) && typeof parsed.text === 'string') return parsed.text.trim();
    } catch {
      return '';
    }
  }
  return typeof message.text === 'string' ? message.text.trim() : '';
}

function callbackMessageOperator(body: Record<string, unknown>): {
  operatorId: string;
  identities: string[];
} {
  const event = callbackEvent(body);
  const sender = isRecord(event.sender) ? event.sender : {};
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {};
  const identities: string[] = [];
  for (const key of ['open_id', 'union_id', 'user_id'] as const) {
    const value = typeof senderId[key] === 'string' ? senderId[key].trim() : '';
    if (value) identities.push(`${key}:${value}`);
  }
  const unique = [...new Set(identities)];
  return { operatorId: unique[0] ? `feishu:${unique[0]}` : '', identities: unique };
}

function callbackActionToken(body: Record<string, unknown>): string {
  const event = callbackEvent(body);
  const action = isRecord(event.action) ? event.action : isRecord(body.action) ? body.action : {};
  const value = isRecord(action.value) ? action.value : {};
  return typeof value.metapi_ticket === 'string' ? value.metapi_ticket : '';
}

function callbackTopicPromptToken(body: Record<string, unknown>): string {
  const event = callbackEvent(body);
  const action = isRecord(event.action) ? event.action : isRecord(body.action) ? body.action : {};
  const value = isRecord(action.value) ? action.value : {};
  return typeof value.metapi_topic_prompt === 'string' ? value.metapi_topic_prompt : '';
}

function callbackFormPrompt(body: Record<string, unknown>): string {
  const event = callbackEvent(body);
  const action = isRecord(event.action) ? event.action : isRecord(body.action) ? body.action : {};
  const formValue = isRecord(action.form_value) ? action.form_value : {};
  return typeof formValue[BRIDGE_PROMPT_INPUT_NAME] === 'string'
    ? formValue[BRIDGE_PROMPT_INPUT_NAME].trim()
    : '';
}

function callbackEventId(body: Record<string, unknown>): string | null {
  const header = isRecord(body.header) ? body.header : {};
  const event = callbackEvent(body);
  const raw = typeof header.event_id === 'string'
    ? header.event_id
    : typeof event.event_id === 'string'
      ? event.event_id
      : '';
  const normalized = raw.trim();
  return normalized && normalized.length <= 256 && !normalized.includes('\0') ? normalized : null;
}

function callbackFallbackId(body: Record<string, unknown>): string {
  return `body:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}

function bridgePromptModeFromActionKey(actionKey: string): 'steer_current' | 'start_next' | null {
  if (actionKey === `${BRIDGE_PROMPT_ACTION_PREFIX}steer_current`) return 'steer_current';
  if (actionKey === `${BRIDGE_PROMPT_ACTION_PREFIX}start_next`) return 'start_next';
  return null;
}

async function isBridgePromptActionTicket(adapter: AdapterRow, token: string, now: Date): Promise<boolean> {
  const parsed = parseAndVerifyTicketToken(token, now.getTime());
  const ticket = await db.select().from(schema.interactionActionTickets)
    .where(eq(schema.interactionActionTickets.id, parsed.ticketId)).get();
  if (!ticket || ticket.adapterId !== adapter.id || ticket.tokenHash !== tokenHash(parsed.token)) {
    throw new Error('Interaction 动作票据不存在或已轮换');
  }
  return bridgePromptModeFromActionKey(ticket.actionKey) !== null;
}

async function consumeFeishuTopicPrompt(input: {
  adapter: AdapterRow;
  token: string;
  operatorId: string;
  prompt: string;
  eventId: string;
  now: Date;
}): Promise<Readonly<{ replayed: boolean; taskId: string; binding: FeishuTopicBinding }>> {
  const bindingId = verifyTopicPromptToken(input.adapter.id, input.token);
  const binding = await getFeishuTopicBindingById({ adapterId: input.adapter.id, bindingId });
  if (!binding || binding.deviceId !== input.adapter.deviceId) {
    throw new Error('飞书话题未绑定当前 Connector 的 Codex 会话');
  }
  if (!binding.rootMessageId) throw new Error('飞书话题根消息尚未建立');
  if (!input.prompt || input.prompt.length > 4_000) throw new Error('人工 Prompt 不能为空且不能超过 4000 字符');
  const context = await resolvePromptCardContext({
    deviceId: binding.deviceId,
    threadId: binding.codexThreadId,
  });
  const created = await createManualBridgePromptTask({
    deviceId: context.deviceId,
    threadId: context.threadId,
    threadStatus: context.threadStatus,
    activeFlags: context.activeFlags,
    activeTurnId: context.activeTurnId,
    prompt: input.prompt,
    submissionMode: 'start_next',
    source: 'im',
    operatorId: input.operatorId,
    sourceAdapterId: input.adapter.id,
    idempotencyKey: `feishu-topic:${input.adapter.id}:${input.eventId}`,
    now: input.now,
  });
  return Object.freeze({
    replayed: created.deduplicated,
    taskId: created.task.state.taskId,
    binding,
  });
}

async function consumeFeishuTopicMessage(input: {
  adapter: AdapterRow;
  body: Record<string, unknown>;
  now: Date;
}): Promise<Readonly<Record<string, unknown>>> {
  const message = callbackMessage(input.body);
  const event = callbackEvent(input.body);
  const sender = isRecord(event.sender) ? event.sender : {};
  const senderType = typeof sender.sender_type === 'string' ? sender.sender_type : '';
  if (senderType === 'app') return { success: true, ignored: true, reason: 'app_message' };
  const messageId = callbackMessageId(input.body);
  const prompt = callbackMessageText(input.body);
  const topic = callbackMessageTopic(input.body);
  if (!messageId || !prompt || (!topic.rootMessageId && !topic.feishuThreadId)) {
    return { success: true, ignored: true, reason: 'not_a_bound_text_message' };
  }
  if (prompt.length > 4_000) {
    return { success: true, ignored: true, reason: 'prompt_too_long' };
  }
  const operator = callbackMessageOperator(input.body);
  const allowlist = new Set(parseOperatorAllowlist(input.adapter.operatorAllowlist));
  if (!operator.operatorId || !operator.identities.some((identity) => allowlist.has(identity))) {
    return { success: true, ignored: true, reason: 'operator_not_allowed' };
  }
  const binding = await getFeishuTopicBindingForMessage({
    adapterId: input.adapter.id,
    rootMessageId: topic.rootMessageId,
    feishuThreadId: topic.feishuThreadId,
  });
  if (!binding || !binding.rootMessageId) {
    return { success: true, ignored: true, reason: 'topic_not_bound' };
  }
  const context = await resolvePromptCardContext({
    deviceId: binding.deviceId,
    threadId: binding.codexThreadId,
  });
  const created = await createManualBridgePromptTask({
    deviceId: context.deviceId,
    threadId: context.threadId,
    threadStatus: context.threadStatus,
    activeFlags: context.activeFlags,
    activeTurnId: context.activeTurnId,
    prompt,
    submissionMode: 'start_next',
    source: 'im',
    operatorId: operator.operatorId,
    sourceAdapterId: input.adapter.id,
    idempotencyKey: `feishu-topic-message:${input.adapter.id}:${messageId}`,
    now: input.now,
  });
  await recordFeishuTopicReply({
    adapterId: input.adapter.id,
    bindingId: binding.id,
    rootMessageId: binding.rootMessageId,
    messageId,
    feishuThreadId: topic.feishuThreadId,
    now: input.now,
  });
  return {
    success: true,
    queued: true,
    replayed: created.deduplicated,
    taskId: created.task.state.taskId,
    codexThreadId: binding.codexThreadId,
  };
}

function callbackOperator(body: Record<string, unknown>): {
  operatorId: string;
  identities: string[];
} {
  const event = callbackEvent(body);
  const operator = isRecord(event.operator) ? event.operator : event;
  const identities: string[] = [];
  for (const key of ['open_id', 'union_id', 'user_id'] as const) {
    const value = typeof operator[key] === 'string' ? operator[key].trim() : '';
    if (value) identities.push(`${key}:${value}`);
  }
  const fallback = typeof event.open_id === 'string' ? event.open_id.trim() : '';
  if (fallback) identities.push(`open_id:${fallback}`);
  const unique = [...new Set(identities)];
  return { operatorId: unique[0] ? `feishu:${unique[0]}` : '', identities: unique };
}

async function resolveVerificationToken(adapter: AdapterRow): Promise<string> {
  if (!adapter.verificationTokenCredentialId) throw new Error('飞书 Verification Token 未配置');
  const resolved = await resolveCredentialVaultSecret(adapter.verificationTokenCredentialId);
  if (!resolved) throw new Error('飞书 Verification Token 已失效');
  return resolved.secret;
}

function ticketSubjectCondition(ticket: TicketRow): SQL<unknown> {
  if (ticket.promptCardId && !ticket.interactionId) {
    return eq(schema.interactionActionTickets.promptCardId, ticket.promptCardId);
  }
  if (ticket.interactionId && !ticket.promptCardId) {
    return eq(schema.interactionActionTickets.interactionId, ticket.interactionId);
  }
  throw new Error('Interaction 动作票据 Subject 无效');
}

async function consumeActionTicket(input: {
  adapter: AdapterRow;
  token: string;
  operatorId: string;
  now: Date;
}): Promise<Readonly<{
  replayed: boolean;
  unavailable: 'expired' | 'closed' | null;
}>> {
  const parsed = parseAndVerifyTicketToken(input.token, input.now.getTime());
  const hash = tokenHash(parsed.token);
  return await db.transaction(async (tx: DbExecutor) => {
    const ticket = await tx.select().from(schema.interactionActionTickets)
      .where(eq(schema.interactionActionTickets.id, parsed.ticketId)).get();
    if (!ticket || ticket.adapterId !== input.adapter.id || ticket.tokenHash !== hash) {
      throw new Error('Interaction 动作票据不存在或已轮换');
    }
    if (!ticket.interactionId || ticket.promptCardId) {
      throw new Error('Interaction 响应票据 Subject 无效');
    }
    let responsePayload: unknown;
    try {
      responsePayload = JSON.parse(ticket.responsePayload);
    } catch {
      throw new Error('Interaction 动作票据响应损坏');
    }
    if (ticket.status === 'consumed') {
      const replayed = await commitInteractionResponseWithExecutor(tx, {
        requestId: ticket.interactionId,
        responsePayload,
        source: 'im',
        operatorId: ticket.consumedBy || input.operatorId,
        idempotencyKey: `feishu-ticket:${ticket.id}`,
        now: input.now,
      });
      return Object.freeze({ replayed: true, unavailable: null });
    }
    if (ticket.status === 'expired') return Object.freeze({ replayed: false, unavailable: 'expired' });
    if (ticket.status === 'cancelled') return Object.freeze({ replayed: false, unavailable: 'closed' });
    if (ticket.status !== 'pending') throw new Error('Interaction 动作票据已失效');
    const interaction = await tx.select({
      status: schema.interactionRequests.status,
      expiresAt: schema.interactionRequests.expiresAt,
    }).from(schema.interactionRequests)
      .where(eq(schema.interactionRequests.id, ticket.interactionId)).get();
    if (!interaction) throw new Error('Interaction request 不存在');
    if (interaction.status === 'expired') {
      await tx.update(schema.interactionActionTickets).set({
        status: 'expired',
        updatedAt: input.now.toISOString(),
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionActionTickets.interactionId, ticket.interactionId),
        eq(schema.interactionActionTickets.status, 'pending'),
      )).run();
      return Object.freeze({ replayed: false, unavailable: 'expired' });
    }
    if (interaction.status !== 'pending') {
      await tx.update(schema.interactionActionTickets).set({
        status: 'cancelled',
        updatedAt: input.now.toISOString(),
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionActionTickets.interactionId, ticket.interactionId),
        eq(schema.interactionActionTickets.status, 'pending'),
      )).run();
      return Object.freeze({ replayed: false, unavailable: 'closed' });
    }
    const effectiveExpiresAtMs = Math.min(parsed.expiresAtMs + 999, Date.parse(ticket.expiresAt));
    if (effectiveExpiresAtMs <= input.now.getTime() || Date.parse(interaction.expiresAt) <= input.now.getTime()) {
      await commitInteractionResponseWithExecutor(tx, {
        requestId: ticket.interactionId,
        responsePayload,
        source: 'im',
        operatorId: input.operatorId,
        idempotencyKey: `feishu-ticket:${ticket.id}`,
        now: input.now,
      });
      await tx.update(schema.interactionActionTickets).set({
        status: 'expired',
        updatedAt: input.now.toISOString(),
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionActionTickets.interactionId, ticket.interactionId),
        eq(schema.interactionActionTickets.status, 'pending'),
      )).run();
      return Object.freeze({ replayed: false, unavailable: 'expired' });
    }
    const committed = await commitInteractionResponseWithExecutor(tx, {
      requestId: ticket.interactionId,
      responsePayload,
      source: 'im',
      operatorId: input.operatorId,
      idempotencyKey: `feishu-ticket:${ticket.id}`,
      now: input.now,
    });
    if (committed.expired) {
      await tx.update(schema.interactionActionTickets).set({
        status: 'expired',
        updatedAt: input.now.toISOString(),
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionActionTickets.interactionId, ticket.interactionId),
        eq(schema.interactionActionTickets.status, 'pending'),
      )).run();
      return Object.freeze({ replayed: false, unavailable: 'expired' });
    }
    const consumed = await tx.update(schema.interactionActionTickets).set({
      status: 'consumed',
      consumedAt: input.now.toISOString(),
      consumedBy: input.operatorId,
      updatedAt: input.now.toISOString(),
      stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
    }).where(and(
      eq(schema.interactionActionTickets.id, ticket.id),
      eq(schema.interactionActionTickets.status, 'pending'),
      eq(schema.interactionActionTickets.stateVersion, ticket.stateVersion),
    )).run();
    if (affectedRows(consumed) <= 0) throw new Error('Interaction 动作票据已被并发处理');
    await tx.update(schema.interactionActionTickets).set({
      status: 'cancelled',
      updatedAt: input.now.toISOString(),
      stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
    }).where(and(
      eq(schema.interactionActionTickets.interactionId, ticket.interactionId),
      eq(schema.interactionActionTickets.status, 'pending'),
      sql`${schema.interactionActionTickets.actionKey} not like ${`${BRIDGE_PROMPT_ACTION_PREFIX}%`}`,
    )).run();
    return Object.freeze({ replayed: committed.deduplicated, unavailable: null });
  });
}

async function consumeBridgePromptTicket(input: {
  adapter: AdapterRow;
  token: string;
  operatorId: string;
  prompt: string;
  now: Date;
}): Promise<Readonly<{
  replayed: boolean;
  unavailable: 'expired' | 'closed' | null;
  taskId: string | null;
  subjectKind: 'interaction' | 'prompt_card';
}>> {
  const parsed = parseAndVerifyTicketToken(input.token, input.now.getTime());
  const hash = tokenHash(parsed.token);
  const ticket = await db.select().from(schema.interactionActionTickets)
    .where(eq(schema.interactionActionTickets.id, parsed.ticketId)).get();
  if (!ticket || ticket.adapterId !== input.adapter.id || ticket.tokenHash !== hash) {
    throw new Error('Interaction 动作票据不存在或已轮换');
  }
  const subjectCondition = ticketSubjectCondition(ticket);
  const subjectKind = ticket.promptCardId ? 'prompt_card' as const : 'interaction' as const;
  const submissionMode = bridgePromptModeFromActionKey(ticket.actionKey);
  if (!submissionMode) throw new Error('Interaction 动作票据不是人工 Prompt');
  if (ticket.status === 'consumed') {
    return Object.freeze({ replayed: true, unavailable: null, taskId: null, subjectKind });
  }
  if (ticket.status === 'expired') {
    return Object.freeze({ replayed: false, unavailable: 'expired', taskId: null, subjectKind });
  }
  if (ticket.status === 'cancelled') {
    return Object.freeze({ replayed: false, unavailable: 'closed', taskId: null, subjectKind });
  }
  if (ticket.status !== 'pending') throw new Error('Interaction 动作票据已失效');
  const effectiveExpiresAtMs = Math.min(parsed.expiresAtMs + 999, Date.parse(ticket.expiresAt));
  if (effectiveExpiresAtMs <= input.now.getTime()) {
    await db.transaction(async (tx: DbExecutor) => {
      await tx.update(schema.interactionActionTickets).set({
        status: 'expired',
        updatedAt: input.now.toISOString(),
        stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
      }).where(and(
        subjectCondition,
        eq(schema.interactionActionTickets.status, 'pending'),
        sql`${schema.interactionActionTickets.actionKey} like ${`${BRIDGE_PROMPT_ACTION_PREFIX}%`}`,
      )).run();
      if (ticket.promptCardId) {
        await tx.update(schema.interactionPromptCards).set({
          status: 'expired',
          updatedAt: input.now.toISOString(),
          stateVersion: sql`${schema.interactionPromptCards.stateVersion} + 1`,
        }).where(and(
          eq(schema.interactionPromptCards.id, ticket.promptCardId),
          eq(schema.interactionPromptCards.status, 'pending'),
        )).run();
      }
    });
    return Object.freeze({ replayed: false, unavailable: 'expired', taskId: null, subjectKind });
  }
  if (!input.prompt || input.prompt.length > 4_000) throw new Error('人工 Prompt 不能为空且不能超过 4000 字符');
  const interaction = ticket.interactionId ? await getInteractionRequest(ticket.interactionId) : null;
  const promptCard = ticket.promptCardId
    ? await db.select().from(schema.interactionPromptCards)
      .where(eq(schema.interactionPromptCards.id, ticket.promptCardId)).get()
    : null;
  let promptCardContext: Awaited<ReturnType<typeof resolvePromptCardContext>> | null = null;
  if (subjectKind === 'interaction') {
    if (!interaction || !interaction.state.threadId) throw new Error('Interaction 缺少可用的 Codex Thread');
    if (interaction.state.status === 'expired' || interaction.state.status === 'cancelled') {
      return Object.freeze({ replayed: false, unavailable: 'closed', taskId: null, subjectKind });
    }
  } else {
    if (!promptCard) throw new Error('Prompt 卡片不存在');
    if (promptCard.status === 'expired') {
      return Object.freeze({ replayed: false, unavailable: 'expired', taskId: null, subjectKind });
    }
    if (promptCard.status !== 'pending') {
      return Object.freeze({ replayed: false, unavailable: 'closed', taskId: null, subjectKind });
    }
    if (Date.parse(promptCard.expiresAt) <= input.now.getTime()) {
      await expireFeishuBridgePromptCards(input.now);
      return Object.freeze({ replayed: false, unavailable: 'expired', taskId: null, subjectKind });
    }
    promptCardContext = await resolvePromptCardContext({
      contextTaskId: promptCard.contextTaskId,
      deviceId: promptCard.deviceId,
      threadId: promptCard.threadId,
    });
  }
  const interactionActive = interaction
    ? interaction.state.status === 'pending' || interaction.state.status === 'response_pending'
    : false;
  const activeFlags = interactionActive && interaction
    ? interaction.state.kind === 'user_input' || interaction.state.kind === 'mcp_elicitation'
      ? ['waitingOnUserInput'] as const
      : ['waitingOnApproval'] as const
    : [] as const;
  const subjectIdempotencyKey = ticket.promptCardId
    ? `feishu-prompt-subject:prompt-card:${ticket.promptCardId}`
    : `feishu-prompt-subject:interaction:${ticket.interactionId}`;
  const created = await createManualBridgePromptTask({
    contextTaskId: promptCard?.contextTaskId,
    deviceId: promptCard?.deviceId || interaction?.state.deviceId,
    threadId: promptCard?.threadId || interaction?.state.threadId,
    threadStatus: interaction ? 'active' : promptCardContext?.threadStatus,
    activeFlags: interaction ? activeFlags : promptCardContext?.activeFlags,
    activeTurnId: interaction?.state.turnId || promptCardContext?.activeTurnId,
    prompt: input.prompt,
    submissionMode,
    source: 'im',
    operatorId: input.operatorId,
    sourceAdapterId: input.adapter.id,
    idempotencyKey: subjectIdempotencyKey,
    now: input.now,
  });
  const replayed = await db.transaction(async (tx: DbExecutor) => {
    const current = await tx.select().from(schema.interactionActionTickets)
      .where(eq(schema.interactionActionTickets.id, ticket.id)).get();
    if (!current) throw new Error('Interaction 动作票据不存在');
    if (current.status === 'consumed') return true;
    if (current.status !== 'pending') throw new Error('Interaction 动作票据已失效');
    if (ticket.promptCardId) {
      const currentCard = await tx.select().from(schema.interactionPromptCards)
        .where(eq(schema.interactionPromptCards.id, ticket.promptCardId)).get();
      if (!currentCard) throw new Error('Prompt 卡片不存在');
      if (currentCard.status === 'consumed') return true;
      if (currentCard.status !== 'pending') throw new Error('Prompt 卡片已关闭');
      const consumedCard = await tx.update(schema.interactionPromptCards).set({
        status: 'consumed',
        consumedTaskId: created.task.state.taskId,
        consumedBy: input.operatorId,
        consumedAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
        stateVersion: sql`${schema.interactionPromptCards.stateVersion} + 1`,
      }).where(and(
        eq(schema.interactionPromptCards.id, currentCard.id),
        eq(schema.interactionPromptCards.status, 'pending'),
        eq(schema.interactionPromptCards.stateVersion, currentCard.stateVersion),
      )).run();
      if (affectedRows(consumedCard) <= 0) throw new Error('Prompt 卡片已被并发处理');
    }
    const consumed = await tx.update(schema.interactionActionTickets).set({
      status: 'consumed',
      consumedAt: input.now.toISOString(),
      consumedBy: input.operatorId,
      updatedAt: input.now.toISOString(),
      stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
    }).where(and(
      eq(schema.interactionActionTickets.id, current.id),
      eq(schema.interactionActionTickets.status, 'pending'),
      eq(schema.interactionActionTickets.stateVersion, current.stateVersion),
    )).run();
    if (affectedRows(consumed) <= 0) {
      const raced = await tx.select().from(schema.interactionActionTickets)
        .where(eq(schema.interactionActionTickets.id, current.id)).get();
      if (raced?.status === 'consumed') return true;
      throw new Error('Interaction 动作票据已被并发处理');
    }
    await tx.update(schema.interactionActionTickets).set({
      status: 'cancelled',
      updatedAt: input.now.toISOString(),
      stateVersion: sql`${schema.interactionActionTickets.stateVersion} + 1`,
    }).where(and(
      subjectCondition,
      eq(schema.interactionActionTickets.status, 'pending'),
      sql`${schema.interactionActionTickets.actionKey} like ${`${BRIDGE_PROMPT_ACTION_PREFIX}%`}`,
    )).run();
    return false;
  });
  return Object.freeze({
    replayed: replayed || created.deduplicated,
    unavailable: null,
    taskId: created.task.state.taskId,
    subjectKind,
  });
}

async function loadEnabledFeishuAdapter(adapterIdInput: unknown): Promise<AdapterRow> {
  const adapterId = normalizeText(adapterIdInput, 'Adapter ID', 128);
  const adapter = await db.select().from(schema.interactionAdapters)
    .where(and(
      eq(schema.interactionAdapters.id, adapterId),
      eq(schema.interactionAdapters.kind, 'feishu'),
      eq(schema.interactionAdapters.enabled, true),
    )).get();
  if (!adapter) throw new Error('飞书 Interaction Adapter 不存在或已停用');
  return adapter;
}

async function handlePreparedFeishuCallback(
  adapter: AdapterRow,
  body: Record<string, unknown>,
  now: Date,
): Promise<Record<string, unknown>> {
  await db.update(schema.interactionAdapters).set({
    lastCallbackAt: now.toISOString(),
    lastError: null,
    updatedAt: now.toISOString(),
  }).where(eq(schema.interactionAdapters.id, adapter.id)).run();

  if (typeof body.challenge === 'string') return { challenge: body.challenge };
  const event = callbackEvent(body);
  const eventType = isRecord(body.header) && typeof body.header.event_type === 'string'
    ? body.header.event_type
    : typeof body.type === 'string'
      ? body.type
      : '';
  if (eventType === 'im.message.receive_v1') {
    return await consumeFeishuTopicMessage({
      adapter,
      body,
      now,
    });
  }
  if (eventType && eventType !== 'card.action.trigger') return { success: true, ignored: true };

  const operator = callbackOperator(body);
  if (!operator.operatorId) throw new FeishuCallbackUserError('飞书回调缺少操作者身份');
  const allowlist = new Set(parseOperatorAllowlist(adapter.operatorAllowlist));
  if (!operator.identities.some((identity) => allowlist.has(identity))) {
    throw new FeishuCallbackUserError('飞书操作者不在 Interaction 白名单中');
  }
  const topicPromptToken = callbackTopicPromptToken(body);
  if (topicPromptToken) {
    const prompt = callbackFormPrompt(body);
    let consumed: Awaited<ReturnType<typeof consumeFeishuTopicPrompt>>;
    try {
      consumed = await consumeFeishuTopicPrompt({
        adapter,
        token: topicPromptToken,
        operatorId: operator.operatorId,
        prompt,
        eventId: callbackEventId(body) || callbackFallbackId(body),
        now,
      });
    } catch (error) {
      throw new FeishuCallbackUserError(
        String((error as Error)?.message || error || '话题 Prompt 处理失败').slice(0, 500),
        { cause: error },
      );
    }
    return {
      toast: {
        type: 'success',
        content: consumed.replayed
          ? '该 Prompt 已处理'
          : `Prompt 已进入会话 ${consumed.binding.codexThreadId}`,
      },
    };
  }
  const actionToken = callbackActionToken(body);
  let promptAction = false;
  try {
    promptAction = await isBridgePromptActionTicket(adapter, actionToken, now);
  } catch (error) {
    throw new FeishuCallbackUserError(
      String((error as Error)?.message || error || 'Interaction 动作票据无效').slice(0, 500),
      { cause: error },
    );
  }
  if (promptAction) {
    const prompt = callbackFormPrompt(body);
    let consumed: Awaited<ReturnType<typeof consumeBridgePromptTicket>>;
    try {
      consumed = await consumeBridgePromptTicket({
        adapter,
        token: actionToken,
        operatorId: operator.operatorId,
        prompt,
        now,
      });
    } catch (error) {
      if (error instanceof FeishuCallbackUserError) throw error;
      throw new FeishuCallbackUserError(
        String((error as Error)?.message || error || '人工 Prompt 处理失败').slice(0, 500),
        { cause: error },
      );
    }
    if (consumed.unavailable === 'expired') {
      return {
        toast: {
          type: 'warning',
          content: consumed.subjectKind === 'prompt_card'
            ? 'Prompt 卡片已过期，请从控制台重新发送'
            : 'Prompt 卡片已过期，请刷新 Interaction',
        },
      };
    }
    if (consumed.unavailable === 'closed') {
      return {
        toast: {
          type: 'warning',
          content: consumed.subjectKind === 'prompt_card' ? '该 Prompt 卡片已关闭' : '该 Interaction 已关闭',
        },
      };
    }
    return {
      toast: {
        type: 'success',
        content: consumed.replayed ? '该 Prompt 已处理' : 'Prompt 已进入 Bridge 队列',
      },
    };
  }
  let consumed: Awaited<ReturnType<typeof consumeActionTicket>>;
  try {
    consumed = await consumeActionTicket({
      adapter,
      token: actionToken,
      operatorId: operator.operatorId,
      now,
    });
  } catch (error) {
    if (error instanceof FeishuCallbackUserError) throw error;
    throw new FeishuCallbackUserError(
      String((error as Error)?.message || error || 'Interaction 动作处理失败').slice(0, 500),
      { cause: error },
    );
  }
  if (consumed.unavailable === 'expired') {
    return {
      toast: {
        type: 'warning',
        content: '该请求已过期，请在 r-api 控制台刷新',
      },
    };
  }
  if (consumed.unavailable === 'closed') {
    return {
      toast: {
        type: 'warning',
        content: '该请求已由其他入口处理',
      },
    };
  }
  return {
    toast: {
      type: 'success',
      content: consumed.replayed ? '该操作已处理' : '已提交到 r-api',
    },
  };
}

export async function handleFeishuInteractionCallback(
  adapterIdInput: unknown,
  bodyInput: unknown,
  nowInput: Date | number = new Date(),
  securityInput?: FeishuCallbackSecurityInput,
): Promise<Record<string, unknown>> {
  if (!isRecord(bodyInput)) throw new Error('飞书回调正文无效');
  const adapter = await loadEnabledFeishuAdapter(adapterIdInput);
  const body = await prepareFeishuCallbackBody(adapter, bodyInput, securityInput);
  const expectedVerificationToken = await resolveVerificationToken(adapter);
  const receivedVerificationToken = callbackVerificationToken(body);
  if (!receivedVerificationToken || !safeEqualSecret(receivedVerificationToken, expectedVerificationToken)) {
    throw new Error('飞书回调 Verification Token 无效');
  }
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  return await handlePreparedFeishuCallback(adapter, body, now);
}

export async function handleFeishuLongConnectionCallback(input: {
  adapterId: unknown;
  eventType: unknown;
  event: unknown;
  eventId?: unknown;
  now?: Date | number;
}): Promise<Record<string, unknown>> {
  if (!isRecord(input.event)) throw new Error('飞书长连接事件正文无效');
  const adapter = await loadEnabledFeishuAdapter(input.adapterId);
  const eventType = normalizeText(input.eventType, '飞书长连接事件类型', 128);
  const eventId = input.eventId == null || input.eventId === ''
    ? null
    : normalizeText(input.eventId, '飞书长连接事件 ID', 256);
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  return await handlePreparedFeishuCallback(adapter, {
    header: {
      event_type: eventType,
      ...(eventId ? { event_id: eventId } : {}),
    },
    event: input.event,
  }, now);
}

export const feishuInteractionAdapterInternals = {
  actionSpecs,
  buildTicketToken,
  parseAndVerifyTicketToken,
  tokenHash,
  tenantTokenCache,
};
