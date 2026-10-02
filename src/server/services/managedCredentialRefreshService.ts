import { getSub2ApiAuthFromExtraConfig } from './accountExtraConfig.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { refreshOauthAccessToken } from './oauth/service.js';
import { refreshSub2ApiManagedSessionSingleflight } from './sub2apiRefreshSingleflight.js';
import type { schema } from '../db/index.js';

export type ManagedCredentialRefreshOwner = 'r_api' | 'external' | 'none';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;

export type ManagedCredentialRefreshDescriptor = Readonly<{
  owner: ManagedCredentialRefreshOwner;
  provider: string;
  expiresAtMs: number | null;
  hasManagedSecret: boolean;
  explicitOwner: boolean;
}>;

function normalizeOwner(value: unknown): ManagedCredentialRefreshOwner | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'r_api' || normalized === 'external' || normalized === 'none') return normalized;
  return null;
}

function explicitRefreshOwner(extraConfig: string | null): ManagedCredentialRefreshOwner | null {
  if (!extraConfig) return null;
  try {
    const parsed = JSON.parse(extraConfig) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const lifecycle = parsed.credentialLifecycle;
    if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) return null;
    return normalizeOwner((lifecycle as Record<string, unknown>).refreshOwner);
  } catch {
    return null;
  }
}

function normalizedExpiry(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

export function getManagedCredentialRefreshDescriptor(
  account: AccountRow,
  site: SiteRow,
): ManagedCredentialRefreshDescriptor {
  const oauth = getOauthInfoFromAccount(account);
  const sub2api = site.platform.trim().toLowerCase() === 'sub2api'
    ? getSub2ApiAuthFromExtraConfig(account.extraConfig)
    : null;
  const hasManagedSecret = !!(oauth?.refreshToken || sub2api?.refreshToken);
  const declaredOwner = explicitRefreshOwner(account.extraConfig);
  const owner = declaredOwner ?? (hasManagedSecret
    ? 'r_api'
    : (account.accessToken || account.apiToken ? 'external' : 'none'));
  return Object.freeze({
    owner,
    provider: String(oauth?.provider || site.platform || '').trim().toLowerCase() || 'unknown',
    expiresAtMs: normalizedExpiry(oauth?.tokenExpiresAt ?? sub2api?.tokenExpiresAt),
    hasManagedSecret,
    explicitOwner: declaredOwner !== null,
  });
}

export async function refreshManagedAccountCredential(input: {
  account: AccountRow;
  site: SiteRow;
  reason: 'manual' | 'scheduled';
}): Promise<string> {
  const descriptor = getManagedCredentialRefreshDescriptor(input.account, input.site);
  if (descriptor.owner !== 'r_api') {
    throw new Error(`refresh owner is ${descriptor.owner}; r-api refresh skipped`);
  }
  const oauth = getOauthInfoFromAccount(input.account);
  if (oauth?.refreshToken) {
    const result = await refreshOauthAccessToken(input.account.id, {
      reason: input.reason,
      force: input.reason === 'manual',
    });
    return result.reused ? '已复用其他执行者刷新的 OAuth 凭证' : 'OAuth 凭证刷新完成';
  }
  const sub2api = input.site.platform.trim().toLowerCase() === 'sub2api'
    ? getSub2ApiAuthFromExtraConfig(input.account.extraConfig)
    : null;
  if (sub2api?.refreshToken) {
    await refreshSub2ApiManagedSessionSingleflight({
      account: input.account,
      site: input.site,
      currentAccessToken: input.account.accessToken,
      currentExtraConfig: input.account.extraConfig,
    });
    return 'Sub2API 凭证刷新完成';
  }
  throw new Error('该账号没有由 r-api 托管的 refresh token');
}

export const managedCredentialRefreshInternals = {
  explicitRefreshOwner,
  normalizeOwner,
};
