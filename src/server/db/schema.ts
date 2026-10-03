import { sqliteTable, text, integer, real, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const sites = sqliteTable('sites', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  homepageUrl: text('homepage_url'),
  externalCheckinUrl: text('external_checkin_url'),
  platform: text('platform').notNull(), // 'new-api' | 'one-api' | 'veloera' | 'one-hub' | 'done-hub' | 'sub2api' | 'openai' | 'claude' | 'gemini' | 'codex' | 'gemini-cli' | 'antigravity'
  proxyUrl: text('proxy_url'),
  useSystemProxy: integer('use_system_proxy', { mode: 'boolean' }).default(false),
  customHeaders: text('custom_headers'),
  customHeadersOverrideRequestHeaders: integer('custom_headers_override_request_headers', { mode: 'boolean' }).default(false),
  codexFingerprintEnabled: integer('codex_fingerprint_enabled', { mode: 'boolean' }).default(false),
  status: text('status').notNull().default('active'), // 'active' | 'disabled'
  isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
  sortOrder: integer('sort_order').default(0),
  globalWeight: real('global_weight').default(1),
  apiKey: text('api_key'),
  postRefreshProbeEnabled: integer('post_refresh_probe_enabled', { mode: 'boolean' }).default(false),
  postRefreshProbeModel: text('post_refresh_probe_model').default(''),
  postRefreshProbeScope: text('post_refresh_probe_scope').default('single'),
  postRefreshProbeLatencyThresholdMs: integer('post_refresh_probe_latency_threshold_ms').default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  statusIdx: index('sites_status_idx').on(table.status),
  platformUrlUnique: uniqueIndex('sites_platform_url_unique').on(table.platform, table.url),
}));

export const siteApiEndpoints = sqliteTable('site_api_endpoints', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  sortOrder: integer('sort_order').default(0),
  cooldownUntil: text('cooldown_until'),
  lastSelectedAt: text('last_selected_at'),
  lastFailedAt: text('last_failed_at'),
  lastFailureReason: text('last_failure_reason'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteUrlUnique: uniqueIndex('site_api_endpoints_site_url_unique').on(table.siteId, table.url),
  siteEnabledSortIdx: index('site_api_endpoints_site_enabled_sort_idx').on(table.siteId, table.enabled, table.sortOrder),
  siteCooldownIdx: index('site_api_endpoints_site_cooldown_idx').on(table.siteId, table.cooldownUntil),
}));

/** Queryable runtime health state and fenced recovery-probe lease per Site/model scope. */
export const siteRuntimeHealthStates = sqliteTable('site_runtime_health_states', {
  scopeKey: text('scope_key').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(),
  modelName: text('model_name'),
  recoveryState: text('recovery_state').notNull().default('healthy'),
  penaltyScore: real('penalty_score').notNull().default(0),
  latencyEmaMs: real('latency_ema_ms'),
  firstByteLatencyEmaMs: real('first_byte_latency_ema_ms'),
  firstByteSampleCount: integer('first_byte_sample_count').notNull().default(0),
  transientFailureStreak: integer('transient_failure_streak').notNull().default(0),
  lastTransientFailureAt: text('last_transient_failure_at'),
  recentSuccessCount: real('recent_success_count').notNull().default(0),
  recentFailureCount: real('recent_failure_count').notNull().default(0),
  recentWindowUpdatedAt: text('recent_window_updated_at').notNull(),
  breakerLevel: integer('breaker_level').notNull().default(0),
  breakerUntil: text('breaker_until'),
  recoverySuccessCount: integer('recovery_success_count').notNull().default(0),
  lastProbeAt: text('last_probe_at'),
  lastProbeSuccessAt: text('last_probe_success_at'),
  lastFailureAt: text('last_failure_at'),
  lastSuccessAt: text('last_success_at'),
  lastFailureReason: text('last_failure_reason'),
  lastFailureDomain: text('last_failure_domain'),
  lastFailureEndpointId: integer('last_failure_endpoint_id'),
  probeLeaseOwner: text('probe_lease_owner'),
  probeLeaseToken: text('probe_lease_token'),
  probeLeaseChannelId: integer('probe_lease_channel_id'),
  probeLeaseExpiresAt: text('probe_lease_expires_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteScopeIdx: index('site_runtime_health_states_site_scope_idx').on(table.siteId, table.scope),
  stateBreakerIdx: index('site_runtime_health_states_state_breaker_idx').on(table.recoveryState, table.breakerUntil),
  leaseExpiresIdx: index('site_runtime_health_states_lease_expires_idx').on(table.probeLeaseExpiresAt),
  scopeCheck: check('site_runtime_health_states_scope_check', sql`${table.scope} in ('site', 'model')`),
  recoveryStateCheck: check(
    'site_runtime_health_states_recovery_state_check',
    sql`${table.recoveryState} in ('healthy', 'open', 'recovering')`,
  ),
  breakerLevelNonNegative: check(
    'site_runtime_health_states_breaker_level_non_negative',
    sql`${table.breakerLevel} >= 0`,
  ),
}));

export const siteDisabledModels = sqliteTable('site_disabled_models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  modelName: text('model_name').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteModelUnique: uniqueIndex('site_disabled_models_site_model_unique').on(table.siteId, table.modelName),
  siteIdIdx: index('site_disabled_models_site_id_idx').on(table.siteId),
}));

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  username: text('username'),
  accessToken: text('access_token').notNull(),
  apiToken: text('api_token'),
  balance: real('balance').default(0),
  balanceUsed: real('balance_used').default(0),
  quota: real('quota').default(0),
  unitCost: real('unit_cost'),
  valueScore: real('value_score').default(0),
  status: text('status').default('active'), // 'active' | 'disabled' | 'expired'
  isPinned: integer('is_pinned', { mode: 'boolean' }).default(false),
  sortOrder: integer('sort_order').default(0),
  checkinEnabled: integer('checkin_enabled', { mode: 'boolean' }).default(true),
  lastCheckinAt: text('last_checkin_at'),
  lastBalanceRefresh: text('last_balance_refresh'),
  oauthProvider: text('oauth_provider'),
  oauthAccountKey: text('oauth_account_key'),
  oauthProjectId: text('oauth_project_id'),
  oauthCredentialPayload: text('oauth_credential_payload'), // JSON StoredOauthState; canonical OAuth credential runtime state
  oauthCredentialVersion: integer('oauth_credential_version').notNull().default(1),
  oauthRefreshState: text('oauth_refresh_state').notNull().default('idle'),
  oauthRefreshFailureCount: integer('oauth_refresh_failure_count').notNull().default(0),
  oauthRefreshRetryAt: text('oauth_refresh_retry_at'),
  oauthRefreshLastAttemptAt: text('oauth_refresh_last_attempt_at'),
  oauthRefreshLastSuccessAt: text('oauth_refresh_last_success_at'),
  oauthRefreshLastError: text('oauth_refresh_last_error'),
  extraConfig: text('extra_config'), // JSON string
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteIdIdx: index('accounts_site_id_idx').on(table.siteId),
  statusIdx: index('accounts_status_idx').on(table.status),
  siteStatusIdx: index('accounts_site_status_idx').on(table.siteId, table.status),
  oauthProviderIdx: index('accounts_oauth_provider_idx').on(table.oauthProvider),
  oauthIdentityIdx: index('accounts_oauth_identity_idx').on(table.oauthProvider, table.oauthAccountKey, table.oauthProjectId),
  oauthRefreshStateIdx: index('accounts_oauth_refresh_state_idx').on(table.oauthRefreshState),
  oauthRefreshRetryAtIdx: index('accounts_oauth_refresh_retry_at_idx').on(table.oauthRefreshRetryAt),
}));

/**
 * Encrypted credential references owned by the control plane.
 * Secret material is never returned by admin APIs; consumers resolve it only inside the server.
 */
export const credentialVaultItems = sqliteTable('credential_vault_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('active'),
  ciphertext: text('ciphertext').notNull(),
  fingerprint: text('fingerprint').notNull(),
  metadata: text('metadata'),
  expiresAt: text('expires_at'),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteIdIdx: index('credential_vault_items_site_id_idx').on(table.siteId),
  accountIdIdx: index('credential_vault_items_account_id_idx').on(table.accountId),
  statusIdx: index('credential_vault_items_status_idx').on(table.status),
  fingerprintIdx: index('credential_vault_items_fingerprint_idx').on(table.fingerprint),
  expiresAtIdx: index('credential_vault_items_expires_at_idx').on(table.expiresAt),
}));

/**
 * Durable, secret-free record of one credential import request.
 * Raw input and normalized secret material must never be persisted here.
 */
export const credentialImportJobs = sqliteTable('credential_import_jobs', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('previewed'),
  target: text('target'),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  operatorId: text('operator_id').notNull(),
  conflictPolicy: text('conflict_policy').notNull().default('skip'),
  sourceFormat: text('source_format').notNull(),
  sourceVersion: text('source_version'),
  sourcePlatform: text('source_platform'),
  detectionConfidence: text('detection_confidence').notNull(),
  detectionIsBatch: integer('detection_is_batch', { mode: 'boolean' }).notNull().default(false),
  detectionWarnings: text('detection_warnings'),
  normalizationWarnings: text('normalization_warnings'),
  batchFingerprint: text('batch_fingerprint').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  idempotencyKeyHash: text('idempotency_key_hash'),
  candidateCount: integer('candidate_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  importedCount: integer('imported_count').notNull().default(0),
  updatedCount: integer('updated_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  failureMessage: text('failure_message'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  idempotencyKeyHashUnique: uniqueIndex('credential_import_jobs_idempotency_key_hash_unique')
    .on(table.idempotencyKeyHash),
  requestFingerprintIdx: index('credential_import_jobs_request_fingerprint_idx')
    .on(table.requestFingerprint),
  statusCreatedAtIdx: index('credential_import_jobs_status_created_at_idx')
    .on(table.status, table.createdAt),
  siteCreatedAtIdx: index('credential_import_jobs_site_created_at_idx')
    .on(table.siteId, table.createdAt),
}));

