import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lte, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  LOCAL_CONNECTOR_ACTION_KINDS,
  LOCAL_CONNECTOR_ACTION_OPERATIONS,
  LOCAL_CONNECTOR_ACTION_STATUSES,
  LOCAL_CONNECTOR_SCOPES,
  type LocalConnectorActionKind,
  type LocalConnectorActionManifest,
  type LocalConnectorActionOperation,
  type LocalConnectorActionStatus,
  type LocalConnectorEventKind,
  type LocalConnectorScope,
} from '../local-connector/protocol.js';
import { sendNotification, type NotificationDispatchResult } from './notifyService.js';
import { getConfiguredNotificationChannels, type NotificationChannel } from './notificationChannelDispatcher.js';
import { stopBridgeContinuationTasksForDevice } from './bridgeContinuationService.js';
import { cancelInteractionRequestsForDevice } from './interactionRequestService.js';
import {
  parseObservedAppServerEvent,
  recordLocalConnectorThreadEvent,
} from './localConnectorThreadService.js';

export {
  LOCAL_CONNECTOR_ACTION_KINDS,
  LOCAL_CONNECTOR_ACTION_OPERATIONS,
  LOCAL_CONNECTOR_ACTION_STATUSES,
  LOCAL_CONNECTOR_SCOPES,
};
export type {
  LocalConnectorActionKind,
  LocalConnectorActionOperation,
  LocalConnectorActionStatus,
  LocalConnectorEventKind,
  LocalConnectorScope,
};

export type LocalConnectorDevicePublic = Omit<
  typeof schema.localConnectorDevices.$inferSelect,
  'tokenHash' | 'scopes' | 'capabilities'
> & {
  scopes: LocalConnectorScope[];
  capabilities: string[];
};

export type LocalConnectorActionPublic = Omit<
  typeof schema.localConnectorActions.$inferSelect,
  'manifest' | 'resultPayload'
> & {
  manifest: LocalConnectorActionManifest;
  result: Record<string, unknown> | null;
};

export type CreateLocalConnectorPairingInput = {
  deviceName: string;
  scopes?: LocalConnectorScope[];
  ttlSec?: number;
};

export type CreateLocalConnectorPairingResult = {
  pairingId: string;
  pairingToken: string;
  deviceName: string;
  scopes: LocalConnectorScope[];
  expiresAt: string;
};

export type ClaimLocalConnectorPairingInput = {
  pairingId: string;
  pairingToken: string;
  platform: string;
  version?: string;
  capabilities?: string[];
};

export type ClaimLocalConnectorPairingResult = {
  device: LocalConnectorDevicePublic;
  connectorToken: string;
};

export type LocalConnectorIdentity = {
  device: LocalConnectorDevicePublic;
  tokenHash: string;
};

export type LocalConnectorRuntimeMetadataInput = {
  version?: unknown;
  capabilities?: unknown;
};

const DEFAULT_PAIRING_SCOPES: LocalConnectorScope[] = [
  'hooks.manage',
  'hooks.emit',
  'notify.manage',
  'notify.emit',
  'app_server.observe',
  'app_server.control',
];
const PAIRING_TTL_MIN_SEC = 60;
const PAIRING_TTL_MAX_SEC = 30 * 60;
const ACTION_TTL_MIN_SEC = 60;
const ACTION_TTL_MAX_SEC = 24 * 60 * 60;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_EVENT_MESSAGE_BYTES = 16 * 1024;

function hashSecret(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex');
}

function hashPairingToken(token: string): string {
  return hashSecret('local-connector-pairing', token);
}

function hashConnectorToken(token: string): string {
  return hashSecret('local-connector-device', token);
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label}不能为空且不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error(`字段不能超过 ${maxLength} 个字符`);
  return normalized;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeCapabilities(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const values = input
    .map((item) => typeof item === 'string' ? item.trim().toLowerCase() : '')
    .filter((item) => item && item.length <= 80);
  return [...new Set(values)].slice(0, 64);
}

