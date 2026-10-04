export type SiteCredentialKind =
  | 'api_key'
  | 'session_token'
  | 'cookie'
  | 'oauth_access_token'
  | 'oauth_refresh_token'
  | 'browser_storage';

export type SiteAdapterOperation =
  | 'detect'
  | 'login'
  | 'verify_token'
  | 'balance'
  | 'models'
  | 'checkin'
  | 'api_tokens'
  | 'announcements';

export type SiteProbePolicy = 'none' | 'metadata_only' | 'management_only' | 'explicit_only';
export type SiteCheckinSupport = 'supported' | 'unsupported' | 'manual_required';
export type SiteCheckinIdempotency = 'idempotent' | 'detectable' | 'unknown';
export type BrowserRecoveryMode = 'manual' | 'assisted' | 'managed';
export type BrowserCaptureFieldKind = 'cookie' | 'local_storage' | 'session_storage' | 'header';
export type BrowserCaptureStrategy =
  | 'cookie_header'
  | 'named_cookie'
  | 'storage_value'
  | 'json_path'
  | 'manual';

export type BrowserCredentialRuntimeKind = 'session_token' | 'cookie';

/** Names the allowlisted capture fields that can be promoted to an account. */
export interface BrowserCredentialRuntime {
  kind: BrowserCredentialRuntimeKind;
  field: string;
  usernameField?: string;
  platformUserIdField?: string;
  refreshTokenField?: string;
  tokenExpiresAtField?: string;
}

export interface BrowserCaptureSource {
  /** Declarative extraction only. The extension never receives executable code. */
  strategy: BrowserCaptureStrategy;
  /** Exact cookie or Storage key when required by the strategy. */
  key?: string;
  /** Exact JSON property path within a declared Storage key. */
  path?: string[];
}

export interface BrowserCaptureField {
  /** Adapter-owned name, never a wildcard export of the browser profile. */
  name: string;
  kind: BrowserCaptureFieldKind;
  required: boolean;
  capture?: BrowserCaptureSource;
}

export interface SiteBrowserCredentialContract {
  supported: boolean;
  modes: BrowserRecoveryMode[];
  /** Exact origins or explicit subdomain patterns accepted by the adapter. */
  allowedOrigins: string[];
  fields: BrowserCaptureField[];
  runtime?: BrowserCredentialRuntime;
  taskTtlSec: number;
  requiresUserGesture: boolean;
}

export interface SiteAdapterContract {
  platformName: string;
  protocolFamilies: string[];
  proxyEndpoints: { rerank: 'passthrough' | 'unsupported' };
  credentialKinds: SiteCredentialKind[];
  operations: Record<SiteAdapterOperation, boolean>;
  probePolicy: SiteProbePolicy;
  checkin: {
    support: SiteCheckinSupport;
    idempotency: SiteCheckinIdempotency;
    allowsAutomaticExecution: boolean;
  };
  modelSync: {
    readOnly: boolean;
    retireMissingAfterConsecutiveRuns: number;
  };
  browser: SiteBrowserCredentialContract;
  credentialStorage: 'encrypted_vault_only';
  notes: string[];
}

const DEFAULT_BROWSER_CONTRACT: SiteBrowserCredentialContract = {
  supported: false,
  modes: [],
  allowedOrigins: [],
  fields: [],
  taskTtlSec: 300,
  requiresUserGesture: true,
};

const DEFAULT_OPERATIONS: Record<SiteAdapterOperation, boolean> = {
  detect: true,
  login: true,
  verify_token: true,
  balance: true,
  models: true,
  checkin: true,
  api_tokens: true,
  announcements: true,
};

function cloneContract(contract: SiteAdapterContract): SiteAdapterContract {
  return {
    ...contract,
    protocolFamilies: [...contract.protocolFamilies],
    credentialKinds: [...contract.credentialKinds],
    operations: { ...contract.operations },
    checkin: { ...contract.checkin },
    modelSync: { ...contract.modelSync },
    proxyEndpoints: { ...contract.proxyEndpoints },
    browser: {
      ...contract.browser,
      modes: [...contract.browser.modes],
      allowedOrigins: [...contract.browser.allowedOrigins],
      fields: contract.browser.fields.map((field) => ({ ...field })),
      runtime: contract.browser.runtime ? { ...contract.browser.runtime } : undefined,
    },
    notes: [...contract.notes],
  };
}

