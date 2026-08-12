import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

describe('oauth site registry', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-oauth-site-registry-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('creates only the requested oauth provider site without duplicating it', async () => {
    await db.insert(schema.sites).values({
      name: 'Anthropic Claude OAuth',
      url: 'https://api.anthropic.com',
      platform: 'claude',
      status: 'active',
      useSystemProxy: true,
    }).run();

    const { ensureOauthProviderSite } = await import('./oauthSiteRegistry.js');
    const { getOAuthProviderDefinition } = await import('./providers.js');
    const definition = getOAuthProviderDefinition('claude');
    expect(definition).toBeTruthy();
    await ensureOauthProviderSite(definition!);

    const rows = await db.select().from(schema.sites).all();
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => row.platform === 'claude')).toHaveLength(1);
  });

  it('does not recreate a provider site after the user deletes it until OAuth is explicitly restored', async () => {
    const { clearOauthProviderSiteDeletion, ensureOauthProviderSite, markOauthProviderSiteDeleted } = await import('./oauthSiteRegistry.js');
    const { getOAuthProviderDefinition } = await import('./providers.js');
    const definition = getOAuthProviderDefinition('codex');
    expect(definition).toBeTruthy();

    const created = await ensureOauthProviderSite(definition!);
    await markOauthProviderSiteDeleted(created);
    await db.delete(schema.sites).where(eq(schema.sites.id, created.id)).run();

    await expect(ensureOauthProviderSite(definition!)).rejects.toThrow('oauth provider site was deleted');
    expect(await db.select().from(schema.sites).all()).toHaveLength(0);

    await clearOauthProviderSiteDeletion('codex');
    const restored = await ensureOauthProviderSite(definition!);
    expect(restored.platform).toBe('codex');
  });

  it('keeps the deletion marker until the exact official provider site is restored', async () => {
    const {
      clearOauthProviderSiteDeletionForSite,
      ensureOauthProviderSite,
      markOauthProviderSiteDeleted,
    } = await import('./oauthSiteRegistry.js');
    const { getOAuthProviderDefinition } = await import('./providers.js');
    const definition = getOAuthProviderDefinition('codex');
    expect(definition).toBeTruthy();

    const created = await ensureOauthProviderSite(definition!);
    await markOauthProviderSiteDeleted(created);
    await db.delete(schema.sites).where(eq(schema.sites.id, created.id)).run();

    expect(await clearOauthProviderSiteDeletionForSite({
      platform: definition!.site.platform,
      url: 'https://example.com/custom-codex',
    })).toBe(false);
    await expect(ensureOauthProviderSite(definition!)).rejects.toThrow('oauth provider site was deleted');

    expect(await clearOauthProviderSiteDeletionForSite(definition!.site)).toBe(true);
    await expect(ensureOauthProviderSite(definition!)).resolves.toMatchObject({
      platform: definition!.site.platform,
      url: definition!.site.url,
    });
  });
});
