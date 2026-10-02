import { buildConfig, config } from '../config.js';
import { db, schema, switchRuntimeDatabase } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { eq } from 'drizzle-orm';
import { updateBalanceRefreshCron, updateCheckinCron, updateLogCleanupSettings } from './checkinScheduler.js';
import { ensureDefaultSitesSeeded } from './defaultSiteSeedService.js';
import { startProxyLogRetentionService } from './proxyLogRetentionService.js';
import { invalidateSiteProxyCache } from './siteProxy.js';
import {
  ADMIN_PASSWORD_HASH_SETTING_KEY,
  hashAdminCredential,
} from './adminAuthService.js';

export const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';

type FactoryResetDependencies = {
  switchRuntimeDatabase?: typeof switchRuntimeDatabase;
  runSqliteMigrations?: () => Promise<void> | void;
  ensureDefaultSitesSeeded?: typeof ensureDefaultSitesSeeded;
};

type PreservedInfrastructureState = {
  authToken: string;
  adminPasswordHash: string;
  adminTotpConfig: typeof schema.adminTotpConfigs.$inferSelect | null;
  systemProxyUrl: string;
  dbType: 'sqlite' | 'mysql' | 'postgres';
  dbUrl: string;
  dbSsl: boolean;
};

async function clearAllBusinessData() {
  await db.transaction(async (tx) => {
    await tx.delete(schema.routeChannels).run();
    await tx.delete(schema.tokenModelAvailability).run();
    await tx.delete(schema.modelAvailability).run();
    await tx.delete(schema.modelSyncStates).run();
    await tx.delete(schema.proxyLogs).run();
    await tx.delete(schema.proxyVideoTasks).run();
    await tx.delete(schema.proxyFiles).run();
    await tx.delete(schema.checkinLogs).run();
    await tx.delete(schema.accountTokens).run();
    await tx.delete(schema.browserCredentialRecoveryTasks).run();
    await tx.delete(schema.bridgeContinuationEvents).run();
    await tx.delete(schema.bridgeContinuationLeases).run();
    await tx.delete(schema.bridgeContinuationTasks).run();
    await tx.delete(schema.interactionActionTickets).run();
    await tx.delete(schema.interactionCardUpdates).run();
    await tx.delete(schema.interactionDispatches).run();
    await tx.delete(schema.interactionPromptCards).run();
    await tx.delete(schema.interactionAdapters).run();
    await tx.delete(schema.interactionEvents).run();
    await tx.delete(schema.interactionRequests).run();
    await tx.delete(schema.localConnectorActions).run();
    await tx.delete(schema.localConnectorPairings).run();
    await tx.delete(schema.localConnectorDevices).run();
    await tx.delete(schema.credentialLifecycleAudits).run();
    await tx.delete(schema.credentialRefreshJobs).run();
    await tx.delete(schema.credentialImportProvenance).run();
    await tx.delete(schema.credentialImportItems).run();
    await tx.delete(schema.credentialImportJobs).run();
    await tx.delete(schema.credentialVaultItems).run();
    await tx.delete(schema.accounts).run();
    await tx.delete(schema.tokenRoutes).run();
    await tx.delete(schema.sites).run();
    await tx.delete(schema.downstreamApiKeys).run();
    await tx.delete(schema.events).run();
    await tx.delete(schema.notificationOutbox).run();
    await tx.delete(schema.notificationThrottleStates).run();
    await tx.delete(schema.adminAuthChallenges).run();
    await tx.delete(schema.adminSessions).run();
    await tx.delete(schema.adminTotpConfigs).run();
    await tx.delete(schema.settings).run();
  });
}

async function captureInfrastructureState(): Promise<PreservedInfrastructureState> {
  const storedHash = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, ADMIN_PASSWORD_HASH_SETTING_KEY))
    .get();
  let adminPasswordHash = '';
  try {
    const parsed = JSON.parse(storedHash?.value || 'null');
    adminPasswordHash = typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    adminPasswordHash = String(storedHash?.value || '').trim();
  }

  return {
    authToken: config.authToken,
    adminPasswordHash,
    adminTotpConfig: await db.select().from(schema.adminTotpConfigs).get() || null,
    systemProxyUrl: config.systemProxyUrl,
    dbType: config.dbType,
    dbUrl: config.dbUrl,
    dbSsl: config.dbSsl,
  };
}

