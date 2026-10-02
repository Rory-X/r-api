/**
 * Canonical failure vocabulary shared by retry, health, routing and alerts.
 * The contract is protocol- and persistence-neutral so every surface can
 * expose the same classification without importing a route or database.
 */

export type OperationalErrorScope =
  | 'request'
  | 'transport'
  | 'credential'
  | 'model_capability'
  | 'upstream_gateway'
  | 'stream'
  | 'unknown';

export type OperationalHealthDomain =
  | 'endpoint'
  | 'credential'
  | 'model_capability'
  | 'gateway'
  | 'stream'
  | 'request'
  | 'unknown';

export type OperationalAlertCategory =
  | 'request'
  | 'transport'
  | 'authentication'
  | 'compatibility'
  | 'availability'
  | 'capacity'
  | 'verification'
  | 'concurrency'
  | 'unknown';

export type OperationalAlertSeverity = 'info' | 'warning' | 'error';

export type OperationalFailureCode =
  | 'request_invalid'
  | 'credential_unavailable'
  | 'model_unavailable'
  | 'transport_failure'
  | 'upstream_gateway_failure'
  | 'upstream_timeout'
  | 'rate_limited'
  | 'stream_failure'
  | 'verification_required'
  | 'lease_conflict'
  | 'upstream_error'
  | 'unknown_failure';

export type OperationalFailureClassification = Readonly<{
  code: OperationalFailureCode;
  errorScope: OperationalErrorScope;
  healthDomain: OperationalHealthDomain;
  alertCategory: OperationalAlertCategory;
  alertSeverity: OperationalAlertSeverity;
  retryable: boolean;
}>;

export type OperationalFailureHint =
  | 'lease_conflict'
  | 'rate_limited'
  | 'credential_invalid'
  | 'provider_unavailable'
  | 'transient';

export const OPERATIONAL_CLASSIFICATION_VOCABULARY = Object.freeze({
  failureCodes: Object.freeze([
    'request_invalid',
    'credential_unavailable',
    'model_unavailable',
    'transport_failure',
    'upstream_gateway_failure',
    'upstream_timeout',
    'rate_limited',
    'stream_failure',
    'verification_required',
    'lease_conflict',
    'upstream_error',
    'unknown_failure',
  ] satisfies OperationalFailureCode[]),
  errorScopes: Object.freeze([
    'request',
    'transport',
    'credential',
    'model_capability',
    'upstream_gateway',
    'stream',
    'unknown',
  ] satisfies OperationalErrorScope[]),
  healthDomains: Object.freeze([
    'endpoint',
    'credential',
    'model_capability',
    'gateway',
    'stream',
    'request',
    'unknown',
  ] satisfies OperationalHealthDomain[]),
  alertCategories: Object.freeze([
    'request',
    'transport',
    'authentication',
    'compatibility',
    'availability',
    'capacity',
    'verification',
    'concurrency',
    'unknown',
  ] satisfies OperationalAlertCategory[]),
  alertSeverities: Object.freeze([
    'info',
    'warning',
    'error',
  ] satisfies OperationalAlertSeverity[]),
});

const EXPLICIT_REQUEST_FAILURE_PATTERNS: RegExp[] = [
  /invalid\s+request\s+body/i,
  /request\s+validation/i,
  /validation\s+(?:failed|error)/i,
  /missing\s+required/i,
  /required\s+parameter/i,
  /unknown\s+parameter/i,
  /unrecognized\s+(?:field|key|parameter)/i,
  /invalid\s+(?:[^\s]+\s+)?parameter/i,
  /(?:parameter|field|value)\s+[^\s]+\s+must\s+be/i,
  /malformed/i,
  /invalid\s+json/i,
  /cannot\s+parse/i,
  /unsupported\s+media\s+type/i,
  /unprocessable/i,
  /previous_response_not_found/i,
];

const CHANNEL_LOCAL_FAILURE_PATTERNS: RegExp[] = [
  /unsupported\s+(?:legacy\s+)?protocol/i,
  /please\s+use\s+\/v1\/(?:responses|messages|chat\/completions)/i,
  /does\s+not\s+allow\s+\/v1\/[a-z0-9\/_:-]+\s+dispatch/i,
  /unsupported\s+(?:endpoint|path)/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
];

