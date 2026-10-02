import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import {
  buildFastifyOptions,
  config,
} from './config.js';
import { authMiddleware } from './middleware/auth.js';
import { DEMO_MODE_BLOCK_RESPONSE, isDemoModeRequestBlocked } from './middleware/demoMode.js';
import { sitesRoutes } from './routes/api/sites.js';
import { accountsRoutes } from './routes/api/accounts.js';
import { checkinRoutes } from './routes/api/checkin.js';
import { tokensRoutes } from './routes/api/tokens.js';
import { statsRoutes } from './routes/api/stats.js';
import { authRoutes } from './routes/api/auth.js';
import { settingsRoutes } from './routes/api/settings.js';
import { accountTokensRoutes } from './routes/api/accountTokens.js';
import { searchRoutes } from './routes/api/search.js';
import { eventsRoutes } from './routes/api/events.js';
import { notificationOutboxRoutes } from './routes/api/notificationOutbox.js';
import { proxyRequestLedgerRoutes } from './routes/api/proxyRequestLedgers.js';
import { proxyFileAdminRoutes } from './routes/api/proxyFiles.js';
import { credentialVaultRoutes } from './routes/api/credentialVault.js';
import { credentialImportRoutes } from './routes/api/credentialImports.js';
import { credentialExportRoutes } from './routes/api/credentialExports.js';
import { credentialLifecycleRoutes } from './routes/api/credentialLifecycle.js';
import { browserCredentialRecoveryRoutes } from './routes/api/browserCredentialRecovery.js';
import { modelSyncRoutes } from './routes/api/modelSync.js';
import { localConnectorRoutes } from './routes/api/localConnector.js';
import { bridgeContinuationRoutes } from './routes/api/bridgeContinuations.js';
import { interactionRequestRoutes } from './routes/api/interactionRequests.js';
import { interactionAdapterRoutes } from './routes/api/interactionAdapters.js';
import { taskRoutes } from './routes/api/tasks.js';
import { testRoutes } from './routes/api/test.js';
import { monitorRoutes } from './routes/api/monitor.js';
import { downstreamApiKeysRoutes } from './routes/api/downstreamApiKeys.js';
import { oauthRoutes } from './routes/api/oauth.js';
import { siteAnnouncementsRoutes } from './routes/api/siteAnnouncements.js';
import { updateCenterRoutes } from './routes/api/updateCenter.js';
import { operationsRoutes } from './routes/operations.js';
import { proxyRoutes } from './routes/proxy/router.js';
import { startScheduler, stopScheduler } from './services/checkinScheduler.js';
import * as routeRefreshWorkflow from './services/routeRefreshWorkflow.js';
import { startProxyFileRetentionService, stopProxyFileRetentionService } from './services/proxyFileRetentionService.js';
import { setLegacyProxyLogRetentionFallbackEnabled, stopProxyLogRetentionService } from './services/proxyLogRetentionService.js';
import { buildStartupSummaryLines } from './services/startupInfo.js';
import { repairStoredCreatedAtValues } from './services/storedTimestampRepairService.js';
import { migrateSiteApiKeysToAccounts } from './services/siteApiKeyMigrationService.js';
import { ensureDefaultSitesSeeded } from './services/defaultSiteSeedService.js';
import { ensureOauthIdentityBackfill } from './services/oauth/oauthIdentityBackfill.js';
import { recoverAbandonedProxyRequestLedgers } from './services/proxyAttemptLedgerStore.js';
import { startOAuthLoopbackCallbackServers, stopOAuthLoopbackCallbackServers } from './services/oauth/localCallbackServer.js';
import { startSiteAnnouncementPolling, stopSiteAnnouncementPolling } from './services/siteAnnouncementPollingService.js';
import {
  startModelAvailabilityProbeScheduler,
  stopModelAvailabilityProbeScheduler,
} from './services/modelAvailabilityProbeService.js';
import {
  startChannelRecoveryProbeScheduler,
  stopChannelRecoveryProbeScheduler,
} from './services/channelRecoveryProbeService.js';
import {
  startCredentialLifecycleScheduler,
  stopCredentialLifecycleScheduler,
} from './services/credentialLifecycleOperationsService.js';
import { startUpdateCenterPolling, stopUpdateCenterPolling } from './services/updateCenterPollingService.js';
import {
  startAdminSnapshotWarmScheduler,
  stopAdminSnapshotWarmScheduler,
} from './services/adminSnapshotWarmService.js';
import {
  startUsageAggregationProjectorScheduler,
  stopUsageAggregationProjectorScheduler,
} from './services/usageAggregationService.js';
import { reloadBackupWebdavScheduler, stopBackupWebdavScheduler } from './services/backupService.js';
import {
  startNotificationOutboxWorker,
  stopNotificationOutboxWorker,
} from './services/notificationOutboxService.js';
import {
  startBrowserRecoveryTaskSweeper,
  stopBrowserRecoveryTaskSweeper,
} from './services/browserCredentialRecoveryService.js';
import {
  startBridgeContinuationRecoveryScheduler,
  stopBridgeContinuationRecoveryScheduler,
} from './services/bridgeContinuationRecoveryScheduler.js';
import {
  startGlobalBridgeContinuationScheduler,
  stopGlobalBridgeContinuationScheduler,
} from './services/globalBridgeContinuationScheduler.js';
import {
  startInteractionRequestExpiryScheduler,
  stopInteractionRequestExpiryScheduler,
} from './services/interactionRequestExpiryScheduler.js';
import {
  startFeishuInteractionAdapterScheduler,
  stopFeishuInteractionAdapterScheduler,
} from './services/feishuInteractionAdapterScheduler.js';
import {
  startLocalConnectorHealthScheduler,
  stopLocalConnectorHealthScheduler,
} from './services/localConnectorHealthScheduler.js';
import { ensureRuntimeDatabaseReady } from './runtimeDatabaseBootstrap.js';
import { ensureAdminAuthReady, pruneAdminSessions } from './services/adminAuthService.js';
import { pruneAdminAuthChallenges } from './services/adminTotpService.js';
import { configureUpstreamHttpTransport } from './services/upstreamHttpTransport.js';
import { cleanupLegacyGlobalProxyTokenState } from './services/legacyGlobalProxyTokenCleanupService.js';
import { setApplicationReadiness } from './observability/healthService.js';
import { registerHttpObservabilityHooks } from './observability/httpInstrumentation.js';
import { shutdownOpenTelemetry } from './observability/telemetry.js';
import { isPublicApiRoute, registerDesktopRoutes } from './desktop.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, normalize, resolve, sep } from 'path';
import {
  applyRuntimeSettings,
  parseSettingFromMap,
} from './runtimeSettingsHydration.js';
import { normalizeLogCleanupRetentionDays } from './shared/logCleanupRetentionDays.js';
import {
  db,
  ensureProxyFileCompatibilityColumns,
  ensureProxyLogClientColumns,
  ensureProxyLogDownstreamApiKeyIdColumn,
  ensureProxyLogBillingDetailsColumn,
  ensureProxyLogStreamTimingColumns,
  ensureRouteGroupingCompatibilityColumns,
  ensureSiteCompatibilityColumns,
  runtimeDbDialect,
  schema,
  switchRuntimeDatabase,
  type RuntimeDbDialect,
} from './db/index.js';

