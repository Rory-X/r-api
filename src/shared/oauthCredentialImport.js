export class OauthCredentialImportFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OauthCredentialImportFormatError';
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = asNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function firstDefined(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function normalizeProvider(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase().replace(/[_\s]+/g, '-');
  if (!normalized) return null;
  if (normalized === 'codex' || normalized === 'openai' || normalized === 'chatgpt') return 'codex';
  if (normalized === 'claude' || normalized === 'anthropic') return 'claude';
  if (normalized === 'gemini' || normalized === 'gemini-cli' || normalized === 'google') return 'gemini-cli';
  if (normalized === 'antigravity') return 'antigravity';
  return null;
}

function providerLabel(provider) {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  if (provider === 'gemini-cli') return 'Gemini CLI';
  return 'Antigravity';
}

function isGenericOauthType(value) {
  const normalized = value?.toLowerCase().replace(/[_\s]+/g, '-');
  return normalized === 'oauth' || normalized === 'oauth2' || normalized === 'oauth-2';
}

function isExplicitNonOauthType(value) {
  const normalized = value?.toLowerCase().replace(/[_\s]+/g, '-');
  return normalized === 'apikey'
    || normalized === 'api-key'
    || normalized === 'token'
    || normalized === 'cookie'
    || normalized === 'password';
}

function hasAccessToken(record) {
  if (firstString(record, ['access_token', 'accessToken', 'session_token', 'sessionToken'])) return true;
  return isRecord(record.credentials)
    && !!firstString(record.credentials, ['access_token', 'accessToken', 'session_token', 'sessionToken']);
}

function inferProviderFromCredentialShape(record) {
  if (firstString(record, [
    'chatgpt_account_id',
    'chatgptAccountId',
    'chatgpt_user_id',
    'organization_id',
  ])) return 'codex';
  if (firstString(record, ['cloudaicompanionProject', 'project_id', 'projectId'])) return 'gemini-cli';
  return null;
}

function normalizeCredentialCandidate(source, path, providerHint) {
  const credentials = isRecord(source.credentials) ? source.credentials : source;
  const extra = isRecord(source.extra) ? source.extra : null;
  const sourceType = firstString(source, ['type', 'kind', 'auth_type', 'authType']);
  const credentialType = firstString(credentials, ['type', 'kind', 'auth_type', 'authType']);

  if (isExplicitNonOauthType(sourceType) || isExplicitNonOauthType(credentialType)) {
    return { ignored: true };
  }

  const providerCandidates = [
    providerHint,
    firstString(extra || {}, ['auth_provider', 'authProvider', 'provider', 'platform']),
    firstString(source, ['auth_provider', 'authProvider', 'provider', 'platform']),
    firstString(credentials, ['auth_provider', 'authProvider', 'provider', 'platform']),
    isGenericOauthType(credentialType) ? undefined : credentialType,
    isGenericOauthType(sourceType) ? undefined : sourceType,
  ];
  const provider = providerCandidates.reduce(
    (resolved, candidate) => resolved || normalizeProvider(candidate),
    null,
  ) || inferProviderFromCredentialShape(credentials);

  const accessToken = firstString(credentials, [
    'access_token',
    'accessToken',
    'session_token',
    'sessionToken',
  ]);
  if (!accessToken) {
    if (firstString(credentials, ['api_key', 'apiKey', 'key'])) return { ignored: true };
    return { issue: { path, message: '缺少 access_token/session_token' } };
  }
  if (!provider) {
    return { issue: { path, message: '无法识别 OAuth Provider' } };
  }

  const normalized = {
    ...credentials,
    type: provider,
    access_token: accessToken,
  };
  const refreshToken = firstString(credentials, ['refresh_token', 'refreshToken']);
  const idToken = firstString(credentials, ['id_token', 'idToken']);
  const email = firstString(credentials, ['email']) || firstString(source, ['email', 'name']);
  const accountId = firstString(credentials, [
    'chatgpt_account_id',
    'chatgptAccountId',
    'account_id',
    'accountId',
  ]) || firstString(source, ['account_id', 'accountId']);
  const accountKey = firstString(credentials, ['account_key', 'accountKey'])
    || firstString(source, ['account_key', 'accountKey']);
  const planType = firstString(credentials, ['plan_type', 'planType']);
  const projectId = firstString(credentials, ['project_id', 'projectId', 'cloudaicompanionProject']);
  const expired = firstDefined(credentials, [
    'expired',
    'expires_at',
    'expiresAt',
    'token_expires_at',
    'tokenExpiresAt',
  ]);
  const disabled = typeof source.disabled === 'boolean'
    ? source.disabled
    : (typeof credentials.disabled === 'boolean' ? credentials.disabled : undefined);

  if (refreshToken) normalized.refresh_token = refreshToken;
  if (idToken) normalized.id_token = idToken;
  if (email) normalized.email = email;
  if (accountId) normalized.account_id = accountId;
  if (accountKey) normalized.account_key = accountKey;
  if (planType) normalized.plan_type = planType;
  if (projectId) normalized.project_id = projectId;
  if (expired !== undefined) normalized.expired = expired;
  if (disabled !== undefined) normalized.disabled = disabled;
  return { record: normalized };
}

function collectOauthCredentials(value, path, records, issues, providerHint) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectOauthCredentials(item, `${path}[${index}]`, records, issues, providerHint);
    });
    return;
  }

  if (!isRecord(value)) {
    issues.push({ path, message: '凭证记录必须是 JSON 对象' });
    return;
  }

  const nextProviderHint = firstString(value, ['provider', 'platform']) || providerHint;
  if (!hasAccessToken(value) && Array.isArray(value.accounts)) {
    value.accounts.forEach((item, index) => {
      collectOauthCredentials(item, `${path}.accounts[${index}]`, records, issues, nextProviderHint);
    });
    return;
  }
  if (!hasAccessToken(value) && Array.isArray(value.items)) {
    value.items.forEach((item, index) => {
      collectOauthCredentials(item, `${path}.items[${index}]`, records, issues, nextProviderHint);
    });
    return;
  }
  if (!hasAccessToken(value) && value.data !== undefined) {
    collectOauthCredentials(value.data, `${path}.data`, records, issues, nextProviderHint);
    return;
  }

  const candidate = normalizeCredentialCandidate(value, path, nextProviderHint);
  if ('record' in candidate) records.push(candidate.record);
  if ('issue' in candidate) issues.push(candidate.issue);
}

function resolveRootFormat(input) {
  if (Array.isArray(input)) return 'array';
  if (!isRecord(input)) return 'native';
  if (Array.isArray(input.accounts)) return 'accounts-envelope';
  if (input.data !== undefined || Array.isArray(input.items)) return 'wrapped';
  return 'native';
}

function resolveResultLabel(format, records) {
  if (format === 'array') return 'OAuth 凭证数组';
  if (format === 'accounts-envelope') return 'Sub2API / Cockpit 包';
  if (format === 'wrapped') return '批量凭证包';
  return `${providerLabel(records[0].type)} OAuth JSON`;
}

export function normalizeOauthCredentialImport(input) {
  const records = [];
  const issues = [];
  collectOauthCredentials(input, '$', records, issues);

  if (records.length <= 0) {
    const message = issues[0]?.message || '未找到可导入的 OAuth 凭证';
    throw new OauthCredentialImportFormatError(message);
  }

  const format = resolveRootFormat(input);
  return {
    format,
    label: resolveResultLabel(format, records),
    records,
    issues,
  };
}
