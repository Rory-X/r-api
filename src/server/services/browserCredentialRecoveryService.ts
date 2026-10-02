import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, lte, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  runObservedWorkerPass,
  startObservedWorker,
  stopObservedWorker,
} from '../observability/workerHealth.js';
import {
  getSiteAdapterContract,
  type BrowserCaptureField,
  type BrowserCaptureSource,
  type BrowserRecoveryMode,
  type SiteAdapterContract,
} from './platforms/siteAdapterContract.js';
import {
  storeCredentialVaultItemWithExecutor,
  type CredentialVaultPublicItem,
} from './credentialVaultService.js';

export const BROWSER_RECOVERY_MODES = ['manual', 'assisted', 'managed'] as const;
export type BrowserRecoveryTaskMode = typeof BROWSER_RECOVERY_MODES[number];

export const BROWSER_RECOVERY_STATUSES = [
  'pending',
  'claimed',
  'completing',
  'completed',
  'cancelled',
  'expired',
] as const;
export type BrowserRecoveryTaskStatus = typeof BROWSER_RECOVERY_STATUSES[number];

export type BrowserRecoveryTaskField = BrowserCaptureField;

export type BrowserRecoveryTaskPublic = {
  id: string;
  siteId: number;
  accountId: number | null;
  mode: BrowserRecoveryTaskMode;
  status: BrowserRecoveryTaskStatus;
  credentialName: string;
  credentialKind: 'browser_storage';
  adapterPlatform: string;
  targetUrl: string;
  targetOrigin: string;
  allowedOrigins: string[];
  fields: BrowserRecoveryTaskField[];
  requiresUserGesture: boolean;
  expiresAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  resultCredentialId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type CreateBrowserRecoveryTaskInput = {
  siteId: number;
  accountId?: number | null;
  mode: BrowserRecoveryTaskMode;
  credentialName?: string;
  ttlSec?: number;
};

export type CreateBrowserRecoveryTaskResult = {
  task: BrowserRecoveryTaskPublic;
  token: string;
  launchPath: string;
};

export type BrowserRecoveryClaimResult = {
  task: BrowserRecoveryTaskPublic;
  claimToken: string;
};

export type BrowserRecoveryCapturedField = {
  name: string;
  kind: BrowserCaptureField['kind'];
  value: string;
};

export type CompleteBrowserRecoveryTaskInput = {
  taskId: string;
  claimToken: string;
  origin: string;
  fields: BrowserRecoveryCapturedField[];
  username?: string | null;
};

export type CompleteBrowserRecoveryTaskResult = {
  task: BrowserRecoveryTaskPublic;
  credential: CredentialVaultPublicItem;
  idempotent: boolean;
};

type DbExecutor = typeof db;

type BrowserContractSnapshot = {
  platformName: string;
  targetUrl: string;
  targetOrigin: string;
  allowedOrigins: string[];
  fields: BrowserRecoveryTaskField[];
  runtime?: SiteAdapterContract['browser']['runtime'];
  requiresUserGesture: boolean;
};

const MAX_FIELD_VALUE_BYTES = 512 * 1024;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const TASK_SWEEP_INTERVAL_MS = 60_000;
const WORKER_NAME = 'browser-recovery-task-sweeper';
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function hashToken(token: string): string {
  return createHash('sha256').update('browser-recovery\0').update(token).digest('hex');
}

function normalizeTaskId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id || id.length > 80) throw new Error('任务 id 无效');
  return id;
}

function normalizeToken(value: unknown, label: string): string {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token || token.length < 32 || token.length > 256) throw new Error(label + '无效');
  return token;
}

function normalizeMode(value: unknown): BrowserRecoveryTaskMode {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(BROWSER_RECOVERY_MODES as readonly string[]).includes(mode)) {
    throw new Error('浏览器凭证采集模式无效');
  }
  return mode as BrowserRecoveryTaskMode;
}

function normalizeCredentialName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.trim() : '';
  const normalized = name || fallback;
  if (!normalized || normalized.length > 160) throw new Error('凭证名称不能为空且不能超过 160 个字符');
  return normalized;
}

function normalizeSiteOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('站点 URL 无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('站点 URL 必须使用 http 或 https');
  }
  return parsed.origin;
}

function normalizeOrigin(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('origin 必须是有效的站点 Origin');
  return normalizeSiteOrigin(value.trim());
}

function normalizeAllowedOriginPattern(value: string, targetOrigin: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed === 'same-origin') return targetOrigin;
  if (trimmed.includes('*')) {
    const wildcardMatch = /^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(trimmed);
    if (!wildcardMatch) return null;
    return `${wildcardMatch[1]}://*.${wildcardMatch[2].toLowerCase()}${wildcardMatch[3] ? `:${wildcardMatch[3]}` : ''}`;
  }
  try {
    const origin = new URL(trimmed);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return null;
    return origin.origin;
  } catch {
    return null;
  }
}

function resolveAllowedOrigins(contract: SiteAdapterContract, targetOrigin: string): string[] {
  const resolved = contract.browser.allowedOrigins
    .map((value) => normalizeAllowedOriginPattern(value, targetOrigin))
    .filter((value): value is string => Boolean(value));
  if (resolved.length === 0) throw new Error('站点适配器未声明有效的浏览器 Origin 白名单');
  return [...new Set(resolved)];
}

function normalizeFields(fields: BrowserCaptureField[]): BrowserRecoveryTaskField[] {
  const seen = new Set<string>();
  const normalized: BrowserRecoveryTaskField[] = [];
  for (const field of fields) {
    const name = String(field?.name || '').trim();
    if (!name || name === '*' || name.length > 120) throw new Error('浏览器字段白名单包含无效字段');
    if (seen.has(name)) throw new Error('浏览器字段白名单包含重复字段');
    seen.add(name);
    const capture = normalizeCaptureSource(field);
    normalized.push({ name, kind: field.kind, required: field.required === true, capture });
  }
  if (normalized.length === 0) throw new Error('站点适配器未声明浏览器字段白名单');
  return normalized;
}

function normalizeCaptureSource(field: BrowserCaptureField): BrowserCaptureSource {
  const source = field.capture || (
    field.kind === 'cookie'
      ? { strategy: 'cookie_header' as const }
      : field.kind === 'local_storage' || field.kind === 'session_storage'
        ? { strategy: 'storage_value' as const, key: field.name }
        : { strategy: 'manual' as const }
  );
  const key = typeof source.key === 'string' ? source.key.trim() : '';
  const path = Array.isArray(source.path)
    ? source.path
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.trim())
    : [];
  if (source.strategy === 'cookie_header' && field.kind !== 'cookie') {
    throw new Error(`字段 ${field.name} 的采集策略与类型不匹配`);
  }
  if (source.strategy === 'named_cookie' && (field.kind !== 'cookie' || !key)) {
    throw new Error(`字段 ${field.name} 的 named_cookie 采集策略无效`);
  }
  if (
    (source.strategy === 'storage_value' || source.strategy === 'json_path')
    && !['local_storage', 'session_storage'].includes(field.kind)
  ) {
    throw new Error(`字段 ${field.name} 的 Storage 采集策略与类型不匹配`);
  }
  if ((source.strategy === 'storage_value' || source.strategy === 'json_path') && !key) {
    throw new Error(`字段 ${field.name} 的 Storage 采集策略缺少 key`);
  }
  if (source.strategy === 'json_path' && (path.length === 0 || path.some((part) => !part || part.length > 120))) {
    throw new Error(`字段 ${field.name} 的 JSON 路径无效`);
  }
  if (key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error(`字段 ${field.name} 的采集 key 无效`);
  }
  return {
    strategy: source.strategy,
    ...(key ? { key } : {}),
    ...(path.length > 0 ? { path } : {}),
  };
}