function toSettingsMap(rows: Array<{ key: string; value: string }>) {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function normalizeSavedDbType(value: unknown): RuntimeDbDialect | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sqlite') return 'sqlite';
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return null;
}

function validateSavedDbUrl(dialect: RuntimeDbDialect, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (dialect === 'sqlite') return normalized;
  if (dialect === 'mysql' && normalized.startsWith('mysql://')) return normalized;
  if (dialect === 'postgres' && (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://'))) return normalized;
  return null;
}

function extractSavedRuntimeDatabaseConfig(settingsMap: Map<string, string>): { dialect: RuntimeDbDialect; dbUrl: string; ssl: boolean } | null {
  const rawType = parseSettingFromMap<unknown>(settingsMap, 'db_type');
  const rawUrl = parseSettingFromMap<unknown>(settingsMap, 'db_url');
  const rawSsl = parseSettingFromMap<boolean>(settingsMap, 'db_ssl');
  const dialect = normalizeSavedDbType(rawType);
  if (!dialect) return null;
  const dbUrl = validateSavedDbUrl(dialect, rawUrl);
  if (!dbUrl) return null;
  return {
    dialect,
    dbUrl,
    ssl: typeof rawSsl === 'boolean' ? rawSsl : false,
  };
}

const LOG_CLEANUP_SETTING_KEYS = [
  'log_cleanup_cron',
  'log_cleanup_usage_logs_enabled',
  'log_cleanup_program_logs_enabled',
  'log_cleanup_retention_days',
] as const;

function hasExplicitLogCleanupSettings(settingsMap: Map<string, string>): boolean {
  return LOG_CLEANUP_SETTING_KEYS.some((key) => settingsMap.has(key));
}

configureUpstreamHttpTransport();

// Ensure the current runtime database is bootstrapped before reading settings.
await ensureRuntimeDatabaseReady({
  dialect: runtimeDbDialect,
  connectionString: config.dbUrl,
  ssl: config.dbSsl,
});

// Load runtime config overrides from settings
try {
  const initialRows = await db.select().from(schema.settings).all();
  const initialMap = toSettingsMap(initialRows);
  await ensureProxyFileCompatibilityColumns();
  await cleanupLegacyGlobalProxyTokenState();
  const savedDbConfig = extractSavedRuntimeDatabaseConfig(initialMap);
  const activeDbUrl = (config.dbUrl || '').trim();
  const originalRuntimeConfig = {
    dialect: runtimeDbDialect,
    dbUrl: activeDbUrl,
    ssl: config.dbSsl,
  };
  if (savedDbConfig && (savedDbConfig.dialect !== runtimeDbDialect || savedDbConfig.dbUrl !== activeDbUrl || savedDbConfig.ssl !== config.dbSsl)) {
    try {
      await switchRuntimeDatabase(savedDbConfig.dialect, savedDbConfig.dbUrl, savedDbConfig.ssl);
      console.log(`Loaded runtime DB config from settings: ${savedDbConfig.dialect}`);
    } catch (error) {
      const currentDbUrl = (config.dbUrl || '').trim();
      const switchedAway = runtimeDbDialect !== originalRuntimeConfig.dialect
        || currentDbUrl !== originalRuntimeConfig.dbUrl
        || config.dbSsl !== originalRuntimeConfig.ssl;
      if (switchedAway) {
        await switchRuntimeDatabase(
          originalRuntimeConfig.dialect,
          originalRuntimeConfig.dbUrl,
          originalRuntimeConfig.ssl,
        );
      }
      console.warn(`Failed to switch runtime DB from settings: ${(error as Error)?.message || 'unknown error'}`);
    }
  }

  await ensureSiteCompatibilityColumns();
  await ensureRouteGroupingCompatibilityColumns();
  await ensureProxyFileCompatibilityColumns();
  await ensureProxyLogStreamTimingColumns();
  await ensureProxyLogClientColumns();
  await ensureProxyLogDownstreamApiKeyIdColumn();
  await cleanupLegacyGlobalProxyTokenState();
  const finalRows = await db.select().from(schema.settings).all();
  const finalMap = toSettingsMap(finalRows);
  applyRuntimeSettings(finalMap);
  config.logCleanupConfigured = hasExplicitLogCleanupSettings(finalMap);
  if (!config.logCleanupConfigured && config.proxyLogRetentionDays > 0) {
    config.logCleanupUsageLogsEnabled = true;
    config.logCleanupProgramLogsEnabled = false;
    config.logCleanupRetentionDays = normalizeLogCleanupRetentionDays(config.proxyLogRetentionDays);
  }
  await ensureProxyLogBillingDetailsColumn();
  await repairStoredCreatedAtValues();
  await migrateSiteApiKeysToAccounts();
  await ensureDefaultSitesSeeded();
  await ensureOauthIdentityBackfill();
  await routeRefreshWorkflow.rebuildRoutesOnly();

  console.log('Loaded runtime settings overrides');
} catch (error) {
  console.warn(`Failed to load runtime settings overrides: ${(error as Error)?.message || 'unknown error'}`);
}

await ensureAdminAuthReady();
await pruneAdminSessions();
await pruneAdminAuthChallenges();

try {
  const recovered = await recoverAbandonedProxyRequestLedgers();
  if (recovered.recoveredRequests > 0) {
    console.warn(
      `[proxy-ledger] recovered ${recovered.recoveredRequests} abandoned request(s) `
      + `and ${recovered.recoveredAttempts} in-flight attempt(s) as sent_unknown`,
    );
  }
} catch (error) {
  console.warn(`[proxy-ledger] startup recovery failed: ${(error as Error)?.message || 'unknown error'}`);
}

const app = Fastify(buildFastifyOptions(config));

await app.register(cookie);
await app.register(cors);
registerHttpObservabilityHooks(app);

app.addHook('onRequest', async (request, reply) => {
  if (config.demoMode && isDemoModeRequestBlocked(request.method, request.url)) {
    return reply.code(403).send(DEMO_MODE_BLOCK_RESPONSE);
  }
});

// Auth middleware for /api routes
app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/') && !isPublicApiRoute(request.url)) {
    await authMiddleware(request, reply);
  }
});

