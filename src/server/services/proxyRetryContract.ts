/**
 * Neutral retry vocabulary shared by proxy surfaces, channel selection, and
 * future request-attempt ledgers.
 *
 * The contract deliberately contains no transport or database code. Callers
 * can snapshot it into a request and make retry decisions without coupling
 * route handlers to a particular upstream gateway.
 */

export type RetryOwner = 'local_proxy' | 'upstream_gateway' | 'cooperative';

/**
 * `safe_only` is the default: once delivery is ambiguous, do not replay.
 * `allow_explicit` requires the caller to opt into an unsafe replay for the
 * specific request or route.
 */
export type ReplaySafety = 'safe_only' | 'allow_explicit';

export type AttemptCommitState =
  | 'not_started'
  | 'request_sent'
  | 'response_started'
  | 'completed'
  | 'sent_unknown';

export type RetryErrorScope =
  | 'request'
  | 'transport'
  | 'credential'
  | 'model_capability'
  | 'upstream_gateway'
  | 'stream'
  | 'unknown';

const RETRYABLE_PRE_OUTPUT_STREAM_FAILURE_PATTERNS: RegExp[] = [
  /overload(?:ed)?/i,
  /server\s+(?:is\s+)?busy/i,
  /service\s+unavailable/i,
  /temporar(?:y|ily)\s+unavailable/i,
  /try\s+again\s+later/i,
  /rate\s+limit/i,
  /too\s+many\s+requests/i,
  /quota(?:\s+exceeded)?/i,
];

export function shouldRetryPreOutputStreamFailure(upstreamErrorText?: string | null): boolean {
  const text = (upstreamErrorText || '').trim();
  if (!text) return false;
  return RETRYABLE_PRE_OUTPUT_STREAM_FAILURE_PATTERNS.some((pattern) => pattern.test(text));
}

export type RetryBudgetLimits = {
  /** Maximum wall-clock time for the whole request, not each attempt. */
  maxElapsedMs?: number | null;
  /** Total outgoing attempts, including the first attempt. */
  maxAttempts?: number | null;
  /** Successful credential refresh/rotation operations. */
  maxCredentialRotations?: number | null;
  /** Channel changes after the initially selected channel. */
  maxChannelSwitches?: number | null;
};

export type RetryBudgetState = {
  startedAtMs: number;
  limits: {
    maxElapsedMs: number | null;
    maxAttempts: number | null;
    maxCredentialRotations: number | null;
    maxChannelSwitches: number | null;
  };
  attempts: number;
  credentialRotations: number;
  channelSwitches: number;
};

export type RetryBudgetSpend = {
  nowMs?: number;
  attempt?: boolean;
  credentialRotation?: boolean;
  channelSwitch?: boolean;
};

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
  /does\s+not\s+allow\s+\/v1\/[a-z0-9/_:-]+\s+dispatch/i,
  /unsupported\s+(?:endpoint|path)/i,
  /unknown\s+endpoint/i,
  /unrecognized\s+request\s+url/i,
  /no\s+route\s+matched/i,
];

function matchesFailurePattern(patterns: RegExp[], rawErrorText?: string | null): boolean {
  const text = String(rawErrorText || '').trim();
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}