function parseSnapshot(raw: string): BrowserContractSnapshot {
  try {
    const parsed = JSON.parse(raw) as Partial<BrowserContractSnapshot>;
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const targetUrl = typeof parsed.targetUrl === 'string' ? parsed.targetUrl : '';
    const targetOrigin = typeof parsed.targetOrigin === 'string' ? parsed.targetOrigin : '';
    const platformName = typeof parsed.platformName === 'string' ? parsed.platformName : '';
    const allowedOrigins = Array.isArray(parsed.allowedOrigins)
      ? parsed.allowedOrigins.filter((item): item is string => typeof item === 'string')
      : [];
    const fields = Array.isArray(parsed.fields) ? parsed.fields as BrowserRecoveryTaskField[] : [];
    if (!targetUrl || !targetOrigin || !platformName || allowedOrigins.length === 0 || fields.length === 0) throw new Error();
    return {
      platformName,
      targetUrl,
      targetOrigin,
      allowedOrigins,
      fields: normalizeFields(fields),
      runtime: parsed.runtime && typeof parsed.runtime === 'object'
        ? parsed.runtime as SiteAdapterContract['browser']['runtime']
        : undefined,
      requiresUserGesture: parsed.requiresUserGesture === true,
    };
  } catch {
    throw new Error('任务契约快照损坏');
  }
}

