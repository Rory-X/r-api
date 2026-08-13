import { inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { getOauthInfoFromAccount, type OauthInfo } from './oauthAccount.js';

export const OFFICIAL_CREDENTIAL_SECRET_EXPORT_CONFIRMATION = 'EXPORT_OFFICIAL_SECRETS';

type JsonRecord = Record<string, unknown>;

export class OfficialCredentialExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficialCredentialExportError';
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function decodeJwtPayload(token?: string): JsonRecord | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function normalizeTimestampToIso(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  const numeric = asNumber(value);
  if (numeric === undefined) return undefined;
  const millis = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildSub2ApiCredentials(input: {
  accessToken: string;
  oauth: OauthInfo;
}): { credentials: JsonRecord; expiresAt?: string } {
  const idTokenPayload = decodeJwtPayload(input.oauth.idToken);
  const accessTokenPayload = decodeJwtPayload(input.accessToken);
  const idAuth = asRecord(idTokenPayload?.['https://api.openai.com/auth']);
  const accessAuth = asRecord(accessTokenPayload?.['https://api.openai.com/auth']);
  const credentials: JsonRecord = { access_token: input.accessToken };
  const expiresAt = normalizeTimestampToIso(accessTokenPayload?.exp)
    || normalizeTimestampToIso(input.oauth.tokenExpiresAt);
  if (expiresAt) credentials.expires_at = expiresAt;
  if (input.oauth.refreshToken) {
    credentials.refresh_token = input.oauth.refreshToken;
    credentials.client_id = config.codexClientId;
  }
  if (input.oauth.idToken) credentials.id_token = input.oauth.idToken;

  const email = firstString(input.oauth.email, idTokenPayload?.email, accessTokenPayload?.email);
  if (email) credentials.email = email;
  const accountId = firstString(
    input.oauth.accountKey,
    input.oauth.accountId,
    idAuth?.chatgpt_account_id,
    accessAuth?.chatgpt_account_id,
    idAuth?.account_id,
    accessAuth?.account_id,
  );
  if (accountId) credentials.chatgpt_account_id = accountId;
  const userId = firstString(
    idAuth?.chatgpt_user_id,
    accessAuth?.chatgpt_user_id,
    idAuth?.user_id,
    accessAuth?.user_id,
    idTokenPayload?.sub,
    accessTokenPayload?.sub,
  );
  if (userId) credentials.chatgpt_user_id = userId;
  const organizationId = firstString(
    idAuth?.organization_id,
    accessAuth?.organization_id,
    idAuth?.poid,
    accessAuth?.poid,
  );
  if (organizationId) credentials.organization_id = organizationId;
  const planType = firstString(
    input.oauth.planType,
    idAuth?.chatgpt_plan_type,
    accessAuth?.chatgpt_plan_type,
  );
  if (planType) credentials.plan_type = planType;
  const subscriptionExpiresAt = normalizeTimestampToIso(
    input.oauth.quota?.subscription?.activeUntil
      || idAuth?.chatgpt_subscription_active_until
      || accessAuth?.chatgpt_subscription_active_until,
  );
  if (subscriptionExpiresAt) credentials.subscription_expires_at = subscriptionExpiresAt;
  return { credentials, expiresAt };
}

function formatExportedAt(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function exportOfficialCredentialsAsSub2Api(input: {
  accountIds: number[];
  confirmation: string;
  now?: Date;
}) {
  if (input.confirmation !== OFFICIAL_CREDENTIAL_SECRET_EXPORT_CONFIRMATION) {
    throw new OfficialCredentialExportError('explicit secret export confirmation is required');
  }
  const accountIds = Array.from(new Set(
    input.accountIds.map((id) => Math.trunc(id)).filter((id) => id > 0),
  ));
  if (accountIds.length <= 0) {
    throw new OfficialCredentialExportError('at least one official credential is required');
  }
  if (accountIds.length > 100) {
    throw new OfficialCredentialExportError('official credential export supports at most 100 accounts');
  }

  const rows = await db.select().from(schema.accounts)
    .where(inArray(schema.accounts.id, accountIds))
    .all();
  const rowById = new Map<number, typeof schema.accounts.$inferSelect>(
    rows.map((row) => [row.id, row] as const),
  );
  const accounts = accountIds.map((accountId) => {
    const account = rowById.get(accountId);
    if (!account) {
      throw new OfficialCredentialExportError(`official credential ${accountId} was not found`);
    }
    const oauth = getOauthInfoFromAccount(account);
    if (!oauth) {
      throw new OfficialCredentialExportError(`account ${accountId} is not an official credential`);
    }
    if (oauth.provider !== 'codex') {
      throw new OfficialCredentialExportError(
        'Sub2API export currently supports Codex/OpenAI official credentials only',
      );
    }
    const accessToken = asString(account.accessToken);
    if (!accessToken) {
      throw new OfficialCredentialExportError(`official credential ${accountId} is missing access token`);
    }

    const { credentials, expiresAt } = buildSub2ApiCredentials({ accessToken, oauth });
    const item: JsonRecord = {
      name: account.username || oauth.email || oauth.accountKey || `codex-${account.id}`,
      platform: 'openai',
      type: 'oauth',
      credentials,
      concurrency: 3,
      priority: 50,
    };
    if (!oauth.refreshToken) {
      if (!expiresAt) {
        throw new OfficialCredentialExportError(
          `official credential ${accountId} has no refresh token or token expiry`,
        );
      }
      item.expires_at = Math.floor(new Date(expiresAt).getTime() / 1000);
      item.auto_pause_on_expired = true;
    }
    return item;
  });

  return {
    type: 'sub2api-data' as const,
    version: 1 as const,
    exported_at: formatExportedAt(input.now || new Date()),
    proxies: [] as never[],
    accounts,
  };
}
