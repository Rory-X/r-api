import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

const ADMIN_TOTP_CONFIG_ID = 'primary';
const LOGIN_CHALLENGE_KIND = 'login_totp';
const SETUP_CHALLENGE_KIND = 'setup_totp';
const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SETUP_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ENCRYPTION_NAMESPACE = 'metapi-admin-totp-encryption\0';
const RECOVERY_HASH_NAMESPACE = 'metapi-admin-totp-recovery\0';
const CHALLENGE_TOKEN_NAMESPACE = 'metapi-admin-auth-challenge\0';

type TotpConfigRow = typeof schema.adminTotpConfigs.$inferSelect;
type AuthChallengeRow = typeof schema.adminAuthChallenges.$inferSelect;

export type AdminSecondFactorType = 'totp' | 'recovery_code';

export type AdminTotpStatus = {
  enabled: boolean;
  recoveryCodesRemaining: number;
  enabledAt: string | null;
};

export type AdminTotpSetup = {
  setupToken: string;
  secret: string;
  otpauthUrl: string;
  expiresAt: string;
};

export type AdminLoginTotpChallenge = {
  challengeToken: string;
  expiresAt: string;
};

export class AdminTotpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AdminTotpError';
  }
}

function affectedRows(result: unknown): number {
  const normalized = result as { changes?: unknown; rowCount?: unknown; affectedRows?: unknown } | null;
  return Number(normalized?.changes ?? normalized?.rowCount ?? normalized?.affectedRows ?? 0);
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function encryptionKey(): Buffer {
  const secret = (config.accountCredentialSecret || '').trim();
  if (!secret) throw new AdminTotpError('totp_encryption_unavailable', 'TOTP encryption secret is unavailable', 500);
  return createHash('sha256').update(ENCRYPTION_NAMESPACE).update(secret).digest();
}

function recoveryHashKey(): Buffer {
  const secret = (config.accountCredentialSecret || '').trim();
  if (!secret) throw new AdminTotpError('totp_encryption_unavailable', 'TOTP encryption secret is unavailable', 500);
  return createHash('sha256').update(RECOVERY_HASH_NAMESPACE).update(secret).digest();
}

function encryptPayload(payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptPayload(value: string): Record<string, unknown> {
  const [version, ivText, tagText, ciphertextText] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) {
    throw new AdminTotpError('totp_payload_invalid', 'Stored TOTP payload is invalid', 500);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextText, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid payload');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AdminTotpError) throw error;
    throw new AdminTotpError('totp_payload_decrypt_failed', 'Stored TOTP payload cannot be decrypted', 500);
  }
}

function hashChallengeToken(token: string): string {
  return createHash('sha256')
    .update(CHALLENGE_TOKEN_NAMESPACE)
    .update(token)
    .digest('hex');
}

function normalizeRecoveryCode(value: string): string {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code: string): string {
  return createHmac('sha256', recoveryHashKey())
    .update(normalizeRecoveryCode(code))
    .digest('hex');
}

function parseRecoveryCodeHashes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
      : [];
  } catch {
    return [];
  }
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(12);
  let value = '';
  for (let index = 0; index < bytes.length; index += 1) {
    value += RECOVERY_CODE_ALPHABET[bytes[index] % RECOVERY_CODE_ALPHABET.length];
  }
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