function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  for (const allowed of allowedOrigins) {
    if (allowed === origin) return true;
    const wildcard = /^(https?):\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(allowed);
    if (!wildcard) continue;
    try {
      const parsed = new URL(origin);
      const expectedPort = wildcard[3] || (wildcard[1] === 'https' ? '443' : '80');
      const actualPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      if (
        parsed.protocol === `${wildcard[1]}:`
        && actualPort === expectedPort
        && parsed.hostname.endsWith(`.${wildcard[2]}`)
        && parsed.hostname !== wildcard[2]
      ) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function toPublicTask(row: typeof schema.browserCredentialRecoveryTasks.$inferSelect): BrowserRecoveryTaskPublic {
  const snapshot = parseSnapshot(row.contractSnapshot);
  return {
    id: row.id,
    siteId: row.siteId,
    accountId: row.accountId ?? null,
    mode: normalizeMode(row.mode),
    status: row.status as BrowserRecoveryTaskStatus,
    credentialName: row.credentialName,
    credentialKind: 'browser_storage',
    adapterPlatform: row.adapterPlatform,
    targetUrl: snapshot.targetUrl,
    targetOrigin: snapshot.targetOrigin,
    allowedOrigins: [...snapshot.allowedOrigins],
    fields: snapshot.fields.map((field) => ({ ...field })),
    requiresUserGesture: snapshot.requiresUserGesture,
    expiresAt: row.expiresAt,
    claimedAt: row.claimedAt ?? null,
    completedAt: row.completedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    resultCredentialId: row.resultCredentialId ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function buildCaptureSecret(origin: string, fields: BrowserRecoveryCapturedField[]): string {
  const payload = JSON.stringify({
    version: 1,
    origin,
    fields: fields.map((field) => ({ name: field.name, kind: field.kind, value: field.value })),
  });
  if (Buffer.byteLength(payload, 'utf8') > MAX_CAPTURE_BYTES) throw new Error('浏览器凭证数据超过 2MB 限制');
  return payload;
}

function normalizeCapturedFields(
  input: unknown,
  expectedFields: BrowserRecoveryTaskField[],
): BrowserRecoveryCapturedField[] {
  if (!Array.isArray(input)) throw new Error('fields 必须是数组');
  const expected = new Map(expectedFields.map((field) => [field.name, field]));
  const seen = new Set<string>();
  const normalized: BrowserRecoveryCapturedField[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') throw new Error('fields 包含无效项');
    const item = raw as Partial<BrowserRecoveryCapturedField>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const kind = item.kind;
    const value = typeof item.value === 'string' ? item.value : '';
    const expectedField = expected.get(name);
    if (!expectedField || expectedField.kind !== kind || seen.has(name)) {
      throw new Error('fields 包含未声明或重复字段');
    }
    if (!value || Buffer.byteLength(value, 'utf8') > MAX_FIELD_VALUE_BYTES) {
      throw new Error(`字段 ${name} 为空或超过大小限制`);
    }
    seen.add(name);
    normalized.push({ name, kind: expectedField.kind, value });
  }
  for (const field of expectedFields) {
    if (field.required && !seen.has(field.name)) {
      throw new Error(`缺少必填浏览器字段: ${field.name}`);
    }
  }
  if (normalized.length === 0) throw new Error('至少需要提交一个浏览器字段');
  return normalized;
}

async function expireDueTasks(nowIso = new Date().toISOString()): Promise<number> {
  const result = await db.update(schema.browserCredentialRecoveryTasks).set({
    status: 'expired',
    taskTokenHash: null,
    claimTokenHash: null,
    updatedAt: nowIso,
  }).where(and(
    inArray(schema.browserCredentialRecoveryTasks.status, ['pending', 'claimed']),
    lte(schema.browserCredentialRecoveryTasks.expiresAt, nowIso),
  )).run();
  return Number(result?.changes || 0);
}

export async function createBrowserRecoveryTask(
  input: CreateBrowserRecoveryTaskInput,
): Promise<CreateBrowserRecoveryTaskResult> {
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, input.siteId)).get();
  if (!site) throw new Error('目标站点不存在');

  const accountId = input.accountId == null ? null : Math.trunc(Number(input.accountId));
  if (accountId !== null) {
    if (!Number.isFinite(accountId) || accountId <= 0) throw new Error('accountId 无效');
    const account = await db.select({ id: schema.accounts.id, siteId: schema.accounts.siteId })
      .from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
    if (!account || account.siteId !== site.id) throw new Error('账号不存在或不属于目标站点');
  }

  const mode = normalizeMode(input.mode);
  const contract = getSiteAdapterContract(site.platform);
  if (!contract.browser.supported || !contract.browser.modes.includes(mode as BrowserRecoveryMode)) {
    throw new Error(`站点 ${site.platform} 不支持 ${mode} 浏览器凭证采集`);
  }
  if (!contract.credentialKinds.includes('browser_storage')) {
    throw new Error(`站点 ${site.platform} 未声明 browser_storage 凭证类型`);
  }

  const targetUrl = site.homepageUrl?.trim() || site.url;
  const targetOrigin = normalizeSiteOrigin(targetUrl);
  const fields = normalizeFields(contract.browser.fields);
  const allowedOrigins = resolveAllowedOrigins(contract, targetOrigin);
  const maxTtlSec = Math.max(30, Math.min(3600, Math.trunc(Number(contract.browser.taskTtlSec) || 300)));
  const requestedTtlSec = input.ttlSec == null ? maxTtlSec : Math.trunc(Number(input.ttlSec));
  if (!Number.isFinite(requestedTtlSec) || requestedTtlSec < 30) throw new Error('ttlSec 必须至少为 30 秒');
  const ttlSec = Math.min(maxTtlSec, requestedTtlSec);
  const now = new Date();
  const nowIso = now.toISOString();
  const taskId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const contractSnapshot: BrowserContractSnapshot = {
    platformName: contract.platformName,
    targetUrl,
    targetOrigin,
    allowedOrigins,
    fields,
    runtime: contract.browser.runtime ? { ...contract.browser.runtime } : undefined,
    requiresUserGesture: contract.browser.requiresUserGesture,
  };
  await db.insert(schema.browserCredentialRecoveryTasks).values({
    id: taskId,
    siteId: site.id,
    accountId,
    mode,
    status: 'pending',
    credentialName: normalizeCredentialName(input.credentialName, `${site.name} 浏览器凭证`),
    credentialKind: 'browser_storage',
    adapterPlatform: contract.platformName,
    targetUrl,
    contractSnapshot: JSON.stringify(contractSnapshot),
    taskTokenHash: hashToken(token),
    claimTokenHash: null,
    expiresAt: new Date(now.getTime() + ttlSec * 1_000).toISOString(),
    createdAt: nowIso,
    updatedAt: nowIso,
  }).run();
  const inserted = await db.select().from(schema.browserCredentialRecoveryTasks)
    .where(eq(schema.browserCredentialRecoveryTasks.id, taskId)).get();
  if (!inserted) throw new Error('浏览器凭证恢复任务创建失败');

  return {
    task: toPublicTask(inserted),
    token,
    launchPath: `/browser-credential-recovery#task=${encodeURIComponent(taskId)}&token=${encodeURIComponent(token)}`,
  };
}

export async function listBrowserRecoveryTasks(options?: {
  siteId?: number;
  status?: BrowserRecoveryTaskStatus;
}): Promise<BrowserRecoveryTaskPublic[]> {
  await expireDueTasks();
  const conditions: SQL[] = [];
  if (options?.siteId !== undefined) conditions.push(eq(schema.browserCredentialRecoveryTasks.siteId, options.siteId));
  if (options?.status) conditions.push(eq(schema.browserCredentialRecoveryTasks.status, options.status));
  const rows = await db.select().from(schema.browserCredentialRecoveryTasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.browserCredentialRecoveryTasks.createdAt), desc(schema.browserCredentialRecoveryTasks.id))
    .all();
  return rows.map(toPublicTask);
}

export async function claimBrowserRecoveryTask(
  taskIdInput: unknown,
  tokenInput: unknown,
  claimedByInput?: unknown,
): Promise<BrowserRecoveryClaimResult> {
  await expireDueTasks();
  const taskId = normalizeTaskId(taskIdInput);
  const token = normalizeToken(tokenInput, '任务令牌');
  const nowIso = new Date().toISOString();
  const claimToken = randomBytes(32).toString('base64url');
  const claimedBy = typeof claimedByInput === 'string' ? claimedByInput.trim().slice(0, 160) || null : null;
  const result = await db.update(schema.browserCredentialRecoveryTasks).set({
    status: 'claimed',
    taskTokenHash: null,
    claimTokenHash: hashToken(claimToken),
    claimedBy,
    claimedAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.browserCredentialRecoveryTasks.id, taskId),
    eq(schema.browserCredentialRecoveryTasks.status, 'pending'),
    eq(schema.browserCredentialRecoveryTasks.taskTokenHash, hashToken(token)),
    gt(schema.browserCredentialRecoveryTasks.expiresAt, nowIso),
  )).run();
  if (Number(result?.changes || 0) <= 0) throw new Error('任务不存在、已领取、已取消或已过期');

  const row = await db.select().from(schema.browserCredentialRecoveryTasks)
    .where(eq(schema.browserCredentialRecoveryTasks.id, taskId)).get();
  if (!row) throw new Error('任务不存在');
  return { task: toPublicTask(row), claimToken };
}

