import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';

export const CREDENTIAL_LIFECYCLE_POLICY_SETTING_KEY = 'credential_lifecycle_policy_v1';

export type CredentialLifecyclePolicy = Readonly<{
  expiryWarningLeadMinutes: number;
  automaticRemindersEnabled: boolean;
  automaticRefreshEnabled: boolean;
  defaultRefreshLeadMinutes: number;
  providerRefreshLeadMinutes: Readonly<Record<string, number>>;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  retryMaxAttempts: number;
  ownerConflictRetrySeconds: number;
  schedulerIntervalSeconds: number;
  updatedAt: string | null;
}>;

export type CredentialLifecyclePolicyInput = Partial<Omit<CredentialLifecyclePolicy, 'updatedAt'>>;

const DEFAULT_PROVIDER_REFRESH_LEAD_MINUTES: Readonly<Record<string, number>> = Object.freeze({
  codex: 5 * 24 * 60,
  claude: 4 * 60,
  'gemini-cli': 5,
  antigravity: 5,
  sub2api: 2,
});

export const DEFAULT_CREDENTIAL_LIFECYCLE_POLICY: CredentialLifecyclePolicy = Object.freeze({
  expiryWarningLeadMinutes: 24 * 60,
  automaticRemindersEnabled: true,
  automaticRefreshEnabled: true,
  defaultRefreshLeadMinutes: 5,
  providerRefreshLeadMinutes: DEFAULT_PROVIDER_REFRESH_LEAD_MINUTES,
  retryBaseSeconds: 30,
  retryMaxSeconds: 30 * 60,
  retryMaxAttempts: 8,
  ownerConflictRetrySeconds: 15,
  schedulerIntervalSeconds: 60,
  updatedAt: null,
});

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeProvider(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeProviderLeadMinutes(
  value: unknown,
  fallback: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({ ...fallback });
  const normalized: Record<string, number> = {};
  for (const [rawProvider, rawMinutes] of Object.entries(value)) {
    const provider = normalizeProvider(rawProvider);
    if (!provider) continue;
    normalized[provider] = normalizeInteger(rawMinutes, fallback[provider] ?? 5, 1, 30 * 24 * 60);
  }
  return Object.freeze({ ...fallback, ...normalized });
}

function normalizePolicy(
  input: CredentialLifecyclePolicyInput | null | undefined,
  updatedAt: string | null,
): CredentialLifecyclePolicy {
  const fallback = DEFAULT_CREDENTIAL_LIFECYCLE_POLICY;
  const retryBaseSeconds = normalizeInteger(input?.retryBaseSeconds, fallback.retryBaseSeconds, 1, 24 * 60 * 60);
  const retryMaxSeconds = normalizeInteger(
    input?.retryMaxSeconds,
    fallback.retryMaxSeconds,
    retryBaseSeconds,
    7 * 24 * 60 * 60,
  );
  return Object.freeze({
    expiryWarningLeadMinutes: normalizeInteger(
      input?.expiryWarningLeadMinutes,
      fallback.expiryWarningLeadMinutes,
      5,
      30 * 24 * 60,
    ),
    automaticRemindersEnabled: normalizeBoolean(
      input?.automaticRemindersEnabled,
      fallback.automaticRemindersEnabled,
    ),
    automaticRefreshEnabled: normalizeBoolean(
      input?.automaticRefreshEnabled,
      fallback.automaticRefreshEnabled,
    ),
    defaultRefreshLeadMinutes: normalizeInteger(
      input?.defaultRefreshLeadMinutes,
      fallback.defaultRefreshLeadMinutes,
      1,
      30 * 24 * 60,
    ),
    providerRefreshLeadMinutes: normalizeProviderLeadMinutes(
      input?.providerRefreshLeadMinutes,
      fallback.providerRefreshLeadMinutes,
    ),
    retryBaseSeconds,
    retryMaxSeconds,
    retryMaxAttempts: normalizeInteger(input?.retryMaxAttempts, fallback.retryMaxAttempts, 1, 100),
    ownerConflictRetrySeconds: normalizeInteger(
      input?.ownerConflictRetrySeconds,
      fallback.ownerConflictRetrySeconds,
      1,
      60 * 60,
    ),
    schedulerIntervalSeconds: normalizeInteger(
      input?.schedulerIntervalSeconds,
      fallback.schedulerIntervalSeconds,
      15,
      60 * 60,
    ),
    updatedAt,
  });
}

function parseStoredPolicy(raw: string | null | undefined): CredentialLifecyclePolicy | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      policy?: CredentialLifecyclePolicyInput;
      updatedAt?: unknown;
    };
    if (parsed.version !== 1 || !parsed.policy || typeof parsed.policy !== 'object') return null;
    const updatedAt = typeof parsed.updatedAt === 'string' && Number.isFinite(Date.parse(parsed.updatedAt))
      ? new Date(parsed.updatedAt).toISOString()
      : null;
    return normalizePolicy(parsed.policy, updatedAt);
  } catch {
    return null;
  }
}

export async function getCredentialLifecyclePolicy(): Promise<CredentialLifecyclePolicy> {
  const row = await db.select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, CREDENTIAL_LIFECYCLE_POLICY_SETTING_KEY))
    .get();
  return parseStoredPolicy(row?.value) ?? DEFAULT_CREDENTIAL_LIFECYCLE_POLICY;
}

export async function setCredentialLifecyclePolicy(
  input: CredentialLifecyclePolicyInput,
  now = new Date(),
): Promise<CredentialLifecyclePolicy> {
  const current = await getCredentialLifecyclePolicy();
  const updatedAt = now.toISOString();
  const next = normalizePolicy({ ...current, ...input }, updatedAt);
  await upsertSetting(CREDENTIAL_LIFECYCLE_POLICY_SETTING_KEY, {
    version: 1,
    policy: {
      expiryWarningLeadMinutes: next.expiryWarningLeadMinutes,
      automaticRemindersEnabled: next.automaticRemindersEnabled,
      automaticRefreshEnabled: next.automaticRefreshEnabled,
      defaultRefreshLeadMinutes: next.defaultRefreshLeadMinutes,
      providerRefreshLeadMinutes: next.providerRefreshLeadMinutes,
      retryBaseSeconds: next.retryBaseSeconds,
      retryMaxSeconds: next.retryMaxSeconds,
      retryMaxAttempts: next.retryMaxAttempts,
      ownerConflictRetrySeconds: next.ownerConflictRetrySeconds,
      schedulerIntervalSeconds: next.schedulerIntervalSeconds,
    },
    updatedAt,
  });
  return next;
}

export function getCredentialRefreshLeadMs(
  policy: CredentialLifecyclePolicy,
  provider?: string | null,
): number {
  const normalized = normalizeProvider(provider);
  const minutes = policy.providerRefreshLeadMinutes[normalized] ?? policy.defaultRefreshLeadMinutes;
  return minutes * 60 * 1_000;
}

export const credentialLifecyclePolicyInternals = {
  normalizePolicy,
  parseStoredPolicy,
};
