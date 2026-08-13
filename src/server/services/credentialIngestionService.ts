import { createHash } from 'node:crypto';

export type CredentialTarget = 'new_api' | 'sub2api' | 'native_oauth' | 'api_key' | 'vault';

export type CredentialKind =
  | 'api_key'
  | 'session_token'
  | 'oauth_token_set'
  | 'username_password'
  | 'browser_storage'
  | 'platform_bundle'
  | 'metadata_only';

export type CredentialSourceFormat =
  | 'cockpit_account_transfer'
  | 'cockpit_platform_payload'
  | 'r_api_credential_transfer'
  | 'native_oauth_json'
  | 'sub2api_bundle'
  | 'new_api_account'
  | 'browser_storage'
  | 'api_key'
  | 'mixed_batch';

export type CredentialSecretSet = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  cookie?: string;
};

export type CredentialIdentity = {
  externalId?: string;
  accountKey?: string;
  email?: string;
  username?: string;
  displayName?: string;
};

export type CredentialCandidate = {
  source: {
    format: CredentialSourceFormat;
    version?: string | number;
    platform?: string;
    sourceIndex?: number;
  };
  provider?: string;
  kind: CredentialKind;
  identity: CredentialIdentity;
  secrets: CredentialSecretSet;
  secretPresence: {
    accessToken: boolean;
    refreshToken: boolean;
    idToken: boolean;
    apiKey: boolean;
    password: boolean;
    cookie: boolean;
  };
  expiresAt?: number;
  disabled: boolean;
  fingerprint: string;
  warnings: string[];
  compatibleTargets: CredentialTarget[];
};

export type CredentialPreview = Omit<CredentialCandidate, 'secrets' | 'fingerprint'> & {
  fingerprint: string;
  secretSummary: {
    accessToken: boolean;
    refreshToken: boolean;
    idToken: boolean;
    apiKey: boolean;
    password: boolean;
    cookie: boolean;
  };
};

export type CredentialCandidateValidationStatus =
  | 'ready'
  | 'incomplete'
  | 'metadata_only'
  | 'unsupported';

export type CredentialCandidateValidation = {
  status: CredentialCandidateValidationStatus;
  target?: CredentialTarget;
  errors: string[];
  warnings: string[];
};

export type CredentialCandidatePreviewResult = {
  candidate: CredentialPreview;
  validation: CredentialCandidateValidation;
  duplicateOfIndex?: number;
};

export type CredentialBatchPreview = {
  batchFingerprint: string;
  duplicateCount: number;
  candidates: CredentialCandidatePreviewResult[];
};

export type CredentialFormatDetection = {
  format: CredentialSourceFormat;
  version?: string | number;
  provider?: string;
  isBatch: boolean;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
};

export type CredentialNormalizationResult = {
  detection: CredentialFormatDetection;
  candidates: CredentialCandidate[];
  warnings: string[];
};

type RecordValue = Record<string, unknown>;

const COCKPIT_SCHEMA = 'cockpit-tools.account-transfer';
const R_API_TRANSFER_SCHEMA = 'r-api.credential-transfer';
const NATIVE_OAUTH_TYPES = new Map<string, string>([
  ['codex', 'codex'],
  ['openai', 'codex'],
  ['claude', 'claude'],
  ['anthropic', 'claude'],
  ['gemini', 'gemini-cli'],
  ['gemini-cli', 'gemini-cli'],
  ['antigravity', 'antigravity'],
]);

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function firstString(record: RecordValue, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) throw new Error('凭证输入不能为空');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return Number.isFinite(numeric) && numeric > 0
      ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function resolveExpiry(record: RecordValue): number | undefined {
  return normalizeTimestamp(
    record.expires_at
      ?? record.token_expires_at
      ?? record.tokenExpiresAt
      ?? record.expired
      ?? record.expiresAt,
  );
}

function resolveProvider(record: RecordValue, platformHint?: string): string | undefined {
  const raw = firstString(record, ['provider', 'platform', 'provider_id', 'providerId', 'type']);
  if (raw) {
    const normalized = raw.toLowerCase().replace(/[_\s]+/g, '-');
    return NATIVE_OAUTH_TYPES.get(normalized) || normalized;
  }
  return nonEmptyString(platformHint)?.toLowerCase();
}

