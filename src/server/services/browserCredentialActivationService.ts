import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import {
  getProxyUrlFromExtraConfig,
  mergeAccountExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { applyAccountUpdateWorkflow } from './accountUpdateWorkflow.js';
import { resolveCredentialVaultSecret } from './credentialVaultService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { getAdapter } from './platforms/index.js';
import type { BrowserCredentialRuntime } from './platforms/siteAdapterContract.js';

type BrowserCaptureSecret = {
  version: number;
  origin: string;
  fields: Array<{ name: string; kind: string; value: string }>;
};

export type BrowserCredentialActivationResult = {
  accountId: number;
  credentialId: number;
  tokenType: 'session';
  username: string | null;
  apiTokenFound: boolean;
  idempotent: boolean;
  created: boolean;
};

function parseCaptureSecret(secret: string): BrowserCaptureSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('浏览器凭证内容损坏');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('浏览器凭证内容损坏');
  }
  const value = parsed as Partial<BrowserCaptureSecret>;
  if (value.version !== 1 || typeof value.origin !== 'string' || !Array.isArray(value.fields)) {
    throw new Error('浏览器凭证格式不受支持');
  }
  const fields = value.fields.filter((field): field is BrowserCaptureSecret['fields'][number] => (
    Boolean(field)
    && typeof field === 'object'
    && typeof field.name === 'string'
    && typeof field.kind === 'string'
    && typeof field.value === 'string'
  ));
  if (fields.length !== value.fields.length) throw new Error('浏览器凭证字段损坏');
  return { version: 1, origin: value.origin, fields };
}

