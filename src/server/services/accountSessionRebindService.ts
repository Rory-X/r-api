import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { applyAccountUpdateWorkflow } from './accountUpdateWorkflow.js';
import {
  getProxyUrlFromExtraConfig,
  getSub2ApiAuthFromExtraConfig,
  mergeAccountExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';

export class AccountSessionRebindError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'AccountSessionRebindError';
  }
}

function normalizeRefreshToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeExpiresAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function rebindSessionAccount(input: {
  accountId: number;
  accessToken: string;
  platformUserId?: number;
  refreshToken?: string;
  tokenExpiresAt?: number | string;
}) {
  const accountId = Math.trunc(input.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new AccountSessionRebindError('账号 ID 无效');
  }
  const nextAccessToken = input.accessToken.trim();
  if (!nextAccessToken) {
    throw new AccountSessionRebindError('请提供新的 Session Token');
  }

  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!row) throw new AccountSessionRebindError('账号不存在', 404);

  const account = row.accounts;
  const site = row.sites;
  const adapter = getAdapter(site.platform);
  if (!adapter) {
    throw new AccountSessionRebindError(`platform not supported: ${site.platform}`);
  }

  const requestedPlatformUserId = typeof input.platformUserId === 'number'
    && Number.isFinite(input.platformUserId)
    && input.platformUserId > 0
    ? Math.trunc(input.platformUserId)
    : undefined;
  const candidatePlatformUserId = requestedPlatformUserId
    || resolvePlatformUserId(account.extraConfig, account.username);

  let verifyResult;
  try {
    verifyResult = await withAccountProxyOverride(
      getProxyUrlFromExtraConfig(account.extraConfig),
      () => adapter.verifyToken(site.url, nextAccessToken, candidatePlatformUserId),
    );
  } catch (error) {
    throw new AccountSessionRebindError(appendSessionTokenRebindHint(
      error instanceof Error ? error.message : 'Token 验证失败',
    ));
  }
  if (verifyResult?.tokenType !== 'session') {
    throw new AccountSessionRebindError('新的 Token 验证失败：请提供可用的 Session Token');
  }

  const verifiedUsername = verifyResult.userInfo?.username?.trim() || '';
  const nextUsername = verifiedUsername || account.username || '';
  const resolvedPlatformUserId = requestedPlatformUserId
    || resolvePlatformUserId(account.extraConfig, nextUsername);
  const nextApiToken = verifyResult.apiToken?.trim() || account.apiToken || '';
  const extraConfigPatch: Record<string, unknown> = { credentialMode: 'session' };
  if (resolvedPlatformUserId) extraConfigPatch.platformUserId = resolvedPlatformUserId;

  if ((site.platform || '').toLowerCase() === 'sub2api') {
    const existingManagedAuth = getSub2ApiAuthFromExtraConfig(account.extraConfig);
    const nextRefreshToken = normalizeRefreshToken(input.refreshToken)
      || existingManagedAuth?.refreshToken;
    const nextTokenExpiresAt = normalizeExpiresAt(input.tokenExpiresAt)
      ?? existingManagedAuth?.tokenExpiresAt;
    if (nextRefreshToken) {
      extraConfigPatch.sub2apiAuth = nextTokenExpiresAt
        ? { refreshToken: nextRefreshToken, tokenExpiresAt: nextTokenExpiresAt }
        : { refreshToken: nextRefreshToken };
    }
  }

  const { account: latest } = await applyAccountUpdateWorkflow({
    accountId,
    updates: {
      accessToken: nextAccessToken,
      ...(nextUsername ? { username: nextUsername } : {}),
      ...(nextApiToken ? { apiToken: nextApiToken } : {}),
      status: 'active',
      extraConfig: mergeAccountExtraConfig(account.extraConfig, extraConfigPatch),
    },
    preferredApiToken: nextApiToken,
    refreshModels: true,
    continueOnError: true,
  });

  return {
    account: latest,
    tokenType: 'session' as const,
    credentialMode: 'session' as const,
    apiTokenFound: !!nextApiToken,
  };
}