function resolveIdentity(record: RecordValue, secrets: CredentialSecretSet): CredentialIdentity {
  const externalId = firstString(record, ['external_id', 'externalId', 'account_id', 'accountId', 'user_id', 'userId']);
  const accountKey = firstString(record, ['account_key', 'accountKey', 'chatgpt_account_id']);
  const email = firstString(record, ['email', 'mail']);
  const username = firstString(record, ['username', 'user_name', 'userName']) || secrets.username;
  const displayName = firstString(record, ['display_name', 'displayName', 'name', 'label']);
  return {
    ...(externalId ? { externalId } : {}),
    ...(accountKey ? { accountKey } : {}),
    ...(email ? { email } : {}),
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
  };
}

function hasAnySecret(secrets: CredentialSecretSet): boolean {
  return Object.values(secrets).some((value) => !!value);
}

function buildFingerprint(
  provider: string | undefined,
  kind: CredentialKind,
  secrets: CredentialSecretSet,
  identity: CredentialIdentity,
): string {
  const secret = secrets.refreshToken
    || secrets.idToken
    || secrets.apiKey
    || secrets.accessToken
    || secrets.cookie
    || (secrets.username && secrets.password ? `${secrets.username}\0${secrets.password}` : '')
    || identity.externalId
    || identity.accountKey
    || identity.email
    || identity.username
    || 'metadata';
  return createHash('sha256')
    .update(provider || '')
    .update('\0')
    .update(kind)
    .update('\0')
    .update(secret)
    .digest('hex');
}

function buildCandidateExecutionFingerprint(candidate: CredentialCandidate): string {
  const identity = candidate.identity;
  const stablePayload = JSON.stringify({
    credentialFingerprint: candidate.fingerprint,
    provider: candidate.provider || null,
    kind: candidate.kind,
    identity: {
      externalId: identity.externalId || null,
      accountKey: identity.accountKey || null,
      email: identity.email || null,
      username: identity.username || null,
      displayName: identity.displayName || null,
    },
    expiresAt: candidate.expiresAt || null,
    disabled: candidate.disabled,
    compatibleTargets: [...candidate.compatibleTargets].sort(),
  });
  return createHash('sha256').update(stablePayload).digest('hex');
}

function buildCandidate(input: {
  record: RecordValue;
  source: CredentialCandidate['source'];
  provider?: string;
  kind: CredentialKind;
  secrets?: CredentialSecretSet;
  compatibleTargets: CredentialTarget[];
  warnings?: string[];
}): CredentialCandidate {
  const secrets = input.secrets || {};
  const identity = resolveIdentity(input.record, secrets);
  const warnings = [...(input.warnings || [])];
  const expiresAt = resolveExpiry(input.record);
  if (!hasAnySecret(secrets) && input.kind !== 'metadata_only' && input.kind !== 'platform_bundle') {
    warnings.push('未提取到可保存的秘密字段');
  }
  if (input.kind === 'metadata_only') {
    warnings.push('该条目只有元数据，不能恢复登录或创建可路由凭证');
  }
  return {
    source: input.source,
    ...(input.provider ? { provider: input.provider } : {}),
    kind: input.kind,
    identity,
    secrets,
    secretPresence: {
      accessToken: !!secrets.accessToken,
      refreshToken: !!secrets.refreshToken,
      idToken: !!secrets.idToken,
      apiKey: !!secrets.apiKey,
      password: !!secrets.password,
      cookie: !!secrets.cookie,
    },
    ...(expiresAt ? { expiresAt } : {}),
    disabled: input.record.disabled === true || input.record.enabled === false,
    fingerprint: buildFingerprint(input.provider, input.kind, secrets, identity),
    warnings: [...new Set(warnings)],
    compatibleTargets: [...new Set(input.compatibleTargets)],
  };
}

