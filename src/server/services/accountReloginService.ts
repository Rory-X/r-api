import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAutoReloginConfig, mergeAccountExtraConfig, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';

type AutoReloginResult = {
  accessToken: string;
  platformUserId?: number;
  extraConfig?: string;
};

export async function tryAutoRelogin(
  account: Pick<typeof schema.accounts.$inferSelect, 'id' | 'status' | 'extraConfig'>,
  site: Pick<typeof schema.sites.$inferSelect, 'url' | 'platform'>,
): Promise<AutoReloginResult | null> {
  const adapter = getAdapter(site.platform);
  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!adapter || !relogin) return null;
  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const result = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password),
  );
  if (!result.success || !result.accessToken) return null;

  const platformUserId = typeof result.platformUserId === 'number'
    && Number.isSafeInteger(result.platformUserId) && result.platformUserId > 0
    ? result.platformUserId : undefined;
  // Settings can change while login is in flight. Merge the identity into the
  // latest configuration rather than writing the pre-login snapshot back.
  const latest = platformUserId
    ? await db.select({ extraConfig: schema.accounts.extraConfig }).from(schema.accounts)
      .where(eq(schema.accounts.id, account.id)).get()
    : undefined;
  const extraConfig = platformUserId
    ? mergeAccountExtraConfig(latest ? latest.extraConfig : account.extraConfig, { platformUserId })
    : undefined;
  await db.update(schema.accounts).set({
    accessToken: result.accessToken,
    ...(extraConfig ? { extraConfig } : {}),
    status: account.status === 'expired' ? 'active' : account.status,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, account.id)).run();
  return { accessToken: result.accessToken, platformUserId, extraConfig };
}
