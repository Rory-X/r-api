import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { AccountCreatePayload } from '../contracts/accountsRoutePayloads.js';
import {
  buildCredentialBatchPreview,
  normalizeCredentialInput,
  validateCredentialCandidate,
  type CredentialCandidate,
  type CredentialCandidatePreviewResult,
  type CredentialTarget,
} from './credentialIngestionService.js';
import { loginAndPersistAccount } from './accountLoginService.js';
import { rebindSessionAccount } from './accountSessionRebindService.js';
import { createManualAccount } from './manualAccountCreationService.js';
import { getAdapter } from './platforms/index.js';
import { getSiteAdapterContract } from './platforms/siteAdapterContract.js';
import { applyAccountUpdateWorkflow } from './accountUpdateWorkflow.js';
import { mergeAccountExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import {
  importOauthConnectionsFromNativeJson,
} from './oauth/service.js';
import {
  findActiveCredentialVaultItemBySecret,
  storeCredentialVaultItem,
  type CredentialVaultKind,
} from './credentialVaultService.js';

export type CredentialConflictPolicy = 'skip' | 'update' | 'create_duplicate';
export type CredentialPromotionItemStatus = 'imported' | 'updated' | 'skipped' | 'failed';

export type CredentialPromotionItem = {
  index: number;
  status: CredentialPromotionItemStatus;
  provider?: string;
  kind: CredentialCandidate['kind'];
  fingerprint: string;
  duplicateOfIndex?: number;
  accountId?: number;
  vaultItemIds?: number[];
  message?: string;
};

export type CredentialPromotionResult = {
  success: boolean;
  target: CredentialTarget;
  batchFingerprint: string;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  items: CredentialPromotionItem[];
};

export class CredentialPromotionError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'CredentialPromotionError';
  }
}