function readField(capture: BrowserCaptureSecret, name: string | undefined): string {
  if (!name) return '';
  return capture.fields.find((field) => field.name === name)?.value.trim() || '';
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readUsername(capture: BrowserCaptureSecret, runtime: BrowserCredentialRuntime): string | null {
  const raw = readField(capture, runtime.usernameField);
  if (!raw) return null;
  const parsed = parseJsonObject(raw);
  const candidate = parsed
    ? parsed.username || parsed.user_name || parsed.name || parsed.email || parsed.id
    : raw;
  return typeof candidate === 'string' || typeof candidate === 'number'
    ? String(candidate).trim().slice(0, 256) || null
    : null;
}

function readPositiveInteger(capture: BrowserCaptureSecret, fieldName: string | undefined): number | undefined {
  const raw = readField(capture, fieldName);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function hasBoundCredential(extraConfig: string | null | undefined, credentialId: number): boolean {
  if (!extraConfig) return false;
  try {
    const parsed = JSON.parse(extraConfig) as Record<string, unknown>;
    return parsed.browserCredentialId === credentialId;
  } catch {
    return false;
  }
}

function readSnapshotRuntime(raw: string): BrowserCredentialRuntime | undefined {
  try {
    const parsed = JSON.parse(raw) as { runtime?: BrowserCredentialRuntime };
    const runtime = parsed?.runtime;
    if (!runtime || typeof runtime !== 'object' || typeof runtime.field !== 'string') return undefined;
    if (runtime.kind !== 'session_token' && runtime.kind !== 'cookie') return undefined;
    return runtime;
  } catch {
    return undefined;
  }
}

async function nextAccountSortOrder(): Promise<number> {
  const rows = await db.select({ sortOrder: schema.accounts.sortOrder })
    .from(schema.accounts)
    .all();
  return rows.reduce((maximum, row) => Math.max(maximum, row.sortOrder || 0), -1) + 1;
}

async function createBrowserCredentialAccount(input: {
  siteId: number;
  username: string | null;
  accessToken: string;
  apiToken: string | null;
  extraConfig: string;
}): Promise<typeof schema.accounts.$inferSelect> {
  const now = new Date().toISOString();
  return insertAndGetById<typeof schema.accounts.$inferSelect>({
    table: schema.accounts,
    idColumn: schema.accounts.id,
    values: {
      siteId: input.siteId,
      username: input.username,
      accessToken: input.accessToken,
      apiToken: input.apiToken,
      status: 'active',
      checkinEnabled: true,
      sortOrder: await nextAccountSortOrder(),
      extraConfig: input.extraConfig,
      createdAt: now,
      updatedAt: now,
    },
    insertErrorMessage: '浏览器凭证账号创建失败',
  });
}

export function browserCaptureRuntimeInternals() {
  return { parseCaptureSecret, readField, readUsername, readPositiveInteger };
}

export async function activateBrowserRecoveryCredential(input: {
  taskId: string;
  accountId?: number | null;
}): Promise<BrowserCredentialActivationResult> {
  const task = await db.select().from(schema.browserCredentialRecoveryTasks)
    .where(eq(schema.browserCredentialRecoveryTasks.id, input.taskId)).get();
  if (!task) throw new Error('浏览器凭证任务不存在');
  if (task.status !== 'completed' || !task.resultCredentialId) {
    throw new Error('浏览器凭证任务尚未完成，暂不能启用凭证');
  }

  const accountId = input.accountId == null ? task.accountId : Math.trunc(Number(input.accountId));
  if (accountId != null && (!Number.isFinite(accountId) || accountId <= 0)) {
    throw new Error('目标账号无效');
  }
  const row = accountId == null
    ? null
    : await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, accountId)).get();
  if (accountId != null && !row) throw new Error('目标账号不存在');
  if (row && row.sites.id !== task.siteId) throw new Error('目标账号与浏览器凭证任务站点不匹配');
  const site = row?.sites || await db.select().from(schema.sites)
    .where(eq(schema.sites.id, task.siteId)).get();
  if (!site) throw new Error('目标站点不存在');

  const adapter = getAdapter(site.platform);
  const contract = adapter?.getContract();
  const runtime = readSnapshotRuntime(task.contractSnapshot) || contract?.browser.runtime;
  if (!runtime) throw new Error(`站点 ${site.platform} 未声明浏览器凭证启用方式`);

  const resolved = await resolveCredentialVaultSecret(task.resultCredentialId);
  if (!resolved) throw new Error('恢复凭证不存在、已撤销或已过期');
  const capture = parseCaptureSecret(resolved.secret);
  const accessToken = readField(capture, runtime.field);
  if (!accessToken) throw new Error(`恢复凭证缺少运行时字段 ${runtime.field}`);
  const platformUserId = readPositiveInteger(capture, runtime.platformUserIdField)
    || (row ? resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username) : undefined);
  if (!adapter) throw new Error(`不支持的平台: ${site.platform}`);

  let verified;
  try {
    verified = await withAccountProxyOverride(
      row ? getProxyUrlFromExtraConfig(row.accounts.extraConfig) : null,
      () => adapter.verifyToken(site.url, accessToken, platformUserId),
    );
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '浏览器凭证验证失败');
  }
  if (verified.tokenType !== 'session') throw new Error('浏览器凭证验证失败：未识别为可用会话');

  const username = verified.userInfo?.username?.trim()
    || readUsername(capture, runtime)
    || resolved.item.metadata?.username
    || row?.accounts.username
    || null;
  const apiToken = verified.apiToken?.trim() || row?.accounts.apiToken || null;
  const extraConfigPatch: Record<string, unknown> = {
    credentialMode: 'session',
    browserCredentialId: task.resultCredentialId,
  };
  if (platformUserId) extraConfigPatch.platformUserId = platformUserId;
  if (runtime.refreshTokenField) {
    const refreshToken = readField(capture, runtime.refreshTokenField);
    const tokenExpiresAt = readPositiveInteger(capture, runtime.tokenExpiresAtField);
    if (refreshToken) {
      extraConfigPatch.sub2apiAuth = tokenExpiresAt
        ? { refreshToken, tokenExpiresAt }
        : { refreshToken };
    }
  }

  const account = row?.accounts || await createBrowserCredentialAccount({
    siteId: site.id,
    username,
    accessToken,
    apiToken,
    extraConfig: mergeAccountExtraConfig(undefined, extraConfigPatch),
  });
  const created = !row;
  const idempotent = !created && hasBoundCredential(account.extraConfig, task.resultCredentialId);

  await applyAccountUpdateWorkflow({
    accountId: account.id,
    updates: {
      accessToken,
      ...(username ? { username } : {}),
      ...(apiToken ? { apiToken } : {}),
      status: 'active',
      extraConfig: mergeAccountExtraConfig(account.extraConfig, extraConfigPatch),
    },
    preferredApiToken: apiToken,
    refreshModels: true,
    continueOnError: true,
  });

  await db.update(schema.credentialVaultItems).set({
    accountId: account.id,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.credentialVaultItems.id, task.resultCredentialId)).run();

  if (task.accountId == null) {
    await db.update(schema.browserCredentialRecoveryTasks).set({
      accountId: account.id,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.browserCredentialRecoveryTasks.id, task.id)).run();
  }

  return {
    accountId: account.id,
    credentialId: task.resultCredentialId,
    tokenType: 'session',
    username,
    apiTokenFound: Boolean(apiToken),
    idempotent,
    created,
  };
}