function detectRecord(record: RecordValue, platformHint?: string): CredentialFormatDetection {
  const rawType = firstString(record, ['type', 'format', 'schema']);
  const normalizedType = rawType?.toLowerCase().replace(/[_\s]+/g, '-');
  const provider = resolveProvider(record, platformHint);
  if (record.schema === COCKPIT_SCHEMA) {
    return {
      format: 'cockpit_account_transfer',
      version: typeof record.version === 'string' || typeof record.version === 'number' ? record.version : undefined,
      isBatch: true,
      confidence: 'high',
      warnings: [],
    };
  }
  if (record.schema === R_API_TRANSFER_SCHEMA) {
    return {
      format: 'r_api_credential_transfer',
      version: typeof record.version === 'string' || typeof record.version === 'number' ? record.version : undefined,
      isBatch: true,
      confidence: 'high',
      warnings: [],
    };
  }
  if (normalizedType === 'sub2api-data' || normalizedType === 'sub2api-bundle' || normalizedType === 'sub2api') {
    return {
      format: 'sub2api_bundle',
      version: typeof record.version === 'string' || typeof record.version === 'number' ? record.version : undefined,
      provider: 'sub2api',
      isBatch: Array.isArray(record.accounts) || Array.isArray(record.data),
      confidence: 'high',
      warnings: [],
    };
  }
  if (provider === 'sub2api') {
    return {
      format: 'sub2api_bundle',
      provider: 'sub2api',
      isBatch: Array.isArray(record.accounts) || Array.isArray(record.data),
      confidence: 'high',
      warnings: [],
    };
  }
  if (firstString(record, ['cookie', 'cookies'])) {
    return {
      format: 'browser_storage',
      provider,
      isBatch: false,
      confidence: 'high',
      warnings: [],
    };
  }
  if (normalizedType === 'new-api' || normalizedType === 'newapi'
    || normalizedType === 'one-api' || normalizedType === 'oneapi'
    || provider === 'new-api' || provider === 'newapi'
    || provider === 'one-api' || provider === 'oneapi') {
    return {
      format: 'new_api_account',
      provider,
      isBatch: false,
      confidence: 'high',
      warnings: [],
    };
  }
  if ((normalizedType && NATIVE_OAUTH_TYPES.has(normalizedType))
    || (provider && NATIVE_OAUTH_TYPES.has(provider))) {
    return {
      format: 'native_oauth_json',
      provider: NATIVE_OAUTH_TYPES.get(normalizedType || provider || ''),
      isBatch: false,
      confidence: 'high',
      warnings: [],
    };
  }
  if (firstString(record, ['access_token', 'session_token', 'accessToken', 'sessionToken', 'auth_token', 'authToken'])
    && firstString(record, ['refresh_token', 'refreshToken'])) {
    return {
      format: normalizedType?.includes('sub2api') || provider === 'sub2api'
        ? 'sub2api_bundle'
        : 'native_oauth_json',
      provider,
      isBatch: false,
      confidence: 'medium',
      warnings: normalizedType ? [] : ['未声明 provider/type，将在目标适配时再次校验'],
    };
  }
  if (firstString(record, ['username']) && firstString(record, ['password', 'passwd'])) {
    return {
      format: 'new_api_account',
      provider,
      isBatch: false,
      confidence: 'high',
      warnings: [],
    };
  }
  if (firstString(record, ['api_key', 'apiKey', 'api_token', 'apiToken', 'key'])) {
    return {
      format: 'api_key',
      provider,
      isBatch: false,
      confidence: 'high',
      warnings: [],
    };
  }
  return {
    format: 'api_key',
    provider,
    isBatch: false,
    confidence: 'low',
    warnings: ['无法确认输入 schema；仅在值看起来像 API key 时继续处理'],
  };
}