function normalizePositiveId(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function displayName(candidate: CredentialCandidate, fallback: string): string {
  return candidate.identity.displayName
    || candidate.identity.email
    || candidate.identity.username
    || candidate.identity.accountKey
    || candidate.identity.externalId
    || fallback;
}

function toAccountCreateBody(input: {
  siteId: number;
  candidate: CredentialCandidate;
  credentialMode: 'session' | 'apikey';
}): AccountCreatePayload {
  const { candidate } = input;
  const username = candidate.identity.username || candidate.identity.email || candidate.identity.displayName;
  const platformUserId = normalizePositiveId(candidate.identity.externalId);
  return {
    siteId: input.siteId,
    ...(username ? { username } : {}),
    ...(platformUserId ? { platformUserId } : {}),
    ...(candidate.expiresAt ? { tokenExpiresAt: candidate.expiresAt } : {}),
    ...(candidate.secrets.refreshToken ? { refreshToken: candidate.secrets.refreshToken } : {}),
    credentialMode: input.credentialMode,
    skipModelFetch: false,
  };
}

function buildNativeOauthPayload(candidate: CredentialCandidate): Record<string, unknown> {
  if (!candidate.provider) throw new CredentialPromotionError('原生 OAuth 凭证缺少 provider');
  if (!candidate.secrets.accessToken) throw new CredentialPromotionError('原生 OAuth 凭证缺少 access token');
  return {
    type: candidate.provider,
    access_token: candidate.secrets.accessToken,
    ...(candidate.secrets.refreshToken ? { refresh_token: candidate.secrets.refreshToken } : {}),
    ...(candidate.secrets.idToken ? { id_token: candidate.secrets.idToken } : {}),
    ...(candidate.identity.email ? { email: candidate.identity.email } : {}),
    ...(candidate.identity.externalId ? { account_id: candidate.identity.externalId } : {}),
    ...(candidate.identity.accountKey ? { account_key: candidate.identity.accountKey } : {}),
    ...(candidate.expiresAt ? { expired: candidate.expiresAt } : {}),
    ...(candidate.disabled ? { disabled: true } : {}),
  };
}

async function listCandidateScopeAccounts(siteId?: number): Promise<Array<{
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
}>> {
  const rows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();
  return rows
    .filter((row) => siteId === undefined || row.accounts.siteId === siteId)
    .map((row) => ({ account: row.accounts, site: row.sites }));
}

async function findExistingAccount(input: {
  siteId?: number;
  target: CredentialTarget;
  candidate: CredentialCandidate;
}) {
  const rows = await listCandidateScopeAccounts(input.siteId);
  const candidate = input.candidate;
  const provider = (candidate.provider || '').toLowerCase();
  const identityKey = candidate.identity.accountKey || candidate.identity.externalId;
  const identityName = candidate.identity.username
    || candidate.identity.email
    || candidate.identity.displayName;
  const rawApiKey = candidate.secrets.apiKey;
  const rawAccessToken = candidate.secrets.accessToken;

  for (const row of rows) {
    const account = row.account;
    if (input.target === 'native_oauth') {
      if ((account.oauthProvider || '').toLowerCase() !== provider) continue;
      if (identityKey && account.oauthAccountKey === identityKey) return row;
      if (!identityKey && identityName && account.username === identityName) return row;
      continue;
    }
    if (input.siteId !== undefined && account.siteId !== input.siteId) continue;
    if (rawApiKey && (account.apiToken === rawApiKey || account.accessToken === rawApiKey)) return row;
    if (rawAccessToken && account.accessToken === rawAccessToken) return row;
    if (identityName && account.username === identityName) return row;
    if (identityKey && account.username === identityKey) return row;
    const configuredPlatformUserId = resolvePlatformUserId(account.extraConfig, account.username);
    if (identityKey && configuredPlatformUserId === normalizePositiveId(identityKey)) return row;
  }
  return null;
}

async function promoteVaultCandidate(input: {
  siteId: number;
  candidate: CredentialCandidate;
  conflictPolicy: CredentialConflictPolicy;
}): Promise<{ ids: number[]; created: number; skipped: number }> {
  const entries: Array<{ kind: CredentialVaultKind; secret: string; suffix: string }> = [];
  if (input.candidate.kind === 'api_key' && input.candidate.secrets.apiKey) {
    entries.push({ kind: 'api_key', secret: input.candidate.secrets.apiKey, suffix: 'api-key' });
  }
  if (input.candidate.kind === 'session_token' && input.candidate.secrets.accessToken) {
    entries.push({ kind: 'session_token', secret: input.candidate.secrets.accessToken, suffix: 'session' });
  }
  if (input.candidate.kind === 'browser_storage' && input.candidate.secrets.cookie) {
    entries.push({ kind: 'browser_storage', secret: input.candidate.secrets.cookie, suffix: 'browser' });
  }
  if (input.candidate.kind === 'oauth_token_set') {
    if (input.candidate.secrets.accessToken) {
      entries.push({ kind: 'oauth_access_token', secret: input.candidate.secrets.accessToken, suffix: 'access' });
    }
    if (input.candidate.secrets.refreshToken) {
      entries.push({ kind: 'oauth_refresh_token', secret: input.candidate.secrets.refreshToken, suffix: 'refresh' });
    }
  }
  if (entries.length === 0) throw new CredentialPromotionError('该凭证没有可保存的秘密');

  const ids: number[] = [];
  let created = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (input.conflictPolicy !== 'create_duplicate') {
      const existing = await findActiveCredentialVaultItemBySecret({
        siteId: input.siteId,
        kind: entry.kind,
        secret: entry.secret,
      });
      if (existing) {
        ids.push(existing.id);
        skipped += 1;
        continue;
      }
    }
    const stored = await storeCredentialVaultItem({
      siteId: input.siteId,
      name: `${displayName(input.candidate, 'imported credential')} · ${entry.suffix}`,
      kind: entry.kind,
      secret: entry.secret,
      expiresAt: input.candidate.expiresAt ? new Date(input.candidate.expiresAt).toISOString() : null,
      metadata: {
        source: 'import',
        username: input.candidate.identity.username || input.candidate.identity.email,
        adapterPlatform: input.candidate.provider,
        label: input.candidate.source.format,
        purpose: 'credential-import',
      },
    });
    ids.push(stored.id);
    created += 1;
  }
  return { ids, created, skipped };
}

