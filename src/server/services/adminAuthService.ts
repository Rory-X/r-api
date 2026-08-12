import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { and, eq, isNull, lt, ne, or } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { formatUtcSqlDateTime, parseStoredUtcDateTime } from './localTimeService.js';

export const ADMIN_SESSION_COOKIE_NAME = 'metapi_admin_session';
export const ADMIN_CSRF_HEADER_NAME = 'x-metapi-csrf';
export const ADMIN_PASSWORD_HASH_SETTING_KEY = 'admin_password_hash';
export const LEGACY_ADMIN_TOKEN_SETTING_KEY = 'auth_token';

const ADMIN_SESSION_TOKEN_NAMESPACE = 'metapi-admin-session\0';
const ARGON2_MEMORY_COST_KIB = 19_456;
const ARGON2_TIME_COST = 2;
const ARGON2_PARALLELISM = 1;
const VERIFIED_CREDENTIAL_CACHE_TTL_MS = 30_000;

type AdminSessionRow = typeof schema.adminSessions.$inferSelect;

export type AdminSession = {
  id: string;
  csrfToken: string;
  expiresAt: string;
  lastSeenAt: string;
  secondFactorVerifiedAt: string | null;
  secondFactorVerified: boolean;
};

export type CreatedAdminSession = AdminSession & {
  token: string;
};

let credentialBootstrapInFlight: Promise<string> | null = null;
const verifiedCredentialCache = new Map<string, number>();

function parseSettingString(raw: string | null | undefined): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed.trim() : '';
  } catch {
    return value;
  }
}

function isArgon2idHash(value: string): boolean {
  return value.startsWith('$argon2id$');
}

async function getSettingString(key: string): Promise<string> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return parseSettingString(row?.value);
}

async function deleteSetting(key: string): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
}

export async function hashAdminCredential(value: string): Promise<string> {
  return await argon2.hash(value, {
    type: argon2.argon2id,
    memoryCost: ARGON2_MEMORY_COST_KIB,
    timeCost: ARGON2_TIME_COST,
    parallelism: ARGON2_PARALLELISM,
  });
}

async function bootstrapAdminCredentialHash(): Promise<string> {
  const storedHash = await getSettingString(ADMIN_PASSWORD_HASH_SETTING_KEY);
  if (isArgon2idHash(storedHash)) {
    return storedHash;
  }
  if (storedHash) {
    throw new Error('Stored administrator credential hash is not valid Argon2id');
  }

  const configuredHash = (config.authTokenHash || '').trim();
  if (configuredHash && !isArgon2idHash(configuredHash)) {
    throw new Error('AUTH_TOKEN_HASH must be an Argon2id encoded hash');
  }

  const legacyToken = await getSettingString(LEGACY_ADMIN_TOKEN_SETTING_KEY);
  if (
    !legacyToken
    && !config.adminCredentialBootstrapConfigured
    && config.adminCredentialBootstrapRequired
  ) {
    throw new Error(
      'Administrator credential is not initialized; set AUTH_TOKEN or AUTH_TOKEN_HASH for the first startup',
    );
  }
  const bootstrapToken = legacyToken || (config.authToken || '').trim();
  const nextHash = configuredHash || await hashAdminCredential(bootstrapToken);

  await upsertSetting(ADMIN_PASSWORD_HASH_SETTING_KEY, nextHash);
  await deleteSetting(LEGACY_ADMIN_TOKEN_SETTING_KEY);
  return nextHash;
}

export async function ensureAdminAuthReady(): Promise<string> {
  if (!credentialBootstrapInFlight) {
    credentialBootstrapInFlight = bootstrapAdminCredentialHash().finally(() => {
      credentialBootstrapInFlight = null;
    });
  }
  return await credentialBootstrapInFlight;
}