/** Secret-free preview and execution result for one normalized credential candidate. */
export const credentialImportItems = sqliteTable('credential_import_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull().references(() => credentialImportJobs.id, { onDelete: 'cascade' }),
  sourceIndex: integer('source_index').notNull(),
  candidateFingerprint: text('candidate_fingerprint').notNull(),
  sourceFormat: text('source_format').notNull(),
  sourceVersion: text('source_version'),
  sourcePlatform: text('source_platform'),
  provider: text('provider'),
  kind: text('kind').notNull(),
  identitySummary: text('identity_summary'),
  secretSummary: text('secret_summary').notNull(),
  compatibleTargets: text('compatible_targets').notNull(),
  expiresAt: text('expires_at'),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  candidateWarnings: text('candidate_warnings'),
  validationStatus: text('validation_status').notNull(),
  validationErrors: text('validation_errors'),
  validationWarnings: text('validation_warnings'),
  duplicateOfIndex: integer('duplicate_of_index'),
  status: text('status').notNull().default('previewed'),
  resultMessage: text('result_message'),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  vaultItemIds: text('vault_item_ids'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  jobSourceIndexUnique: uniqueIndex('credential_import_items_job_source_index_unique')
    .on(table.jobId, table.sourceIndex),
  jobStatusIdx: index('credential_import_items_job_status_idx').on(table.jobId, table.status),
  candidateFingerprintIdx: index('credential_import_items_candidate_fingerprint_idx')
    .on(table.candidateFingerprint),
  accountIdIdx: index('credential_import_items_account_id_idx').on(table.accountId),
}));

/** Links imported resources back to their source and conflict decision. */
export const credentialImportProvenance = sqliteTable('credential_import_provenance', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: text('job_id').notNull().references(() => credentialImportJobs.id, { onDelete: 'cascade' }),
  itemId: integer('item_id').notNull().references(() => credentialImportItems.id, { onDelete: 'cascade' }),
  targetEntityType: text('target_entity_type').notNull(),
  targetEntityId: integer('target_entity_id').notNull(),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  candidateFingerprint: text('candidate_fingerprint').notNull(),
  sourceFormat: text('source_format').notNull(),
  sourceVersion: text('source_version'),
  sourcePlatform: text('source_platform'),
  provider: text('provider'),
  operatorId: text('operator_id').notNull(),
  conflictPolicy: text('conflict_policy').notNull(),
  importAction: text('import_action').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  itemEntityUnique: uniqueIndex('credential_import_provenance_item_entity_unique')
    .on(table.itemId, table.targetEntityType, table.targetEntityId),
  targetEntityIdx: index('credential_import_provenance_target_entity_idx')
    .on(table.targetEntityType, table.targetEntityId),
  siteCreatedAtIdx: index('credential_import_provenance_site_created_at_idx')
    .on(table.siteId, table.createdAt),
  fingerprintIdx: index('credential_import_provenance_fingerprint_idx')
    .on(table.candidateFingerprint),
}));

/**
 * Short-lived browser credential recovery handoffs.
 * Token material is stored only as hashes; the captured fields are written to
 * credentialVaultItems inside the completion transaction and never stored here.
 */
export const browserCredentialRecoveryTasks = sqliteTable('browser_credential_recovery_tasks', {
  id: text('id').primaryKey(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  mode: text('mode').notNull(),
  status: text('status').notNull().default('pending'),
  credentialName: text('credential_name').notNull(),
  credentialKind: text('credential_kind').notNull().default('browser_storage'),
  adapterPlatform: text('adapter_platform').notNull(),
  targetUrl: text('target_url').notNull(),
  contractSnapshot: text('contract_snapshot').notNull(),
  taskTokenHash: text('task_token_hash'),
  claimTokenHash: text('claim_token_hash'),
  claimedBy: text('claimed_by'),
  claimedAt: text('claimed_at'),
  completedAt: text('completed_at'),
  cancelledAt: text('cancelled_at'),
  resultCredentialId: integer('result_credential_id').references(() => credentialVaultItems.id, { onDelete: 'set null' }),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteIdIdx: index('browser_credential_recovery_tasks_site_id_idx').on(table.siteId),
  accountIdIdx: index('browser_credential_recovery_tasks_account_id_idx').on(table.accountId),
  statusIdx: index('browser_credential_recovery_tasks_status_idx').on(table.status),
  expiresAtIdx: index('browser_credential_recovery_tasks_expires_at_idx').on(table.expiresAt),
  taskTokenHashUnique: uniqueIndex('browser_credential_recovery_tasks_task_token_hash_unique').on(table.taskTokenHash),
  claimTokenHashUnique: uniqueIndex('browser_credential_recovery_tasks_claim_token_hash_unique').on(table.claimTokenHash),
}));

export const localConnectorDevices = sqliteTable('local_connector_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  version: text('version'),
  status: text('status').notNull().default('active'),
  tokenHash: text('token_hash').notNull(),
  scopes: text('scopes').notNull(),
  capabilities: text('capabilities'),
  pairedAt: text('paired_at').notNull(),
  lastSeenAt: text('last_seen_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenHashUnique: uniqueIndex('local_connector_devices_token_hash_unique').on(table.tokenHash),
  statusIdx: index('local_connector_devices_status_idx').on(table.status),
  lastSeenAtIdx: index('local_connector_devices_last_seen_at_idx').on(table.lastSeenAt),
}));

export const localConnectorHealthChecks = sqliteTable('local_connector_health_checks', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => localConnectorDevices.id, { onDelete: 'cascade' }),
  checkId: text('check_id').notNull(),
  status: text('status').notNull().default('unknown'),
  reason: text('reason'),
  observedAt: text('observed_at'),
  transitionedAt: text('transitioned_at'),
  incidentStartedAt: text('incident_started_at'),
  alertedAt: text('alerted_at'),
  recoveryNotifiedAt: text('recovery_notified_at'),
  autoRepairActionId: text('auto_repair_action_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  deviceCheckUnique: uniqueIndex('local_connector_health_checks_device_check_unique')
    .on(table.deviceId, table.checkId),
  statusObservedIdx: index('local_connector_health_checks_status_observed_idx')
    .on(table.status, table.observedAt),
}));

export const localConnectorThreads = sqliteTable('local_connector_threads', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => localConnectorDevices.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull(),
  title: text('title'),
  observationSource: text('observation_source').notNull().default('connector_app_server'),
  controlState: text('control_state').notNull().default('available'),
  threadStatus: text('thread_status').notNull().default('unknown'),
  activeFlags: text('active_flags').notNull().default('[]'),
  activeTurnId: text('active_turn_id'),
  lastEventKind: text('last_event_kind').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  lastActiveAt: text('last_active_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  deviceThreadUnique: uniqueIndex('local_connector_threads_device_thread_unique')
    .on(table.deviceId, table.threadId),
  deviceLastSeenIdx: index('local_connector_threads_device_last_seen_idx')
    .on(table.deviceId, table.lastSeenAt),
  lastSeenAtIdx: index('local_connector_threads_last_seen_at_idx').on(table.lastSeenAt),
  lastActiveAtIdx: index('local_connector_threads_last_active_at_idx').on(table.lastActiveAt),
}));

export const localConnectorPairings = sqliteTable('local_connector_pairings', {
  id: text('id').primaryKey(),
  deviceName: text('device_name').notNull(),
  requestedScopes: text('requested_scopes').notNull(),
  tokenHash: text('token_hash').notNull(),
  status: text('status').notNull().default('pending'),
  claimedDeviceId: text('claimed_device_id').references(() => localConnectorDevices.id, { onDelete: 'set null' }),
  expiresAt: text('expires_at').notNull(),
  claimedAt: text('claimed_at'),
  cancelledAt: text('cancelled_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenHashUnique: uniqueIndex('local_connector_pairings_token_hash_unique').on(table.tokenHash),
  statusExpiresIdx: index('local_connector_pairings_status_expires_idx').on(table.status, table.expiresAt),
  claimedDeviceIdx: index('local_connector_pairings_claimed_device_idx').on(table.claimedDeviceId),
}));

/**
 * Durable bridge continuation state. `active_slot = 1` is unique per session;
 * terminal rows clear the slot so audit history can remain alongside a new task.
 */
export const bridgeContinuationTasks = sqliteTable('bridge_continuation_tasks', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').references(() => localConnectorDevices.id, { onDelete: 'set null' }),
  sessionKey: text('session_key').notNull(),
  activeSlot: integer('active_slot'),
  threadId: text('thread_id').notNull(),
  taskKind: text('task_kind').notNull().default('automatic'),
  submissionMode: text('submission_mode'),
  pendingMethod: text('pending_method'),
  requestSource: text('request_source'),
  requestedBy: text('requested_by'),
  sourceAdapterId: text('source_adapter_id'),
  requestIdempotencyKeyHash: text('request_idempotency_key_hash'),
  promptFingerprint: text('prompt_fingerprint'),
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  policySnapshot: text('policy_snapshot').notNull(),
  policyFingerprint: text('policy_fingerprint').notNull(),
  continuationCount: integer('continuation_count').notNull().default(0),
  startedAt: text('started_at').notNull(),
  nextRunAt: text('next_run_at'),
  threadStatus: text('thread_status').notNull().default('unknown'),
  activeFlags: text('active_flags').notNull().default('[]'),
  activeTurnId: text('active_turn_id'),
  lastFailureClass: text('last_failure_class'),
  lastFailureSource: text('last_failure_source'),
  lastFailureRecoverability: text('last_failure_recoverability'),
  lastCodexErrorCode: text('last_codex_error_code'),
  lastHttpStatusCode: integer('last_http_status_code'),
  lastMessageSummary: text('last_message_summary'),
  lastMessageFingerprint: text('last_message_fingerprint'),
  lastWillRetry: integer('last_will_retry', { mode: 'boolean' }),
  lastFailureTurnTerminal: integer('last_failure_turn_terminal', { mode: 'boolean' }).notNull().default(false),
  retryAfterMs: integer('retry_after_ms'),
  pendingRouteAction: text('pending_route_action'),
  pendingPrompt: text('pending_prompt'),
  stateVersion: integer('state_version').notNull().default(1),
  stoppedAt: text('stopped_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  sessionActiveUnique: uniqueIndex('bridge_continuation_tasks_session_active_unique')
    .on(table.sessionKey, table.activeSlot),
  deviceIdIdx: index('bridge_continuation_tasks_device_id_idx').on(table.deviceId),
  threadIdIdx: index('bridge_continuation_tasks_thread_id_idx').on(table.threadId),
  statusNextRunIdx: index('bridge_continuation_tasks_status_next_run_idx').on(table.status, table.nextRunAt),
  policyFingerprintIdx: index('bridge_continuation_tasks_policy_fingerprint_idx').on(table.policyFingerprint),
  requestIdempotencyKeyUnique: uniqueIndex('bridge_continuation_tasks_request_idempotency_key_unique')
    .on(table.requestIdempotencyKeyHash),
  continuationCountNonNegative: check(
    'bridge_continuation_tasks_continuation_count_non_negative',
    sql`${table.continuationCount} >= 0`,
  ),
  stateVersionPositive: check('bridge_continuation_tasks_state_version_positive', sql`${table.stateVersion} > 0`),
  activeSlotValid: check(
    'bridge_continuation_tasks_active_slot_valid',
    sql`${table.activeSlot} is null or ${table.activeSlot} = 1`,
  ),
}));