function normalizeScopes(input: unknown, fallback = DEFAULT_PAIRING_SCOPES): LocalConnectorScope[] {
  const source = Array.isArray(input) ? input : fallback;
  const allowed = new Set<string>(LOCAL_CONNECTOR_SCOPES);
  const scopes = source
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item): item is LocalConnectorScope => allowed.has(item));
  const normalized = [...new Set(scopes)];
  if (normalized.length === 0) throw new Error('至少需要选择一个 Connector 权限');
  return normalized;
}

function normalizePlatform(value: unknown): string {
  const platform = normalizeText(value, '设备平台', 80).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(platform)) throw new Error('设备平台格式无效');
  return platform;
}

function normalizePairingId(value: unknown): string {
  return normalizeText(value, '配对 id', 80);
}

function normalizePairingToken(value: unknown): string {
  const token = normalizeText(value, '配对令牌', 256);
  if (!token.startsWith('lcp_') || token.length < 40) throw new Error('配对令牌无效');
  return token;
}

function normalizeConnectorToken(value: unknown): string {
  const token = normalizeText(value, 'Connector 令牌', 256);
  if (!token.startsWith('lc_') || token.length < 40) throw new Error('Connector 令牌无效');
  return token;
}

function toPublicDevice(row: typeof schema.localConnectorDevices.$inferSelect): LocalConnectorDevicePublic {
  const { tokenHash: _tokenHash, scopes, capabilities, ...publicRow } = row;
  return {
    ...publicRow,
    scopes: normalizeScopes(parseStringArray(scopes), []),
    capabilities: parseStringArray(capabilities),
  };
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseActionManifest(raw: string): LocalConnectorActionManifest {
  const parsed = parseJsonRecord(raw);
  if (!parsed || parsed.protocol !== 'metapi.local-connector.action.v1') {
    throw new Error('Connector 动作清单损坏');
  }
  return parsed as unknown as LocalConnectorActionManifest;
}

function toPublicAction(row: typeof schema.localConnectorActions.$inferSelect): LocalConnectorActionPublic {
  const { manifest, resultPayload, ...publicRow } = row;
  return {
    ...publicRow,
    manifest: parseActionManifest(manifest),
    result: parseJsonRecord(resultPayload),
  };
}

function normalizeActionKind(value: unknown): LocalConnectorActionKind {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(LOCAL_CONNECTOR_ACTION_KINDS as readonly string[]).includes(normalized)) {
    throw new Error('Connector 动作类型无效');
  }
  return normalized as LocalConnectorActionKind;
}

function normalizeActionOperation(value: unknown): LocalConnectorActionOperation {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(LOCAL_CONNECTOR_ACTION_OPERATIONS as readonly string[]).includes(normalized)) {
    throw new Error('Connector 动作操作无效');
  }
  return normalized as LocalConnectorActionOperation;
}

function normalizeActionStatus(value: unknown): LocalConnectorActionStatus | undefined {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (LOCAL_CONNECTOR_ACTION_STATUSES as readonly string[]).includes(normalized)
    ? normalized as LocalConnectorActionStatus
    : undefined;
}

function normalizeAgent(value: unknown): 'codex' | 'claude_code' {
  return value === 'claude_code' ? 'claude_code' : 'codex';
}

function normalizeEventNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const values = input
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item) => item && item.length <= 80 && /^[a-zA-Z0-9._:-]+$/.test(item));
  return [...new Set(values)].slice(0, 32);
}

function requiredScopeForAction(kind: LocalConnectorActionKind): LocalConnectorScope {
  return kind === 'hook' ? 'hooks.manage' : 'notify.manage';
}

function requiredScopeForEvent(kind: 'hook' | 'notify' | 'app_server' | 'browser_recovery'): LocalConnectorScope {
  if (kind === 'hook') return 'hooks.emit';
  if (kind === 'notify') return 'notify.emit';
  if (kind === 'app_server') return 'app_server.observe';
  return 'browser.recovery';
}