// Register API routes
await app.register(operationsRoutes);
await app.register(registerDesktopRoutes);
await app.register(sitesRoutes);
await app.register(accountsRoutes);
await app.register(checkinRoutes);
await app.register(tokensRoutes);
await app.register(statsRoutes);
await app.register(authRoutes);
await app.register(settingsRoutes);
await app.register(accountTokensRoutes);
await app.register(searchRoutes);
await app.register(eventsRoutes);
await app.register(notificationOutboxRoutes);
await app.register(proxyRequestLedgerRoutes);
await app.register(proxyFileAdminRoutes);
await app.register(credentialVaultRoutes);
await app.register(credentialImportRoutes);
await app.register(credentialExportRoutes);
await app.register(credentialLifecycleRoutes);
await app.register(browserCredentialRecoveryRoutes);
await app.register(modelSyncRoutes);
await app.register(localConnectorRoutes);
await app.register(bridgeContinuationRoutes);
await app.register(interactionRequestRoutes);
await app.register(interactionAdapterRoutes);
await app.register(siteAnnouncementsRoutes);
await app.register(updateCenterRoutes);
await app.register(taskRoutes);
await app.register(testRoutes);
await app.register(monitorRoutes);
await app.register(downstreamApiKeysRoutes);
await app.register(oauthRoutes);