export const bridgeContinuationLeases = sqliteTable('bridge_continuation_leases', {
  sessionKey: text('session_key').primaryKey(),
  taskId: text('task_id').notNull().references(() => bridgeContinuationTasks.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  leaseTokenHash: text('lease_token_hash').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  taskIdUnique: uniqueIndex('bridge_continuation_leases_task_id_unique').on(table.taskId),
  leaseTokenHashUnique: uniqueIndex('bridge_continuation_leases_token_hash_unique').on(table.leaseTokenHash),
  expiresAtIdx: index('bridge_continuation_leases_expires_at_idx').on(table.expiresAt),
}));

export const bridgeContinuationEvents = sqliteTable('bridge_continuation_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: text('task_id').notNull().references(() => bridgeContinuationTasks.id, { onDelete: 'cascade' }),
  deliveryId: text('delivery_id'),
  eventType: text('event_type').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason').notNull(),
  metadata: text('metadata'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  deliveryIdUnique: uniqueIndex('bridge_continuation_events_delivery_id_unique').on(table.deliveryId),
  taskCreatedIdx: index('bridge_continuation_events_task_created_idx').on(table.taskId, table.createdAt),
  eventTypeCreatedIdx: index('bridge_continuation_events_type_created_idx').on(table.eventType, table.createdAt),
}));

export const interactionRequests = sqliteTable('interaction_requests', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => localConnectorDevices.id, { onDelete: 'cascade' }),
  sourceRequestKey: text('source_request_key').notNull(),
  connectionId: text('connection_id').notNull(),
  sourceRequestId: text('source_request_id').notNull(),
  kind: text('kind').notNull(),
  method: text('method').notNull(),
  threadId: text('thread_id'),
  turnId: text('turn_id'),
  itemId: text('item_id'),
  requestPayload: text('request_payload').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  responsePayload: text('response_payload'),
  responseFingerprint: text('response_fingerprint'),
  responseSource: text('response_source'),
  responseOperatorId: text('response_operator_id'),
  responseIdempotencyKeyHash: text('response_idempotency_key_hash'),
  responseCommittedAt: text('response_committed_at'),
  responseDeliveryCount: integer('response_delivery_count').notNull().default(0),
  responseDeliveredAt: text('response_delivered_at'),
  resolvedAt: text('resolved_at'),
  cancelledAt: text('cancelled_at'),
  expiresAt: text('expires_at').notNull(),
  stateVersion: integer('state_version').notNull().default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  sourceRequestKeyUnique: uniqueIndex('interaction_requests_source_request_key_unique').on(table.sourceRequestKey),
  deviceStatusIdx: index('interaction_requests_device_status_idx').on(table.deviceId, table.status),
  threadCreatedIdx: index('interaction_requests_thread_created_idx').on(table.threadId, table.createdAt),
  statusExpiresIdx: index('interaction_requests_status_expires_idx').on(table.status, table.expiresAt),
  responseIdempotencyIdx: index('interaction_requests_response_idempotency_idx').on(table.responseIdempotencyKeyHash),
  deliveryCountNonNegative: check(
    'interaction_requests_delivery_count_non_negative',
    sql`${table.responseDeliveryCount} >= 0`,
  ),
  stateVersionPositive: check('interaction_requests_state_version_positive', sql`${table.stateVersion} > 0`),
}));

export const interactionEvents = sqliteTable('interaction_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  interactionId: text('interaction_id').notNull().references(() => interactionRequests.id, { onDelete: 'cascade' }),
  deliveryId: text('delivery_id'),
  eventType: text('event_type').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id'),
  metadata: text('metadata'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  deliveryIdUnique: uniqueIndex('interaction_events_delivery_id_unique').on(table.deliveryId),
  interactionCreatedIdx: index('interaction_events_interaction_created_idx').on(table.interactionId, table.createdAt),
  eventTypeCreatedIdx: index('interaction_events_type_created_idx').on(table.eventType, table.createdAt),
}));

export const interactionAdapters = sqliteTable('interaction_adapters', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').references(() => localConnectorDevices.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  appId: text('app_id').notNull(),
  appSecretCredentialId: integer('app_secret_credential_id')
    .references(() => credentialVaultItems.id, { onDelete: 'set null' }),
  verificationTokenCredentialId: integer('verification_token_credential_id')
    .references(() => credentialVaultItems.id, { onDelete: 'set null' }),
  encryptKeyCredentialId: integer('encrypt_key_credential_id')
    .references(() => credentialVaultItems.id, { onDelete: 'set null' }),
  apiBaseUrl: text('api_base_url').notNull().default('https://open.feishu.cn'),
  receiveIdType: text('receive_id_type').notNull().default('chat_id'),
  receiveId: text('receive_id').notNull(),
  consoleBaseUrl: text('console_base_url'),
  operatorAllowlist: text('operator_allowlist').notNull().default('[]'),
  lastDispatchAt: text('last_dispatch_at'),
  lastCallbackAt: text('last_callback_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  kindNameUnique: uniqueIndex('interaction_adapters_kind_name_unique').on(table.kind, table.name),
  enabledKindIdx: index('interaction_adapters_enabled_kind_idx').on(table.enabled, table.kind),
  deviceEnabledKindIdx: index('interaction_adapters_device_enabled_kind_idx')
    .on(table.deviceId, table.enabled, table.kind),
}));

/**
 * Durable one-to-one mapping between a Codex thread and a Feishu topic.
 * The first completion card becomes the topic root; later cards reply to it.
 */
export const feishuTopicBindings = sqliteTable('feishu_topic_bindings', {
  id: text('id').primaryKey(),
  adapterId: text('adapter_id').notNull().references(() => interactionAdapters.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => localConnectorDevices.id, { onDelete: 'cascade' }),
  codexThreadId: text('codex_thread_id').notNull(),
  rootMessageId: text('root_message_id'),
  feishuThreadId: text('feishu_thread_id'),
  lastMessageId: text('last_message_id'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  adapterDeviceThreadUnique: uniqueIndex('feishu_topic_bindings_adapter_device_thread_unique')
    .on(table.adapterId, table.deviceId, table.codexThreadId),
  adapterRootMessageUnique: uniqueIndex('feishu_topic_bindings_adapter_root_message_unique')
    .on(table.adapterId, table.rootMessageId),
  adapterFeishuThreadUnique: uniqueIndex('feishu_topic_bindings_adapter_feishu_thread_unique')
    .on(table.adapterId, table.feishuThreadId),
  deviceThreadIdx: index('feishu_topic_bindings_device_thread_idx')
    .on(table.deviceId, table.codexThreadId),
}));