function buildTotp(secretBase32: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'r-api',
    label: 'administrator',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

function validateTotpCounter(secretBase32: string, code: string, now: Date): number | null {
  const normalized = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const totp = buildTotp(secretBase32);
  const delta = totp.validate({ token: normalized, timestamp: now.getTime(), window: 1 });
  if (delta === null) return null;
  return totp.counter({ timestamp: now.getTime() }) + delta;
}

async function getTotpConfig(): Promise<TotpConfigRow | null> {
  return await db.select().from(schema.adminTotpConfigs)
    .where(eq(schema.adminTotpConfigs.id, ADMIN_TOTP_CONFIG_ID))
    .get() || null;
}

function readSecret(row: TotpConfigRow): string {
  const payload = decryptPayload(row.encryptedSecret);
  const secret = typeof payload.secret === 'string' ? payload.secret.trim() : '';
  if (!secret) throw new AdminTotpError('totp_secret_invalid', 'Stored TOTP secret is invalid', 500);
  return secret;
}

async function consumeTotpCode(row: TotpConfigRow, code: string, now: Date): Promise<boolean> {
  const counter = validateTotpCounter(readSecret(row), code, now);
  if (counter === null) return false;
  const nowText = formatUtcSqlDateTime(now);
  const result = await db.update(schema.adminTotpConfigs)
    .set({ lastAcceptedCounter: counter, updatedAt: nowText })
    .where(and(
      eq(schema.adminTotpConfigs.id, ADMIN_TOTP_CONFIG_ID),
      or(
        isNull(schema.adminTotpConfigs.lastAcceptedCounter),
        lt(schema.adminTotpConfigs.lastAcceptedCounter, counter),
      ),
    ))
    .run();
  return affectedRows(result) === 1;
}

async function consumeRecoveryCode(row: TotpConfigRow, code: string, now: Date): Promise<number | null> {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return null;
  const candidateHash = hashRecoveryCode(normalized);
  const hashes = parseRecoveryCodeHashes(row.recoveryCodeHashes);
  const index = hashes.findIndex((hash) => safeEqual(hash, candidateHash));
  if (index < 0) return null;
  const nextHashes = hashes.filter((_, currentIndex) => currentIndex !== index);
  const result = await db.update(schema.adminTotpConfigs)
    .set({
      recoveryCodeHashes: JSON.stringify(nextHashes),
      updatedAt: formatUtcSqlDateTime(now),
    })
    .where(and(
      eq(schema.adminTotpConfigs.id, ADMIN_TOTP_CONFIG_ID),
      eq(schema.adminTotpConfigs.recoveryCodeHashes, row.recoveryCodeHashes),
    ))
    .run();
  return affectedRows(result) === 1 ? nextHashes.length : null;
}

export async function verifyAndConsumeAdminSecondFactor(
  code: string,
  now = new Date(),
): Promise<{ ok: true; type: AdminSecondFactorType; recoveryCodesRemaining: number } | { ok: false }> {
  const row = await getTotpConfig();
  if (!row) return { ok: false };
  if (await consumeTotpCode(row, code, now)) {
    return {
      ok: true,
      type: 'totp',
      recoveryCodesRemaining: parseRecoveryCodeHashes(row.recoveryCodeHashes).length,
    };
  }
  const recoveryCodesRemaining = await consumeRecoveryCode(row, code, now);
  return recoveryCodesRemaining === null
    ? { ok: false }
    : { ok: true, type: 'recovery_code', recoveryCodesRemaining };
}

export async function getAdminTotpStatus(): Promise<AdminTotpStatus> {
  const row = await getTotpConfig();
  return row
    ? {
      enabled: true,
      recoveryCodesRemaining: parseRecoveryCodeHashes(row.recoveryCodeHashes).length,
      enabledAt: row.enabledAt,
    }
    : { enabled: false, recoveryCodesRemaining: 0, enabledAt: null };
}

export async function isAdminTotpEnabled(): Promise<boolean> {
  return (await getAdminTotpStatus()).enabled;
}

export async function pruneAdminAuthChallenges(now = new Date()): Promise<void> {
  const nowText = formatUtcSqlDateTime(now);
  const consumedCutoff = formatUtcSqlDateTime(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  await db.delete(schema.adminAuthChallenges)
    .where(or(
      lt(schema.adminAuthChallenges.expiresAt, nowText),
      lt(schema.adminAuthChallenges.consumedAt, consumedCutoff),
    ))
    .run();
}

async function createChallenge(input: {
  kind: typeof LOGIN_CHALLENGE_KIND | typeof SETUP_CHALLENGE_KIND;
  payload?: Record<string, unknown> | null;
  clientIp?: string | null;
  userAgent?: string | null;
  ttlMs: number;
  now?: Date;
}): Promise<{ token: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  await pruneAdminAuthChallenges(now);
  if (input.kind === SETUP_CHALLENGE_KIND) {
    await db.delete(schema.adminAuthChallenges)
      .where(and(
        eq(schema.adminAuthChallenges.kind, SETUP_CHALLENGE_KIND),
        isNull(schema.adminAuthChallenges.consumedAt),
      ))
      .run();
  }
  const token = `mat_${randomBytes(32).toString('base64url')}`;
  const nowText = formatUtcSqlDateTime(now);
  const expiresAt = formatUtcSqlDateTime(new Date(now.getTime() + input.ttlMs));
  await db.insert(schema.adminAuthChallenges).values({
    id: randomUUID(),
    kind: input.kind,
    tokenHash: hashChallengeToken(token),
    encryptedPayload: input.payload ? encryptPayload(input.payload) : null,
    clientIp: (input.clientIp || '').trim() || null,
    userAgent: (input.userAgent || '').trim().slice(0, 512) || null,
    attemptCount: 0,
    expiresAt,
    createdAt: nowText,
    updatedAt: nowText,
  }).run();
  return { token, expiresAt };
}

async function readActiveChallenge(
  token: string,
  kind: typeof LOGIN_CHALLENGE_KIND | typeof SETUP_CHALLENGE_KIND,
  now: Date,
): Promise<AuthChallengeRow> {
  const row = await db.select().from(schema.adminAuthChallenges)
    .where(and(
      eq(schema.adminAuthChallenges.tokenHash, hashChallengeToken(String(token || '').trim())),
      eq(schema.adminAuthChallenges.kind, kind),
      isNull(schema.adminAuthChallenges.consumedAt),
      gt(schema.adminAuthChallenges.expiresAt, formatUtcSqlDateTime(now)),
    ))
    .get();
  if (!row || row.attemptCount >= CHALLENGE_MAX_ATTEMPTS) {
    throw new AdminTotpError('totp_challenge_invalid', '第二因素挑战已失效，请重新开始', 401);
  }
  return row;
}

async function recordChallengeFailure(row: AuthChallengeRow, now: Date): Promise<void> {
  await db.update(schema.adminAuthChallenges)
    .set({
      attemptCount: sql`${schema.adminAuthChallenges.attemptCount} + 1`,
      updatedAt: formatUtcSqlDateTime(now),
    })
    .where(and(
      eq(schema.adminAuthChallenges.id, row.id),
      isNull(schema.adminAuthChallenges.consumedAt),
    ))
    .run();
}

async function consumeChallenge(row: AuthChallengeRow, now: Date): Promise<void> {
  const nowText = formatUtcSqlDateTime(now);
  const result = await db.update(schema.adminAuthChallenges)
    .set({ consumedAt: nowText, updatedAt: nowText })
    .where(and(
      eq(schema.adminAuthChallenges.id, row.id),
      isNull(schema.adminAuthChallenges.consumedAt),
      gt(schema.adminAuthChallenges.expiresAt, nowText),
      lt(schema.adminAuthChallenges.attemptCount, CHALLENGE_MAX_ATTEMPTS),
    ))
    .run();
  if (affectedRows(result) !== 1) {
    throw new AdminTotpError('totp_challenge_consumed', '第二因素挑战已被使用，请重新开始', 409);
  }
}

function challengeBindingMatches(row: AuthChallengeRow, clientIp?: string | null, userAgent?: string | null): boolean {
  const expectedIp = row.clientIp || '';
  const expectedUserAgent = row.userAgent || '';
  return expectedIp === ((clientIp || '').trim())
    && expectedUserAgent === ((userAgent || '').trim().slice(0, 512));
}

export async function beginAdminTotpSetup(input: {
  sessionId: string;
  clientIp?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<AdminTotpSetup> {
  if (await isAdminTotpEnabled()) {
    throw new AdminTotpError('totp_already_enabled', '双重验证已启用', 409);
  }
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = buildTotp(secret.base32);
  const challenge = await createChallenge({
    kind: SETUP_CHALLENGE_KIND,
    payload: { secret: secret.base32, sessionId: input.sessionId },
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    ttlMs: SETUP_CHALLENGE_TTL_MS,
    now: input.now,
  });
  return {
    setupToken: challenge.token,
    secret: secret.base32,
    otpauthUrl: totp.toString(),
    expiresAt: challenge.expiresAt,
  };
}

export async function confirmAdminTotpSetup(
  setupToken: string,
  code: string,
  input: {
    sessionId: string;
    clientIp?: string | null;
    userAgent?: string | null;
    now?: Date;
  },
): Promise<{ recoveryCodes: string[]; recoveryCodesRemaining: number }> {
  const now = input.now ?? new Date();
  if (await isAdminTotpEnabled()) {
    throw new AdminTotpError('totp_already_enabled', '双重验证已启用', 409);
  }
  const challenge = await readActiveChallenge(setupToken, SETUP_CHALLENGE_KIND, now);
  if (!challengeBindingMatches(challenge, input.clientIp, input.userAgent)) {
    await recordChallengeFailure(challenge, now);
    throw new AdminTotpError('totp_challenge_binding_mismatch', '双重验证设置与当前客户端不匹配', 401);
  }
  const payload = challenge.encryptedPayload ? decryptPayload(challenge.encryptedPayload) : {};
  const secret = typeof payload.secret === 'string' ? payload.secret.trim() : '';
  const setupSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  if (!setupSessionId || setupSessionId !== input.sessionId) {
    await recordChallengeFailure(challenge, now);
    throw new AdminTotpError('totp_setup_session_mismatch', '双重验证设置会话已失效', 401);
  }
  const counter = secret ? validateTotpCounter(secret, code, now) : null;
  if (counter === null) {
    await recordChallengeFailure(challenge, now);
    throw new AdminTotpError('totp_code_invalid', '动态验证码无效', 401);
  }
  await consumeChallenge(challenge, now);
  const recovery = generateRecoveryCodes();
  const nowText = formatUtcSqlDateTime(now);
  await db.insert(schema.adminTotpConfigs).values({
    id: ADMIN_TOTP_CONFIG_ID,
    encryptedSecret: encryptPayload({ secret }),
    recoveryCodeHashes: JSON.stringify(recovery.hashes),
    lastAcceptedCounter: counter,
    enabledAt: nowText,
    createdAt: nowText,
    updatedAt: nowText,
  }).run();
  return { recoveryCodes: recovery.codes, recoveryCodesRemaining: recovery.codes.length };
}

export async function createAdminLoginTotpChallenge(input: {
  clientIp?: string | null;
  userAgent?: string | null;
  now?: Date;
} = {}): Promise<AdminLoginTotpChallenge> {
  if (!await isAdminTotpEnabled()) {
    throw new AdminTotpError('totp_not_enabled', '双重验证未启用', 409);
  }
  const challenge = await createChallenge({
    kind: LOGIN_CHALLENGE_KIND,
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    ttlMs: LOGIN_CHALLENGE_TTL_MS,
    now: input.now,
  });
  return { challengeToken: challenge.token, expiresAt: challenge.expiresAt };
}

export async function verifyAdminLoginTotpChallenge(input: {
  challengeToken: string;
  code: string;
  clientIp?: string | null;
  userAgent?: string | null;
  now?: Date;
}): Promise<{ type: AdminSecondFactorType; recoveryCodesRemaining: number }> {
  const now = input.now ?? new Date();
  const challenge = await readActiveChallenge(input.challengeToken, LOGIN_CHALLENGE_KIND, now);
  if (!challengeBindingMatches(challenge, input.clientIp, input.userAgent)) {
    await recordChallengeFailure(challenge, now);
    throw new AdminTotpError('totp_challenge_binding_mismatch', '第二因素挑战与当前客户端不匹配', 401);
  }
  const verified = await verifyAndConsumeAdminSecondFactor(input.code, now);
  if (!verified.ok) {
    await recordChallengeFailure(challenge, now);
    throw new AdminTotpError('totp_code_invalid', '动态验证码或恢复码无效', 401);
  }
  await consumeChallenge(challenge, now);
  return {
    type: verified.type,
    recoveryCodesRemaining: verified.recoveryCodesRemaining,
  };
}

export async function regenerateAdminRecoveryCodes(now = new Date()): Promise<string[]> {
  const row = await getTotpConfig();
  if (!row) throw new AdminTotpError('totp_not_enabled', '双重验证未启用', 409);
  const recovery = generateRecoveryCodes();
  await db.update(schema.adminTotpConfigs)
    .set({
      recoveryCodeHashes: JSON.stringify(recovery.hashes),
      updatedAt: formatUtcSqlDateTime(now),
    })
    .where(eq(schema.adminTotpConfigs.id, ADMIN_TOTP_CONFIG_ID))
    .run();
  return recovery.codes;
}

export async function disableAdminTotp(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(schema.adminAuthChallenges).run();
    await tx.delete(schema.adminTotpConfigs)
      .where(eq(schema.adminTotpConfigs.id, ADMIN_TOTP_CONFIG_ID))
      .run();
  });
}

export const __adminTotpTestUtils = {
  buildTotp,
  parseRecoveryCodeHashes,
};
