import { and, eq } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../db/index.js';

export type ProxyModelCapabilityRef = {
  accountId: number;
  tokenId?: number | null;
  modelName: string;
};

export type ProxyModelCapabilityStatus = 'supported' | 'unsupported' | 'unknown';

export type ProxyModelCapabilityState = {
  status: ProxyModelCapabilityStatus;
  source: 'manual' | 'discovery' | 'runtime' | 'unknown';
  checkedAt: string | null;
};

type CachedCapabilityState = ProxyModelCapabilityState & {
  loadedAtMs: number;
};

const CAPABILITY_CACHE_TTL_MS = 15_000;
const capabilityCache = new Map<string, CachedCapabilityState>();

function normalizeId(value: number | null | undefined): number | null {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return null;
  return Math.trunc(value as number);
}

function normalizeModelName(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeCapabilityRef(ref: ProxyModelCapabilityRef): {
  accountId: number;
  tokenId: number | null;
  modelName: string;
} | null {
  const accountId = normalizeId(ref.accountId);
  const tokenId = normalizeId(ref.tokenId);
  const modelName = normalizeModelName(ref.modelName);
  if (!accountId || !modelName) return null;
  return { accountId, tokenId, modelName };
}

function buildCapabilityCacheKey(ref: ProxyModelCapabilityRef): string | null {
  const normalized = normalizeCapabilityRef(ref);
  if (!normalized) return null;
  return normalized.tokenId
    ? `token:${normalized.tokenId}:model:${normalized.modelName}`
    : `account:${normalized.accountId}:model:${normalized.modelName}`;
}

function toCapabilityStatus(available: boolean | null | undefined): ProxyModelCapabilityStatus {
  if (available === true) return 'supported';
  if (available === false) return 'unsupported';
  return 'unknown';
}

function rememberCapabilityState(
  ref: ProxyModelCapabilityRef,
  state: ProxyModelCapabilityState,
  nowMs = Date.now(),
): ProxyModelCapabilityState {
  const key = buildCapabilityCacheKey(ref);
  if (key) {
    capabilityCache.set(key, {
      ...state,
      loadedAtMs: nowMs,
    });
  }
  return state;
}

export function peekProxyModelCapability(
  ref: ProxyModelCapabilityRef,
  nowMs = Date.now(),
): ProxyModelCapabilityState | null {
  const key = buildCapabilityCacheKey(ref);
  if (!key) return null;
  const cached = capabilityCache.get(key);
  if (!cached) return null;
  if ((nowMs - cached.loadedAtMs) >= CAPABILITY_CACHE_TTL_MS) {
    capabilityCache.delete(key);
    return null;
  }
  return {
    status: cached.status,
    source: cached.source,
    checkedAt: cached.checkedAt,
  };
}

export async function getProxyModelCapability(
  ref: ProxyModelCapabilityRef,
  nowMs = Date.now(),
): Promise<ProxyModelCapabilityState> {
  const normalized = normalizeCapabilityRef(ref);
  if (!normalized) {
    return {
      status: 'unknown',
      source: 'unknown',
      checkedAt: null,
    };
  }

  const cached = peekProxyModelCapability(normalized, nowMs);
  if (cached) return cached;

  if (normalized.tokenId) {
    const row = await db.select({
      available: schema.tokenModelAvailability.available,
      checkedAt: schema.tokenModelAvailability.checkedAt,
    }).from(schema.tokenModelAvailability)
      .where(and(
        eq(schema.tokenModelAvailability.tokenId, normalized.tokenId),
        eq(schema.tokenModelAvailability.modelName, normalized.modelName),
      ))
      .get();
    return rememberCapabilityState(normalized, {
      status: toCapabilityStatus(row?.available),
      source: row ? 'discovery' : 'unknown',
      checkedAt: row?.checkedAt ?? null,
    }, nowMs);
  }

  const row = await db.select({
    available: schema.modelAvailability.available,
    isManual: schema.modelAvailability.isManual,
    checkedAt: schema.modelAvailability.checkedAt,
  }).from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, normalized.accountId),
      eq(schema.modelAvailability.modelName, normalized.modelName),
    ))
    .get();
  return rememberCapabilityState(normalized, {
    status: toCapabilityStatus(row?.available),
    source: row?.isManual ? 'manual' : (row ? 'discovery' : 'unknown'),
    checkedAt: row?.checkedAt ?? null,
  }, nowMs);
}