export const interactionPromptCards = sqliteTable('interaction_prompt_cards', {
  id: text('id').primaryKey(),
  adapterId: text('adapter_id').notNull().references(() => interactionAdapters.id, { onDelete: 'cascade' }),
  deviceId: text('device_id').notNull().references(() => localConnectorDevices.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull(),
  contextTaskId: text('context_task_id').references(() => bridgeContinuationTasks.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  expiresAt: text('expires_at').notNull(),
  requestedBy: text('requested_by').notNull(),
  requestIdempotencyKeyHash: text('request_idempotency_key_hash').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  consumedTaskId: text('consumed_task_id').references(() => bridgeContinuationTasks.id, { onDelete: 'set null' }),
  consumedBy: text('consumed_by'),
  consumedAt: text('consumed_at'),
  stateVersion: integer('state_version').notNull().default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  idempotencyKeyUnique: uniqueIndex('interaction_prompt_cards_idempotency_key_unique')
    .on(table.requestIdempotencyKeyHash),
  adapterStatusExpiresIdx: index('interaction_prompt_cards_adapter_status_expires_idx')
    .on(table.adapterId, table.status, table.expiresAt),
  deviceThreadCreatedIdx: index('interaction_prompt_cards_device_thread_created_idx')
    .on(table.deviceId, table.threadId, table.createdAt),
  stateVersionPositive: check('interaction_prompt_cards_state_version_positive', sql`${table.stateVersion} > 0`),
}));

export const interactionDispatches = sqliteTable('interaction_dispatches', {
  id: text('id').primaryKey(),
  subjectKind: text('subject_kind').notNull().default('interaction'),
  interactionId: text('interaction_id').references(() => interactionRequests.id, { onDelete: 'cascade' }),
  promptCardId: text('prompt_card_id').references(() => interactionPromptCards.id, { onDelete: 'cascade' }),
  adapterId: text('adapter_id').notNull().references(() => interactionAdapters.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  externalMessageId: text('external_message_id'),
  cardFingerprint: text('card_fingerprint'),
  lastError: text('last_error'),
  deliveredAt: text('delivered_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  interactionAdapterUnique: uniqueIndex('interaction_dispatches_interaction_adapter_unique')
    .on(table.interactionId, table.adapterId),
  promptCardAdapterUnique: uniqueIndex('interaction_dispatches_prompt_card_adapter_unique')
    .on(table.promptCardId, table.adapterId),
  statusNextAttemptIdx: index('interaction_dispatches_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  adapterCreatedIdx: index('interaction_dispatches_adapter_created_idx').on(table.adapterId, table.createdAt),
  subjectKindCheck: check(
    'interaction_dispatches_subject_kind_check',
    sql`(${table.subjectKind} = 'interaction' and ${table.interactionId} is not null and ${table.promptCardId} is null)
      or (${table.subjectKind} = 'prompt_card' and ${table.interactionId} is null and ${table.promptCardId} is not null)`,
  ),
  attemptCountNonNegative: check(
    'interaction_dispatches_attempt_count_non_negative',
    sql`${table.attemptCount} >= 0`,
  ),
}));

export const interactionCardUpdates = sqliteTable('interaction_card_updates', {
  id: text('id').primaryKey(),
  dispatchId: text('dispatch_id').notNull()
    .references(() => interactionDispatches.id, { onDelete: 'cascade' }),
  subjectRevision: integer('subject_revision').notNull(),
  targetStatus: text('target_status').notNull(),
  cardFingerprint: text('card_fingerprint').notNull(),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at').notNull(),
  deadlineAt: text('deadline_at').notNull(),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastError: text('last_error'),
  deliveredAt: text('delivered_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  dispatchFingerprintUnique: uniqueIndex('interaction_card_updates_dispatch_fingerprint_unique')
    .on(table.dispatchId, table.cardFingerprint),
  statusNextAttemptIdx: index('interaction_card_updates_status_next_attempt_idx')
    .on(table.status, table.nextAttemptAt),
  dispatchCreatedIdx: index('interaction_card_updates_dispatch_created_idx')
    .on(table.dispatchId, table.createdAt),
  deadlineIdx: index('interaction_card_updates_deadline_idx').on(table.deadlineAt),
  subjectRevisionPositive: check(
    'interaction_card_updates_subject_revision_positive',
    sql`${table.subjectRevision} > 0`,
  ),
  attemptCountNonNegative: check(
    'interaction_card_updates_attempt_count_non_negative',
    sql`${table.attemptCount} >= 0`,
  ),
}));

export const interactionActionTickets = sqliteTable('interaction_action_tickets', {
  id: text('id').primaryKey(),
  dispatchId: text('dispatch_id').notNull().references(() => interactionDispatches.id, { onDelete: 'cascade' }),
  interactionId: text('interaction_id').references(() => interactionRequests.id, { onDelete: 'cascade' }),
  promptCardId: text('prompt_card_id').references(() => interactionPromptCards.id, { onDelete: 'cascade' }),
  adapterId: text('adapter_id').notNull().references(() => interactionAdapters.id, { onDelete: 'cascade' }),
  actionKey: text('action_key').notNull(),
  tokenHash: text('token_hash').notNull(),
  responsePayload: text('response_payload').notNull(),
  status: text('status').notNull().default('pending'),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
  consumedBy: text('consumed_by'),
  stateVersion: integer('state_version').notNull().default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  dispatchActionUnique: uniqueIndex('interaction_action_tickets_dispatch_action_unique')
    .on(table.dispatchId, table.actionKey),
  tokenHashUnique: uniqueIndex('interaction_action_tickets_token_hash_unique').on(table.tokenHash),
  statusExpiresIdx: index('interaction_action_tickets_status_expires_idx').on(table.status, table.expiresAt),
  interactionCreatedIdx: index('interaction_action_tickets_interaction_created_idx')
    .on(table.interactionId, table.createdAt),
  promptCardCreatedIdx: index('interaction_action_tickets_prompt_card_created_idx')
    .on(table.promptCardId, table.createdAt),
  subjectCheck: check(
    'interaction_action_tickets_subject_check',
    sql`(${table.interactionId} is not null and ${table.promptCardId} is null)
      or (${table.interactionId} is null and ${table.promptCardId} is not null)`,
  ),
  stateVersionPositive: check('interaction_action_tickets_state_version_positive', sql`${table.stateVersion} > 0`),
}));

export const localConnectorActions = sqliteTable('local_connector_actions', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().references(() => localConnectorDevices.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  operation: text('operation').notNull(),
  status: text('status').notNull().default('pending'),
  manifest: text('manifest').notNull(),
  resultPayload: text('result_payload'),
  backupRef: text('backup_ref'),
  errorMessage: text('error_message'),
  claimedAt: text('claimed_at'),
  completedAt: text('completed_at'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  deviceStatusIdx: index('local_connector_actions_device_status_idx').on(table.deviceId, table.status),
  statusExpiresIdx: index('local_connector_actions_status_expires_idx').on(table.status, table.expiresAt),
}));

export const oauthRefreshLeases = sqliteTable('oauth_refresh_leases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerSlot: integer('provider_slot').notNull(),
  leaseToken: text('lease_token').notNull(),
  leaseOwner: text('lease_owner').notNull(),
  credentialVersion: integer('credential_version').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  accountUnique: uniqueIndex('oauth_refresh_leases_account_unique').on(table.accountId),
  leaseTokenUnique: uniqueIndex('oauth_refresh_leases_token_unique').on(table.leaseToken),
  providerSlotUnique: uniqueIndex('oauth_refresh_leases_provider_slot_unique').on(table.provider, table.providerSlot),
  providerIdx: index('oauth_refresh_leases_provider_idx').on(table.provider),
  expiresAtIdx: index('oauth_refresh_leases_expires_at_idx').on(table.expiresAt),
  slotPositive: check('oauth_refresh_leases_slot_positive', sql`${table.providerSlot} > 0`),
  credentialVersionPositive: check('oauth_refresh_leases_credential_version_positive', sql`${table.credentialVersion} > 0`),
}));

export const oauthRefreshProviderStates = sqliteTable('oauth_refresh_provider_states', {
  provider: text('provider').primaryKey(),
  nextAllowedAt: text('next_allowed_at'),
  lastStartedAt: text('last_started_at'),
  lastCompletedAt: text('last_completed_at'),
  consecutiveFailureCount: integer('consecutive_failure_count').notNull().default(0),
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  nextAllowedAtIdx: index('oauth_refresh_provider_states_next_allowed_at_idx').on(table.nextAllowedAt),
}));

/** Durable work queue for managed credential refresh attempts. */
export const credentialRefreshJobs = sqliteTable('credential_refresh_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityType: text('entity_type').notNull().default('account'),
  entityId: integer('entity_id').notNull(),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  provider: text('provider'),
  refreshOwner: text('refresh_owner').notNull().default('r_api'),
  status: text('status').notNull().default('pending'),
  failureClass: text('failure_class'),
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(8),
  nextAttemptAt: text('next_attempt_at'),
  lastAttemptAt: text('last_attempt_at'),
  lastSuccessAt: text('last_success_at'),
  lastError: text('last_error'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  entityUnique: uniqueIndex('credential_refresh_jobs_entity_unique').on(table.entityType, table.entityId),
  statusNextAttemptIdx: index('credential_refresh_jobs_status_next_attempt_idx').on(table.status, table.nextAttemptAt),
  providerStatusIdx: index('credential_refresh_jobs_provider_status_idx').on(table.provider, table.status),
  siteIdIdx: index('credential_refresh_jobs_site_id_idx').on(table.siteId),
  failureClassIdx: index('credential_refresh_jobs_failure_class_idx').on(table.failureClass),
  attemptCountNonNegative: check('credential_refresh_jobs_attempt_count_non_negative', sql`${table.attemptCount} >= 0`),
  maxAttemptsPositive: check('credential_refresh_jobs_max_attempts_positive', sql`${table.maxAttempts} > 0`),
}));

/** Structured, secret-free audit trail for credential lifecycle operations. */
export const credentialLifecycleAudits = sqliteTable('credential_lifecycle_audits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityType: text('entity_type').notNull(),
  entityId: integer('entity_id').notNull(),
  siteId: integer('site_id').references(() => sites.id, { onDelete: 'set null' }),
  provider: text('provider'),
  credentialSource: text('credential_source').notNull().default('unknown'),
  operatorId: text('operator_id').notNull(),
  action: text('action').notNull(),
  status: text('status').notNull(),
  outcome: text('outcome').notNull(),
  message: text('message'),
  metadata: text('metadata'),
  dedupeKey: text('dedupe_key'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  dedupeKeyUnique: uniqueIndex('credential_lifecycle_audits_dedupe_key_unique').on(table.dedupeKey),
  entityCreatedAtIdx: index('credential_lifecycle_audits_entity_created_at_idx').on(table.entityType, table.entityId, table.createdAt),
  sourceCreatedAtIdx: index('credential_lifecycle_audits_source_created_at_idx').on(table.credentialSource, table.createdAt),
  operatorCreatedAtIdx: index('credential_lifecycle_audits_operator_created_at_idx').on(table.operatorId, table.createdAt),
  statusCreatedAtIdx: index('credential_lifecycle_audits_status_created_at_idx').on(table.status, table.createdAt),
  actionCreatedAtIdx: index('credential_lifecycle_audits_action_created_at_idx').on(table.action, table.createdAt),
}));

export const accountTokens = sqliteTable('account_tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  token: text('token').notNull(),
  tokenGroup: text('token_group'),
  valueStatus: text('value_status').notNull().default('ready'),
  source: text('source').default('manual'), // 'manual' | 'sync' | 'legacy'
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  accountIdIdx: index('account_tokens_account_id_idx').on(table.accountId),
  accountEnabledIdx: index('account_tokens_account_enabled_idx').on(table.accountId, table.enabled),
  enabledIdx: index('account_tokens_enabled_idx').on(table.enabled),
}));

