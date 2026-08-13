import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

const LEGACY_PROXY_TOKEN_SETTING_KEY = 'proxy_token';
const LEGACY_GLOBAL_PROXY_FILE_OWNER_TYPE = 'global_proxy_token';

async function cleanupLegacyGlobalProxyTokenSetting(): Promise<void> {
  await db.delete(schema.settings)
    .where(eq(schema.settings.key, LEGACY_PROXY_TOKEN_SETTING_KEY))
    .run();
}

export async function cleanupLegacyGlobalProxyTokenState(): Promise<void> {
  await cleanupLegacyGlobalProxyTokenSetting();
  await db.delete(schema.proxyFiles)
    .where(eq(schema.proxyFiles.ownerType, LEGACY_GLOBAL_PROXY_FILE_OWNER_TYPE))
    .run();
}