function normalizeRecord(
  record: RecordValue,
  source: CredentialCandidate['source'],
  platformHint?: string,
): CredentialCandidate {
  const detection = detectRecord(record, platformHint);
  const provider = detection.provider || resolveProvider(record, platformHint);
  const accessToken = firstString(record, ['access_token', 'session_token', 'accessToken', 'sessionToken', 'auth_token', 'authToken']);
  const refreshToken = firstString(record, ['refresh_token', 'refreshToken']);
  const idToken = firstString(record, ['id_token', 'idToken']);
  const apiKey = firstString(record, ['api_key', 'apiKey', 'api_token', 'apiToken', 'key']);
  const password = firstString(record, ['password', 'passwd']);
  const username = firstString(record, ['username', 'user_name', 'userName']);
  const cookie = firstString(record, ['cookie', 'cookies']);

  if (detection.format === 'new_api_account') {
    if (apiKey) {
      return buildCandidate({
        record,
        source,
        provider,
        kind: 'api_key',
        secrets: { apiKey },
        compatibleTargets: ['new_api', 'api_key', 'vault'],
        warnings: detection.warnings,
      });
    }
    if (accessToken) {
      return buildCandidate({
        record,
        source,
        provider,
        kind: 'session_token',
        secrets: { accessToken },
        compatibleTargets: ['new_api', 'vault'],
        warnings: detection.warnings,
      });
    }
    return buildCandidate({
      record,
      source,
      provider,
      kind: 'username_password',
      secrets: { username, password },
      compatibleTargets: ['new_api'],
      warnings: detection.warnings,
    });
  }
  if (detection.format === 'browser_storage') {
    return buildCandidate({
      record,
      source,
      provider,
      kind: 'browser_storage',
      secrets: { cookie },
      compatibleTargets: ['vault'],
      warnings: detection.warnings,
    });
  }
  if (detection.format === 'api_key') {
    const warnings = [...detection.warnings];
    if (!apiKey && typeof record.value === 'string' && record.value.trim()) {
      if (!/^(sk-|key-|api[-_])/i.test(record.value.trim())) {
        warnings.push('纯文本凭证格式不明确，将按 API Key 候选交由目标站点验证');
      }
      return buildCandidate({
        record,
        source,
        provider,
        kind: 'api_key',
        secrets: { apiKey: record.value.trim() },
        compatibleTargets: ['api_key', 'new_api', 'sub2api', 'vault'],
        warnings,
      });
    }
    if (!apiKey) {
      return buildCandidate({
        record,
        source,
        provider,
        kind: 'metadata_only',
        compatibleTargets: [],
        warnings,
      });
    }
    return buildCandidate({
      record,
      source,
      provider,
      kind: 'api_key',
      secrets: { apiKey },
      compatibleTargets: ['api_key', 'new_api', 'sub2api', 'vault'],
      warnings,
    });
  }
  if (detection.format === 'sub2api_bundle') {
    return buildCandidate({
      record,
      source,
      provider: 'sub2api',
      kind: accessToken || refreshToken ? 'oauth_token_set' : 'metadata_only',
      secrets: { accessToken, refreshToken, idToken },
      compatibleTargets: accessToken || refreshToken ? ['sub2api', 'vault'] : [],
      warnings: detection.warnings,
    });
  }
  if (detection.format === 'native_oauth_json') {
    return buildCandidate({
      record,
      source,
      provider,
      kind: accessToken || refreshToken ? 'oauth_token_set' : 'metadata_only',
      secrets: { accessToken, refreshToken, idToken },
      compatibleTargets: accessToken || refreshToken ? ['native_oauth', 'vault'] : [],
      warnings: detection.warnings,
    });
  }
  return buildCandidate({
    record,
    source,
    provider,
    kind: cookie ? 'browser_storage' : 'platform_bundle',
    secrets: cookie ? { cookie } : {},
    compatibleTargets: cookie ? ['vault'] : [],
    warnings: detection.warnings,
  });
}

function normalizeBatchRecords(
  input: unknown,
  source: CredentialCandidate['source'],
  platformHint?: string,
): CredentialCandidate[] {
  if (Array.isArray(input)) {
    return input.flatMap((item, index) => {
      const record = isRecord(item)
        ? item
        : (typeof item === 'string' ? { value: item } : null);
      if (!record) return [];
      return [normalizeRecord(
        record,
        {
          ...source,
          format: source.format === 'mixed_batch'
            ? detectRecord(record, platformHint).format
            : source.format,
          sourceIndex: index,
        },
        platformHint,
      )];
    });
  }
  if (isRecord(input)) return [normalizeRecord(input, source, platformHint)];
  if (typeof input === 'string') {
    return [normalizeRecord({ value: input }, source, platformHint)];
  }
  return [];
}

