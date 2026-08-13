import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getAutoReloginConfig,
  getCredentialModeFromExtraConfig,
  getPlatformUserIdFromExtraConfig,
  getSub2ApiAuthFromExtraConfig,
} from './accountExtraConfig.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { credentialVaultInternals } from './credentialVaultService.js';

const TRANSFER_SCHEMA = 'r-api.credential-transfer';
const BACKUP_SCHEMA = 'r-api.credential-backup';
const EXPORT_VERSION = 1;
const CIPHER_ALGORITHM = 'aes-256-gcm';
const MIN_PASSPHRASE_LENGTH = 12;
const PORTABLE_CONFIRMATION = 'EXPORT_SECRETS';

export type CredentialExportMode = 'metadata_only' | 'encrypted_backup' | 'portable_secret';

export type CredentialExportItem = {
  source: { type: 'account' | 'vault_item'; id: number };
  site?: { id: number; name: string; url: string; platform: string };
  accountId?: number;
  provider?: string;
  kind: string;
  identity: Record<string, string | number>;
  status: string;
  expires_at?: string;
  fingerprint: string;
  recoverability: 'recoverable' | 'reauthorization_required' | 'metadata_only';
  secret_presence: Record<string, boolean>;
  credential?: Record<string, unknown>;
  metadata?: Record<string, unknown> | null;
};

export type PortableCredentialTransfer = {
  schema: typeof TRANSFER_SCHEMA;
  version: number;
  exported_at: string;
  mode: 'metadata_only' | 'portable_secret';
  item_count: number;
  items: Array<Record<string, unknown>>;
};

export type EncryptedCredentialBackup = {
  schema: typeof BACKUP_SCHEMA;
  version: number;
  exported_at: string;
  expires_at?: string;
  item_count: number;
  encryption: {
    kdf: 'scrypt';
    salt: string;
    cipher: typeof CIPHER_ALGORITHM;
    iv: string;
    auth_tag: string;
    ciphertext: string;
  };
};

export class CredentialExportError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'CredentialExportError';
  }
}

function normalizePositiveIds(value: unknown, label: string): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new CredentialExportError(`${label} 必须是数组`);
  const ids = value.map((entry) => {
    const parsed = Number(entry);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new CredentialExportError(`${label} 包含无效 id`);
    return Math.trunc(parsed);
  });
  return [...new Set(ids)];
}

function normalizeSiteId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new CredentialExportError('siteId 无效');
  return Math.trunc(parsed);
}

function normalizeOperatorId(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return 'webui:admin';
  if (normalized.length > 300 || normalized.includes('\0')) throw new CredentialExportError('operatorId 无效');
  return normalized;
}

function normalizeMode(value: unknown): CredentialExportMode {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'metadata_only' || normalized === 'encrypted_backup' || normalized === 'portable_secret') {
    return normalized;
  }
  throw new CredentialExportError('mode 无效');
}

function normalizePassphrase(value: unknown): string {
  const passphrase = typeof value === 'string' ? value : '';
  if (passphrase.length < MIN_PASSPHRASE_LENGTH || Buffer.byteLength(passphrase, 'utf8') > 1024) {
    throw new CredentialExportError(`备份口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符`);
  }
  return passphrase;
}

function normalizeExpirySeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new CredentialExportError('expiresInSec 无效');
  return Math.min(30 * 24 * 60 * 60, Math.trunc(parsed));
}

function sha256(namespace: string, value: string): string {
  return createHash('sha256').update(namespace).update('\0').update(value).digest('hex');
}

function siteRecord(site: typeof schema.sites.$inferSelect) {
  return { id: site.id, name: site.name, url: site.url, platform: site.platform };
}

function metadataFingerprint(type: string, id: number, fingerprint?: string | null): string {
  return fingerprint || sha256('credential-export-metadata', `${type}\0${id}`);
}