function buildContract(
  platformName: string,
  overrides: Partial<Omit<SiteAdapterContract, 'platformName'>> = {},
): SiteAdapterContract {
  return {
    platformName,
    protocolFamilies: ['openai-compatible'],
    proxyEndpoints: { rerank: 'unsupported' },
    credentialKinds: ['session_token', 'api_key'],
    operations: { ...DEFAULT_OPERATIONS },
    probePolicy: 'management_only',
    checkin: {
      support: 'supported',
      idempotency: 'detectable',
      allowsAutomaticExecution: false,
    },
    modelSync: {
      readOnly: true,
      retireMissingAfterConsecutiveRuns: 3,
    },
    browser: { ...DEFAULT_BROWSER_CONTRACT },
    credentialStorage: 'encrypted_vault_only',
    notes: [],
    ...overrides,
  };
}

const CONTRACTS: Record<string, SiteAdapterContract> = {
  openai: buildContract('openai', {
    proxyEndpoints: { rerank: 'passthrough' },
    credentialKinds: ['api_key'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
    notes: ['官方按量 API Key 不由本项目托管；该契约仅描述兼容上游。'],
  }),
  claude: buildContract('claude', {
    credentialKinds: ['api_key', 'oauth_access_token', 'oauth_refresh_token'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
  gemini: buildContract('gemini', {
    credentialKinds: ['api_key', 'oauth_access_token', 'oauth_refresh_token'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    protocolFamilies: ['gemini-native', 'openai-compatible'],
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
  'gemini-cli': buildContract('gemini-cli', {
    credentialKinds: ['oauth_access_token', 'oauth_refresh_token'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    protocolFamilies: ['gemini-native', 'openai-compatible'],
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
  antigravity: buildContract('antigravity', {
    credentialKinds: ['oauth_access_token', 'oauth_refresh_token'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    protocolFamilies: ['openai-compatible'],
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
  codex: buildContract('codex', {
    credentialKinds: ['oauth_access_token', 'oauth_refresh_token'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    protocolFamilies: ['responses'],
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
    notes: ['官方订阅 OAuth 凭据可托管；官方 API Key 不纳入本项目。'],
  }),
  'cliproxyapi': buildContract('cliproxyapi', {
    credentialKinds: ['api_key'],
    operations: { ...DEFAULT_OPERATIONS, login: false, checkin: false, api_tokens: false, announcements: false },
    probePolicy: 'metadata_only',
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
  'new-api': buildContract('new-api', {
    proxyEndpoints: { rerank: 'passthrough' },
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [
        { name: 'session_cookie', kind: 'cookie', required: true },
        {
          name: 'user_id',
          kind: 'local_storage',
          required: false,
          capture: { strategy: 'json_path', key: 'user', path: ['id'] },
        },
      ],
      runtime: {
        kind: 'session_token',
        field: 'session_cookie',
        platformUserIdField: 'user_id',
      },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
    notes: ['浏览器采集仅允许适配器声明字段；不上传完整 Profile、密码或无关 Storage。'],
  }),
  'one-api': buildContract('one-api', {
    proxyEndpoints: { rerank: 'passthrough' },
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [{ name: 'session_cookie', kind: 'cookie', required: true }],
      runtime: { kind: 'session_token', field: 'session_cookie' },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
  }),
  'one-hub': buildContract('one-hub', {
    proxyEndpoints: { rerank: 'passthrough' },
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [{ name: 'session_cookie', kind: 'cookie', required: true }],
      runtime: { kind: 'session_token', field: 'session_cookie' },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
  }),
  'done-hub': buildContract('done-hub', {
    proxyEndpoints: { rerank: 'passthrough' },
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [{ name: 'session_cookie', kind: 'cookie', required: true }],
      runtime: { kind: 'session_token', field: 'session_cookie' },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
  veloera: buildContract('veloera', {
    proxyEndpoints: { rerank: 'passthrough' },
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [{ name: 'session_cookie', kind: 'cookie', required: true }],
      runtime: { kind: 'session_token', field: 'session_cookie' },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
  }),
  anyrouter: buildContract('anyrouter', {
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [{ name: 'session_cookie', kind: 'cookie', required: true }],
      runtime: { kind: 'session_token', field: 'session_cookie' },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
  }),
  sub2api: buildContract('sub2api', {
    credentialKinds: ['session_token', 'cookie', 'api_key', 'browser_storage'],
    probePolicy: 'explicit_only',
    browser: {
      supported: true,
      modes: ['manual', 'assisted', 'managed'],
      allowedOrigins: ['same-origin'],
      fields: [
        {
          name: 'auth_token',
          kind: 'local_storage',
          required: true,
          capture: { strategy: 'storage_value', key: 'auth_token' },
        },
        {
          name: 'auth_user',
          kind: 'local_storage',
          required: false,
          capture: { strategy: 'storage_value', key: 'auth_user' },
        },
        {
          name: 'refresh_token',
          kind: 'local_storage',
          required: false,
          capture: { strategy: 'storage_value', key: 'refresh_token' },
        },
        {
          name: 'token_expires_at',
          kind: 'local_storage',
          required: false,
          capture: { strategy: 'storage_value', key: 'token_expires_at' },
        },
      ],
      runtime: {
        kind: 'session_token',
        field: 'auth_token',
        usernameField: 'auth_user',
        refreshTokenField: 'refresh_token',
        tokenExpiresAtField: 'token_expires_at',
      },
      taskTtlSec: 300,
      requiresUserGesture: true,
    },
    checkin: { support: 'unsupported', idempotency: 'unknown', allowsAutomaticExecution: false },
  }),
};

export function getSiteAdapterContract(platformName: string): SiteAdapterContract {
  const normalized = String(platformName || '').trim().toLowerCase();
  return cloneContract(CONTRACTS[normalized] || buildContract(normalized || 'unknown'));
}

export function listSiteAdapterContracts(): SiteAdapterContract[] {
  return Object.values(CONTRACTS).map(cloneContract);
}

export function validateSiteAdapterContract(contract: SiteAdapterContract): string[] {
  const errors: string[] = [];
  if (!contract.platformName.trim()) errors.push('platformName is required');
  if (contract.browser.supported && contract.browser.modes.length === 0) {
    errors.push('supported browser contract must declare at least one recovery mode');
  }
  if (contract.browser.supported && contract.browser.allowedOrigins.length === 0) {
    errors.push('supported browser contract must declare allowed origins');
  }
  if (contract.browser.taskTtlSec < 30 || contract.browser.taskTtlSec > 3600) {
    errors.push('browser taskTtlSec must be between 30 and 3600 seconds');
  }
  for (const field of contract.browser.fields) {
    if (!field.capture) continue;
    const key = field.capture.key?.trim() || '';
    const path = field.capture.path || [];
    if (field.capture.strategy === 'cookie_header' && field.kind !== 'cookie') {
      errors.push(`browser field ${field.name} uses cookie_header outside cookie kind`);
    }
    if (field.capture.strategy === 'named_cookie' && (field.kind !== 'cookie' || !key)) {
      errors.push(`browser field ${field.name} has invalid named_cookie capture`);
    }
    if (
      (field.capture.strategy === 'storage_value' || field.capture.strategy === 'json_path')
      && !['local_storage', 'session_storage'].includes(field.kind)
    ) {
      errors.push(`browser field ${field.name} uses Storage capture outside Storage kind`);
    }
    if (field.capture.strategy === 'storage_value' && !key) {
      errors.push(`browser field ${field.name} has invalid storage_value capture`);
    }
    if (field.capture.strategy === 'json_path' && (!key || path.length === 0 || path.some((part) => !part.trim()))) {
      errors.push(`browser field ${field.name} has invalid json_path capture`);
    }
  }
  if (contract.browser.supported) {
    const runtime = contract.browser.runtime;
    const fieldNames = new Set(contract.browser.fields.map((field) => field.name));
    if (!runtime) {
      errors.push('supported browser contract must declare runtime promotion');
    } else {
      for (const fieldName of [
        runtime.field,
        runtime.usernameField,
        runtime.platformUserIdField,
        runtime.refreshTokenField,
        runtime.tokenExpiresAtField,
      ]) {
        if (fieldName && !fieldNames.has(fieldName)) {
          errors.push(`browser runtime references unknown field ${fieldName}`);
        }
      }
    }
  }
  if (contract.modelSync.retireMissingAfterConsecutiveRuns < 1) {
    errors.push('model sync retirement threshold must be positive');
  }
  if (contract.checkin.support !== 'supported' && contract.checkin.allowsAutomaticExecution) {
    errors.push('unsupported/manual checkin cannot allow automatic execution');
  }
  return errors;
}