function normalizeSub2ApiBundle(
  root: RecordValue,
  detection: CredentialFormatDetection,
): CredentialNormalizationResult {
  const nested = Array.isArray(root.accounts)
    ? root.accounts
    : (Array.isArray(root.data)
      ? root.data
      : (isRecord(root.data) && Array.isArray(root.data.accounts) ? root.data.accounts : null));
  const rawCandidates = nested || [root];
  const candidates = normalizeBatchRecords(
    rawCandidates,
    { format: 'sub2api_bundle', version: detection.version },
    'sub2api',
  );
  return {
    detection,
    candidates,
    warnings: detection.warnings,
  };
}

function normalizeCockpitBundle(root: RecordValue): CredentialNormalizationResult {
  const candidates: CredentialCandidate[] = [];
  const warnings: string[] = [];
  const platforms = isRecord(root.platforms) ? root.platforms : {};
  for (const [platform, rawPayload] of Object.entries(platforms)) {
    const payload = isRecord(rawPayload) && 'exported_data' in rawPayload
      ? rawPayload.exported_data
      : rawPayload;
    if (payload == null || (Array.isArray(payload) && payload.length === 0)) continue;
    const before = candidates.length;
    candidates.push(...normalizeBatchRecords(
      payload,
      {
        format: 'cockpit_platform_payload',
        version: root.version as string | number | undefined,
        platform,
      },
      platform,
    ));
    if (candidates.length === before) {
      warnings.push(`平台 ${platform} 没有提取出可识别凭证`);
    }
  }
  return {
    detection: {
      format: 'cockpit_account_transfer',
      version: typeof root.version === 'string' || typeof root.version === 'number' ? root.version : undefined,
      isBatch: true,
      confidence: 'high',
      warnings,
    },
    candidates,
    warnings,
  };
}

function normalizeRapiTransfer(root: RecordValue): CredentialNormalizationResult {
  const detection: CredentialFormatDetection = {
    format: 'r_api_credential_transfer',
    version: typeof root.version === 'string' || typeof root.version === 'number' ? root.version : undefined,
    isBatch: true,
    confidence: 'high',
    warnings: [],
  };
  const candidates = normalizeBatchRecords(
    Array.isArray(root.items) ? root.items : [],
    { format: 'r_api_credential_transfer', version: detection.version },
  );
  return {
    detection,
    candidates,
    warnings: candidates.length > 0 ? [] : ['r-api 凭证迁移包不包含可识别条目'],
  };
}

export function detectCredentialFormat(input: unknown): CredentialFormatDetection {
  const parsed = typeof input === 'string' ? parseInput(input) : input;
  if (isRecord(parsed)) return detectRecord(parsed);
  if (Array.isArray(parsed)) {
    return {
      format: 'mixed_batch',
      isBatch: true,
      confidence: 'medium',
      warnings: ['数组输入需要逐项检测；非对象项只支持明确的 API key 文本'],
    };
  }
  if (typeof parsed === 'string') {
    return {
      format: 'api_key',
      isBatch: false,
      confidence: /^(sk-|key-|api[-_])/i.test(parsed.trim()) ? 'medium' : 'low',
      warnings: [],
    };
  }
  throw new Error('无法识别凭证输入');
}

export function normalizeCredentialInput(input: unknown): CredentialNormalizationResult {
  const parsed = parseInput(input);
  if (isRecord(parsed) && parsed.schema === COCKPIT_SCHEMA) {
    return normalizeCockpitBundle(parsed);
  }
  if (isRecord(parsed) && parsed.schema === R_API_TRANSFER_SCHEMA) {
    return normalizeRapiTransfer(parsed);
  }

  const detection = detectCredentialFormat(parsed);
  if (isRecord(parsed) && detection.format === 'sub2api_bundle') {
    return normalizeSub2ApiBundle(parsed, detection);
  }
  const candidates = normalizeBatchRecords(parsed, { format: detection.format, version: detection.version });
  return {
    detection,
    candidates,
    warnings: detection.warnings,
  };
}