export const checkinLogs = sqliteTable('checkin_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // 'success' | 'failed' | 'skipped'
  message: text('message'),
  reward: text('reward'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  accountCreatedIdx: index('checkin_logs_account_created_at_idx').on(table.accountId, table.createdAt),
  createdAtIdx: index('checkin_logs_created_at_idx').on(table.createdAt),
  statusIdx: index('checkin_logs_status_idx').on(table.status),
}));

export const modelAvailability = sqliteTable('model_availability', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  modelName: text('model_name').notNull(),
  available: integer('available', { mode: 'boolean' }),
  isManual: integer('is_manual', { mode: 'boolean' }).default(false),
  contextLength: integer('context_length'),
  contextSource: text('context_source'),
  contextUpdatedAt: text('context_updated_at'),
  latencyMs: integer('latency_ms'),
  checkedAt: text('checked_at').default(sql`(datetime('now'))`),
}, (table) => ({
  accountModelUnique: uniqueIndex('model_availability_account_model_unique').on(table.accountId, table.modelName),
  accountAvailableIdx: index('model_availability_account_available_idx').on(table.accountId, table.available),
  modelNameIdx: index('model_availability_model_name_idx').on(table.modelName),
}));

/**
 * Durable model discovery observations. A model is only retired after the
 * adapter contract's consecutive-missing threshold is reached.
 */
export const modelSyncStates = sqliteTable('model_sync_states', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  modelName: text('model_name').notNull(),
  consecutiveMissing: integer('consecutive_missing').notNull().default(0),
  lastSeenAt: text('last_seen_at'),
  lastSyncAt: text('last_sync_at'),
  status: text('status').notNull().default('active'), // 'active' | 'candidate_retired'
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  accountModelUnique: uniqueIndex('model_sync_states_account_model_unique').on(table.accountId, table.modelName),
  accountStatusIdx: index('model_sync_states_account_status_idx').on(table.accountId, table.status),
  lastSyncAtIdx: index('model_sync_states_last_sync_at_idx').on(table.lastSyncAt),
}));

export const tokenModelAvailability = sqliteTable('token_model_availability', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tokenId: integer('token_id').notNull().references(() => accountTokens.id, { onDelete: 'cascade' }),
  modelName: text('model_name').notNull(),
  available: integer('available', { mode: 'boolean' }),
  contextLength: integer('context_length'),
  contextSource: text('context_source'),
  contextUpdatedAt: text('context_updated_at'),
  latencyMs: integer('latency_ms'),
  checkedAt: text('checked_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenModelUnique: uniqueIndex('token_model_availability_token_model_unique').on(table.tokenId, table.modelName),
  tokenAvailableIdx: index('token_model_availability_token_available_idx').on(table.tokenId, table.available),
  modelNameIdx: index('token_model_availability_model_name_idx').on(table.modelName),
  availableIdx: index('token_model_availability_available_idx').on(table.available),
}));

export const tokenRoutes = sqliteTable('token_routes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelPattern: text('model_pattern').notNull(),
  displayName: text('display_name'),
  displayIcon: text('display_icon'),
  routeMode: text('route_mode').default('pattern'),
  modelMapping: text('model_mapping'), // JSON
  decisionSnapshot: text('decision_snapshot'), // JSON
  decisionRefreshedAt: text('decision_refreshed_at'),
  routingStrategy: text('routing_strategy').default('weighted'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  modelPatternIdx: index('token_routes_model_pattern_idx').on(table.modelPattern),
  enabledIdx: index('token_routes_enabled_idx').on(table.enabled),
}));

export const routeGroupSources = sqliteTable('route_group_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  groupRouteId: integer('group_route_id').notNull().references(() => tokenRoutes.id, { onDelete: 'cascade' }),
  sourceRouteId: integer('source_route_id').notNull().references(() => tokenRoutes.id, { onDelete: 'cascade' }),
}, (table) => ({
  groupSourceUnique: uniqueIndex('route_group_sources_group_source_unique').on(table.groupRouteId, table.sourceRouteId),
  sourceRouteIdx: index('route_group_sources_source_route_id_idx').on(table.sourceRouteId),
}));

export const oauthRouteUnits = sqliteTable('oauth_route_units', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  strategy: text('strategy').notNull().default('round_robin'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  siteProviderIdx: index('oauth_route_units_site_provider_idx').on(table.siteId, table.provider),
  enabledIdx: index('oauth_route_units_enabled_idx').on(table.enabled),
}));

export const oauthRouteUnitMembers = sqliteTable('oauth_route_unit_members', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  unitId: integer('unit_id').notNull().references(() => oauthRouteUnits.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').default(0),
  successCount: integer('success_count').default(0),
  failCount: integer('fail_count').default(0),
  totalLatencyMs: integer('total_latency_ms').default(0),
  totalCost: real('total_cost').default(0),
  lastUsedAt: text('last_used_at'),
  lastSelectedAt: text('last_selected_at'),
  lastFailAt: text('last_fail_at'),
  consecutiveFailCount: integer('consecutive_fail_count').notNull().default(0),
  cooldownLevel: integer('cooldown_level').notNull().default(0),
  cooldownUntil: text('cooldown_until'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  unitAccountUnique: uniqueIndex('oauth_route_unit_members_unit_account_unique').on(table.unitId, table.accountId),
  accountUnique: uniqueIndex('oauth_route_unit_members_account_unique').on(table.accountId),
  unitSortIdx: index('oauth_route_unit_members_unit_sort_idx').on(table.unitId, table.sortOrder),
  unitCooldownIdx: index('oauth_route_unit_members_unit_cooldown_idx').on(table.unitId, table.cooldownUntil),
}));

export const routeChannels = sqliteTable('route_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  routeId: integer('route_id').notNull().references(() => tokenRoutes.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  tokenId: integer('token_id').references(() => accountTokens.id, { onDelete: 'set null' }),
  oauthRouteUnitId: integer('oauth_route_unit_id'),
  sourceModel: text('source_model'),
  priority: integer('priority').default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  weight: integer('weight').default(10),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  manualOverride: integer('manual_override', { mode: 'boolean' }).default(false),
  retryOwner: text('retry_owner').notNull().default('cooperative'),
  upstreamRetryMode: text('upstream_retry_mode').notNull().default('unknown'),
  successCount: integer('success_count').default(0),
  failCount: integer('fail_count').default(0),
  totalLatencyMs: integer('total_latency_ms').default(0),
  totalCost: real('total_cost').default(0),
  lastUsedAt: text('last_used_at'),
  lastSelectedAt: text('last_selected_at'),
  lastFailAt: text('last_fail_at'),
  consecutiveFailCount: integer('consecutive_fail_count').notNull().default(0),
  cooldownLevel: integer('cooldown_level').notNull().default(0),
  cooldownUntil: text('cooldown_until'),
}, (table) => ({
  routeIdIdx: index('route_channels_route_id_idx').on(table.routeId),
  accountIdIdx: index('route_channels_account_id_idx').on(table.accountId),
  tokenIdIdx: index('route_channels_token_id_idx').on(table.tokenId),
  oauthRouteUnitIdx: index('route_channels_oauth_route_unit_id_idx').on(table.oauthRouteUnitId),
  routeEnabledIdx: index('route_channels_route_enabled_idx').on(table.routeId, table.enabled),
  routeTokenIdx: index('route_channels_route_token_idx').on(table.routeId, table.tokenId),
  routePrioritySortIdx: index('route_channels_route_priority_sort_idx').on(table.routeId, table.priority, table.sortOrder),
}));

export const proxyLogs = sqliteTable('proxy_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  routeId: integer('route_id'),
  channelId: integer('channel_id'),
  accountId: integer('account_id'),
  downstreamApiKeyId: integer('downstream_api_key_id'),
  requestId: text('request_id'),
  attemptId: text('attempt_id'),
  modelRequested: text('model_requested'),
  modelActual: text('model_actual'),
  status: text('status'), // 'success' | 'failed' | 'retried'
  httpStatus: integer('http_status'),
  isStream: integer('is_stream', { mode: 'boolean' }),
  firstByteLatencyMs: integer('first_byte_latency_ms'),
  latencyMs: integer('latency_ms'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalTokens: integer('total_tokens'),
  estimatedCost: real('estimated_cost'),
  billingDetails: text('billing_details'),
  clientFamily: text('client_family'),
  clientAppId: text('client_app_id'),
  clientAppName: text('client_app_name'),
  clientConfidence: text('client_confidence'),
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  archivedAt: text('archived_at'),
}, (table) => ({
  createdAtIdx: index('proxy_logs_created_at_idx').on(table.createdAt),
  accountCreatedIdx: index('proxy_logs_account_created_at_idx').on(table.accountId, table.createdAt),
  statusCreatedIdx: index('proxy_logs_status_created_at_idx').on(table.status, table.createdAt),
  modelActualCreatedIdx: index('proxy_logs_model_actual_created_at_idx').on(table.modelActual, table.createdAt),
  downstreamKeyCreatedIdx: index('proxy_logs_downstream_api_key_created_at_idx').on(table.downstreamApiKeyId, table.createdAt),
  clientAppCreatedIdx: index('proxy_logs_client_app_id_created_at_idx').on(table.clientAppId, table.createdAt),
  clientFamilyCreatedIdx: index('proxy_logs_client_family_created_at_idx').on(table.clientFamily, table.createdAt),
  requestCreatedIdx: index('proxy_logs_request_id_created_at_idx').on(table.requestId, table.createdAt),
  attemptCreatedIdx: index('proxy_logs_attempt_id_created_at_idx').on(table.attemptId, table.createdAt),
  archivedAtIdx: index('proxy_logs_archived_at_idx').on(table.archivedAt, table.createdAt),
}));

