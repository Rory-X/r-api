import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import {
  acquireDownstreamConcurrencyLease,
  authorizeDownstreamToken,
  consumeManagedKeyRequest,
  createInternalDownstreamPolicySnapshot,
  resolveDownstreamPolicySnapshot,
  reserveManagedKeyRequest,
  verifyDownstreamPolicySnapshotActive,
  type DownstreamPolicyActiveResult,
  type DownstreamPolicySnapshot,
} from '../services/downstreamApiKeyService.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY, type DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';
import {
  ADMIN_CSRF_HEADER_NAME,
  authenticateAdminSessionRequest,
  verifyAdminCredential,
  verifyAdminCsrfToken,
  type AdminSession,
} from '../services/adminAuthService.js';

export type AdminAuthContext =
  | { method: 'bearer'; session: null }
  | { method: 'session'; session: AdminSession };

export interface ProxyAuthContext {
  token: string;
  source: 'managed' | 'internal';
  keyId: number | null;
  keyName: string;
  policy: DownstreamRoutingPolicy;
  snapshot: DownstreamPolicySnapshot;
}

export interface ProxyResourceOwner {
  ownerType: 'managed_key' | 'internal_tester';
  ownerId: string;
}

const proxyAuthContextByRequest = new WeakMap<FastifyRequest, ProxyAuthContext>();
const proxyConcurrencyReleaseByRequest = new WeakMap<FastifyRequest, () => Promise<void>>();
const adminAuthContextByRequest = new WeakMap<FastifyRequest, AdminAuthContext>();
const PROXY_AUTH_HANDOFF_HEADER = 'x-metapi-internal-auth-handoff';
const PROXY_AUTH_HANDOFF_TTL_MS = 30_000;
const proxyAuthHandoffs = new Map<string, { context: ProxyAuthContext; expiresAtMs: number }>();
const ADMIN_BEARER_FAILURE_LIMIT = 10;
const ADMIN_BEARER_FAILURE_WINDOW_MS = 60_000;
const ADMIN_BEARER_FAILURE_MAX_CLIENTS = 10_000;
const adminBearerFailures = new Map<string, { count: number; resetAt: number }>();

function pruneExpiredProxyAuthHandoffs(nowMs = Date.now()): void {
  for (const [handoffId, handoff] of proxyAuthHandoffs) {
    if (handoff.expiresAtMs > nowMs) continue;
    proxyAuthHandoffs.delete(handoffId);
  }
}

function takeProxyAuthHandoff(request: FastifyRequest): ProxyAuthContext | null {
  const raw = request.headers[PROXY_AUTH_HANDOFF_HEADER];
  const handoffId = typeof raw === 'string' ? raw.trim() : '';
  if (!handoffId) return null;
  pruneExpiredProxyAuthHandoffs();
  const handoff = proxyAuthHandoffs.get(handoffId);
  if (!handoff) return null;
  proxyAuthHandoffs.delete(handoffId);
  return handoff.context;
}

export function createProxyAuthHandoffHeaders(context: ProxyAuthContext): Record<string, string> {
  pruneExpiredProxyAuthHandoffs();
  const handoffId = randomUUID();
  proxyAuthHandoffs.set(handoffId, {
    context,
    expiresAtMs: Date.now() + PROXY_AUTH_HANDOFF_TTL_MS,
  });
  return { [PROXY_AUTH_HANDOFF_HEADER]: handoffId };
}

export function createInternalProxyAuthHandoffHeaders(): Record<string, string> {
  const token = `internal-tester:${randomUUID()}`;
  const snapshot = createInternalDownstreamPolicySnapshot(token);
  return createProxyAuthHandoffHeaders({
    token,
    source: 'internal',
    keyId: null,
    keyName: 'internal-tester',
    policy: snapshot.policy,
    snapshot,
  });
}

type ParsedAllowlistEntry =
  | { kind: 'exact'; normalizedIp: string }
  | { kind: 'cidr'; network: number; mask: number };