function extractStructuredFailure(rawErrorText?: string | null): {
  message: string;
  type: string;
  code: string;
} | null {
  const text = String(rawErrorText || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const root = parsed as Record<string, unknown>;
    const error = root.error && typeof root.error === 'object'
      ? root.error as Record<string, unknown>
      : root;
    return {
      message: typeof error.message === 'string' ? error.message.replace(/\s+/g, ' ').trim() : '',
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

/**
 * Some compatibility gateways erase the real cause and only return a bare
 * `400 Bad Request` (or an empty `upstream_error`). That response is not enough
 * evidence to declare the downstream request invalid on every channel.
 */
export function isGenericUpstreamBadRequest(
  status: number,
  rawErrorText?: string | null,
): boolean {
  if (status !== 400 || isExplicitRequestFailure(rawErrorText)) return false;

  const text = String(rawErrorText || '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  const structured = extractStructuredFailure(text);
  if (structured) {
    const genericMessage = !structured.message
      || /^(?:400\s+)?bad\s+request[.!]?$/i.test(structured.message);
    const genericType = !structured.type || /^upstream_error$/i.test(structured.type);
    const genericCode = !structured.code || /^(?:400|bad_request|upstream_error)$/i.test(structured.code);
    if (genericMessage && genericType && genericCode) return true;
  }

  return (
    /^(?:400\s+)?bad\s+request[.!]?$/i.test(text)
    || /upstream\s+returned\s+http\s+400(?::\s*(?:400\s+)?bad\s+request[.!]?)?$/i.test(text)
    || /^(?:\[upstream:[^\]]+\]\s*)?(?:upstream\s+returned\s+http\s+400:\s*)?upstream_error[.!]?$/i.test(text)
  );
}

export type RetryBudgetExhaustion =
  | 'elapsed'
  | 'attempts'
  | 'credential_rotations'
  | 'channel_switches';

export type RetryBudgetDecision =
  | {
    allowed: true;
    state: RetryBudgetState;
    elapsedMs: number;
  }
  | {
    allowed: false;
    state: RetryBudgetState;
    elapsedMs: number;
    reason: RetryBudgetExhaustion;
  };

function normalizeClock(nowMs?: number): number {
  return Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs as number)) : Date.now();
}

function normalizeLimit(value: number | null | undefined, minimum: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(minimum, Math.trunc(value));
}

export function createRetryBudget(input: RetryBudgetLimits & { nowMs?: number } = {}): RetryBudgetState {
  return {
    startedAtMs: normalizeClock(input.nowMs),
    limits: {
      maxElapsedMs: normalizeLimit(input.maxElapsedMs, 0),
      maxAttempts: normalizeLimit(input.maxAttempts, 1),
      maxCredentialRotations: normalizeLimit(input.maxCredentialRotations, 0),
      maxChannelSwitches: normalizeLimit(input.maxChannelSwitches, 0),
    },
    attempts: 0,
    credentialRotations: 0,
    channelSwitches: 0,
  };
}

function withBudgetSpend(state: RetryBudgetState, spend: RetryBudgetSpend): RetryBudgetState {
  return {
    ...state,
    attempts: state.attempts + (spend.attempt === true ? 1 : 0),
    credentialRotations: state.credentialRotations + (spend.credentialRotation === true ? 1 : 0),
    channelSwitches: state.channelSwitches + (spend.channelSwitch === true ? 1 : 0),
  };
}

/**
 * Atomically checks and spends one or more units from the shared request
 * budget. A denied spend leaves the state unchanged so the caller can return
 * a stable diagnostic snapshot.
 */
export function spendRetryBudget(state: RetryBudgetState, spend: RetryBudgetSpend = {}): RetryBudgetDecision {
  const nowMs = normalizeClock(spend.nowMs);
  const elapsedMs = Math.max(0, nowMs - state.startedAtMs);
  const nextState = withBudgetSpend(state, spend);

  if (state.limits.maxElapsedMs !== null && elapsedMs > state.limits.maxElapsedMs) {
    return { allowed: false, state, elapsedMs, reason: 'elapsed' };
  }
  if (state.limits.maxAttempts !== null && nextState.attempts > state.limits.maxAttempts) {
    return { allowed: false, state, elapsedMs, reason: 'attempts' };
  }
  if (
    state.limits.maxCredentialRotations !== null
    && nextState.credentialRotations > state.limits.maxCredentialRotations
  ) {
    return { allowed: false, state, elapsedMs, reason: 'credential_rotations' };
  }
  if (state.limits.maxChannelSwitches !== null && nextState.channelSwitches > state.limits.maxChannelSwitches) {
    return { allowed: false, state, elapsedMs, reason: 'channel_switches' };
  }

  return { allowed: true, state: nextState, elapsedMs };
}

export type LocalRetryDecisionInput = {
  retryOwner: RetryOwner;
  replaySafety: ReplaySafety;
  commitState: AttemptCommitState;
  errorScope: RetryErrorScope;
  /** True when the upstream has already claimed responsibility for retrying. */
  upstreamRetryable?: boolean;
  /** Explicit per-request opt-in for replaying an ambiguous send. */
  explicitReplay?: boolean;
};

/**
 * Answers only the local replay question. It does not consume a budget and it
 * does not decide whether another channel is healthy; those remain separate
 * concerns owned by the conductor and channel selector.
 */
export function canRetryLocally(input: LocalRetryDecisionInput): boolean {
  if (input.errorScope === 'request') return false;
  if (input.retryOwner === 'upstream_gateway') return false;
  if (input.retryOwner === 'cooperative' && input.upstreamRetryable === true) return false;
  if (input.commitState === 'completed' || input.commitState === 'response_started') return false;
  if (input.commitState === 'sent_unknown') {
    return input.replaySafety === 'allow_explicit' && input.explicitReplay === true;
  }
  return true;
}

export type AttemptCommitEvent =
  | 'request_sent'
  | 'response_started'
  | 'completed'
  | 'transport_unknown';

/**
 * Small state transition helper for transports that can report whether a
 * request was committed. Once delivery is ambiguous, the state is sticky.
 */
export function advanceAttemptCommitState(
  state: AttemptCommitState,
  event: AttemptCommitEvent,
): AttemptCommitState {
  if (state === 'sent_unknown' || state === 'completed') return state;
  if (event === 'transport_unknown') return 'sent_unknown';
  if (event === 'completed') return 'completed';
  if (event === 'response_started') return 'response_started';
  if (event === 'request_sent' && state === 'not_started') return 'request_sent';
  return state;
}

export function classifyRetryErrorScope(input: {
  status?: number;
  rawErrorText?: string | null;
}): RetryErrorScope {
  const status = input.status ?? 0;
  const text = (input.rawErrorText || '').trim();

  if (status === 401 || status === 403 || /invalid\s+(?:api\s+key|access\s+token)|token\s+expired/i.test(text)) {
    return 'credential';
  }
  if (
    /unsupported\s+model|model\s+not\s+supported|does\s+not\s+exist|unknown\s+model|no\s+such\s+model/i.test(text)
  ) {
    return 'model_capability';
  }
  if (isChannelLocalFailure(text)) {
    return 'upstream_gateway';
  }
  if (isExplicitRequestFailure(text) || status === 422) {
    return 'request';
  }
  if (isGenericUpstreamBadRequest(status, text)) return 'unknown';
  if (status === 400) return 'request';
  if (
    status === 408
    || status === 425
    || status === 429
    || status >= 500
    || /timed\s+out|connection\s+(?:reset|refused)|econn(?:reset|refused)|rate\s+limit|quota/i.test(text)
  ) {
    return 'upstream_gateway';
  }
  if (/stream|sse|websocket/i.test(text)) return 'stream';
  if (/network|dns|socket|fetch/i.test(text)) return 'transport';
  return 'unknown';
}