export const proxyDebugTraces = sqliteTable('proxy_debug_traces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  downstreamPath: text('downstream_path').notNull(),
  clientKind: text('client_kind'),
  sessionId: text('session_id'),
  traceHint: text('trace_hint'),
  requestId: text('request_id'),
  requestedModel: text('requested_model'),
  downstreamApiKeyId: integer('downstream_api_key_id'),
  requestHeadersJson: text('request_headers_json'),
  requestBodyJson: text('request_body_json'),
  stickySessionKey: text('sticky_session_key'),
  stickyHitChannelId: integer('sticky_hit_channel_id'),
  selectedChannelId: integer('selected_channel_id'),
  selectedRouteId: integer('selected_route_id'),
  selectedAccountId: integer('selected_account_id'),
  selectedSiteId: integer('selected_site_id'),
  selectedSitePlatform: text('selected_site_platform'),
  endpointCandidatesJson: text('endpoint_candidates_json'),
  endpointRuntimeStateJson: text('endpoint_runtime_state_json'),
  decisionSummaryJson: text('decision_summary_json'),
  finalStatus: text('final_status'),
  finalHttpStatus: integer('final_http_status'),
  finalUpstreamPath: text('final_upstream_path'),
  finalResponseHeadersJson: text('final_response_headers_json'),
  finalResponseBodyJson: text('final_response_body_json'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  createdAtIdx: index('proxy_debug_traces_created_at_idx').on(table.createdAt),
  sessionCreatedIdx: index('proxy_debug_traces_session_created_at_idx').on(table.sessionId, table.createdAt),
  modelCreatedIdx: index('proxy_debug_traces_model_created_at_idx').on(table.requestedModel, table.createdAt),
  finalStatusCreatedIdx: index('proxy_debug_traces_final_status_created_at_idx').on(table.finalStatus, table.createdAt),
  requestIdIdx: index('proxy_debug_traces_request_id_idx').on(table.requestId),
}));

export const proxyDebugAttempts = sqliteTable('proxy_debug_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  traceId: integer('trace_id').notNull().references(() => proxyDebugTraces.id, { onDelete: 'cascade' }),
  attemptIndex: integer('attempt_index').notNull(),
  attemptId: text('attempt_id'),
  endpoint: text('endpoint').notNull(),
  requestPath: text('request_path').notNull(),
  targetUrl: text('target_url').notNull(),
  runtimeExecutor: text('runtime_executor'),
  requestHeadersJson: text('request_headers_json'),
  requestBodyJson: text('request_body_json'),
  responseStatus: integer('response_status'),
  responseHeadersJson: text('response_headers_json'),
  responseBodyJson: text('response_body_json'),
  rawErrorText: text('raw_error_text'),
  recoverApplied: integer('recover_applied', { mode: 'boolean' }).default(false),
  downgradeDecision: integer('downgrade_decision', { mode: 'boolean' }).default(false),
  downgradeReason: text('downgrade_reason'),
  memoryWriteJson: text('memory_write_json'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  traceAttemptUnique: uniqueIndex('proxy_debug_attempts_trace_attempt_unique').on(table.traceId, table.attemptIndex),
  traceCreatedIdx: index('proxy_debug_attempts_trace_created_at_idx').on(table.traceId, table.createdAt),
  attemptIdIdx: index('proxy_debug_attempts_attempt_id_idx').on(table.attemptId),
}));

/**
 * Durable request-level ledger. Debug traces are opt-in diagnostics; these
 * records remain available for retry safety, restart recovery, and auditing.
 */
export const proxyRequests = sqliteTable('proxy_requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: text('request_id').notNull(),
  requestedModel: text('requested_model').notNull(),
  downstreamPath: text('downstream_path').notNull(),
  clientKind: text('client_kind'),
  sessionId: text('session_id'),
  clientThreadId: text('client_thread_id'),
  clientTurnId: text('client_turn_id'),
  bridgeTaskId: text('bridge_task_id'),
  bridgeRouteAction: text('bridge_route_action'),
  bridgeContinuationNumber: integer('bridge_continuation_number'),
  downstreamApiKeyId: integer('downstream_api_key_id'),
  status: text('status').notNull().default('active'), // 'active' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  retryOwner: text('retry_owner').notNull().default('cooperative'),
  replaySafety: text('replay_safety').notNull().default('safe_only'),
  policySnapshotJson: text('policy_snapshot_json').notNull(),
  retryBudgetJson: text('retry_budget_json').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  finishedAt: text('finished_at'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  archivedAt: text('archived_at'),
}, (table) => ({
  requestIdUnique: uniqueIndex('proxy_requests_request_id_unique').on(table.requestId),
  statusUpdatedIdx: index('proxy_requests_status_updated_at_idx').on(table.status, table.updatedAt),
  sessionCreatedIdx: index('proxy_requests_session_created_at_idx').on(table.sessionId, table.createdAt),
  threadCreatedIdx: index('proxy_requests_thread_created_at_idx').on(table.clientThreadId, table.createdAt),
  bridgeTaskCreatedIdx: index('proxy_requests_bridge_task_created_at_idx').on(table.bridgeTaskId, table.createdAt),
  modelCreatedIdx: index('proxy_requests_model_created_at_idx').on(table.requestedModel, table.createdAt),
  archivedAtIdx: index('proxy_requests_archived_at_idx').on(table.archivedAt, table.updatedAt),
}));

export const proxyRequestAttempts = sqliteTable('proxy_request_attempts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestRowId: integer('request_row_id').notNull().references(() => proxyRequests.id, { onDelete: 'cascade' }),
  attemptId: text('attempt_id').notNull(),
  attemptIndex: integer('attempt_index').notNull(),
  channelId: integer('channel_id'),
  accountId: integer('account_id'),
  tokenId: integer('token_id'),
  endpoint: text('endpoint'),
  requestPath: text('request_path'),
  targetUrl: text('target_url'),
  status: text('status').notNull().default('in_flight'), // 'in_flight' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  commitState: text('commit_state').notNull().default('not_started'),
  errorScope: text('error_scope'),
  statusCode: integer('status_code'),
  errorSummary: text('error_summary'),
  startedAt: text('started_at').default(sql`(datetime('now'))`),
  finishedAt: text('finished_at'),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  requestAttemptUnique: uniqueIndex('proxy_request_attempts_request_attempt_unique').on(table.requestRowId, table.attemptIndex),
  attemptIdUnique: uniqueIndex('proxy_request_attempts_attempt_id_unique').on(table.attemptId),
  requestStatusIdx: index('proxy_request_attempts_request_status_idx').on(table.requestRowId, table.status),
  channelStartedIdx: index('proxy_request_attempts_channel_started_at_idx').on(table.channelId, table.startedAt),
  commitStateIdx: index('proxy_request_attempts_commit_state_idx').on(table.commitState, table.updatedAt),
}));

export const proxyVideoTasks = sqliteTable('proxy_video_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull(),
  upstreamVideoId: text('upstream_video_id').notNull(),
  siteUrl: text('site_url').notNull(),
  tokenValue: text('token_value').notNull(),
  requestedModel: text('requested_model'),
  actualModel: text('actual_model'),
  channelId: integer('channel_id'),
  accountId: integer('account_id'),
  statusSnapshot: text('status_snapshot'),
  upstreamResponseMeta: text('upstream_response_meta'),
  lastUpstreamStatus: integer('last_upstream_status'),
  lastPolledAt: text('last_polled_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  publicIdUnique: uniqueIndex('proxy_video_tasks_public_id_unique').on(table.publicId),
  upstreamVideoIdIdx: index('proxy_video_tasks_upstream_video_id_idx').on(table.upstreamVideoId),
  createdAtIdx: index('proxy_video_tasks_created_at_idx').on(table.createdAt),
}));

export const proxyFiles = sqliteTable('proxy_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  publicId: text('public_id').notNull(),
  ownerType: text('owner_type').notNull(),
  ownerId: text('owner_id').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  purpose: text('purpose'),
  byteSize: integer('byte_size').notNull(),
  sha256: text('sha256').notNull(),
  contentBase64: text('content_base64').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),
}, (table) => ({
  publicIdUnique: uniqueIndex('proxy_files_public_id_unique').on(table.publicId),
  ownerLookupIdx: index('proxy_files_owner_lookup_idx').on(table.ownerType, table.ownerId, table.deletedAt),
}));

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'), // JSON
});

export const adminSessions = sqliteTable('admin_sessions', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull(),
  csrfToken: text('csrf_token').notNull(),
  clientIp: text('client_ip'),
  userAgent: text('user_agent'),
  secondFactorVerifiedAt: text('second_factor_verified_at'),
  expiresAt: text('expires_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenHashUnique: uniqueIndex('admin_sessions_token_hash_unique').on(table.tokenHash),
  expiresAtIdx: index('admin_sessions_expires_at_idx').on(table.expiresAt),
  revokedAtIdx: index('admin_sessions_revoked_at_idx').on(table.revokedAt),
}));

export const adminTotpConfigs = sqliteTable('admin_totp_configs', {
  id: text('id').primaryKey(),
  encryptedSecret: text('encrypted_secret').notNull(),
  recoveryCodeHashes: text('recovery_code_hashes').notNull(),
  lastAcceptedCounter: integer('last_accepted_counter'),
  enabledAt: text('enabled_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
});

export const adminAuthChallenges = sqliteTable('admin_auth_challenges', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  tokenHash: text('token_hash').notNull(),
  encryptedPayload: text('encrypted_payload'),
  clientIp: text('client_ip'),
  userAgent: text('user_agent'),
  attemptCount: integer('attempt_count').notNull().default(0),
  expiresAt: text('expires_at').notNull(),
  consumedAt: text('consumed_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenHashUnique: uniqueIndex('admin_auth_challenges_token_hash_unique').on(table.tokenHash),
  expiresAtIdx: index('admin_auth_challenges_expires_at_idx').on(table.expiresAt),
  consumedAtIdx: index('admin_auth_challenges_consumed_at_idx').on(table.consumedAt),
}));