function assertScope(device: LocalConnectorDevicePublic, scope: LocalConnectorScope): void {
  if (!device.scopes.includes(scope)) throw new Error(`Connector 缺少权限: ${scope}`);
}

export async function requireActiveLocalConnectorDevice(
  deviceIdInput: unknown,
  requiredScope?: LocalConnectorScope,
): Promise<LocalConnectorDevicePublic> {
  const deviceId = normalizeText(deviceIdInput, '设备 id', 80);
  const row = await db.select().from(schema.localConnectorDevices).where(and(
    eq(schema.localConnectorDevices.id, deviceId),
    eq(schema.localConnectorDevices.status, 'active'),
  )).get();
  if (!row) throw new Error('Connector 设备不存在或已撤销');
  const device = toPublicDevice(row);
  if (requiredScope) assertScope(device, requiredScope);
  return device;
}

function affectedRows(result: any): number {
  return Number(result?.changes ?? result?.rowCount ?? result?.affectedRows ?? 0);
}

async function expirePairings(nowIso = new Date().toISOString()): Promise<void> {
  await db.update(schema.localConnectorPairings).set({
    status: 'expired',
    updatedAt: nowIso,
  }).where(and(
    eq(schema.localConnectorPairings.status, 'pending'),
    lte(schema.localConnectorPairings.expiresAt, nowIso),
  )).run();
}

async function expireActions(nowIso = new Date().toISOString()): Promise<void> {
  await db.update(schema.localConnectorActions).set({
    status: 'expired',
    completedAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    inArray(schema.localConnectorActions.status, ['pending', 'claimed']),
    lte(schema.localConnectorActions.expiresAt, nowIso),
  )).run();
}

