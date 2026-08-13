import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  snapshotBridgeContinuationPolicy,
  type BridgeContinuationPolicyInput,
  type BridgeContinuationPolicySnapshot,
} from './bridgeContinuationContract.js';

const GLOBAL_BRIDGE_CONTINUATION_SETTING_KEY = 'global_bridge_continuation_v1';

export const GLOBAL_BRIDGE_CONTINUATION_REQUESTED_BY = 'global:auto-continuation';
export const GLOBAL_BRIDGE_CONTINUATION_SINGLE_CREATE_ERROR = '全局自动续跑已开启，不能再为单个会话创建自动续跑事务';

export class GlobalBridgeContinuationConflictError extends Error {
  constructor() {
    super(GLOBAL_BRIDGE_CONTINUATION_SINGLE_CREATE_ERROR);
    this.name = 'GlobalBridgeContinuationConflictError';
  }
}

type StoredGlobalBridgeContinuationConfig = {
  version: 1;
  enabled: boolean;
  policy: BridgeContinuationPolicySnapshot;
  updatedAt: string;
};

export type GlobalBridgeContinuationConfig = Readonly<{
  enabled: boolean;
  policy: BridgeContinuationPolicySnapshot;
  updatedAt: string | null;
}>;

type SettingsReader = Pick<typeof db, 'select'>;

function defaultPolicy(nowMs = Date.now()): BridgeContinuationPolicySnapshot {
  return snapshotBridgeContinuationPolicy({ enabled: true }, nowMs);
}

function parseStoredConfig(raw: string | null | undefined): StoredGlobalBridgeContinuationConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGlobalBridgeContinuationConfig>;
    if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean' || !parsed.policy || typeof parsed.policy !== 'object') {
      return null;
    }
    return {
      version: 1,
      enabled: parsed.enabled,
      policy: parsed.policy,
      updatedAt: typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
        ? new Date(parsed.updatedAt).toISOString()
        : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export async function getGlobalBridgeContinuationConfig(
  executor: SettingsReader = db,
): Promise<GlobalBridgeContinuationConfig> {
  const row = await executor.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, GLOBAL_BRIDGE_CONTINUATION_SETTING_KEY))
    .get();
  const stored = parseStoredConfig(row?.value);
  if (!stored) {
    return Object.freeze({ enabled: false, policy: defaultPolicy(), updatedAt: null });
  }
  const capturedAtMs = Number.isFinite(Date.parse(stored.policy.capturedAt as string))
    ? Date.parse(stored.policy.capturedAt as string)
    : Date.parse(stored.updatedAt);
  return Object.freeze({
    enabled: stored.enabled,
    policy: snapshotBridgeContinuationPolicy({ ...stored.policy, enabled: true }, capturedAtMs),
    updatedAt: stored.updatedAt,
  });
}

export async function setGlobalBridgeContinuationConfig(input: {
  enabled: unknown;
  policy?: BridgeContinuationPolicyInput;
  now?: Date | number;
}): Promise<GlobalBridgeContinuationConfig> {
  const current = await getGlobalBridgeContinuationConfig();
  const now = input.now instanceof Date
    ? input.now
    : typeof input.now === 'number'
      ? new Date(input.now)
      : new Date();
  const nowIso = now.toISOString();
  const policy = snapshotBridgeContinuationPolicy({
    ...(input.policy || current.policy),
    enabled: true,
  }, now.getTime());
  const stored: StoredGlobalBridgeContinuationConfig = {
    version: 1,
    enabled: input.enabled === true,
    policy,
    updatedAt: nowIso,
  };
  await upsertSetting(GLOBAL_BRIDGE_CONTINUATION_SETTING_KEY, stored);
  return Object.freeze({ enabled: stored.enabled, policy, updatedAt: nowIso });
}

export async function assertSingleBridgeContinuationCreationAllowed(
  executor: SettingsReader = db,
): Promise<void> {
  if ((await getGlobalBridgeContinuationConfig(executor)).enabled) {
    throw new GlobalBridgeContinuationConflictError();
  }
}

export function isGlobalBridgeContinuationConflict(error: unknown): boolean {
  return error instanceof GlobalBridgeContinuationConflictError;
}