function buildAccountCredential(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
): { kind: string; provider?: string; expiresAt?: number; credential: Record<string, unknown>; secretPresence: Record<string, boolean> } {
  const oauth = getOauthInfoFromAccount(account);
  if (oauth) {
    return {
      kind: 'oauth_token_set',
      provider: oauth.provider,
      expiresAt: oauth.tokenExpiresAt,
      credential: {
        type: oauth.provider,
        access_token: account.accessToken,
        ...(oauth.refreshToken ? { refresh_token: oauth.refreshToken } : {}),
        ...(oauth.idToken ? { id_token: oauth.idToken } : {}),
        ...(oauth.email ? { email: oauth.email } : {}),
        ...(oauth.accountId ? { account_id: oauth.accountId } : {}),
        ...(oauth.accountKey ? { account_key: oauth.accountKey } : {}),
        ...(oauth.projectId ? { project_id: oauth.projectId } : {}),
        ...(oauth.tokenExpiresAt ? { expired: oauth.tokenExpiresAt } : {}),
        ...(account.status === 'disabled' ? { disabled: true } : {}),
      },
      secretPresence: {
        accessToken: !!account.accessToken,
        refreshToken: !!oauth.refreshToken,
        idToken: !!oauth.idToken,
      },
    };
  }

  const sub2api = site.platform.toLowerCase() === 'sub2api'
    ? getSub2ApiAuthFromExtraConfig(account.extraConfig)
    : null;
  if (sub2api) {
    return {
      kind: 'oauth_token_set',
      provider: 'sub2api',
      expiresAt: sub2api.tokenExpiresAt,
      credential: {
        type: 'sub2api-data',
        access_token: account.accessToken,
        refresh_token: sub2api.refreshToken,
        ...(sub2api.tokenExpiresAt ? { token_expires_at: sub2api.tokenExpiresAt } : {}),
        ...(getPlatformUserIdFromExtraConfig(account.extraConfig)
          ? { account_id: getPlatformUserIdFromExtraConfig(account.extraConfig) }
          : {}),
        ...(account.username ? { username: account.username } : {}),
        ...(account.status === 'disabled' ? { disabled: true } : {}),
      },
      secretPresence: { accessToken: !!account.accessToken, refreshToken: true },
    };
  }

  const credentialMode = getCredentialModeFromExtraConfig(account.extraConfig);
  if (credentialMode === 'apikey' || (!!account.apiToken && !account.accessToken)) {
    const apiKey = account.apiToken || account.accessToken;
    return {
      kind: 'api_key',
      provider: site.platform,
      credential: {
        type: site.platform,
        api_key: apiKey,
        ...(account.username ? { username: account.username } : {}),
        ...(getPlatformUserIdFromExtraConfig(account.extraConfig)
          ? { account_id: getPlatformUserIdFromExtraConfig(account.extraConfig) }
          : {}),
        ...(account.status === 'disabled' ? { disabled: true } : {}),
      },
      secretPresence: { apiKey: !!apiKey },
    };
  }

  const relogin = getAutoReloginConfig(account.extraConfig);
  return {
    kind: 'session_token',
    provider: site.platform,
    credential: {
      type: site.platform,
      access_token: account.accessToken,
      ...(account.username ? { username: account.username } : {}),
      ...(getPlatformUserIdFromExtraConfig(account.extraConfig)
        ? { account_id: getPlatformUserIdFromExtraConfig(account.extraConfig) }
        : {}),
      ...(account.status === 'disabled' ? { disabled: true } : {}),
    },
    secretPresence: { accessToken: !!account.accessToken, password: !!relogin },
  };
}

function buildVaultCredential(row: typeof schema.credentialVaultItems.$inferSelect, secret?: string): Record<string, unknown> | undefined {
  if (secret === undefined) return undefined;
  const base = {
    provider: credentialVaultInternals.parseMetadata(row.metadata)?.adapterPlatform,
    name: row.name,
    ...(row.expiresAt ? { expires_at: row.expiresAt } : {}),
    ...(row.status !== 'active' ? { disabled: true } : {}),
  };
  switch (row.kind) {
    case 'api_key': return { ...base, api_key: secret };
    case 'session_token': return { ...base, access_token: secret, type: base.provider || 'new-api' };
    case 'oauth_access_token': return { ...base, access_token: secret, type: base.provider || 'oauth' };
    case 'oauth_refresh_token': return { ...base, refresh_token: secret, type: base.provider || 'oauth' };
    case 'cookie':
    case 'browser_storage': return { ...base, cookie: secret };
    case 'integration_secret': return { ...base, api_key: secret, type: 'integration' };
    default: return { ...base, api_key: secret };
  }
}

