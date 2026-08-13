import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import { encryptAccountPassword } from './accountCredentialService.js';
import { convergeAccountMutation } from './accountMutationWorkflow.js';
import {
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
} from './accountExtraConfig.js';
import { getAdapter } from './platforms/index.js';

type LoginFailureInfo = {
  message: string;
  shieldBlocked: boolean;
};

export type AccountLoginResult =
  | {
    success: false;
    message: string;
    shieldBlocked?: boolean;
  }
  | {
    success: true;
    account: typeof schema.accounts.$inferSelect;
    apiTokenFound: boolean;
    tokenCount: number;
    reusedAccount: boolean;
  };

function normalizeLoginFailure(
  message: string | null | undefined,
): LoginFailureInfo {
  const raw = (message || '').trim();
  const lowered = raw.toLowerCase();
  const looksLikeHtmlJsonParseError =
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'));
  const looksLikeShieldChallenge =
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error');

  if (looksLikeHtmlJsonParseError || looksLikeShieldChallenge) {
    return {
      shieldBlocked: true,
      message:
        'This site is shielded by anti-bot challenge. Account/password login is blocked. Create an API key on the target site and import that key.',
    };
  }

  return {
    shieldBlocked: false,
    message: raw || 'login failed',
  };
}

async function getNextAccountSortOrder(): Promise<number> {
  const rows = await db.select({ sortOrder: schema.accounts.sortOrder })
    .from(schema.accounts)
    .all();
  const max = rows.reduce(
    (currentMax, row) => Math.max(currentMax, row.sortOrder || 0),
    -1,
  );
  return max + 1;
}

export async function loginAndPersistAccount(input: {
  siteId: number;
  username: string;
  password: string;
}): Promise<AccountLoginResult> {
  const site = await db.select().from(schema.sites)
    .where(eq(schema.sites.id, input.siteId))
    .get();
  if (!site) return { success: false, message: 'site not found' };

  const adapter = getAdapter(site.platform);
  if (!adapter) return { success: false, message: `不支持的平台: ${site.platform}` };

  const loginResult = await adapter.login(site.url, input.username, input.password);
  if (!loginResult.success || !loginResult.accessToken) {
    const normalizedFailure = normalizeLoginFailure(loginResult.message);
    return {
      success: false,
      shieldBlocked: normalizedFailure.shieldBlocked,
      message: normalizedFailure.message,
    };
  }

  const guessedPlatformUserId = guessPlatformUserIdFromUsername(input.username);
  let apiToken: string | null = null;
  let apiTokens: Array<{
    name?: string | null;
    key?: string | null;
    enabled?: boolean | null;
  }> = [];
  try {
    apiToken = await adapter.getApiToken(
      site.url,
      loginResult.accessToken,
      guessedPlatformUserId,
    );
  } catch {}
  try {
    apiTokens = await adapter.getApiTokens(
      site.url,
      loginResult.accessToken,
      guessedPlatformUserId,
    );
  } catch {}

  const preferredApiToken =
    apiTokens.find((token) => token.enabled !== false && token.key)?.key
    || apiToken
    || null;
  const existing = await db.select().from(schema.accounts)
    .where(and(
      eq(schema.accounts.siteId, input.siteId),
      eq(schema.accounts.username, input.username),
    ))
    .get();

  const extraConfigPatch: Record<string, unknown> = {
    credentialMode: 'session',
    autoRelogin: {
      username: input.username,
      passwordCipher: encryptAccountPassword(input.password),
      updatedAt: new Date().toISOString(),
    },
  };
  if (guessedPlatformUserId) extraConfigPatch.platformUserId = guessedPlatformUserId;
  const extraConfig = mergeAccountExtraConfig(existing?.extraConfig, extraConfigPatch);

  let accountId = existing?.id;
  if (existing) {
    await db.update(schema.accounts).set({
      accessToken: loginResult.accessToken,
      apiToken: preferredApiToken || undefined,
      checkinEnabled: true,
      status: 'active',
      extraConfig,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accounts.id, existing.id)).run();
  } else {
    const created = await insertAndGetById<typeof schema.accounts.$inferSelect>({
      table: schema.accounts,
      idColumn: schema.accounts.id,
      values: {
        siteId: input.siteId,
        username: input.username,
        accessToken: loginResult.accessToken,
        apiToken: preferredApiToken || undefined,
        checkinEnabled: true,
        extraConfig,
        isPinned: false,
        sortOrder: await getNextAccountSortOrder(),
      },
      insertErrorMessage: 'account create failed',
      loadErrorMessage: 'account create failed',
    });
    accountId = created.id;
  }

  const persisted = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId!))
    .get();
  if (!persisted) throw new Error('account create failed');

  await convergeAccountMutation({
    accountId: persisted.id,
    preferredApiToken,
    defaultTokenSource: 'sync',
    upstreamTokens: apiTokens,
    refreshBalance: true,
    refreshModels: true,
    rebuildRoutes: true,
    continueOnError: true,
  });

  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, persisted.id))
    .get();
  if (!account) throw new Error('account create failed');

  return {
    success: true,
    account,
    apiTokenFound: !!preferredApiToken,
    tokenCount: apiTokens.length,
    reusedAccount: !!existing,
  };
}

export const accountLoginInternals = {
  normalizeLoginFailure,
};