function normalizeIp(rawIp: string | null | undefined): string {
  const ip = (rawIp || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length).trim();
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function parseIpv4Value(rawIp: string): number | null {
  const normalizedIp = normalizeIp(rawIp);
  if (isIP(normalizedIp) !== 4) return null;

  let value = 0;
  for (const part of normalizedIp.split('.')) {
    value = (value << 8) + Number(part);
  }

  return value >>> 0;
}

function parseAllowlistEntry(rawEntry: string): ParsedAllowlistEntry | null {
  const entry = (rawEntry || '').trim();
  if (!entry) return null;

  const slashIndex = entry.indexOf('/');
  if (slashIndex === -1) {
    const normalizedIp = normalizeIp(entry);
    return isIP(normalizedIp) > 0
      ? { kind: 'exact', normalizedIp }
      : null;
  }

  if (entry.indexOf('/', slashIndex + 1) !== -1) return null;

  const networkIp = normalizeIp(entry.slice(0, slashIndex));
  const prefixText = entry.slice(slashIndex + 1).trim();
  if (isIP(networkIp) !== 4 || !/^\d+$/.test(prefixText)) return null;

  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const networkValue = parseIpv4Value(networkIp);
  if (networkValue === null) return null;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return {
    kind: 'cidr',
    network: networkValue & mask,
    mask,
  };
}

export function findInvalidIpAllowlistEntries(allowlist: string[]): string[] {
  return allowlist.filter((item) => parseAllowlistEntry(item) === null);
}

export function extractClientIp(remoteIp: string | null | undefined): string {
  return normalizeIp(remoteIp);
}

export function isIpAllowed(clientIp: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const normalizedClientIp = normalizeIp(clientIp);
  if (!normalizedClientIp) return false;
  const clientIpv4Value = parseIpv4Value(normalizedClientIp);

  return allowlist.some((item) => {
    const entry = parseAllowlistEntry(item);
    if (!entry) return false;
    if (entry.kind === 'exact') return entry.normalizedIp === normalizedClientIp;
    if (clientIpv4Value === null) return false;
    return (clientIpv4Value & entry.mask) === entry.network;
  });
}

export function getAdminAuthContext(request: FastifyRequest): AdminAuthContext | null {
  return adminAuthContextByRequest.get(request) || null;
}

function readBearerCredential(request: FastifyRequest): string {
  const authorization = typeof request.headers.authorization === 'string'
    ? request.headers.authorization.trim()
    : '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() || '';
}

function readCsrfToken(request: FastifyRequest): string {
  const raw = request.headers[ADMIN_CSRF_HEADER_NAME];
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return typeof raw === 'string' ? raw.trim() : '';
}

function methodRequiresCsrf(method: string): boolean {
  const normalized = (method || '').trim().toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

function getAdminBearerFailureRetryAfter(clientIp: string, nowMs = Date.now()): number | null {
  const entry = adminBearerFailures.get(clientIp);
  if (!entry) return null;
  if (entry.resetAt <= nowMs) {
    adminBearerFailures.delete(clientIp);
    return null;
  }
  if (entry.count < ADMIN_BEARER_FAILURE_LIMIT) return null;
  return Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
}

function pruneAdminBearerFailures(nowMs: number): void {
  for (const [clientIp, entry] of adminBearerFailures) {
    if (entry.resetAt <= nowMs) adminBearerFailures.delete(clientIp);
  }
  while (adminBearerFailures.size >= ADMIN_BEARER_FAILURE_MAX_CLIENTS) {
    const oldestClientIp = adminBearerFailures.keys().next().value as string | undefined;
    if (!oldestClientIp) break;
    adminBearerFailures.delete(oldestClientIp);
  }
}

function recordAdminBearerFailure(clientIp: string, nowMs = Date.now()): void {
  pruneAdminBearerFailures(nowMs);
  const entry = adminBearerFailures.get(clientIp);
  if (!entry || entry.resetAt <= nowMs) {
    adminBearerFailures.set(clientIp, { count: 1, resetAt: nowMs + ADMIN_BEARER_FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function resetAdminBearerFailureStore(): void {
  adminBearerFailures.clear();
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const clientIp = extractClientIp(request.ip);
  if (!isIpAllowed(clientIp, config.adminIpAllowlist)) {
    reply.code(403).send({ error: 'IP not allowed' });
    return;
  }

  const bearerCredential = readBearerCredential(request);
  if (bearerCredential) {
    const retryAfter = getAdminBearerFailureRetryAfter(clientIp);
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter));
      reply.code(429).send({ error: 'Too many invalid admin credentials', code: 'admin_auth_rate_limited' });
      return;
    }
    if (!await verifyAdminCredential(bearerCredential)) {
      recordAdminBearerFailure(clientIp);
      reply.code(401).send({ error: 'Invalid admin credential', code: 'admin_auth_invalid' });
      return;
    }
    adminBearerFailures.delete(clientIp);
    adminAuthContextByRequest.set(request, { method: 'bearer', session: null });
    return;
  }

  const session = await authenticateAdminSessionRequest(request);
  if (!session) {
    reply.code(401).send({ error: 'Admin session required', code: 'admin_session_required' });
    return;
  }

  if (methodRequiresCsrf(request.method) && !verifyAdminCsrfToken(session, readCsrfToken(request))) {
    reply.code(403).send({ error: 'Invalid CSRF token', code: 'admin_csrf_invalid' });
    return;
  }

  adminAuthContextByRequest.set(request, { method: 'session', session });
}

export async function proxyAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const handedOffContext = takeProxyAuthHandoff(request);
  if (handedOffContext) {
    proxyAuthContextByRequest.set(request, handedOffContext);
    return;
  }

  const auth = typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : '';
  const apiKeyHeader = typeof request.headers['x-api-key'] === 'string'
    ? request.headers['x-api-key']
    : '';
  const googApiKeyHeader = typeof request.headers['x-goog-api-key'] === 'string'
    ? request.headers['x-goog-api-key']
    : '';
  const queryKey = (
    request.query
    && typeof request.query === 'object'
    && typeof (request.query as Record<string, unknown>).key === 'string'
  )
    ? String((request.query as Record<string, unknown>).key).trim()
    : '';
  const token = auth
    ? auth.replace(/^Bearer\s+/i, '').trim()
    : (apiKeyHeader.trim() || googApiKeyHeader.trim() || queryKey);

  if (!token) {
    reply.code(401).send({ error: 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter' });
    return;
  }

  const authResult = await authorizeDownstreamToken(token);
  if (!authResult.ok) {
    if (authResult.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(authResult.retryAfterSeconds));
    }
    reply.code(authResult.statusCode).send({
      error: authResult.error,
      reason: authResult.reason,
      ...(authResult.retryAfterSeconds !== undefined ? { retryAfterSeconds: authResult.retryAfterSeconds } : {}),
      ...(authResult.remaining !== undefined ? { remaining: authResult.remaining } : {}),
      ...(authResult.resetAt ? { resetAt: authResult.resetAt } : {}),
      ...(authResult.limit !== undefined ? { limit: authResult.limit } : {}),
      ...(authResult.metric ? { metric: authResult.metric } : {}),
    });
    return;
  }

  const snapshot = resolveDownstreamPolicySnapshot(authResult);
  const leaseResult = await acquireDownstreamConcurrencyLease(snapshot);
  if (!leaseResult.ok) {
    if ('retryAfterSeconds' in leaseResult) {
      reply.header('Retry-After', String(leaseResult.retryAfterSeconds));
    }
    reply.code(leaseResult.statusCode).send({ error: leaseResult.error });
    return;
  }

  const rateLimitResult = await reserveManagedKeyRequest(
    authResult.key.id,
    authResult.key.requestsPerMinute,
  );
  if (!rateLimitResult.ok) {
    await leaseResult.lease?.release();
    reply.header('Retry-After', String(rateLimitResult.retryAfterSeconds));
    reply.header('X-RateLimit-Limit', String(rateLimitResult.limit ?? authResult.key.requestsPerMinute));
    reply.header('X-RateLimit-Remaining', String(rateLimitResult.remaining));
    reply.header('X-RateLimit-Reset', rateLimitResult.resetAt);
    reply.code(rateLimitResult.statusCode).send({
      error: rateLimitResult.error,
      reason: rateLimitResult.reason,
      retryAfterSeconds: rateLimitResult.retryAfterSeconds,
      remaining: rateLimitResult.remaining,
      resetAt: rateLimitResult.resetAt,
    });
    return;
  }
  if (rateLimitResult.remaining !== null && rateLimitResult.resetAt) {
    reply.header('X-RateLimit-Limit', String(rateLimitResult.limit ?? authResult.key.requestsPerMinute));
    reply.header('X-RateLimit-Remaining', String(rateLimitResult.remaining));
    reply.header('X-RateLimit-Reset', rateLimitResult.resetAt);
    reply.header('RateLimit-Limit', String(rateLimitResult.limit ?? authResult.key.requestsPerMinute));
    reply.header('RateLimit-Remaining', String(rateLimitResult.remaining));
    reply.header('RateLimit-Reset', rateLimitResult.resetAt);
  }

  let released = false;
  const releaseConcurrencyLease = async () => {
    if (released) return;
    released = true;
    await leaseResult.lease?.release();
  };
  proxyConcurrencyReleaseByRequest.set(request, releaseConcurrencyLease);
  reply.raw.once('finish', () => {
    void releaseConcurrencyLease();
  });
  reply.raw.once('close', () => {
    void releaseConcurrencyLease();
  });
  request.raw.once('aborted', () => {
    void releaseConcurrencyLease();
  });

  try {
    await consumeManagedKeyRequest(authResult.key.id);
  } catch (error) {
    await releaseConcurrencyLease();
    throw error;
  }

  proxyAuthContextByRequest.set(request, {
    token: authResult.token,
    source: authResult.source,
    keyId: authResult.key.id,
    keyName: authResult.key.name,
    policy: snapshot.policy || EMPTY_DOWNSTREAM_ROUTING_POLICY,
    snapshot,
  });
}

export function getProxyAuthContext(request: FastifyRequest): ProxyAuthContext | null {
  return proxyAuthContextByRequest.get(request) || null;
}

export async function verifyProxyAuthContextActive(request: FastifyRequest): Promise<DownstreamPolicyActiveResult> {
  const auth = getProxyAuthContext(request);
  if (!auth) return { ok: true };
  return await verifyDownstreamPolicySnapshotActive(auth.snapshot);
}

export async function releaseProxyConcurrencyLease(request: FastifyRequest): Promise<void> {
  await proxyConcurrencyReleaseByRequest.get(request)?.();
}

export function getProxyResourceOwner(request: FastifyRequest): ProxyResourceOwner | null {
  const auth = getProxyAuthContext(request);
  if (!auth) return null;

  return auth.source === 'managed'
    ? { ownerType: 'managed_key', ownerId: String(auth.keyId) }
    : { ownerType: 'internal_tester', ownerId: 'admin' };
}