function normalizeText(value?: string | null): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function matchesFailurePattern(patterns: RegExp[], rawErrorText?: string | null): boolean {
  const text = normalizeText(rawErrorText);
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}

function extractStructuredFailure(rawErrorText?: string | null): {
  message: string;
  type: string;
  code: string;
} | null {
  const text = normalizeText(rawErrorText);
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const root = parsed as Record<string, unknown>;
    const error = root.error && typeof root.error === 'object'
      ? root.error as Record<string, unknown>
      : root;
    return {
      message: typeof error.message === 'string' ? normalizeText(error.message) : '',
      type: typeof error.type === 'string' ? error.type.trim() : '',
      code: typeof error.code === 'string' ? error.code.trim() : '',
    };
  } catch {
    return null;
  }
}

export function isExplicitRequestFailure(rawErrorText?: string | null): boolean {
  return matchesFailurePattern(EXPLICIT_REQUEST_FAILURE_PATTERNS, rawErrorText);
}

export function isChannelLocalFailure(rawErrorText?: string | null): boolean {
  return matchesFailurePattern(CHANNEL_LOCAL_FAILURE_PATTERNS, rawErrorText);
}

export function isCloudflareChallengeMessage(message?: string | null): boolean {
  const text = normalizeText(message).toLowerCase();
  return text.includes('cloudflare') || text.includes('cf challenge') || text.includes('challenge required');
}

export function isTokenExpiredMessage(input: { status?: number; message?: string | null }): boolean {
  const rawMessage = normalizeText(input.message);
  const text = rawMessage.toLowerCase();
  if (isChannelLocalFailure(rawMessage)) return false;
  if (input.status === 401 || /(?:^|\b)(?:http\s*)?401(?:\b|:)/i.test(rawMessage)) return true;
  if (!text || text.includes('未登录且未提供 access token')) return false;
  const tokenPhrase = text.includes('token') || text.includes('令牌') || text.includes('访问令牌');
  const hasInvalid = text.includes('invalid') || text.includes('无效');
  const hasExpired = text.includes('expired') || text.includes('过期');
  return text.includes('jwt expired')
    || text.includes('token expired')
    || (tokenPhrase && (hasInvalid || hasExpired))
    || /invalid\s+access\s+token/.test(text)
    || /access\s+token\s+is\s+invalid/.test(text);
}

export function isGenericUpstreamBadRequest(status: number, rawErrorText?: string | null): boolean {
  if (status !== 400 || isExplicitRequestFailure(rawErrorText)) return false;
  const text = normalizeText(rawErrorText);
  if (!text) return true;
  const structured = extractStructuredFailure(text);
  if (structured) {
    const genericMessage = !structured.message || /^(?:400\s+)?bad\s+request[.!]?$/i.test(structured.message);
    const genericType = !structured.type || /^upstream_error$/i.test(structured.type);
    const genericCode = !structured.code || /^(?:400|bad_request|upstream_error)$/i.test(structured.code);
    if (genericMessage && genericType && genericCode) return true;
  }
  return /^(?:400\s+)?bad\s+request[.!]?$/i.test(text)
    || /upstream\s+returned\s+http\s+400(?::\s*(?:400\s+)?bad\s+request[.!]?)?$/i.test(text)
    || /^(?:\[upstream:[^\]]+\]\s*)?(?:upstream\s+returned\s+http\s+400:\s*)?upstream_error[.!]?$/i.test(text);
}

function result(
  code: OperationalFailureCode,
  errorScope: OperationalErrorScope,
  healthDomain: OperationalHealthDomain,
  alertCategory: OperationalAlertCategory,
  alertSeverity: OperationalAlertSeverity,
  retryable: boolean,
): OperationalFailureClassification {
  return Object.freeze({ code, errorScope, healthDomain, alertCategory, alertSeverity, retryable });
}

