import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import argon2 from 'argon2';

type DbModule = typeof import('../db/index.js');
type ConfigModule = typeof import('../config.js');
type ServiceModule = typeof import('./factoryResetService.js');

describe('factoryResetService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let performFactoryReset: ServiceModule['performFactoryReset'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-factory-reset-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./factoryResetService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    performFactoryReset = serviceModule.performFactoryReset;
  });

  beforeEach(async () => {
    await db.delete(schema.adminAuthChallenges).run();
    await db.delete(schema.adminSessions).run();
    await db.delete(schema.adminTotpConfigs).run();
    await db.delete(schema.interactionActionTickets).run();
    await db.delete(schema.interactionDispatches).run();
    await db.delete(schema.interactionPromptCards).run();
    await db.delete(schema.interactionAdapters).run();
    await db.delete(schema.bridgeContinuationEvents).run();
    await db.delete(schema.bridgeContinuationLeases).run();
    await db.delete(schema.bridgeContinuationTasks).run();
    await db.delete(schema.localConnectorActions).run();
    await db.delete(schema.localConnectorPairings).run();
    await db.delete(schema.localConnectorDevices).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyVideoTasks).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.credentialVaultItems).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();

    config.authToken = 'external-reset-token';
    config.dbType = 'postgres';
    config.dbUrl = 'postgres://user:pass@127.0.0.1:5432/metapi';
    config.dbSsl = true;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('clears current active data while preserving external runtime connectivity', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'External Runtime Site',
      url: 'https://external.example.com',
      platform: 'new-api',
    }).returning().get();
    await db.insert(schema.credentialVaultItems).values({
      siteId: site.id,
      name: 'reset secret',
      kind: 'session_token',
      ciphertext: 'vault-v1:test',
      fingerprint: 'reset-fingerprint',
    }).run();
    await db.insert(schema.adminTotpConfigs).values({
      id: 'primary',
      encryptedSecret: 'v1.test.test.test',
      recoveryCodeHashes: JSON.stringify(['a'.repeat(64)]),
      lastAcceptedCounter: 42,
      enabledAt: '2026-08-04 00:00:00',
    }).run();
    await db.insert(schema.localConnectorDevices).values({
      id: 'reset-device',
      name: 'Reset Connector',
      platform: 'macos',
      status: 'active',
      tokenHash: 'reset-device-token-hash',
      scopes: JSON.stringify(['app_server.control']),
      pairedAt: '2026-08-04T00:00:00.000Z',
    }).run();
    await db.insert(schema.interactionAdapters).values({
      id: 'reset-adapter',
      kind: 'feishu',
      name: 'Reset Adapter',
      appId: 'reset-app',
      receiveId: 'reset-chat',
      operatorAllowlist: JSON.stringify(['open_id:reset-user']),
    }).run();
    await db.insert(schema.interactionPromptCards).values({
      id: 'reset-prompt-card',
      adapterId: 'reset-adapter',
      deviceId: 'reset-device',
      threadId: 'reset-thread',
      status: 'pending',
      expiresAt: '2026-08-04T23:59:59.000Z',
      requestedBy: 'webui:admin',
      requestIdempotencyKeyHash: 'reset-idempotency-hash',
      requestFingerprint: 'reset-request-fingerprint',
    }).run();
    await db.insert(schema.settings).values([
      { key: 'auth_token', value: JSON.stringify('external-reset-token') },
      { key: 'db_type', value: JSON.stringify('postgres') },
      { key: 'db_url', value: JSON.stringify('postgres://user:pass@127.0.0.1:5432/metapi') },
      { key: 'db_ssl', value: JSON.stringify(true) },
    ]).run();

    const switchRuntimeDatabase = vi.fn(async () => undefined);
    const runSqliteMigrations = vi.fn(() => undefined);
    const ensureDefaultSitesSeeded = vi.fn(async () => ({
      seeded: 0,
      alreadyMarked: false,
      hadExistingSites: false,
    }));

    await performFactoryReset({
      switchRuntimeDatabase,
      runSqliteMigrations,
      ensureDefaultSitesSeeded,
    });

    expect(switchRuntimeDatabase).toHaveBeenCalledWith('postgres', 'postgres://user:pass@127.0.0.1:5432/metapi', true);
    expect(runSqliteMigrations).not.toHaveBeenCalled();
    expect(ensureDefaultSitesSeeded).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.sites).all()).toHaveLength(0);
    expect(await db.select().from(schema.credentialVaultItems).all()).toHaveLength(0);
    expect(await db.select().from(schema.adminTotpConfigs).all()).toMatchObject([{
      id: 'primary',
      encryptedSecret: 'v1.test.test.test',
      lastAcceptedCounter: 42,
    }]);
    expect(await db.select().from(schema.interactionPromptCards).all()).toHaveLength(0);
    const settings = await db.select().from(schema.settings).all();
    const adminPasswordHash = JSON.parse(
      settings.find((row) => row.key === 'admin_password_hash')?.value || '""',
    );
    expect(adminPasswordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(adminPasswordHash, 'external-reset-token')).toBe(true);
    expect(settings.some((row) => row.key === 'auth_token')).toBe(false);
    expect(settings.filter((row) => row.key !== 'admin_password_hash')).toEqual([
      { key: 'proxy_token', value: JSON.stringify('change-me-proxy-sk-token') },
      { key: 'system_proxy_url', value: JSON.stringify('') },
      { key: 'db_type', value: JSON.stringify('postgres') },
      { key: 'db_url', value: JSON.stringify('postgres://user:pass@127.0.0.1:5432/metapi') },
      { key: 'db_ssl', value: JSON.stringify(true) },
    ]);
  });
});