async function promoteAccountCandidate(input: {
  siteId: number;
  candidate: CredentialCandidate;
  existing: Awaited<ReturnType<typeof findExistingAccount>>;
  conflictPolicy: CredentialConflictPolicy;
}): Promise<{ accountId: number; status: 'imported' | 'updated' }> {
  const { candidate, existing, conflictPolicy, siteId } = input;
  if (existing && conflictPolicy === 'update'
    && (candidate.kind === 'session_token' || candidate.kind === 'oauth_token_set')) {
    const rebound = await rebindSessionAccount({
      accountId: existing.account.id,
      accessToken: candidate.secrets.accessToken || '',
      platformUserId: normalizePositiveId(candidate.identity.externalId),
      refreshToken: candidate.secrets.refreshToken,
      tokenExpiresAt: candidate.expiresAt,
    });
    if (!rebound.account) throw new CredentialPromotionError('Session 账号更新后读取失败');
    return { accountId: rebound.account.id, status: 'updated' };
  }
  if (existing && conflictPolicy === 'update' && candidate.kind === 'api_key') {
    const site = existing.site;
    const adapter = getAdapter(site.platform);
    const apiKey = candidate.secrets.apiKey || '';
    if (!adapter || !apiKey) throw new CredentialPromotionError('API Key 更新缺少站点适配器或凭证');
    const verify = await adapter.verifyToken(site.url, apiKey, normalizePositiveId(candidate.identity.externalId));
    if (verify.tokenType !== 'apikey') throw new CredentialPromotionError('API Key 验证失败');
    const updated = await applyAccountUpdateWorkflow({
      accountId: existing.account.id,
      updates: {
        accessToken: '',
        apiToken: apiKey,
        status: 'active',
        extraConfig: mergeAccountExtraConfig(existing.account.extraConfig, { credentialMode: 'apikey' }),
      },
      preferredApiToken: null,
      refreshModels: true,
      continueOnError: true,
    });
    if (!updated.account) throw new CredentialPromotionError('API Key 账号更新后读取失败');
    return { accountId: updated.account.id, status: 'updated' };
  }
  if (existing && conflictPolicy === 'update' && candidate.kind === 'username_password') {
    const login = await loginAndPersistAccount({
      siteId,
      username: candidate.secrets.username || candidate.identity.username || '',
      password: candidate.secrets.password || '',
    });
    if (!login.success) throw new CredentialPromotionError(login.message);
    return { accountId: login.account.id, status: 'updated' };
  }
  if (existing && conflictPolicy === 'create_duplicate' && candidate.kind === 'username_password') {
    throw new CredentialPromotionError('用户名密码导入不支持创建同用户名重复账号，请使用 update 或 skip');
  }

  if (candidate.kind === 'username_password') {
    const login = await loginAndPersistAccount({
      siteId,
      username: candidate.secrets.username || candidate.identity.username || '',
      password: candidate.secrets.password || '',
    });
    if (!login.success) throw new CredentialPromotionError(login.message);
    return { accountId: login.account.id, status: existing ? 'updated' : 'imported' };
  }

  const credentialMode = candidate.kind === 'api_key' ? 'apikey' : 'session';
  const rawAccessToken = candidate.kind === 'api_key'
    ? candidate.secrets.apiKey || ''
    : candidate.secrets.accessToken || '';
  if (!rawAccessToken) throw new CredentialPromotionError('凭证内容为空');
  const adapter = getAdapter((await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get())?.platform || '');
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
  if (!site || !adapter) throw new CredentialPromotionError('目标站点不存在或平台不支持');
  const created = await createManualAccount({
    body: toAccountCreateBody({ siteId, candidate, credentialMode }),
    site,
    adapter,
    credentialMode,
    rawAccessToken,
  });
  return { accountId: created.account.id, status: 'imported' };
}