export async function createLocalConnectorPairing(
  input: CreateLocalConnectorPairingInput,
): Promise<CreateLocalConnectorPairingResult> {
  await expirePairings();
  const deviceName = normalizeText(input.deviceName, '设备名称', 120);
  const scopes = normalizeScopes(input.scopes);
  const ttlSecRaw = input.ttlSec == null ? 5 * 60 : Math.trunc(Number(input.ttlSec));
  if (!Number.isFinite(ttlSecRaw) || ttlSecRaw < PAIRING_TTL_MIN_SEC || ttlSecRaw > PAIRING_TTL_MAX_SEC) {
    throw new Error(`配对有效期必须在 ${PAIRING_TTL_MIN_SEC} 到 ${PAIRING_TTL_MAX_SEC} 秒之间`);
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const pairingId = randomUUID();
  const pairingToken = `lcp_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + ttlSecRaw * 1000).toISOString();

  await db.insert(schema.localConnectorPairings).values({
    id: pairingId,
    deviceName,
    requestedScopes: JSON.stringify(scopes),
    tokenHash: hashPairingToken(pairingToken),
    status: 'pending',
    expiresAt,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();

  return { pairingId, pairingToken, deviceName, scopes, expiresAt };
}

export async function cancelLocalConnectorPairing(pairingIdInput: unknown): Promise<boolean> {
  const pairingId = normalizePairingId(pairingIdInput);
  const nowIso = new Date().toISOString();
  const result = await db.update(schema.localConnectorPairings).set({
    status: 'cancelled',
    cancelledAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.localConnectorPairings.id, pairingId),
    eq(schema.localConnectorPairings.status, 'pending'),
  )).run();
  return affectedRows(result) > 0;
}

export async function claimLocalConnectorPairing(
  input: ClaimLocalConnectorPairingInput,
): Promise<ClaimLocalConnectorPairingResult> {
  await expirePairings();
  const pairingId = normalizePairingId(input.pairingId);
  const pairingToken = normalizePairingToken(input.pairingToken);
  const tokenHash = hashPairingToken(pairingToken);
  const platform = normalizePlatform(input.platform);
  const version = normalizeOptionalText(input.version, 80);
  const capabilities = normalizeCapabilities(input.capabilities);
  const connectorToken = `lc_${randomBytes(32).toString('base64url')}`;
  const deviceId = randomUUID();
  const nowIso = new Date().toISOString();
  let deviceRow: typeof schema.localConnectorDevices.$inferSelect | null = null;

  await db.transaction(async (tx) => {
    const pairing = await tx.select().from(schema.localConnectorPairings).where(and(
      eq(schema.localConnectorPairings.id, pairingId),
      eq(schema.localConnectorPairings.tokenHash, tokenHash),
      eq(schema.localConnectorPairings.status, 'pending'),
      gt(schema.localConnectorPairings.expiresAt, nowIso),
    )).get();
    if (!pairing) throw new Error('配对不存在、已使用、已取消或已过期');

    const scopes = normalizeScopes(parseStringArray(pairing.requestedScopes), []);
    await tx.insert(schema.localConnectorDevices).values({
      id: deviceId,
      name: pairing.deviceName,
      platform,
      version,
      status: 'active',
      tokenHash: hashConnectorToken(connectorToken),
      scopes: JSON.stringify(scopes),
      capabilities: capabilities.length > 0 ? JSON.stringify(capabilities) : null,
      pairedAt: nowIso,
      lastSeenAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    }).run();

    const claimed = await tx.update(schema.localConnectorPairings).set({
      status: 'claimed',
      claimedDeviceId: deviceId,
      claimedAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.localConnectorPairings.id, pairingId),
      eq(schema.localConnectorPairings.tokenHash, tokenHash),
      eq(schema.localConnectorPairings.status, 'pending'),
      gt(schema.localConnectorPairings.expiresAt, nowIso),
    )).run();
    if (affectedRows(claimed) <= 0) throw new Error('配对已被其他 Connector 领取');
    deviceRow = await tx.select().from(schema.localConnectorDevices)
      .where(eq(schema.localConnectorDevices.id, deviceId))
      .get() ?? null;
  });

  if (!deviceRow) throw new Error('Connector 设备创建失败');
  return { device: toPublicDevice(deviceRow), connectorToken };
}

export async function authenticateLocalConnectorToken(tokenInput: unknown): Promise<LocalConnectorIdentity | null> {
  let token: string;
  try {
    token = normalizeConnectorToken(tokenInput);
  } catch {
    return null;
  }
  const tokenHash = hashConnectorToken(token);
  const row = await db.select().from(schema.localConnectorDevices).where(and(
    eq(schema.localConnectorDevices.tokenHash, tokenHash),
    eq(schema.localConnectorDevices.status, 'active'),
  )).get();
  if (!row) return null;

  const nowIso = new Date().toISOString();
  if (!row.lastSeenAt || Date.now() - Date.parse(row.lastSeenAt) >= 30_000) {
    await db.update(schema.localConnectorDevices).set({
      lastSeenAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.localConnectorDevices.id, row.id),
      eq(schema.localConnectorDevices.status, 'active'),
    )).run();
    row.lastSeenAt = nowIso;
    row.updatedAt = nowIso;
  }
  return { device: toPublicDevice(row), tokenHash };
}

export async function updateLocalConnectorRuntimeMetadata(
  identity: LocalConnectorIdentity,
  input: LocalConnectorRuntimeMetadataInput,
): Promise<LocalConnectorIdentity> {
  const version = input.version === undefined
    ? identity.device.version
    : normalizeOptionalText(input.version, 80);
  const capabilities = input.capabilities === undefined
    ? identity.device.capabilities
    : normalizeCapabilities(input.capabilities);
  const capabilitiesChanged = JSON.stringify(capabilities) !== JSON.stringify(identity.device.capabilities);
  if (version === identity.device.version && !capabilitiesChanged) return identity;

  const nowIso = new Date().toISOString();
  await db.update(schema.localConnectorDevices).set({
    version,
    capabilities: capabilities.length > 0 ? JSON.stringify(capabilities) : null,
    lastSeenAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.localConnectorDevices.id, identity.device.id),
    eq(schema.localConnectorDevices.status, 'active'),
  )).run();
  return {
    tokenHash: identity.tokenHash,
    device: {
      ...identity.device,
      version,
      capabilities,
      lastSeenAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

export async function listLocalConnectorDevices(): Promise<LocalConnectorDevicePublic[]> {
  const rows = await db.select().from(schema.localConnectorDevices)
    .orderBy(desc(schema.localConnectorDevices.createdAt))
    .all();
  return rows.map(toPublicDevice);
}

export async function revokeLocalConnectorDevice(deviceIdInput: unknown): Promise<boolean> {
  const deviceId = normalizeText(deviceIdInput, '设备 id', 80);
  const nowIso = new Date().toISOString();
  const result = await db.update(schema.localConnectorDevices).set({
    status: 'revoked',
    revokedAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.localConnectorDevices.id, deviceId),
    eq(schema.localConnectorDevices.status, 'active'),
  )).run();
  if (affectedRows(result) > 0) {
    await db.update(schema.localConnectorActions).set({
      status: 'cancelled',
      completedAt: nowIso,
      errorMessage: 'device revoked',
      updatedAt: nowIso,
    }).where(and(
      eq(schema.localConnectorActions.deviceId, deviceId),
      inArray(schema.localConnectorActions.status, ['pending', 'claimed']),
    )).run();
    await stopBridgeContinuationTasksForDevice(deviceId);
    await cancelInteractionRequestsForDevice(deviceId);
    return true;
  }
  return false;
}

export async function createLocalConnectorAction(input: {
  deviceId: string;
  kind: LocalConnectorActionKind;
  operation: LocalConnectorActionOperation;
  agent?: 'codex' | 'claude_code';
  backupRef?: string | null;
  eventNames?: string[];
  ttlSec?: number;
}): Promise<LocalConnectorActionPublic> {
  await expireActions();
  const deviceId = normalizeText(input.deviceId, '设备 id', 80);
  const kind = normalizeActionKind(input.kind);
  const operation = normalizeActionOperation(input.operation);
  const agent = normalizeAgent(input.agent);
  const backupRef = normalizeOptionalText(input.backupRef, 512);
  if (operation === 'rollback' && !backupRef) throw new Error('回滚动作必须提供 backupRef');
  const ttlSecRaw = input.ttlSec == null ? 30 * 60 : Math.trunc(Number(input.ttlSec));
  if (!Number.isFinite(ttlSecRaw) || ttlSecRaw < ACTION_TTL_MIN_SEC || ttlSecRaw > ACTION_TTL_MAX_SEC) {
    throw new Error(`动作有效期必须在 ${ACTION_TTL_MIN_SEC} 到 ${ACTION_TTL_MAX_SEC} 秒之间`);
  }

  await requireActiveLocalConnectorDevice(deviceId, requiredScopeForAction(kind));

  const existing = await db.select({ id: schema.localConnectorActions.id })
    .from(schema.localConnectorActions)
    .where(and(
      eq(schema.localConnectorActions.deviceId, deviceId),
      eq(schema.localConnectorActions.kind, kind),
      inArray(schema.localConnectorActions.status, ['pending', 'claimed']),
    ))
    .get();
  if (existing) throw new Error(`设备已有未完成的 ${kind} 动作`);

  const now = new Date();
  const nowIso = now.toISOString();
  const actionId = randomUUID();
  const manifest: LocalConnectorActionManifest = {
    protocol: 'metapi.local-connector.action.v1',
    actionId,
    kind,
    operation,
    agent,
    requiresBackup: operation === 'install' || operation === 'uninstall',
    backupRef,
    eventNames: normalizeEventNames(input.eventNames),
    endpoints: {
      events: '/api/local-connector/public/events',
      browserRecoveryClaim: '/api/browser-credential-tasks/public/claim',
      browserRecoveryComplete: '/api/browser-credential-tasks/public/complete',
    },
    createdAt: nowIso,
  };
  const expiresAt = new Date(now.getTime() + ttlSecRaw * 1000).toISOString();

  await db.insert(schema.localConnectorActions).values({
    id: actionId,
    deviceId,
    kind,
    operation,
    status: 'pending',
    manifest: JSON.stringify(manifest),
    backupRef,
    expiresAt,
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();
  const row = await db.select().from(schema.localConnectorActions)
    .where(eq(schema.localConnectorActions.id, actionId))
    .get();
  if (!row) throw new Error('Connector 动作创建失败');
  return toPublicAction(row);
}

export async function listLocalConnectorActions(input: {
  deviceId?: string;
  status?: LocalConnectorActionStatus;
} = {}): Promise<LocalConnectorActionPublic[]> {
  await expireActions();
  const filters: SQL[] = [];
  if (input.deviceId) filters.push(eq(schema.localConnectorActions.deviceId, input.deviceId));
  if (input.status) filters.push(eq(schema.localConnectorActions.status, input.status));
  let query = db.select().from(schema.localConnectorActions).orderBy(desc(schema.localConnectorActions.createdAt));
  if (filters.length > 0) query = query.where(and(...filters)) as typeof query;
  const rows = await query.all();
  return rows.map(toPublicAction);
}

export async function cancelLocalConnectorAction(actionIdInput: unknown): Promise<boolean> {
  const actionId = normalizeText(actionIdInput, '动作 id', 80);
  const nowIso = new Date().toISOString();
  const result = await db.update(schema.localConnectorActions).set({
    status: 'cancelled',
    completedAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.localConnectorActions.id, actionId),
    inArray(schema.localConnectorActions.status, ['pending', 'claimed']),
  )).run();
  return affectedRows(result) > 0;
}

export async function claimNextLocalConnectorAction(
  identity: LocalConnectorIdentity,
): Promise<LocalConnectorActionPublic | null> {
  await expireActions();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const row = await db.select().from(schema.localConnectorActions).where(and(
      eq(schema.localConnectorActions.deviceId, identity.device.id),
      eq(schema.localConnectorActions.status, 'pending'),
      gt(schema.localConnectorActions.expiresAt, new Date().toISOString()),
    )).orderBy(asc(schema.localConnectorActions.createdAt)).get();
    if (!row) return null;
    assertScope(identity.device, requiredScopeForAction(normalizeActionKind(row.kind)));
    const nowIso = new Date().toISOString();
    const claimed = await db.update(schema.localConnectorActions).set({
      status: 'claimed',
      claimedAt: nowIso,
      updatedAt: nowIso,
    }).where(and(
      eq(schema.localConnectorActions.id, row.id),
      eq(schema.localConnectorActions.status, 'pending'),
    )).run();
    if (affectedRows(claimed) <= 0) continue;
    const claimedRow = await db.select().from(schema.localConnectorActions)
      .where(eq(schema.localConnectorActions.id, row.id))
      .get();
    return claimedRow ? toPublicAction(claimedRow) : null;
  }
  return null;
}

function normalizeResultPayload(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const payload = JSON.stringify(input);
  if (Buffer.byteLength(payload, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error('Connector 动作结果超过 64KB 限制');
  }
  const parsed = JSON.parse(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Connector 动作结果必须是 JSON 对象');
  }
  return payload;
}

export async function completeLocalConnectorAction(input: {
  identity: LocalConnectorIdentity;
  actionId: string;
  status: 'succeeded' | 'failed';
  result?: Record<string, unknown> | null;
  backupRef?: string | null;
  errorMessage?: string | null;
}): Promise<{ action: LocalConnectorActionPublic; idempotent: boolean }> {
  const actionId = normalizeText(input.actionId, '动作 id', 80);
  const status = input.status === 'succeeded' ? 'succeeded' : 'failed';
  const resultPayload = normalizeResultPayload(input.result);
  const backupRef = normalizeOptionalText(input.backupRef, 512);
  const errorMessage = normalizeOptionalText(input.errorMessage, 2_000);
  const existing = await db.select().from(schema.localConnectorActions).where(and(
    eq(schema.localConnectorActions.id, actionId),
    eq(schema.localConnectorActions.deviceId, input.identity.device.id),
  )).get();
  if (!existing) throw new Error('Connector 动作不存在');
  assertScope(input.identity.device, requiredScopeForAction(normalizeActionKind(existing.kind)));
  if (existing.status === 'succeeded' || existing.status === 'failed') {
    return { action: toPublicAction(existing), idempotent: true };
  }
  if (existing.status !== 'claimed') throw new Error('Connector 动作未领取或已结束');

  const nowIso = new Date().toISOString();
  const updated = await db.update(schema.localConnectorActions).set({
    status,
    resultPayload,
    backupRef: backupRef ?? existing.backupRef,
    errorMessage: status === 'failed' ? errorMessage || 'connector action failed' : null,
    completedAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.localConnectorActions.id, actionId),
    eq(schema.localConnectorActions.deviceId, input.identity.device.id),
    eq(schema.localConnectorActions.status, 'claimed'),
  )).run();
  if (affectedRows(updated) <= 0) throw new Error('Connector 动作状态已变化');
  const row = await db.select().from(schema.localConnectorActions)
    .where(eq(schema.localConnectorActions.id, actionId))
    .get();
  if (!row) throw new Error('Connector 动作结果读取失败');
  return { action: toPublicAction(row), idempotent: false };
}

export async function recordLocalConnectorEvent(input: {
  identity: LocalConnectorIdentity;
  kind: 'hook' | 'notify' | 'app_server' | 'browser_recovery';
  title: string;
  message: string;
  level?: 'info' | 'warning' | 'error';
  idempotencyKey?: string;
}): Promise<{ notification: NotificationDispatchResult | null }> {
  const kind = input.kind;
  const scope = requiredScopeForEvent(kind);
  assertScope(input.identity.device, scope);
  const title = normalizeText(input.title, '事件标题', 160);
  const message = normalizeText(input.message, '事件内容', MAX_EVENT_MESSAGE_BYTES);
  if (Buffer.byteLength(message, 'utf8') > MAX_EVENT_MESSAGE_BYTES) {
    throw new Error('事件内容超过 16KB 限制');
  }
  const level = input.level === 'warning' || input.level === 'error' ? input.level : 'info';
  const idempotencyKey = normalizeOptionalText(input.idempotencyKey, 256);
  const nowIso = new Date().toISOString();

  if (kind === 'app_server') {
    const observed = parseObservedAppServerEvent({ title, message });
    if (observed) {
      await recordLocalConnectorThreadEvent({
        deviceId: input.identity.device.id,
        event: observed,
        now: new Date(nowIso),
      });
    }
  }

  await db.insert(schema.events).values({
    type: 'status',
    title: `[Connector/${kind}] ${title}`,
    message: `${input.identity.device.name}: ${message}`,
    level,
    relatedType: 'local_connector',
    createdAt: nowIso,
  }).run();

  if (kind !== 'notify') return { notification: null };
  const channels = getConfiguredNotificationChannels();
  const { hasEnabledFeishuAdapterForDevice } = await import('./feishuInteractionAdapterService.js');
  if (await hasEnabledFeishuAdapterForDevice(input.identity.device.id)) {
    channels.push(`feishu:${input.identity.device.id}` as NotificationChannel);
  }
  const notification = await sendNotification(title, message, level, {
    idempotencyKey: idempotencyKey
      ? `connector:${input.identity.device.id}:${idempotencyKey}`
      : undefined,
    channels,
  });
  return { notification };
}

export function parseLocalConnectorActionStatus(value: unknown): LocalConnectorActionStatus | undefined {
  return normalizeActionStatus(value);
}
