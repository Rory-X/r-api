import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { insertAndGetById } from '../../db/insertHelpers.js';
import { listOAuthProviderDefinitions, type OAuthProviderDefinition } from './providers.js';
import { upsertSetting } from '../../db/upsertSetting.js';

export const OAUTH_PROVIDER_SITE_DELETION_KEY_PREFIX = 'oauth_provider_site_deleted_v1:';

function deletionKey(provider: string): string {
  return `${OAUTH_PROVIDER_SITE_DELETION_KEY_PREFIX}${provider}`;
}

function findProviderForSite(site: Pick<typeof schema.sites.$inferSelect, 'platform' | 'url'>) {
  return listOAuthProviderDefinitions().find((definition) => (
    definition.site.platform === site.platform && definition.site.url === site.url
  ));
}

export function isOauthProviderSite(
  site: Pick<typeof schema.sites.$inferSelect, 'platform' | 'url'>,
): boolean {
  return Boolean(findProviderForSite(site));
}

async function isDeletionMarked(definition: OAuthProviderDefinition, txDb: typeof db = db): Promise<boolean> {
  const marker = await txDb.select({ key: schema.settings.key })
    .from(schema.settings)
    .where(eq(schema.settings.key, deletionKey(definition.metadata.provider)))
    .get();
  return Boolean(marker);
}

export async function markOauthProviderSiteDeleted(
  site: Pick<typeof schema.sites.$inferSelect, 'platform' | 'url'>,
  txDb: typeof db = db,
): Promise<boolean> {
  const definition = findProviderForSite(site);
  if (!definition) return false;
  await upsertSetting(deletionKey(definition.metadata.provider), true, txDb);
  return true;
}

export async function clearOauthProviderSiteDeletion(
  provider: string,
  txDb: typeof db = db,
): Promise<void> {
  await txDb.delete(schema.settings)
    .where(eq(schema.settings.key, deletionKey(provider)))
    .run();
}

export async function clearOauthProviderSiteDeletionForSite(
  site: Pick<typeof schema.sites.$inferSelect, 'platform' | 'url'>,
  txDb: typeof db = db,
): Promise<boolean> {
  const definition = findProviderForSite(site);
  if (!definition) return false;
  await clearOauthProviderSiteDeletion(definition.metadata.provider, txDb);
  return true;
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('unique')
    || normalized.includes('duplicate')
    || normalized.includes('constraint failed');
}

async function getNextSiteSortOrder(): Promise<number> {
  const row = await db.select({
    maxSortOrder: sql<number>`COALESCE(MAX(${schema.sites.sortOrder}), -1)`,
  }).from(schema.sites).get();
  return (row?.maxSortOrder ?? -1) + 1;
}

export async function ensureOauthProviderSite(definition: OAuthProviderDefinition) {
  if (await isDeletionMarked(definition)) {
    throw new Error(
      `oauth provider site was deleted: ${definition.metadata.provider}; start a new OAuth flow to restore it`,
    );
  }

  const existing = await db.select().from(schema.sites).where(and(
    eq(schema.sites.platform, definition.site.platform),
    eq(schema.sites.url, definition.site.url),
  )).get();
  if (existing) return existing;

  try {
    return await insertAndGetById<typeof schema.sites.$inferSelect>({
      table: schema.sites,
      idColumn: schema.sites.id,
      values: {
        name: definition.site.name,
        url: definition.site.url,
        platform: definition.site.platform,
        status: 'active',
        useSystemProxy: false,
        isPinned: false,
        globalWeight: 1,
        sortOrder: await getNextSiteSortOrder(),
      },
      insertErrorMessage: `failed to create oauth provider site: ${definition.site.platform}`,
      loadErrorMessage: `failed to load created oauth provider site: ${definition.site.platform}`,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const recovered = await db.select().from(schema.sites).where(and(
      eq(schema.sites.platform, definition.site.platform),
      eq(schema.sites.url, definition.site.url),
    )).get();
    if (recovered) return recovered;
    throw error;
  }
}