async function upsertTokenCapability(
  ref: { tokenId: number; modelName: string },
  available: boolean,
  checkedAt: string,
): Promise<void> {
  const values = {
    tokenId: ref.tokenId,
    modelName: ref.modelName,
    available,
    latencyMs: null,
    checkedAt,
  };
  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.tokenModelAvailability).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          available,
          latencyMs: null,
          checkedAt,
        },
      })
      .run();
    return;
  }
  await (db.insert(schema.tokenModelAvailability).values(values) as any)
    .onConflictDoUpdate({
      target: [
        schema.tokenModelAvailability.tokenId,
        schema.tokenModelAvailability.modelName,
      ],
      set: {
        available,
        latencyMs: null,
        checkedAt,
      },
    })
    .run();
}

async function upsertAccountCapability(
  ref: { accountId: number; modelName: string },
  available: boolean,
  checkedAt: string,
): Promise<void> {
  const existing = await db.select({
    id: schema.modelAvailability.id,
    isManual: schema.modelAvailability.isManual,
  }).from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, ref.accountId),
      eq(schema.modelAvailability.modelName, ref.modelName),
    ))
    .get();
  if (existing?.isManual) return;

  const values = {
    accountId: ref.accountId,
    modelName: ref.modelName,
    available,
    isManual: false,
    latencyMs: null,
    checkedAt,
  };
  if (runtimeDbDialect === 'mysql') {
    await (db.insert(schema.modelAvailability).values(values) as any)
      .onDuplicateKeyUpdate({
        set: {
          available,
          isManual: false,
          latencyMs: null,
          checkedAt,
        },
      })
      .run();
    return;
  }
  await (db.insert(schema.modelAvailability).values(values) as any)
    .onConflictDoUpdate({
      target: [
        schema.modelAvailability.accountId,
        schema.modelAvailability.modelName,
      ],
      set: {
        available,
        isManual: false,
        latencyMs: null,
        checkedAt,
      },
    })
    .run();
}

export async function recordProxyModelCapabilityFailure(
  ref: ProxyModelCapabilityRef,
  checkedAt = new Date().toISOString(),
): Promise<ProxyModelCapabilityState> {
  const normalized = normalizeCapabilityRef(ref);
  if (!normalized) {
    return {
      status: 'unknown',
      source: 'unknown',
      checkedAt: null,
    };
  }

  if (!normalized.tokenId) {
    const current = await getProxyModelCapability(normalized);
    if (current.source === 'manual') return current;
  }

  if (normalized.tokenId) {
    await upsertTokenCapability({
      tokenId: normalized.tokenId,
      modelName: normalized.modelName,
    }, false, checkedAt);
  } else {
    await upsertAccountCapability({
      accountId: normalized.accountId,
      modelName: normalized.modelName,
    }, false, checkedAt);
  }

  return rememberCapabilityState(normalized, {
    status: 'unsupported',
    source: 'runtime',
    checkedAt,
  });
}

export async function recordProxyModelCapabilitySuccess(
  ref: ProxyModelCapabilityRef,
  checkedAt = new Date().toISOString(),
): Promise<ProxyModelCapabilityState> {
  const normalized = normalizeCapabilityRef(ref);
  if (!normalized) {
    return {
      status: 'unknown',
      source: 'unknown',
      checkedAt: null,
    };
  }

  const current = await getProxyModelCapability(normalized);
  if (current.source === 'manual') return current;
  if (current.status === 'unknown') {
    return rememberCapabilityState(normalized, {
      status: 'supported',
      source: 'runtime',
      checkedAt,
    });
  }

  if (normalized.tokenId) {
    await upsertTokenCapability({
      tokenId: normalized.tokenId,
      modelName: normalized.modelName,
    }, true, checkedAt);
  } else {
    await upsertAccountCapability({
      accountId: normalized.accountId,
      modelName: normalized.modelName,
    }, true, checkedAt);
  }

  return rememberCapabilityState(normalized, {
    status: 'supported',
    source: 'runtime',
    checkedAt,
  });
}

export function invalidateProxyModelCapabilityCache(ref?: ProxyModelCapabilityRef): void {
  if (!ref) {
    capabilityCache.clear();
    return;
  }
  const key = buildCapabilityCacheKey(ref);
  if (key) capabilityCache.delete(key);
}

export const __proxyModelCapabilityTestUtils = {
  buildCapabilityCacheKey,
  normalizeModelName,
};