async function collectExportItems(input: {
  includeSecrets: boolean;
  siteId?: number;
  accountIds?: number[];
  vaultItemIds?: number[];
}): Promise<CredentialExportItem[]> {
  const accountConditions: SQL[] = [];
  if (input.siteId) accountConditions.push(eq(schema.accounts.siteId, input.siteId));
  if (input.vaultItemIds !== undefined && input.accountIds === undefined) {
    accountConditions.push(eq(schema.accounts.id, -1));
  }
  if (input.accountIds) {
    accountConditions.push(input.accountIds.length > 0
      ? inArray(schema.accounts.id, input.accountIds)
      : eq(schema.accounts.id, -1));
  }
  const accountRows = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(accountConditions.length > 0 ? and(...accountConditions) : undefined)
    .orderBy(asc(schema.accounts.id)).all() as Array<{
      accounts: typeof schema.accounts.$inferSelect;
      sites: typeof schema.sites.$inferSelect;
    }>;

  const vaultConditions: SQL[] = [];
  if (input.siteId) vaultConditions.push(eq(schema.credentialVaultItems.siteId, input.siteId));
  if (input.accountIds !== undefined && input.vaultItemIds === undefined) {
    vaultConditions.push(eq(schema.credentialVaultItems.id, -1));
  }
  if (input.vaultItemIds) {
    vaultConditions.push(input.vaultItemIds.length > 0
      ? inArray(schema.credentialVaultItems.id, input.vaultItemIds)
      : eq(schema.credentialVaultItems.id, -1));
  }
  const vaultRows = await db.select().from(schema.credentialVaultItems)
    .where(vaultConditions.length > 0 ? and(...vaultConditions) : undefined)
    .orderBy(asc(schema.credentialVaultItems.id)).all() as Array<typeof schema.credentialVaultItems.$inferSelect>;
  const siteIds: number[] = [...new Set(
    vaultRows.map((row) => row.siteId).filter((id): id is number => !!id),
  )];
  const vaultSites = siteIds.length > 0
    ? await db.select().from(schema.sites).where(inArray(schema.sites.id, siteIds)).all() as Array<typeof schema.sites.$inferSelect>
    : [];
  const siteById = new Map<number, typeof schema.sites.$inferSelect>(
    vaultSites.map((site) => [site.id, site] as const),
  );

  const items: CredentialExportItem[] = [];
  for (const row of accountRows) {
    const built = buildAccountCredential(row.accounts, row.sites);
    const material = JSON.stringify(built.credential);
    const recoverable = Object.values(built.secretPresence).some(Boolean);
    items.push({
      source: { type: 'account', id: row.accounts.id },
      site: siteRecord(row.sites),
      accountId: row.accounts.id,
      ...(built.provider ? { provider: built.provider } : {}),
      kind: built.kind,
      identity: {
        ...(row.accounts.username ? { username: row.accounts.username } : {}),
        ...(row.accounts.oauthAccountKey ? { accountKey: row.accounts.oauthAccountKey } : {}),
        ...(row.accounts.oauthProjectId ? { projectId: row.accounts.oauthProjectId } : {}),
      },
      status: row.accounts.status || 'active',
      ...(built.expiresAt ? { expires_at: new Date(built.expiresAt).toISOString() } : {}),
      fingerprint: sha256('credential-export-account', material),
      recoverability: recoverable ? 'recoverable' : 'reauthorization_required',
      secret_presence: built.secretPresence,
      ...(input.includeSecrets ? { credential: built.credential } : {}),
    });
  }

  for (const row of vaultRows) {
    const metadata = credentialVaultInternals.parseMetadata(row.metadata);
    const secret = input.includeSecrets
      ? credentialVaultInternals.decryptSecret(row.kind as any, row.ciphertext) || undefined
      : undefined;
    const credential = buildVaultCredential(row, secret);
    items.push({
      source: { type: 'vault_item', id: row.id },
      ...(row.siteId && siteById.get(row.siteId) ? { site: siteRecord(siteById.get(row.siteId)!) } : {}),
      ...(row.accountId ? { accountId: row.accountId } : {}),
      ...(metadata?.adapterPlatform ? { provider: metadata.adapterPlatform } : {}),
      kind: row.kind,
      identity: {
        ...(metadata?.username ? { username: metadata.username } : {}),
        name: row.name,
      },
      status: row.status,
      ...(row.expiresAt ? { expires_at: row.expiresAt } : {}),
      fingerprint: metadataFingerprint('vault_item', row.id, row.fingerprint),
      recoverability: secret ? 'recoverable' : input.includeSecrets ? 'reauthorization_required' : 'recoverable',
      secret_presence: { secret: !!row.ciphertext },
      ...(credential ? { credential } : {}),
      metadata,
    });
  }
  return items;
}

function portableEnvelope(items: CredentialExportItem[], mode: 'metadata_only' | 'portable_secret', now: string): PortableCredentialTransfer {
  return {
    schema: TRANSFER_SCHEMA,
    version: EXPORT_VERSION,
    exported_at: now,
    mode,
    item_count: items.length,
    items: items.map((item) => mode === 'portable_secret'
      ? {
        ...(item.credential || {}),
        export_source: item.source,
        export_site: item.site,
        export_kind: item.kind,
        export_fingerprint: item.fingerprint,
      }
      : item),
  };
}