export const adminSnapshots = sqliteTable('admin_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  namespace: text('namespace').notNull(),
  snapshotKey: text('snapshot_key').notNull(),
  payload: text('payload').notNull(),
  generatedAt: text('generated_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  staleUntil: text('stale_until').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  namespaceKeyUnique: uniqueIndex('admin_snapshots_namespace_key_unique').on(table.namespace, table.snapshotKey),
  expiresAtIdx: index('admin_snapshots_expires_at_idx').on(table.expiresAt),
  staleUntilIdx: index('admin_snapshots_stale_until_idx').on(table.staleUntil),
}));

export const analyticsProjectionCheckpoints = sqliteTable('analytics_projection_checkpoints', {
  projectorKey: text('projector_key').primaryKey(),
  timeZone: text('time_zone').notNull().default('Local'),
  lastProxyLogId: integer('last_proxy_log_id').notNull().default(0),
  watermarkCreatedAt: text('watermark_created_at'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  recomputeFromId: integer('recompute_from_id'),
  recomputeRequestedAt: text('recompute_requested_at'),
  recomputeReason: text('recompute_reason'),
  recomputeStartedAt: text('recompute_started_at'),
  recomputeCompletedAt: text('recompute_completed_at'),
  lastProjectedAt: text('last_projected_at'),
  lastSuccessfulAt: text('last_successful_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  recomputeFromIdIdx: index('analytics_projection_checkpoints_recompute_from_id_idx').on(table.recomputeFromId),
  leaseExpiresAtIdx: index('analytics_projection_checkpoints_lease_expires_at_idx').on(table.leaseExpiresAt),
}));

/** Immutable audit trail for local NDJSON archive batches. */
export const archiveManifests = sqliteTable('archive_manifests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  resource: text('resource').notNull(),
  status: text('status').notNull().default('writing'), // 'writing' | 'committed' | 'source_deleted' | 'failed'
  schemaVersion: integer('schema_version').notNull().default(1),
  rowCount: integer('row_count').notNull().default(0),
  minId: integer('min_id'),
  maxId: integer('max_id'),
  minCreatedAt: text('min_created_at'),
  maxCreatedAt: text('max_created_at'),
  storageDriver: text('storage_driver').notNull().default('local'),
  objectKey: text('object_key'),
  byteSize: integer('byte_size'),
  sha256: text('sha256'),
  startedAt: text('started_at').default(sql`(datetime('now'))`),
  committedAt: text('committed_at'),
  deletedAt: text('deleted_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  resourceCreatedIdx: index('archive_manifests_resource_created_at_idx').on(table.resource, table.createdAt),
  statusUpdatedIdx: index('archive_manifests_status_updated_at_idx').on(table.status, table.updatedAt),
  objectKeyUnique: uniqueIndex('archive_manifests_object_key_unique').on(table.objectKey),
  maxIdIdx: index('archive_manifests_max_id_idx').on(table.resource, table.maxId),
}));

export const siteDayUsage = sqliteTable('site_day_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  localDay: text('local_day').notNull(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  totalCalls: integer('total_calls').notNull().default(0),
  successCalls: integer('success_calls').notNull().default(0),
  failedCalls: integer('failed_calls').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  totalSummarySpend: real('total_summary_spend').notNull().default(0),
  totalSiteSpend: real('total_site_spend').notNull().default(0),
  totalLatencyMs: integer('total_latency_ms').notNull().default(0),
  latencyCount: integer('latency_count').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  daySiteUnique: uniqueIndex('site_day_usage_day_site_unique').on(table.localDay, table.siteId),
  dayIdx: index('site_day_usage_day_idx').on(table.localDay),
  siteIdx: index('site_day_usage_site_id_idx').on(table.siteId),
  nonNegative: check(
    'site_day_usage_non_negative',
    sql`${table.totalCalls} >= 0 and ${table.successCalls} >= 0 and ${table.failedCalls} >= 0 and ${table.totalTokens} >= 0 and ${table.totalSummarySpend} >= 0 and ${table.totalSiteSpend} >= 0 and ${table.totalLatencyMs} >= 0 and ${table.latencyCount} >= 0`,
  ),
}));

export const siteHourUsage = sqliteTable('site_hour_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bucketStartUtc: text('bucket_start_utc').notNull(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  totalCalls: integer('total_calls').notNull().default(0),
  successCalls: integer('success_calls').notNull().default(0),
  failedCalls: integer('failed_calls').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  totalSummarySpend: real('total_summary_spend').notNull().default(0),
  totalSiteSpend: real('total_site_spend').notNull().default(0),
  totalLatencyMs: integer('total_latency_ms').notNull().default(0),
  latencyCount: integer('latency_count').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  hourSiteUnique: uniqueIndex('site_hour_usage_hour_site_unique').on(table.bucketStartUtc, table.siteId),
  hourIdx: index('site_hour_usage_hour_idx').on(table.bucketStartUtc),
  siteIdx: index('site_hour_usage_site_id_idx').on(table.siteId),
  nonNegative: check(
    'site_hour_usage_non_negative',
    sql`${table.totalCalls} >= 0 and ${table.successCalls} >= 0 and ${table.failedCalls} >= 0 and ${table.totalTokens} >= 0 and ${table.totalSummarySpend} >= 0 and ${table.totalSiteSpend} >= 0 and ${table.totalLatencyMs} >= 0 and ${table.latencyCount} >= 0`,
  ),
}));

export const modelDayUsage = sqliteTable('model_day_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  localDay: text('local_day').notNull(),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  totalCalls: integer('total_calls').notNull().default(0),
  successCalls: integer('success_calls').notNull().default(0),
  failedCalls: integer('failed_calls').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  totalSpend: real('total_spend').notNull().default(0),
  totalLatencyMs: integer('total_latency_ms').notNull().default(0),
  latencyCount: integer('latency_count').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  daySiteModelUnique: uniqueIndex('model_day_usage_day_site_model_unique').on(table.localDay, table.siteId, table.model),
  dayIdx: index('model_day_usage_day_idx').on(table.localDay),
  siteIdx: index('model_day_usage_site_id_idx').on(table.siteId),
  modelIdx: index('model_day_usage_model_idx').on(table.model),
  nonNegative: check(
    'model_day_usage_non_negative',
    sql`${table.totalCalls} >= 0 and ${table.successCalls} >= 0 and ${table.failedCalls} >= 0 and ${table.totalTokens} >= 0 and ${table.totalSpend} >= 0 and ${table.totalLatencyMs} >= 0 and ${table.latencyCount} >= 0`,
  ),
}));

export const downstreamKeyDayUsage = sqliteTable('downstream_key_day_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  localDay: text('local_day').notNull(),
  downstreamApiKeyId: integer('downstream_api_key_id').notNull(),
  totalCalls: integer('total_calls').notNull().default(0),
  successCalls: integer('success_calls').notNull().default(0),
  failedCalls: integer('failed_calls').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  totalCost: real('total_cost').notNull().default(0),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  dayKeyUnique: uniqueIndex('downstream_key_day_usage_day_key_unique')
    .on(table.localDay, table.downstreamApiKeyId),
  dayIdx: index('downstream_key_day_usage_day_idx').on(table.localDay),
  keyIdx: index('downstream_key_day_usage_key_id_idx').on(table.downstreamApiKeyId),
  nonNegative: check(
    'downstream_key_day_usage_non_negative',
    sql`${table.totalCalls} >= 0 and ${table.successCalls} >= 0 and ${table.failedCalls} >= 0 and ${table.totalTokens} >= 0 and ${table.totalCost} >= 0`,
  ),
}));

export const downstreamApiKeys = sqliteTable('downstream_api_keys', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  key: text('key').notNull(),
  description: text('description'),
  groupName: text('group_name'),
  tags: text('tags'), // JSON array<string>
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  expiresAt: text('expires_at'),
  maxCost: real('max_cost'),
  usedCost: real('used_cost').default(0),
  maxRequests: integer('max_requests'),
  usedRequests: integer('used_requests').default(0),
  requestsPerMinute: integer('requests_per_minute'),
  maxConcurrency: integer('max_concurrency'),
  policyVersion: integer('policy_version').notNull().default(1),
  supportedModels: text('supported_models'), // JSON array<string>
  allowedRouteIds: text('allowed_route_ids'), // JSON array<number>
  siteWeightMultipliers: text('site_weight_multipliers'), // JSON object { [siteId]: multiplier }
  excludedSiteIds: text('excluded_site_ids'), // JSON array<number>
  allowedCredentialRefs: text('allowed_credential_refs'), // JSON array<DownstreamAllowedCredentialRef>
  excludedCredentialRefs: text('excluded_credential_refs'), // JSON array<DownstreamExcludedCredentialRef>
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  keyUnique: uniqueIndex('downstream_api_keys_key_unique').on(table.key),
  nameIdx: index('downstream_api_keys_name_idx').on(table.name),
  enabledIdx: index('downstream_api_keys_enabled_idx').on(table.enabled),
  expiresAtIdx: index('downstream_api_keys_expires_at_idx').on(table.expiresAt),
}));

export const downstreamApiKeyRateWindows = sqliteTable('downstream_api_key_rate_windows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  downstreamApiKeyId: integer('downstream_api_key_id').notNull().references(() => downstreamApiKeys.id, { onDelete: 'cascade' }),
  windowKind: text('window_kind').notNull(),
  windowStart: text('window_start').notNull(),
  reservedRequests: integer('reserved_requests').notNull().default(0),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  keyWindowUnique: uniqueIndex('downstream_api_key_rate_windows_key_window_unique')
    .on(table.downstreamApiKeyId, table.windowKind, table.windowStart),
  windowLookupIdx: index('downstream_api_key_rate_windows_window_lookup_idx')
    .on(table.windowKind, table.windowStart),
  keyUpdatedIdx: index('downstream_api_key_rate_windows_key_updated_idx')
    .on(table.downstreamApiKeyId, table.updatedAt),
}));