// Register OpenAI-compatible proxy routes
await app.register(proxyRoutes);

// Serve static web frontend in production
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
if (existsSync(webDir)) {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    wildcard: false,
    setHeaders: (res, filePath) => {
      const normalizedPath = normalize(filePath);
      if (normalizedPath.includes(`${sep}assets${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (normalizedPath.endsWith(`${sep}index.html`)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });
  // SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/v1/')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'Not found' });
  });
}

// Public demos are intentionally inert: no probes, schedulers, callbacks, or outbound workers.
if (!config.demoMode) {
  await startScheduler();
  await reloadBackupWebdavScheduler();
  startSiteAnnouncementPolling();
  startModelAvailabilityProbeScheduler();
  startChannelRecoveryProbeScheduler();
  await startCredentialLifecycleScheduler();
  startUpdateCenterPolling();
  startUsageAggregationProjectorScheduler();
  startAdminSnapshotWarmScheduler();
  startNotificationOutboxWorker();
  await startBrowserRecoveryTaskSweeper();
  await startBridgeContinuationRecoveryScheduler();
  await startGlobalBridgeContinuationScheduler();
  await startInteractionRequestExpiryScheduler();
  await startFeishuInteractionAdapterScheduler();
  await startLocalConnectorHealthScheduler();
  try {
    await startOAuthLoopbackCallbackServers();
  } catch (error) {
    console.warn(`Failed to start OAuth callback listeners: ${(error as Error)?.message || 'unknown error'}`);
  }
} else {
  console.log('[demo-mode] read-only request policy enabled; background workers are disabled');
}
setLegacyProxyLogRetentionFallbackEnabled(!config.demoMode && !config.logCleanupConfigured);
if (!config.demoMode) startProxyFileRetentionService();
app.addHook('onClose', async () => {
  setApplicationReadiness(false);
  stopScheduler();
  stopBackupWebdavScheduler();
  stopSiteAnnouncementPolling();
  stopUpdateCenterPolling();
  stopProxyFileRetentionService();
  stopProxyLogRetentionService();
  stopModelAvailabilityProbeScheduler();
  stopChannelRecoveryProbeScheduler();
  await stopUsageAggregationProjectorScheduler();
  await stopAdminSnapshotWarmScheduler();
  await stopNotificationOutboxWorker();
  stopBrowserRecoveryTaskSweeper();
  await stopBridgeContinuationRecoveryScheduler();
  await stopGlobalBridgeContinuationScheduler();
  await stopInteractionRequestExpiryScheduler();
  await stopFeishuInteractionAdapterScheduler();
  await stopLocalConnectorHealthScheduler();
  await stopCredentialLifecycleScheduler();
  await stopOAuthLoopbackCallbackServers();
  await shutdownOpenTelemetry();
});

// Start server
try {
  await app.listen({ port: config.port, host: config.listenHost });
  setApplicationReadiness(true);
  const summaryLines = buildStartupSummaryLines({
    port: config.port,
    host: config.listenHost,
  });
  for (const line of summaryLines) {
    console.log(line);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