const NEW_API_LIKE_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'one-hub',
  'done-hub',
  'veloera',
  'anyrouter',
]);

async function assertTargetSiteCompatibility(
  siteId: number,
  target: CredentialTarget,
): Promise<typeof schema.sites.$inferSelect> {
  const site = await db.select().from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();
  if (!site) throw new CredentialPromotionError('目标站点不存在');
  const platform = (site.platform || '').trim().toLowerCase();
  const contract = getSiteAdapterContract(platform);
  if (target === 'sub2api' && platform !== 'sub2api') {
    throw new CredentialPromotionError('Sub2API 凭证只能导入 Sub2API 站点');
  }
  if (target === 'new_api' && !NEW_API_LIKE_PLATFORMS.has(platform)) {
    throw new CredentialPromotionError('NewAPI/OneAPI 凭证只能导入兼容站点');
  }
  if (target === 'api_key' && !contract.credentialKinds.includes('api_key')) {
    throw new CredentialPromotionError(`站点 ${site.platform} 不支持 API Key 凭证`);
  }
  return site;
}

async function writePromotionEvent(input: {
  importJobId?: string;
  siteId?: number;
  target: CredentialTarget;
  batchFingerprint: string;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
}) {
  await db.insert(schema.events).values({
    type: 'credential_import',
    title: '凭证导入完成',
    message: JSON.stringify({
      ...(input.importJobId ? { importJobId: input.importJobId } : {}),
      target: input.target,
      batchFingerprint: input.batchFingerprint,
      imported: input.imported,
      updated: input.updated,
      skipped: input.skipped,
      failed: input.failed,
    }),
    level: input.failed > 0 ? 'warning' : 'info',
    relatedId: input.siteId,
    relatedType: input.siteId ? 'site' : 'credential_import',
    createdAt: new Date().toISOString(),
  }).run();
}