function shouldPreserveExternalRuntime(state: PreservedInfrastructureState): boolean {
  return state.dbType !== 'sqlite' && !!state.dbUrl.trim();
}

function resetRuntimeConfigToInitialState(preserved: PreservedInfrastructureState) {
  const baseline = buildConfig(process.env);
  Object.assign(config, baseline);
  config.authToken = preserved.authToken || baseline.authToken || FACTORY_RESET_ADMIN_TOKEN;
  config.systemProxyUrl = preserved.systemProxyUrl || baseline.systemProxyUrl;
  if (shouldPreserveExternalRuntime(preserved)) {
    config.dbType = preserved.dbType;
    config.dbUrl = preserved.dbUrl;
    config.dbSsl = preserved.dbSsl;
  }
  config.logCleanupConfigured = false;
  config.logCleanupUsageLogsEnabled = config.proxyLogRetentionDays > 0;
  config.logCleanupProgramLogsEnabled = false;
  config.logCleanupRetentionDays = Math.max(1, Math.trunc(config.proxyLogRetentionDays || config.logCleanupRetentionDays || 30));
  updateCheckinCron(config.checkinCron);
  updateBalanceRefreshCron(config.balanceRefreshCron);
  updateLogCleanupSettings({
    cronExpr: config.logCleanupCron,
    usageLogsEnabled: config.logCleanupUsageLogsEnabled,
    programLogsEnabled: config.logCleanupProgramLogsEnabled,
    retentionDays: config.logCleanupRetentionDays,
  });
  startProxyLogRetentionService();
  invalidateSiteProxyCache();
}

async function restoreInfrastructureSettings(preserved: PreservedInfrastructureState): Promise<void> {
  const adminPasswordHash = preserved.adminPasswordHash
    || await hashAdminCredential(preserved.authToken || FACTORY_RESET_ADMIN_TOKEN);
  await upsertSetting(ADMIN_PASSWORD_HASH_SETTING_KEY, adminPasswordHash);
  if (preserved.adminTotpConfig) {
    await db.insert(schema.adminTotpConfigs).values(preserved.adminTotpConfig).run();
  }
  await upsertSetting('system_proxy_url', preserved.systemProxyUrl);

  if (shouldPreserveExternalRuntime(preserved)) {
    await upsertSetting('db_type', preserved.dbType);
    await upsertSetting('db_url', preserved.dbUrl);
    await upsertSetting('db_ssl', preserved.dbSsl);
    return;
  }

  await upsertSetting('db_type', config.dbType);
  await upsertSetting('db_url', config.dbUrl);
  await upsertSetting('db_ssl', config.dbSsl);
}

async function runDefaultSqliteMigrations() {
  const migrateModule = await import('../db/migrate.js');
  migrateModule.runSqliteMigrations();
}

export async function performFactoryReset(deps: FactoryResetDependencies = {}): Promise<void> {
  const switchRuntimeDatabaseImpl = deps.switchRuntimeDatabase ?? switchRuntimeDatabase;
  const runSqliteMigrationsImpl = deps.runSqliteMigrations ?? runDefaultSqliteMigrations;
  const ensureDefaultSitesSeededImpl = deps.ensureDefaultSitesSeeded ?? ensureDefaultSitesSeeded;
  const preserved = await captureInfrastructureState();

  await clearAllBusinessData();
  resetRuntimeConfigToInitialState(preserved);
  await switchRuntimeDatabaseImpl(config.dbType, config.dbUrl, config.dbSsl);
  if (config.dbType === 'sqlite') {
    await runSqliteMigrationsImpl();
  }
  await clearAllBusinessData();
  await restoreInfrastructureSettings(preserved);
  await ensureDefaultSitesSeededImpl();
}