function encryptEnvelope(
  envelope: PortableCredentialTransfer,
  passphrase: string,
  now: string,
  expiresInSec?: number,
): EncryptedCredentialBackup {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(`${BACKUP_SCHEMA}\0${EXPORT_VERSION}`, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(envelope), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    schema: BACKUP_SCHEMA,
    version: EXPORT_VERSION,
    exported_at: now,
    ...(expiresInSec ? { expires_at: new Date(Date.parse(now) + expiresInSec * 1000).toISOString() } : {}),
    item_count: envelope.item_count,
    encryption: {
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      cipher: CIPHER_ALGORITHM,
      iv: iv.toString('base64url'),
      auth_tag: authTag.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function decryptCredentialBackup(input: unknown, passphraseInput: unknown): PortableCredentialTransfer {
  if (!isRecord(input) || input.schema !== BACKUP_SCHEMA || input.version !== EXPORT_VERSION) {
    throw new CredentialExportError('不是受支持的 r-api 加密凭证备份');
  }
  const expiresAt = typeof input.expires_at === 'string' ? Date.parse(input.expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    throw new CredentialExportError('加密凭证备份已过期');
  }
  const encryption = isRecord(input.encryption) ? input.encryption : null;
  if (!encryption
    || encryption.kdf !== 'scrypt'
    || encryption.cipher !== CIPHER_ALGORITHM
    || typeof encryption.salt !== 'string'
    || typeof encryption.iv !== 'string'
    || typeof encryption.auth_tag !== 'string'
    || typeof encryption.ciphertext !== 'string') {
    throw new CredentialExportError('加密凭证备份结构无效');
  }
  const passphrase = normalizePassphrase(passphraseInput);
  try {
    const key = scryptSync(passphrase, Buffer.from(encryption.salt, 'base64url'), 32);
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, Buffer.from(encryption.iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${BACKUP_SCHEMA}\0${EXPORT_VERSION}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(encryption.auth_tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryption.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as unknown;
    if (!isRecord(parsed) || parsed.schema !== TRANSFER_SCHEMA || parsed.version !== EXPORT_VERSION || !Array.isArray(parsed.items)) {
      throw new Error('invalid payload');
    }
    return parsed as PortableCredentialTransfer;
  } catch {
    throw new CredentialExportError('备份口令错误或文件已损坏');
  }
}

export function resolveCredentialImportPayload(input: unknown, passphrase?: unknown): unknown {
  return isRecord(input) && input.schema === BACKUP_SCHEMA
    ? decryptCredentialBackup(input, passphrase)
    : input;
}

async function writeExportEvent(input: {
  mode: CredentialExportMode;
  operatorId: string;
  siteId?: number;
  accountCount: number;
  vaultItemCount: number;
  itemCount: number;
}) {
  await db.insert(schema.events).values({
    type: 'credential_export',
    title: '凭证导出完成',
    message: JSON.stringify(input),
    level: input.mode === 'portable_secret' ? 'warning' : 'info',
    relatedId: input.siteId,
    relatedType: input.siteId ? 'site' : 'credential_export',
    createdAt: new Date().toISOString(),
  }).run();
}

export async function exportCredentials(input: {
  mode: unknown;
  siteId?: unknown;
  accountIds?: unknown;
  vaultItemIds?: unknown;
  passphrase?: unknown;
  confirmation?: unknown;
  expiresInSec?: unknown;
  operatorId?: unknown;
}): Promise<PortableCredentialTransfer | EncryptedCredentialBackup> {
  const mode = normalizeMode(input.mode);
  const siteId = normalizeSiteId(input.siteId);
  const accountIds = normalizePositiveIds(input.accountIds, 'accountIds');
  const vaultItemIds = normalizePositiveIds(input.vaultItemIds, 'vaultItemIds');
  const operatorId = normalizeOperatorId(input.operatorId);
  if (mode === 'portable_secret' && input.confirmation !== PORTABLE_CONFIRMATION) {
    throw new CredentialExportError(`portable_secret 必须确认 ${PORTABLE_CONFIRMATION}`);
  }
  const passphrase = mode === 'encrypted_backup' ? normalizePassphrase(input.passphrase) : undefined;
  const expiresInSec = mode === 'encrypted_backup' ? normalizeExpirySeconds(input.expiresInSec) : undefined;
  const now = new Date().toISOString();
  const items = await collectExportItems({
    includeSecrets: mode !== 'metadata_only',
    siteId,
    accountIds,
    vaultItemIds,
  });
  const accountCount = items.filter((item) => item.source.type === 'account').length;
  const vaultItemCount = items.length - accountCount;
  await writeExportEvent({ mode, operatorId, siteId, accountCount, vaultItemCount, itemCount: items.length });
  const envelope = portableEnvelope(items, mode === 'metadata_only' ? 'metadata_only' : 'portable_secret', now);
  return mode === 'encrypted_backup'
    ? encryptEnvelope(envelope, passphrase!, now, expiresInSec)
    : envelope;
}

export const credentialExportConstants = {
  TRANSFER_SCHEMA,
  BACKUP_SCHEMA,
  PORTABLE_CONFIRMATION,
};