export async function verifyAdminCredential(value: string): Promise<boolean> {
  const credential = (value || '').trim();
  if (!credential) return false;
  const passwordHash = await ensureAdminAuthReady();
  const cacheKey = createHash('sha256')
    .update(passwordHash)
    .update('\0')
    .update(credential)
    .digest('hex');
  const nowMs = Date.now();
  const cachedUntil = verifiedCredentialCache.get(cacheKey) || 0;
  if (cachedUntil > nowMs) return true;
  try {
    const verified = await argon2.verify(passwordHash, credential);
    if (verified) {
      verifiedCredentialCache.clear();
      verifiedCredentialCache.set(cacheKey, nowMs + VERIFIED_CREDENTIAL_CACHE_TTL_MS);
    }
    return verified;
  } catch {
    return false;
  }
}

function hashSessionToken(token: string): string {
  return createHash('sha256')
    .update(ADMIN_SESSION_TOKEN_NAMESPACE)
    .update(token)
    .digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toPublicSession(row: AdminSessionRow): AdminSession {
  return {
    id: row.id,
    csrfToken: row.csrfToken,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    secondFactorVerifiedAt: row.secondFactorVerifiedAt,
    secondFactorVerified: !!row.secondFactorVerifiedAt,
  };
}

function isSessionActive(row: AdminSessionRow, nowMs: number): boolean {
  if (row.revokedAt) return false;
  const expiresAt = parseStoredUtcDateTime(row.expiresAt)?.getTime() ?? 0;
  return expiresAt > nowMs;
}

function readCookieHeader(rawHeader: string | undefined, name: string): string {
  if (!rawHeader) return '';
  for (const pair of rawHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key !== name) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return '';
}

export function getAdminSessionToken(request: FastifyRequest): string {
  const decoratedCookies = (request as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  const decoratedValue = decoratedCookies?.[ADMIN_SESSION_COOKIE_NAME];
  if (typeof decoratedValue === 'string' && decoratedValue.trim()) {
    return decoratedValue.trim();
  }
  return readCookieHeader(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME).trim();
}

export async function createAdminSession(input: {
  clientIp?: string | null;
  userAgent?: string | null;
  secondFactorVerifiedAt?: Date | null;
  now?: Date;
} = {}): Promise<CreatedAdminSession> {
  const now = input.now ?? new Date();
  const nowText = formatUtcSqlDateTime(now);
  const expiresAt = formatUtcSqlDateTime(new Date(now.getTime() + config.adminSessionTtlMs));
  const token = `mas_${randomBytes(32).toString('base64url')}`;
  const csrfToken = `mac_${randomBytes(24).toString('base64url')}`;
  const id = randomUUID();
  const secondFactorVerifiedAt = input.secondFactorVerifiedAt
    ? formatUtcSqlDateTime(input.secondFactorVerifiedAt)
    : null;

  await pruneAdminSessions(now);
  await db.insert(schema.adminSessions).values({
    id,
    tokenHash: hashSessionToken(token),
    csrfToken,
    clientIp: (input.clientIp || '').trim() || null,
    userAgent: (input.userAgent || '').trim().slice(0, 512) || null,
    secondFactorVerifiedAt,
    expiresAt,
    lastSeenAt: nowText,
    createdAt: nowText,
    updatedAt: nowText,
  }).run();

  return {
    id,
    token,
    csrfToken,
    expiresAt,
    lastSeenAt: nowText,
    secondFactorVerifiedAt,
    secondFactorVerified: !!secondFactorVerifiedAt,
  };
}

export async function authenticateAdminSessionToken(
  token: string,
  now = new Date(),
): Promise<AdminSession | null> {
  const normalized = (token || '').trim();
  if (!normalized) return null;

  const row = await db.select().from(schema.adminSessions)
    .where(eq(schema.adminSessions.tokenHash, hashSessionToken(normalized)))
    .get();
  if (!row || !isSessionActive(row, now.getTime())) return null;

  const lastSeenAtMs = parseStoredUtcDateTime(row.lastSeenAt)?.getTime() ?? 0;
  if (now.getTime() - lastSeenAtMs >= config.adminSessionTouchIntervalMs) {
    const nowText = formatUtcSqlDateTime(now);
    await db.update(schema.adminSessions)
      .set({ lastSeenAt: nowText, updatedAt: nowText })
      .where(and(eq(schema.adminSessions.id, row.id), isNull(schema.adminSessions.revokedAt)))
      .run();
    row.lastSeenAt = nowText;
  }

  return toPublicSession(row);
}

export async function authenticateAdminSessionRequest(
  request: FastifyRequest,
  now = new Date(),
): Promise<AdminSession | null> {
  return await authenticateAdminSessionToken(getAdminSessionToken(request), now);
}

export function verifyAdminCsrfToken(session: AdminSession, providedToken: string): boolean {
  const normalized = (providedToken || '').trim();
  return !!normalized && safeEqual(session.csrfToken, normalized);
}

export async function revokeAdminSession(sessionId: string, now = new Date()): Promise<void> {
  const nowText = formatUtcSqlDateTime(now);
  await db.update(schema.adminSessions)
    .set({ revokedAt: nowText, updatedAt: nowText })
    .where(and(eq(schema.adminSessions.id, sessionId), isNull(schema.adminSessions.revokedAt)))
    .run();
}

export async function revokeAllAdminSessions(now = new Date()): Promise<void> {
  const nowText = formatUtcSqlDateTime(now);
  await db.update(schema.adminSessions)
    .set({ revokedAt: nowText, updatedAt: nowText })
    .where(isNull(schema.adminSessions.revokedAt))
    .run();
}

export async function revokeAllAdminSessionsExcept(
  sessionId: string,
  now = new Date(),
): Promise<void> {
  const nowText = formatUtcSqlDateTime(now);
  await db.update(schema.adminSessions)
    .set({ revokedAt: nowText, updatedAt: nowText })
    .where(and(
      isNull(schema.adminSessions.revokedAt),
      ne(schema.adminSessions.id, sessionId),
    ))
    .run();
}

export async function setAdminSessionSecondFactorVerified(
  sessionId: string,
  verified: boolean,
  now = new Date(),
): Promise<boolean> {
  const nowText = formatUtcSqlDateTime(now);
  const result = await db.update(schema.adminSessions)
    .set({
      secondFactorVerifiedAt: verified ? nowText : null,
      updatedAt: nowText,
    })
    .where(and(
      eq(schema.adminSessions.id, sessionId),
      isNull(schema.adminSessions.revokedAt),
    ))
    .run();
  return Number(result?.changes || 0) > 0;
}

export async function replaceAdminCredential(value: string): Promise<void> {
  const passwordHash = await hashAdminCredential(value.trim());
  await upsertSetting(ADMIN_PASSWORD_HASH_SETTING_KEY, passwordHash);
  await deleteSetting(LEGACY_ADMIN_TOKEN_SETTING_KEY);
  verifiedCredentialCache.clear();
  await revokeAllAdminSessions();
}

export async function pruneAdminSessions(now = new Date()): Promise<void> {
  const nowText = formatUtcSqlDateTime(now);
  await db.delete(schema.adminSessions)
    .where(or(
      lt(schema.adminSessions.expiresAt, nowText),
      lt(schema.adminSessions.revokedAt, formatUtcSqlDateTime(new Date(now.getTime() - 24 * 60 * 60 * 1000))),
    ))
    .run();
}

function shouldUseSecureCookie(request: FastifyRequest): boolean {
  if (config.adminCookieSecure) return true;
  return request.protocol === 'https';
}

export function setAdminSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  session: CreatedAdminSession,
): void {
  reply.setCookie(ADMIN_SESSION_COOKIE_NAME, session.token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: shouldUseSecureCookie(request),
    maxAge: Math.max(1, Math.floor(config.adminSessionTtlMs / 1000)),
  });
}

export function clearAdminSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: shouldUseSecureCookie(request),
  });
}
