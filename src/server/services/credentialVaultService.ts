import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lte, type SQL } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import {
  getSiteAdapterContract,
  type SiteCredentialKind,
} from './platforms/siteAdapterContract.js';

const CIPHER_VERSION = 'vault-v1';
const CIPHER_ALGORITHM = 'aes-256-gcm';
const MAX_SECRET_BYTES = 2 * 1024 * 1024;
const VALID_KINDS = new Set<CredentialVaultKind>([
  'api_key',
  'session_token',
  'cookie',
  'oauth_access_token',
  'oauth_refresh_token',
  'browser_storage',
  'integration_secret',
]);
const VALID_STATUSES = new Set(['active', 'disabled', 'revoked', 'expired']);
type DbExecutor = typeof db;

export type CredentialVaultStatus = 'active' | 'disabled' | 'revoked' | 'expired';

export type CredentialVaultMetadata = {
  origin?: string;
  username?: string;
  source?: 'manual' | 'browser' | 'oauth' | 'import';
  adapterPlatform?: string;
  browserTaskId?: string;
  label?: string;
  purpose?: string;
  adapterId?: string;
};

export type CredentialVaultKind = SiteCredentialKind | 'integration_secret';

export type CredentialVaultPublicItem = Omit<
  typeof schema.credentialVaultItems.$inferSelect,
  'ciphertext' | 'metadata'
> & {
  metadata: CredentialVaultMetadata | null;
};

export type StoreCredentialVaultInput = {
  siteId?: number | null;
  accountId?: number | null;
  name: string;
  kind: CredentialVaultKind;
  secret: string;
  metadata?: CredentialVaultMetadata | null;
  expiresAt?: string | null;
};

function buildKey(): Buffer {
  const secret = (config.accountCredentialSecret || '').trim()
    || (config.authToken || '').trim()
    || 'change-me-admin-token';
  return createHash('sha256').update(secret).digest();
}

function normalizeId(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function normalizeName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 160) throw new Error('凭证名称不能为空且不能超过 160 个字符');
  return name;
}

function normalizeSecret(value: unknown): string {
  if (typeof value !== 'string') throw new Error('凭证内容必须是字符串');
  const secret = value.trim();
  if (!secret) throw new Error('凭证内容不能为空');
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error('凭证内容超过 2MB 限制');
  }
  return secret;
}

function normalizeKind(value: unknown): CredentialVaultKind {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!VALID_KINDS.has(kind as CredentialVaultKind)) {
    throw new Error('不支持的凭证类型: ' + (kind || 'empty'));
  }
  return kind as CredentialVaultKind;
}

function normalizeStatus(value: unknown): CredentialVaultStatus | null {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_STATUSES.has(status) ? status as CredentialVaultStatus : null;
}

function normalizeMetadata(input: CredentialVaultMetadata | null | undefined): string | null {
  if (!input) return null;
  const output: CredentialVaultMetadata = {};
  const stringKeys: Array<'origin' | 'username' | 'adapterPlatform' | 'browserTaskId' | 'label' | 'purpose' | 'adapterId'> = [
    'origin',
    'username',
    'adapterPlatform',
    'browserTaskId',
    'label',
  ];
  for (const key of stringKeys) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) output[key] = trimmed.slice(0, 512);
  }
  if (input.source === 'manual' || input.source === 'browser' || input.source === 'oauth' || input.source === 'import') {
    output.source = input.source;
  }
  return Object.keys(output).length > 0 ? JSON.stringify(output) : null;
}

function parseMetadata(raw: string | null | undefined): CredentialVaultMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CredentialVaultMetadata;
  } catch {
    return null;
  }
}