export async function completeBrowserRecoveryTask(
  input: CompleteBrowserRecoveryTaskInput,
): Promise<CompleteBrowserRecoveryTaskResult> {
  await expireDueTasks();
  const taskId = normalizeTaskId(input.taskId);
  const claimToken = normalizeToken(input.claimToken, '领取令牌');
  const origin = normalizeOrigin(input.origin);
  const nowIso = new Date().toISOString();

  return await db.transaction(async (tx) => {
    const existing = await tx.select().from(schema.browserCredentialRecoveryTasks)
      .where(eq(schema.browserCredentialRecoveryTasks.id, taskId)).get();
    if (!existing) throw new Error('任务不存在');
    const snapshot = parseSnapshot(existing.contractSnapshot);
    if (existing.status === 'completed' && existing.claimTokenHash === hashToken(claimToken) && existing.resultCredentialId) {
      const credential = await tx.select().from(schema.credentialVaultItems)
        .where(eq(schema.credentialVaultItems.id, existing.resultCredentialId)).get();
      if (!credential) throw new Error('任务结果凭证不存在');
      return {
        task: toPublicTask(existing),
        credential: {
          ...credential,
          metadata: credential.metadata ? JSON.parse(credential.metadata) : null,
        } as CredentialVaultPublicItem,
        idempotent: true,
      };
    }
    if (existing.status !== 'claimed' || existing.claimTokenHash !== hashToken(claimToken)) {
      throw new Error('任务未领取、令牌无效或已结束');
    }
    if (existing.expiresAt <= nowIso) throw new Error('任务已过期');
    if (!isOriginAllowed(origin, snapshot.allowedOrigins)) throw new Error('origin 不在站点适配器白名单内');
    const fields = normalizeCapturedFields(input.fields, snapshot.fields);
    const secret = buildCaptureSecret(origin, fields);

    const marked = await tx.update(schema.browserCredentialRecoveryTasks).set({
      status: 'completing',
      updatedAt: nowIso,
    }).where(and(
      eq(schema.browserCredentialRecoveryTasks.id, taskId),
      eq(schema.browserCredentialRecoveryTasks.status, 'claimed'),
      eq(schema.browserCredentialRecoveryTasks.claimTokenHash, hashToken(claimToken)),
    )).run();
    if (Number(marked?.changes || 0) <= 0) throw new Error('任务已被其他提交占用');

    const credential = await storeCredentialVaultItemWithExecutor({
      siteId: existing.siteId,
      accountId: existing.accountId,
      name: existing.credentialName,
      kind: 'browser_storage',
      secret,
      metadata: {
        source: 'browser',
        origin,
        adapterPlatform: existing.adapterPlatform,
        browserTaskId: taskId,
        username: typeof input.username === 'string' ? input.username.trim().slice(0, 256) || undefined : undefined,
      },
    }, tx);

    const completedAt = new Date().toISOString();
    const completed = await tx.update(schema.browserCredentialRecoveryTasks).set({
      status: 'completed',
      resultCredentialId: credential.id,
      completedAt,
      updatedAt: completedAt,
    }).where(and(
      eq(schema.browserCredentialRecoveryTasks.id, taskId),
      eq(schema.browserCredentialRecoveryTasks.status, 'completing'),
    )).run();
    if (Number(completed?.changes || 0) <= 0) throw new Error('任务完成状态写入失败');
    const row = await tx.select().from(schema.browserCredentialRecoveryTasks)
      .where(eq(schema.browserCredentialRecoveryTasks.id, taskId)).get();
    if (!row) throw new Error('任务完成后无法读取状态');
    return { task: toPublicTask(row), credential, idempotent: false };
  });
}