/** Declarative time-window limits for managed downstream keys. */
export const downstreamKeyLimitPolicies = sqliteTable('downstream_key_limit_policies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  downstreamApiKeyId: integer('downstream_api_key_id').notNull().references(() => downstreamApiKeys.id, { onDelete: 'cascade' }),
  metric: text('metric').notNull(), // 'requests' | 'input_tokens' | 'output_tokens' | 'total_tokens' | 'cost'
  scopeType: text('scope_type').notNull().default('key'), // 'key' | 'model' | 'site'
  scopeValue: text('scope_value'),
  windowType: text('window_type').notNull(), // 'fixed' | 'calendar_day' | 'calendar_month'
  windowSeconds: integer('window_seconds'),
  limitValue: real('limit_value').notNull(),
  burstValue: real('burst_value').notNull().default(0),
  enforcement: text('enforcement').notNull().default('hard'), // 'hard' | 'soft'
  warningThresholdsJson: text('warning_thresholds_json'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  keyMetricScopeWindowUnique: uniqueIndex('downstream_key_limit_policies_key_metric_scope_window_unique')
    .on(table.downstreamApiKeyId, table.metric, table.scopeType, table.scopeValue, table.windowType, table.windowSeconds),
  keyEnabledIdx: index('downstream_key_limit_policies_key_enabled_idx')
    .on(table.downstreamApiKeyId, table.enabled),
  metricWindowIdx: index('downstream_key_limit_policies_metric_window_idx')
    .on(table.metric, table.windowType),
}));

/** Current usage and reservations for one policy window. */
export const downstreamKeyUsageWindows = sqliteTable('downstream_key_usage_windows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  policyId: integer('policy_id').notNull().references(() => downstreamKeyLimitPolicies.id, { onDelete: 'cascade' }),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  usedValue: real('used_value').notNull().default(0),
  reservedValue: real('reserved_value').notNull().default(0),
  version: integer('version').notNull().default(0),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  policyWindowUnique: uniqueIndex('downstream_key_usage_windows_policy_window_unique')
    .on(table.policyId, table.windowStart),
  windowEndIdx: index('downstream_key_usage_windows_window_end_idx').on(table.windowEnd),
  policyUpdatedIdx: index('downstream_key_usage_windows_policy_updated_idx').on(table.policyId, table.updatedAt),
  nonNegative: check(
    'downstream_key_usage_windows_non_negative',
    sql`${table.usedValue} >= 0 and ${table.reservedValue} >= 0`,
  ),
}));

/** Durable request-level reservations so crashed workers can be recovered. */
export const downstreamKeyQuotaReservations = sqliteTable('downstream_key_quota_reservations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reservationToken: text('reservation_token').notNull(),
  downstreamApiKeyId: integer('downstream_api_key_id').notNull().references(() => downstreamApiKeys.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // 'pending' | 'settled' | 'released' | 'expired'
  amountJson: text('amount_json').notNull(),
  windowIdsJson: text('window_ids_json').notNull(),
  expiresAt: text('expires_at').notNull(),
  settledAt: text('settled_at'),
  releasedAt: text('released_at'),
  lastError: text('last_error'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  tokenUnique: uniqueIndex('downstream_key_quota_reservations_token_unique').on(table.reservationToken),
  statusExpiryIdx: index('downstream_key_quota_reservations_status_expiry_idx').on(table.status, table.expiresAt),
  keyCreatedIdx: index('downstream_key_quota_reservations_key_created_idx').on(table.downstreamApiKeyId, table.createdAt),
}));

export const downstreamApiKeyLeases = sqliteTable('downstream_api_key_leases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  downstreamApiKeyId: integer('downstream_api_key_id').notNull().references(() => downstreamApiKeys.id, { onDelete: 'cascade' }),
  leaseToken: text('lease_token').notNull(),
  slot: integer('slot').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  leaseTokenUnique: uniqueIndex('downstream_api_key_leases_token_unique').on(table.leaseToken),
  keySlotUnique: uniqueIndex('downstream_api_key_leases_key_slot_unique').on(table.downstreamApiKeyId, table.slot),
  keyIdIdx: index('downstream_api_key_leases_key_id_idx').on(table.downstreamApiKeyId),
  expiresAtIdx: index('downstream_api_key_leases_expires_at_idx').on(table.expiresAt),
  slotPositive: check('downstream_api_key_leases_slot_positive', sql`${table.slot} > 0`),
}));

export const siteAnnouncements = sqliteTable('site_announcements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  siteId: integer('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  sourceKey: text('source_key').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  level: text('level').notNull().default('info'),
  sourceUrl: text('source_url'),
  startsAt: text('starts_at'),
  endsAt: text('ends_at'),
  upstreamCreatedAt: text('upstream_created_at'),
  upstreamUpdatedAt: text('upstream_updated_at'),
  firstSeenAt: text('first_seen_at').default(sql`(datetime('now'))`),
  lastSeenAt: text('last_seen_at').default(sql`(datetime('now'))`),
  readAt: text('read_at'),
  dismissedAt: text('dismissed_at'),
  rawPayload: text('raw_payload'),
}, (table) => ({
  siteSourceKeyUnique: uniqueIndex('site_announcements_site_source_key_unique').on(table.siteId, table.sourceKey),
  siteIdFirstSeenAtIdx: index('site_announcements_site_id_first_seen_at_idx').on(table.siteId, table.firstSeenAt),
  readAtIdx: index('site_announcements_read_at_idx').on(table.readAt),
}));

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type').notNull(), // 'checkin' | 'balance' | 'token' | 'proxy' | 'status'
  title: text('title').notNull(),
  message: text('message'),
  level: text('level').notNull().default('info'), // 'info' | 'warning' | 'error'
  read: integer('read', { mode: 'boolean' }).default(false),
  relatedId: integer('related_id'),
  relatedType: text('related_type'), // 'account' | 'site' | 'route'
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  readCreatedIdx: index('events_read_created_at_idx').on(table.read, table.createdAt),
  typeCreatedIdx: index('events_type_created_at_idx').on(table.type, table.createdAt),
  createdAtIdx: index('events_created_at_idx').on(table.createdAt),
}));

/** Durable incident state, separate from notification delivery state. */
export const alertIncidents = sqliteTable('alert_incidents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fingerprint: text('fingerprint').notNull(),
  ruleKey: text('rule_key').notNull(),
  severity: text('severity').notNull().default('error'),
  status: text('status').notNull().default('open'), // 'open' | 'acknowledged' | 'resolved' | 'suppressed'
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  occurrenceCount: integer('occurrence_count').notNull().default(0),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  acknowledgedAt: text('acknowledged_at'),
  acknowledgedBy: text('acknowledged_by'),
  resolvedAt: text('resolved_at'),
  suppressedUntil: text('suppressed_until'),
  escalationStep: integer('escalation_step').notNull().default(0),
  nextEscalationAt: text('next_escalation_at'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastNotifiedAt: text('last_notified_at'),
  lastMessage: text('last_message'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  fingerprintUnique: uniqueIndex('alert_incidents_fingerprint_unique').on(table.fingerprint),
  statusEscalationIdx: index('alert_incidents_status_escalation_idx').on(table.status, table.nextEscalationAt),
  leaseExpiresAtIdx: index('alert_incidents_lease_expires_at_idx').on(table.leaseExpiresAt),
  ruleStatusIdx: index('alert_incidents_rule_status_idx').on(table.ruleKey, table.status),
  entityIdx: index('alert_incidents_entity_idx').on(table.entityType, table.entityId),
  lastSeenIdx: index('alert_incidents_last_seen_idx').on(table.lastSeenAt),
}));

export const alertOccurrences = sqliteTable('alert_occurrences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  incidentId: integer('incident_id').notNull().references(() => alertIncidents.id, { onDelete: 'cascade' }),
  observedAt: text('observed_at').notNull(),
  valueJson: text('value_json'),
  message: text('message'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  incidentObservedIdx: index('alert_occurrences_incident_observed_idx').on(table.incidentId, table.observedAt),
}));

export const alertPolicies = sqliteTable('alert_policies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ruleKey: text('rule_key').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  groupingWindowSec: integer('grouping_window_sec').notNull().default(300),
  stepsJson: text('steps_json').notNull(),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  ruleKeyUnique: uniqueIndex('alert_policies_rule_key_unique').on(table.ruleKey),
  enabledIdx: index('alert_policies_enabled_idx').on(table.enabled),
}));

export const notificationOutbox = sqliteTable('notification_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  notificationId: text('notification_id').notNull(),
  idempotencyKeyHash: text('idempotency_key_hash'),
  throttleSignature: text('throttle_signature'),
  channel: text('channel').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  level: text('level').notNull().default('info'),
  occurredAt: text('occurred_at').notNull(),
  deliveryPolicy: text('delivery_policy').notNull().default('prefer_delivery'),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: text('next_attempt_at'),
  leaseOwner: text('lease_owner'),
  leaseToken: text('lease_token'),
  leaseExpiresAt: text('lease_expires_at'),
  lastAttemptAt: text('last_attempt_at'),
  lastOutcome: text('last_outcome'),
  lastError: text('last_error'),
  deliveredAt: text('delivered_at'),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  notificationChannelUnique: uniqueIndex('notification_outbox_notification_channel_unique')
    .on(table.notificationId, table.channel),
  statusNextAttemptIdx: index('notification_outbox_status_next_attempt_idx')
    .on(table.status, table.nextAttemptAt),
  leaseExpiresAtIdx: index('notification_outbox_lease_expires_at_idx').on(table.leaseExpiresAt),
  idempotencyKeyHashUnique: uniqueIndex('notification_outbox_idempotency_key_hash_unique')
    .on(table.idempotencyKeyHash),
  createdAtIdx: index('notification_outbox_created_at_idx').on(table.createdAt),
}));

export const notificationThrottleStates = sqliteTable('notification_throttle_states', {
  signature: text('signature').primaryKey(),
  lastEnqueuedAt: text('last_enqueued_at').notNull(),
  suppressedCount: integer('suppressed_count').notNull().default(0),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  updatedAtIdx: index('notification_throttle_states_updated_at_idx').on(table.updatedAt),
}));