export function toCredentialPreview(candidate: CredentialCandidate): CredentialPreview {
  const { secrets: _secrets, ...safe } = candidate;
  return {
    ...safe,
    secretSummary: { ...candidate.secretPresence },
  };
}

function validateRequiredSecrets(candidate: CredentialCandidate, errors: string[]): void {
  if (candidate.kind === 'api_key' && !candidate.secrets.apiKey) {
    errors.push('API Key 缺失');
  }
  if (candidate.kind === 'session_token' && !candidate.secrets.accessToken) {
    errors.push('Session token 缺失');
  }
  if (candidate.kind === 'oauth_token_set' && !candidate.secrets.accessToken) {
    errors.push('Access token 缺失');
  }
  if (candidate.kind === 'username_password') {
    if (!candidate.secrets.username) errors.push('用户名缺失');
    if (!candidate.secrets.password) errors.push('密码缺失');
  }
  if (candidate.kind === 'browser_storage' && !candidate.secrets.cookie) {
    errors.push('浏览器凭证内容缺失');
  }
}

export function validateCredentialCandidate(
  candidate: CredentialCandidate,
  target?: CredentialTarget,
  nowMs = Date.now(),
): CredentialCandidateValidation {
  const errors: string[] = [];
  const warnings = [...candidate.warnings];

  if (candidate.kind === 'metadata_only') {
    return {
      status: 'metadata_only',
      ...(target ? { target } : {}),
      errors: ['仅包含元数据，不能执行凭证导入'],
      warnings,
    };
  }
  if (candidate.kind === 'platform_bundle') {
    return {
      status: 'unsupported',
      ...(target ? { target } : {}),
      errors: ['平台 payload 尚无可用的凭证解析器'],
      warnings,
    };
  }

  validateRequiredSecrets(candidate, errors);

  if (target && !candidate.compatibleTargets.includes(target)) {
    errors.push(`凭证类型 ${candidate.kind} 不兼容目标 ${target}`);
  }
  if (target === 'native_oauth' && !candidate.provider) {
    errors.push('原生 OAuth 导入必须声明 provider');
  }
  if (target === 'sub2api'
    && candidate.kind === 'oauth_token_set'
    && !candidate.secrets.refreshToken) {
    warnings.push('缺少 refresh token，导入后不能使用托管刷新');
  }
  if (candidate.expiresAt && candidate.expiresAt <= nowMs) {
    if (candidate.secrets.refreshToken) {
      warnings.push('Access token 已过期，执行导入时需要先刷新');
    } else {
      errors.push('凭证已过期且没有 refresh token');
    }
  }

  return {
    status: errors.length > 0 ? 'incomplete' : 'ready',
    ...(target ? { target } : {}),
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
  };
}

export function buildCredentialBatchPreview(
  candidates: CredentialCandidate[],
  target?: CredentialTarget,
): CredentialBatchPreview {
  const firstIndexByFingerprint = new Map<string, number>();
  let duplicateCount = 0;
  const previewCandidates = candidates.map((candidate, index): CredentialCandidatePreviewResult => {
    const duplicateOfIndex = firstIndexByFingerprint.get(candidate.fingerprint);
    if (duplicateOfIndex === undefined) {
      firstIndexByFingerprint.set(candidate.fingerprint, index);
    } else {
      duplicateCount += 1;
    }
    return {
      candidate: toCredentialPreview(candidate),
      validation: validateCredentialCandidate(candidate, target),
      ...(duplicateOfIndex === undefined ? {} : { duplicateOfIndex }),
    };
  });
  const normalizedFingerprints = candidates
    .map(buildCandidateExecutionFingerprint)
    .sort();
  const batchFingerprint = createHash('sha256')
    .update(target || 'auto')
    .update('\0')
    .update(normalizedFingerprints.join('\0'))
    .digest('hex');
  return {
    batchFingerprint,
    duplicateCount,
    candidates: previewCandidates,
  };
}