export function classifyOperationalFailure(input: {
  status?: number;
  rawErrorText?: string | null;
  hint?: OperationalFailureHint | null;
  errorScope?: OperationalErrorScope | null;
}): OperationalFailureClassification {
  const status = Number.isFinite(input.status) ? Math.trunc(input.status as number) : 0;
  const text = normalizeText(input.rawErrorText);
  const lower = text.toLowerCase();
  const hint = input.hint ?? null;

  if (hint === 'lease_conflict') {
    return result('lease_conflict', 'unknown', 'unknown', 'concurrency', 'warning', true);
  }
  if (hint === 'rate_limited') {
    return result('rate_limited', 'upstream_gateway', 'gateway', 'capacity', 'warning', true);
  }
  if (hint === 'credential_invalid') {
    return result('credential_unavailable', 'credential', 'credential', 'authentication', 'error', false);
  }
  if (hint === 'provider_unavailable') {
    return result('upstream_gateway_failure', 'upstream_gateway', 'gateway', 'availability', 'error', true);
  }
  if (hint === 'transient') {
    return result('upstream_error', 'upstream_gateway', 'gateway', 'availability', 'warning', true);
  }

  if (isCloudflareChallengeMessage(text) || /turnstile|captcha|human verification/i.test(lower)) {
    return result('verification_required', 'upstream_gateway', 'gateway', 'verification', 'warning', false);
  }
  if (isChannelLocalFailure(text)) {
    return result('upstream_gateway_failure', 'upstream_gateway', 'gateway', 'compatibility', 'warning', true);
  }
  if (isTokenExpiredMessage({ status, message: text })
    || status === 401
    || status === 403
    || /invalid\s+(?:api\s+key|access\s+token)|token\s+expired/i.test(lower)) {
    return result('credential_unavailable', 'credential', 'credential', 'authentication', 'error', true);
  }
  if (/unsupported\s+model|model\s+(?:is\s+)?not\s+supported|unknown\s+model|no\s+such\s+model|model.*does\s+not\s+exist|不支持.*模型|模型.*不支持/i.test(lower)) {
    return result('model_unavailable', 'model_capability', 'model_capability', 'compatibility', 'warning', true);
  }
  if (isExplicitRequestFailure(text) || status === 422) {
    return result('request_invalid', 'request', 'request', 'request', 'warning', false);
  }
  if (status === 429 || /rate\s*limit|too\s+many\s+requests|quota(?:\s+exceeded)?/i.test(lower)) {
    return result('rate_limited', 'upstream_gateway', 'gateway', 'capacity', 'warning', true);
  }
  if (status === 408 || /first\s+byte\s+timeout|timed?\s*out|etimedout/i.test(lower)) {
    return result('upstream_timeout', 'upstream_gateway', 'gateway', 'availability', 'warning', true);
  }
  if (status === 400 && isGenericUpstreamBadRequest(status, text)) {
    return result('unknown_failure', 'unknown', 'unknown', 'unknown', 'warning', true);
  }
  if (status === 400 || status === 404) {
    return result('request_invalid', 'request', 'request', 'request', 'warning', false);
  }
  if (/\b(?:stream|sse|websocket)\b/i.test(lower)) {
    return result('stream_failure', 'stream', 'stream', 'availability', 'warning', false);
  }
  if (/econn(?:reset|refused)|enotfound|network\s+error|fetch\s+failed|dns|socket\s+(?:hang\s+up|error)/i.test(lower)) {
    return result('transport_failure', 'transport', 'endpoint', 'transport', 'error', true);
  }
  if (status === 425 || status >= 500 || /bad\s+gateway|gateway\s+time-?out|service\s+unavailable|upstream\s+error|temporar(?:y|ily)\s+unavailable/i.test(lower)) {
    return result('upstream_error', 'upstream_gateway', 'gateway', 'availability', 'error', true);
  }
  if (input.errorScope === 'request') {
    return result('request_invalid', 'request', 'request', 'request', 'warning', false);
  }
  if (input.errorScope === 'transport') {
    return result('transport_failure', 'transport', 'endpoint', 'transport', 'error', true);
  }
  if (input.errorScope === 'credential') {
    return result('credential_unavailable', 'credential', 'credential', 'authentication', 'error', true);
  }
  if (input.errorScope === 'model_capability') {
    return result('model_unavailable', 'model_capability', 'model_capability', 'compatibility', 'warning', true);
  }
  if (input.errorScope === 'upstream_gateway') {
    return result('upstream_gateway_failure', 'upstream_gateway', 'gateway', 'availability', 'warning', true);
  }
  if (input.errorScope === 'stream') {
    return result('stream_failure', 'stream', 'stream', 'availability', 'warning', false);
  }
  return result('unknown_failure', 'unknown', 'unknown', 'unknown', 'warning', false);
}