export async function cancelBrowserRecoveryTask(taskIdInput: unknown): Promise<boolean> {
  await expireDueTasks();
  const taskId = normalizeTaskId(taskIdInput);
  const nowIso = new Date().toISOString();
  const result = await db.update(schema.browserCredentialRecoveryTasks).set({
    status: 'cancelled',
    taskTokenHash: null,
    claimTokenHash: null,
    cancelledAt: nowIso,
    updatedAt: nowIso,
  }).where(and(
    eq(schema.browserCredentialRecoveryTasks.id, taskId),
    inArray(schema.browserCredentialRecoveryTasks.status, ['pending', 'claimed']),
  )).run();
  return Number(result?.changes || 0) > 0;
}

export async function expireBrowserRecoveryTasks(nowIso = new Date().toISOString()): Promise<number> {
  return await expireDueTasks(nowIso);
}

export async function startBrowserRecoveryTaskSweeper(): Promise<void> {
  if (sweepTimer) return;
  startObservedWorker({ name: WORKER_NAME, intervalMs: TASK_SWEEP_INTERVAL_MS });
  await runObservedWorkerPass(WORKER_NAME, expireDueTasks);
  sweepTimer = setInterval(() => {
    void runObservedWorkerPass(WORKER_NAME, expireDueTasks).catch(() => undefined);
  }, TASK_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopBrowserRecoveryTaskSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  stopObservedWorker(WORKER_NAME);
}

export const browserCredentialRecoveryInternals = {
  hashToken,
  normalizeOrigin,
  isOriginAllowed,
  normalizeCapturedFields,
  parseSnapshot,
};