function encryptSecret(kind: CredentialVaultKind, secret: string): string {
  const key = buildKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(kind, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

function decryptSecret(kind: CredentialVaultKind, ciphertext: string): string | null {
  const parts = (ciphertext || '').split(':');
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) return null;
  try {
    const [, ivRaw, tagRaw, encryptedRaw] = parts;
    const decipher = createDecipheriv(
      CIPHER_ALGORITHM,
      buildKey(),
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAAD(Buffer.from(kind, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(encryptedRaw, 'base64url')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

function fingerprintSecret(kind: CredentialVaultKind, secret: string): string {
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(secret)
    .digest('hex');
}

function toPublicItem(row: typeof schema.credentialVaultItems.$inferSelect): CredentialVaultPublicItem {
  const { ciphertext: _ciphertext, metadata, ...publicRow } = row;
  return {
    ...publicRow,
    metadata: parseMetadata(metadata),
  };
}

function assertExpiration(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('expiresAt 必须是有效的 ISO 时间');
  return parsed.toISOString();
}

async function assertOwnerReferences(
  siteId: number | null,
  accountId: number | null,
  executor: DbExecutor = db,
): Promise<void> {
  if (siteId !== null) {
    const site = await executor.select({ id: schema.sites.id }).from(schema.sites)
      .where(eq(schema.sites.id, siteId))
      .get();
    if (!site) throw new Error('目标站点不存在');
  }
  if (accountId !== null) {
    const account = await executor.select({ id: schema.accounts.id }).from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!account) throw new Error('目标账号不存在');
  }
}

async function assertKindAllowed(
  siteId: number | null,
  kind: CredentialVaultKind,
  executor: DbExecutor = db,
): Promise<void> {
  if (siteId === null) {
    if (kind !== 'integration_secret') throw new Error('系统级凭证只允许 integration_secret 类型');
    return;
  }
  if (kind === 'integration_secret') throw new Error('integration_secret 不能关联 API 站点');
  const site = await executor.select({ platform: schema.sites.platform, url: schema.sites.url }).from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();
  if (!site) throw new Error('目标站点不存在');
  if (kind === 'api_key') {
    let hostname = '';
    try {
      hostname = new URL(site.url).hostname.toLowerCase();
    } catch { }
    if (
      hostname === 'api.openai.com'
      || hostname === 'api.anthropic.com'
      || hostname === 'generativelanguage.googleapis.com'
    ) {
      throw new Error('本项目不托管官方按量 API Key，请使用订阅 OAuth 或兼容中转站凭证');
    }
  }
  const contract = getSiteAdapterContract(site.platform);
  if (!contract.credentialKinds.includes(kind)) {
    throw new Error('站点 ' + site.platform + ' 不声明支持凭证类型 ' + kind);
  }
}

export async function storeCredentialVaultItemWithExecutor(
  input: StoreCredentialVaultInput,
  executor: DbExecutor = db,
  options: { allowSystemOwner?: boolean } = {},
): Promise<CredentialVaultPublicItem> {
  const siteId = input.siteId == null ? null : normalizeId(input.siteId);
  const accountId = input.accountId == null ? null : normalizeId(input.accountId);
  if (input.siteId != null && siteId === null) throw new Error('siteId 无效');
  if (input.accountId != null && accountId === null) throw new Error('accountId 无效');
  if (siteId === null && accountId === null && !options.allowSystemOwner) throw new Error('凭证必须关联站点或账号');

  const name = normalizeName(input.name);
  const kind = normalizeKind(input.kind);
  const secret = normalizeSecret(input.secret);
  const expiresAt = assertExpiration(input.expiresAt);
  await assertOwnerReferences(siteId, accountId, executor);
  await assertKindAllowed(siteId, kind, executor);

  const now = new Date().toISOString();
  const inserted = await insertAndGetById<typeof schema.credentialVaultItems.$inferSelect>({
    txDb: executor,
    table: schema.credentialVaultItems,
    idColumn: schema.credentialVaultItems.id,
    values: {
      siteId,
      accountId,
      name,
      kind,
      status: 'active',
      ciphertext: encryptSecret(kind, secret),
      fingerprint: fingerprintSecret(kind, secret),
      metadata: normalizeMetadata(input.metadata),
      expiresAt,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    insertErrorMessage: '凭证创建失败',
  });

  return toPublicItem(inserted);
}

export async function storeCredentialVaultItem(input: StoreCredentialVaultInput): Promise<CredentialVaultPublicItem> {
  return await storeCredentialVaultItemWithExecutor(input, db);
}

export async function storeSystemCredentialVaultItem(input: {
  name: string;
  secret: string;
  metadata?: CredentialVaultMetadata | null;
}, executor: DbExecutor = db): Promise<CredentialVaultPublicItem> {
  return await storeCredentialVaultItemWithExecutor({
    name: input.name,
    kind: 'integration_secret',
    secret: input.secret,
    metadata: input.metadata,
  }, executor, { allowSystemOwner: true });
}

export async function listCredentialVaultItems(options?: {
  siteId?: number;
  accountId?: number;
  status?: CredentialVaultStatus;
}): Promise<CredentialVaultPublicItem[]> {
  const conditions: SQL[] = [];
  if (options?.siteId !== undefined) conditions.push(eq(schema.credentialVaultItems.siteId, options.siteId));
  if (options?.accountId !== undefined) conditions.push(eq(schema.credentialVaultItems.accountId, options.accountId));
  if (options?.status) conditions.push(eq(schema.credentialVaultItems.status, options.status));

  const rows = await db.select().from(schema.credentialVaultItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.credentialVaultItems.createdAt), desc(schema.credentialVaultItems.id))
    .all();
  return rows.map(toPublicItem);
}

export async function findActiveCredentialVaultItemBySecret(input: {
  siteId?: number | null;
  accountId?: number | null;
  kind: CredentialVaultKind;
  secret: string;
}): Promise<CredentialVaultPublicItem | null> {
  const siteId = input.siteId == null ? null : normalizeId(input.siteId);
  const accountId = input.accountId == null ? null : normalizeId(input.accountId);
  const kind = normalizeKind(input.kind);
  const secret = normalizeSecret(input.secret);
  const conditions: SQL[] = [
    eq(schema.credentialVaultItems.kind, kind),
    eq(schema.credentialVaultItems.status, 'active'),
    eq(schema.credentialVaultItems.fingerprint, fingerprintSecret(kind, secret)),
  ];
  if (siteId !== null) conditions.push(eq(schema.credentialVaultItems.siteId, siteId));
  if (accountId !== null) conditions.push(eq(schema.credentialVaultItems.accountId, accountId));
  const row = await db.select().from(schema.credentialVaultItems)
    .where(and(...conditions))
    .get();
  return row ? toPublicItem(row) : null;
}

export async function resolveCredentialVaultSecret(id: number): Promise<{
  item: CredentialVaultPublicItem;
  secret: string;
} | null> {
  const row = await db.select().from(schema.credentialVaultItems)
    .where(eq(schema.credentialVaultItems.id, id))
    .get();
  if (!row || row.status !== 'active') return null;
  if (row.expiresAt && Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) <= Date.now()) {
    await db.update(schema.credentialVaultItems).set({
      status: 'expired',
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.credentialVaultItems.id, id)).run();
    return null;
  }
  const secret = decryptSecret(normalizeKind(row.kind), row.ciphertext);
  if (!secret) return null;

  const now = new Date().toISOString();
  await db.update(schema.credentialVaultItems).set({
    lastUsedAt: now,
    updatedAt: now,
  }).where(eq(schema.credentialVaultItems.id, id)).run();
  return {
    item: toPublicItem({ ...row, lastUsedAt: now, updatedAt: now }),
    secret,
  };
}

export async function revokeCredentialVaultItem(id: number): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.update(schema.credentialVaultItems).set({
    status: 'revoked',
    revokedAt: now,
    updatedAt: now,
  }).where(and(
    eq(schema.credentialVaultItems.id, id),
    inArray(schema.credentialVaultItems.status, ['active', 'disabled']),
  )).run();
  return Number(result?.changes || 0) > 0;
}

export async function setCredentialVaultItemEnabled(id: number, enabled: boolean): Promise<boolean> {
  const row = await db.select({ status: schema.credentialVaultItems.status })
    .from(schema.credentialVaultItems)
    .where(eq(schema.credentialVaultItems.id, id))
    .get();
  if (!row) return false;
  if (enabled && row.status !== 'disabled') return false;
  if (!enabled && row.status !== 'active') return false;
  const result = await db.update(schema.credentialVaultItems).set({
    status: enabled ? 'active' : 'disabled',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.credentialVaultItems.id, id)).run();
  return Number(result?.changes || 0) > 0;
}

export async function deleteCredentialVaultItem(id: number): Promise<boolean> {
  const result = await db.delete(schema.credentialVaultItems)
    .where(eq(schema.credentialVaultItems.id, id))
    .run();
  return Number(result?.changes || 0) > 0;
}

export async function expireCredentialVaultItems(now = new Date().toISOString()): Promise<number> {
  const result = await db.update(schema.credentialVaultItems).set({
    status: 'expired',
    updatedAt: now,
  }).where(and(
    eq(schema.credentialVaultItems.status, 'active'),
    lte(schema.credentialVaultItems.expiresAt, now),
  )).run();
  return Number(result?.changes || 0);
}

export const credentialVaultInternals = {
  encryptSecret,
  decryptSecret,
  fingerprintSecret,
  normalizeMetadata,
  parseMetadata,
};
