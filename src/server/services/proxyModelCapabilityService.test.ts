import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type CapabilityModule = typeof import('./proxyModelCapabilityService.js');

describe('proxyModelCapabilityService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let capability: CapabilityModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-model-capability-'));
    process.env.DATA_DIR = dataDir;
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    capability = await import('./proxyModelCapabilityService.js');
  });

  beforeEach(async () => {
    capability.invalidateProxyModelCapabilityCache();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    capability.invalidateProxyModelCapabilityCache();
    delete process.env.DATA_DIR;
  });

  async function createAccount() {
    const site = await db.insert(schema.sites).values({
      name: 'capability-site',
      url: 'https://capability.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    return await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'capability-user',
      accessToken: 'access-token',
      apiToken: 'api-token',
      status: 'active',
    }).returning().get();
  }

  it('persists runtime unsupported and supported states for token credentials', async () => {
    const account = await createAccount();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'capability-token',
      token: 'sk-capability-token',
      enabled: true,
      isDefault: true,
    }).returning().get();

    const ref = {
      accountId: account.id,
      tokenId: token.id,
      modelName: 'GPT-5.4',
    };
    await expect(capability.getProxyModelCapability(ref)).resolves.toMatchObject({ status: 'unknown' });

    await expect(capability.recordProxyModelCapabilityFailure(ref)).resolves.toMatchObject({
      status: 'unsupported',
      source: 'runtime',
    });
    const failedRow = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .get();
    expect(failedRow).toMatchObject({ modelName: 'gpt-5.4', available: false });

    await expect(capability.recordProxyModelCapabilitySuccess(ref)).resolves.toMatchObject({
      status: 'supported',
      source: 'runtime',
    });
    const recoveredRow = await db.select().from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .get();
    expect(recoveredRow).toMatchObject({ modelName: 'gpt-5.4', available: true });
  });

  it('does not overwrite a manual account capability override', async () => {
    const account = await createAccount();
    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: 'gpt-5.4',
      available: true,
      isManual: true,
    }).run();

    const state = await capability.recordProxyModelCapabilityFailure({
      accountId: account.id,
      modelName: 'gpt-5.4',
    });
    expect(state).toMatchObject({ status: 'supported', source: 'manual' });

    const row = await db.select().from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.accountId, account.id))
      .get();
    expect(row).toMatchObject({ available: true, isManual: true });
  });
});