function redactCandidateSecrets(message: string, candidate: CredentialCandidate): string {
  let redacted = message;
  for (const secret of Object.values(candidate.secrets)) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

export async function promoteCredentialBatch(input: {
  input: unknown;
  target: CredentialTarget;
  siteId?: number;
  batchFingerprint: string;
  conflictPolicy?: CredentialConflictPolicy;
  importJobId?: string;
}): Promise<CredentialPromotionResult> {
  const conflictPolicy = input.conflictPolicy || 'skip';
  if (!['skip', 'update', 'create_duplicate'].includes(conflictPolicy)) {
    throw new CredentialPromotionError('conflictPolicy 无效');
  }
  if (input.target === 'native_oauth' && conflictPolicy === 'create_duplicate') {
    throw new CredentialPromotionError('原生 OAuth 不支持 create_duplicate，同一 provider 身份必须收敛');
  }
  const normalized = normalizeCredentialInput(input.input);
  const preview = buildCredentialBatchPreview(normalized.candidates, input.target);
  if (preview.batchFingerprint !== input.batchFingerprint) {
    throw new CredentialPromotionError('凭证输入已变化，请重新预览后再执行');
  }
  if (input.target !== 'native_oauth' && input.target !== 'vault' && !normalizePositiveId(input.siteId)) {
    throw new CredentialPromotionError('该目标必须提供 siteId');
  }
  if (input.target !== 'native_oauth' && input.target !== 'vault') {
    await assertTargetSiteCompatibility(normalizePositiveId(input.siteId)!, input.target);
  }

  const items: CredentialPromotionItem[] = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [index, candidate] of normalized.candidates.entries()) {
    const previewItem: CredentialCandidatePreviewResult = preview.candidates[index]!;
    const itemBase = {
      index,
      provider: candidate.provider,
      kind: candidate.kind,
      fingerprint: candidate.fingerprint,
      ...(previewItem.duplicateOfIndex === undefined ? {} : { duplicateOfIndex: previewItem.duplicateOfIndex }),
    };
    if (previewItem.duplicateOfIndex !== undefined) {
      skipped += 1;
      items.push({ ...itemBase, status: 'skipped', message: `与第 ${previewItem.duplicateOfIndex + 1} 项重复` });
      continue;
    }
    const validation = validateCredentialCandidate(candidate, input.target);
    if (validation.status !== 'ready') {
      failed += 1;
      items.push({ ...itemBase, status: 'failed', message: validation.errors.join('；') || validation.warnings.join('；') || '凭证不可导入' });
      continue;
    }

    try {
      if (input.target === 'native_oauth') {
        const existing = await findExistingAccount({ target: input.target, candidate });
        if (existing && conflictPolicy === 'skip') {
          skipped += 1;
          items.push({ ...itemBase, status: 'skipped', accountId: existing.account.id, message: '已存在相同 OAuth 账号身份' });
          continue;
        }
        const result = await importOauthConnectionsFromNativeJson({
          items: [buildNativeOauthPayload(candidate)],
        });
        const resultItem = result.items[0];
        if (!resultItem || resultItem.status === 'failed' || !resultItem.accountId) {
          throw new CredentialPromotionError(resultItem?.message || 'OAuth 导入失败');
        }
        if (existing) updated += 1; else imported += 1;
        items.push({ ...itemBase, status: existing ? 'updated' : 'imported', accountId: resultItem.accountId });
        continue;
      }

      if (input.target === 'vault') {
        if (!input.siteId) throw new CredentialPromotionError('Vault 导入必须提供 siteId');
        const vaultResult = await promoteVaultCandidate({
          siteId: input.siteId,
          candidate,
          conflictPolicy,
        });
        if (vaultResult.created > 0) {
          imported += 1;
          items.push({ ...itemBase, status: 'imported', vaultItemIds: vaultResult.ids });
        } else {
          skipped += 1;
          items.push({
            ...itemBase,
            status: 'skipped',
            vaultItemIds: vaultResult.ids,
            message: 'Vault 中已存在相同凭证',
          });
        }
        continue;
      }

      const siteId = normalizePositiveId(input.siteId)!;
      const existing = await findExistingAccount({ siteId, target: input.target, candidate });
      if (existing && conflictPolicy === 'skip') {
        skipped += 1;
        items.push({ ...itemBase, status: 'skipped', accountId: existing.account.id, message: '已存在匹配账号或凭证' });
        continue;
      }
      if (existing && conflictPolicy === 'update'
        && (candidate.kind === 'session_token' || candidate.kind === 'oauth_token_set')) {
        const result = await promoteAccountCandidate({ siteId, candidate, existing, conflictPolicy });
        updated += 1;
        items.push({ ...itemBase, status: 'updated', accountId: result.accountId });
        continue;
      }
      const result = await promoteAccountCandidate({ siteId, candidate, existing, conflictPolicy });
      if (result.status === 'updated') updated += 1; else imported += 1;
      items.push({ ...itemBase, status: result.status, accountId: result.accountId });
    } catch (error) {
      failed += 1;
      const rawMessage = error instanceof Error ? error.message : '凭证导入失败';
      items.push({
        ...itemBase,
        status: 'failed',
        message: redactCandidateSecrets(rawMessage, candidate),
      });
    }
  }

  await writePromotionEvent({
    importJobId: input.importJobId,
    siteId: input.siteId,
    target: input.target,
    batchFingerprint: input.batchFingerprint,
    imported,
    updated,
    skipped,
    failed,
  });

  return {
    success: failed === 0,
    target: input.target,
    batchFingerprint: input.batchFingerprint,
    imported,
    updated,
    skipped,
    failed,
    items,
  };
}
