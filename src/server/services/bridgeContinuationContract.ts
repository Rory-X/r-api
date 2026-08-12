import { createHash } from 'node:crypto';

export const BRIDGE_FAILURE_CLASSES = [
  'rate_limited',
  'concurrency_limited',
  'service_temporary',
  'transport_failure',
  'stream_interrupted',
  'retry_exhausted',
  'usage_limit',
  'context_exhausted',
  'session_budget_exhausted',
  'authentication_failure',
  'request_invalid',
  'policy_rejected',
  'sandbox_failure',
  'turn_conflict',
  'cancelled',
  'unknown',
] as const;

export type BridgeFailureClass = typeof BRIDGE_FAILURE_CLASSES[number];
export type BridgeFailureSource =
  | 'error_notification'
  | 'turn_completed'
  | 'control_error'
  | 'gateway_observation';
export type BridgeFailureRecoverability = 'transient' | 'conditional' | 'terminal';
export type CodexThreadStatus = 'unknown' | 'not_loaded' | 'idle' | 'active' | 'system_error';
export type CodexThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type ClassifiedBridgeFailure = Readonly<{
  failureClass: BridgeFailureClass;
  source: BridgeFailureSource;
  recoverability: BridgeFailureRecoverability;
  codexErrorCode: string | null;
  httpStatusCode: number | null;
  messageSummary: string;
  messageFingerprint: string;
  willRetry: boolean | null;
}>;

export type BridgeFailureInput = {
  source?: BridgeFailureSource;
  codexErrorInfo?: unknown;
  httpStatusCode?: unknown;
  message?: unknown;
  willRetry?: unknown;
};

const CODEX_OBJECT_ERROR_KEYS = [
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
  'activeTurnNotSteerable',
] as const;

const TRANSIENT_FAILURES = new Set<BridgeFailureClass>([
  'rate_limited',
  'concurrency_limited',
  'service_temporary',
  'transport_failure',
  'stream_interrupted',
]);

const CONDITIONAL_FAILURES = new Set<BridgeFailureClass>([
  'retry_exhausted',
  'usage_limit',
  'sandbox_failure',
  'turn_conflict',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeHttpStatus(value: unknown): number | null {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 999) return null;
  return status;
}

function safeMessageSummary(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return Buffer.from(normalized, 'utf8').subarray(0, 500).toString('utf8');
}

function extractCodexErrorInfo(value: unknown): {
  code: string | null;
  httpStatusCode: number | null;
} {
  if (typeof value === 'string' && value.trim()) {
    return { code: value.trim(), httpStatusCode: null };
  }
  if (!isRecord(value)) return { code: null, httpStatusCode: null };
  for (const key of CODEX_OBJECT_ERROR_KEYS) {
    if (!(key in value)) continue;
    const details = isRecord(value[key]) ? value[key] as Record<string, unknown> : null;
    return {
      code: key,
      httpStatusCode: normalizeHttpStatus(details?.httpStatusCode),
    };
  }
  return { code: null, httpStatusCode: null };
}

function recoverabilityForFailure(failureClass: BridgeFailureClass): BridgeFailureRecoverability {
  if (TRANSIENT_FAILURES.has(failureClass)) return 'transient';
  if (CONDITIONAL_FAILURES.has(failureClass)) return 'conditional';
  return 'terminal';
}

function classifyByStatusAndMessage(status: number | null, message: string): BridgeFailureClass | null {
  if (/already has an active writer|active writer (?:is )?(?:held|owned|busy)|writer lock/i.test(message)) {
    return 'turn_conflict';
  }
  if (/concurren(?:t|cy)|too many active requests|maximum active requests|并发(?:数|限制|上限)/i.test(message)) {
    return 'concurrency_limited';
  }
  if (/context window|maximum context|context length|too many tokens|上下文(?:窗口|长度|超限)/i.test(message)) {
    return 'context_exhausted';
  }
  if (/session budget|turn budget|会话预算/i.test(message)) return 'session_budget_exhausted';
  if (/usage limit|insufficient quota|billing quota|credits? exhausted|额度(?:不足|耗尽)|用量限制/i.test(message)) {
    return 'usage_limit';
  }
  if (/unauthori[sz]ed|invalid (?:api key|access token)|token expired|authentication failed|未授权|凭证无效/i.test(message)) {
    return 'authentication_failure';
  }
  if (/cyber policy|content policy|policy rejected|安全策略|内容策略/i.test(message)) return 'policy_rejected';
  if (/sandbox|permission denied|operation not permitted|沙箱|权限不足/i.test(message)) return 'sandbox_failure';
  if (/cancelled|canceled|interrupted by user|aborted by user|用户(?:取消|中断)/i.test(message)) return 'cancelled';
  if (/active turn.*not steerable|cannot accept.*steer|当前.*turn.*不可.*steer/i.test(message)) return 'turn_conflict';
  if (/response.*too many failed attempts|retry (?:limit|exhausted)|重试(?:次数|已耗尽|上限)/i.test(message)) {
    return 'retry_exhausted';
  }
  if (status === 429 || /rate limit|too many requests|请求过多|限流/i.test(message)) return 'rate_limited';
  if (
    status === 408
    || status === 425
    || (status !== null && status >= 500)
    || /temporar(?:y|ily) unavailable|service temperate|server overloaded|server busy|upstream unavailable|服务暂时不可用|服务器繁忙/i.test(message)
  ) {
    return 'service_temporary';
  }
  if (/stream.*(?:disconnect|closed|failed)|sse.*(?:disconnect|closed|failed)|响应流.*(?:断开|失败)/i.test(message)) {
    return 'stream_interrupted';
  }
  if (/connection (?:failed|reset|refused)|network|dns|tls|socket|econn|网络|连接失败/i.test(message)) {
    return 'transport_failure';
  }
  if (status === 401 || status === 403) return 'authentication_failure';
  if (status === 400 || status === 404 || status === 409 || status === 422) return 'request_invalid';
  if (/invalid request|bad request|validation|malformed|无法解析|请求无效/i.test(message)) return 'request_invalid';
  return null;
}

function classifyCodexError(
  code: string | null,
  status: number | null,
  message: string,
): BridgeFailureClass {
  if (code === 'activeTurnNotSteerable') return 'turn_conflict';
  if (code === 'contextWindowExceeded') return 'context_exhausted';
  if (code === 'sessionBudgetExceeded') return 'session_budget_exhausted';
  if (code === 'usageLimitExceeded') return 'usage_limit';
  if (code === 'cyberPolicy') return 'policy_rejected';
  if (code === 'unauthorized') return 'authentication_failure';
  if (code === 'badRequest') return 'request_invalid';
  if (code === 'sandboxError') return 'sandbox_failure';

  const messageClass = classifyByStatusAndMessage(status, message);
  if (messageClass) return messageClass;

  if (code === 'serverOverloaded' || code === 'internalServerError') return 'service_temporary';
  if (code === 'httpConnectionFailed') return 'transport_failure';
  if (code === 'responseStreamConnectionFailed' || code === 'responseStreamDisconnected') {
    return 'stream_interrupted';
  }
  if (code === 'responseTooManyFailedAttempts') return 'retry_exhausted';
  return 'unknown';
}

export function classifyBridgeFailure(input: BridgeFailureInput): ClassifiedBridgeFailure {
  const codex = extractCodexErrorInfo(input.codexErrorInfo);
  const httpStatusCode = normalizeHttpStatus(input.httpStatusCode) ?? codex.httpStatusCode;
  const messageSummary = safeMessageSummary(input.message);
  const failureClass = classifyCodexError(codex.code, httpStatusCode, messageSummary);
  const willRetry = typeof input.willRetry === 'boolean' ? input.willRetry : null;
  return Object.freeze({
    failureClass,
    source: input.source || 'control_error',
    recoverability: recoverabilityForFailure(failureClass),
    codexErrorCode: codex.code,
    httpStatusCode,
    messageSummary,
    messageFingerprint: createHash('sha256')
      .update(`${codex.code || ''}\0${httpStatusCode || ''}\0${messageSummary}`)
      .digest('hex'),
    willRetry,
  });
}

export function isBridgeWriterContentionFailure(failure: ClassifiedBridgeFailure): boolean {
  return failure.source === 'control_error'
    && /already has an active writer|active writer (?:is )?(?:held|owned|busy)|writer lock/i
      .test(failure.messageSummary);
}

export type BridgeContinuationRuleAction =
  | 'stop'
  | 'continue_same_route'
  | 'continue_rotate_credential'
  | 'continue_switch_channel';

export type BridgeContinuationLimit =
  | Readonly<{ mode: 'bounded'; maxContinuations: number }>
  | Readonly<{ mode: 'unlimited' }>;

export type BridgeContinuationRule = Readonly<{
  action: BridgeContinuationRuleAction;
  limit: BridgeContinuationLimit;
}>;

export type BridgeContinuationBackoff = Readonly<{
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}>;

export type BridgeContinuationPolicySnapshot = Readonly<{
  capturedAt: string;
  fingerprint: string;
  policyVersion: number;
  enabled: boolean;
  continuePrompt: string;
  maxElapsedMs: number | null;
  backoff: BridgeContinuationBackoff;
  rules: Readonly<Record<BridgeFailureClass, BridgeContinuationRule>>;
}>;

export type BridgeContinuationRuleInput = {
  action?: unknown;
  limit?: unknown;
  maxContinuations?: unknown;
};

export type BridgeContinuationPolicyInput = {
  policyVersion?: unknown;
  enabled?: unknown;
  continuePrompt?: unknown;
  maxElapsedMs?: unknown;
  backoff?: {
    initialDelayMs?: unknown;
    maxDelayMs?: unknown;
    multiplier?: unknown;
    jitterRatio?: unknown;
  } | null;
  rules?: Partial<Record<BridgeFailureClass, BridgeContinuationRuleInput>> | null;
};

function bounded(maxContinuations: number): BridgeContinuationLimit {
  return Object.freeze({ mode: 'bounded', maxContinuations });
}

function unlimited(): BridgeContinuationLimit {
  return Object.freeze({ mode: 'unlimited' });
}

const DEFAULT_BRIDGE_CONTINUATION_RULES: Readonly<Record<BridgeFailureClass, BridgeContinuationRule>> = Object.freeze({
  rate_limited: Object.freeze({ action: 'continue_same_route', limit: bounded(5) }),
  concurrency_limited: Object.freeze({ action: 'continue_same_route', limit: bounded(5) }),
  service_temporary: Object.freeze({ action: 'continue_same_route', limit: bounded(5) }),
  transport_failure: Object.freeze({ action: 'continue_same_route', limit: bounded(3) }),
  stream_interrupted: Object.freeze({ action: 'continue_same_route', limit: bounded(3) }),
  retry_exhausted: Object.freeze({ action: 'continue_rotate_credential', limit: bounded(3) }),
  usage_limit: Object.freeze({ action: 'stop', limit: bounded(1) }),
  context_exhausted: Object.freeze({ action: 'stop', limit: bounded(1) }),
  session_budget_exhausted: Object.freeze({ action: 'stop', limit: bounded(1) }),
  authentication_failure: Object.freeze({ action: 'stop', limit: bounded(1) }),
  request_invalid: Object.freeze({ action: 'stop', limit: bounded(1) }),
  policy_rejected: Object.freeze({ action: 'stop', limit: bounded(1) }),
  sandbox_failure: Object.freeze({ action: 'stop', limit: bounded(1) }),
  turn_conflict: Object.freeze({ action: 'stop', limit: bounded(1) }),
  cancelled: Object.freeze({ action: 'stop', limit: bounded(1) }),
  unknown: Object.freeze({ action: 'stop', limit: bounded(1) }),
});

const RULE_ACTIONS = new Set<BridgeContinuationRuleAction>([
  'stop',
  'continue_same_route',
  'continue_rotate_credential',
  'continue_switch_channel',
]);

function normalizeInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function normalizeRule(input: BridgeContinuationRuleInput | undefined, fallback: BridgeContinuationRule): BridgeContinuationRule {
  const normalizedAction = String(input?.action || '').trim() as BridgeContinuationRuleAction;
  const action = RULE_ACTIONS.has(normalizedAction) ? normalizedAction : fallback.action;
  const rawLimit = input?.limit;
  const limitRecord = isRecord(rawLimit) ? rawLimit : null;
  const limitMode = typeof rawLimit === 'string'
    ? rawLimit
    : typeof limitRecord?.mode === 'string'
      ? limitRecord.mode
      : '';
  let limit: BridgeContinuationLimit;
  if (limitMode === 'unlimited') {
    limit = unlimited();
  } else {
    const fallbackMax = fallback.limit.mode === 'bounded' ? fallback.limit.maxContinuations : 5;
    const rawMax = typeof rawLimit === 'number'
      ? rawLimit
      : limitRecord?.maxContinuations ?? input?.maxContinuations;
    limit = bounded(normalizeInteger(rawMax, fallbackMax, 1, 10_000));
  }
  return Object.freeze({ action, limit });
}

function normalizeMaxElapsedMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, 365 * 24 * 60 * 60 * 1_000);
}

function normalizePrompt(value: unknown): string {
  const prompt = typeof value === 'string' ? value.trim() : '';
  return (prompt || '继续').slice(0, 4_000);
}

export function snapshotBridgeContinuationPolicy(
  input: BridgeContinuationPolicyInput = {},
  nowMs = Date.now(),
): BridgeContinuationPolicySnapshot {
  const initialDelayMs = normalizeInteger(input.backoff?.initialDelayMs, 5_000, 250, 24 * 60 * 60 * 1_000);
  const maxDelayMs = normalizeInteger(
    input.backoff?.maxDelayMs,
    5 * 60 * 1_000,
    initialDelayMs,
    7 * 24 * 60 * 60 * 1_000,
  );
  const backoff = Object.freeze({
    initialDelayMs,
    maxDelayMs,
    multiplier: normalizeNumber(input.backoff?.multiplier, 2, 1, 10),
    jitterRatio: normalizeNumber(input.backoff?.jitterRatio, 0.2, 0, 1),
  });
  const rules = {} as Record<BridgeFailureClass, BridgeContinuationRule>;
  for (const failureClass of BRIDGE_FAILURE_CLASSES) {
    rules[failureClass] = normalizeRule(input.rules?.[failureClass], DEFAULT_BRIDGE_CONTINUATION_RULES[failureClass]);
  }
  const normalized = {
    policyVersion: normalizeInteger(input.policyVersion, 1, 1, Number.MAX_SAFE_INTEGER),
    enabled: input.enabled === true,
    continuePrompt: normalizePrompt(input.continuePrompt),
    maxElapsedMs: normalizeMaxElapsedMs(input.maxElapsedMs),
    backoff,
    rules: Object.freeze(rules),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const capturedAtMs = Number.isFinite(nowMs) ? Math.max(0, Math.trunc(nowMs)) : Date.now();
  return Object.freeze({
    capturedAt: new Date(capturedAtMs).toISOString(),
    fingerprint,
    ...normalized,
  });
}

/** Parses an HTTP Retry-After value supplied by the gateway. App Server errors do not expose this field. */
export function parseRetryAfterMs(value: unknown, nowMs = Date.now()): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value * 1_000);
  }
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Math.round(Number(normalized) * 1_000);
  const targetMs = Date.parse(normalized);
  if (!Number.isFinite(targetMs)) return null;
  const clock = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
  return Math.max(0, targetMs - clock);
}

export function computeBridgeContinuationDelay(input: {
  backoff: BridgeContinuationBackoff;
  continuationNumber: number;
  retryAfterMs?: number | null;
  jitterUnit?: number;
}): number {
  const continuationNumber = Math.max(1, Math.trunc(input.continuationNumber));
  const exponent = Math.min(52, continuationNumber - 1);
  const baseDelay = Math.min(
    input.backoff.maxDelayMs,
    input.backoff.initialDelayMs * (input.backoff.multiplier ** exponent),
  );
  const jitterUnit = Number.isFinite(input.jitterUnit)
    ? Math.min(1, Math.max(0, input.jitterUnit as number))
    : 0.5;
  const jitterMultiplier = 1 + ((jitterUnit * 2) - 1) * input.backoff.jitterRatio;
  const jitteredDelay = Math.max(0, Math.round(baseDelay * jitterMultiplier));
  const retryAfterMs = Number.isFinite(input.retryAfterMs)
    ? Math.max(0, Math.trunc(input.retryAfterMs as number))
    : 0;
  return Math.max(jitteredDelay, retryAfterMs);
}

export type BridgeRouteAction = 'preserve' | 'rotate_credential' | 'switch_channel';
export type BridgeContinuationWaitReason =
  | 'codex_internal_retry'
  | 'waiting_on_approval'
  | 'waiting_on_user_input'
  | 'thread_active'
  | 'thread_state_unknown'
  | 'thread_not_ready';
export type BridgeContinuationStopReason = 'policy_disabled' | 'policy_stop';
export type BridgeContinuationDeadReason = 'unrecoverable_failure' | 'attempt_limit' | 'elapsed_limit';

export type BridgeContinuationDecision =
  | Readonly<{ kind: 'wait'; reason: BridgeContinuationWaitReason }>
  | Readonly<{ kind: 'stop'; reason: BridgeContinuationStopReason }>
  | Readonly<{ kind: 'dead'; reason: BridgeContinuationDeadReason }>
  | Readonly<{
    kind: 'schedule';
    method: 'turn/start';
    continuationNumber: number;
    routeAction: BridgeRouteAction;
    prompt: string;
    delayMs: number;
    nextRunAtMs: number;
  }>;

function routeActionForRule(action: BridgeContinuationRuleAction): BridgeRouteAction {
  if (action === 'continue_rotate_credential') return 'rotate_credential';
  if (action === 'continue_switch_channel') return 'switch_channel';
  return 'preserve';
}

export function evaluateBridgeContinuation(input: {
  policy: BridgeContinuationPolicySnapshot;
  failure: ClassifiedBridgeFailure;
  continuationCount: number;
  taskStartedAtMs: number;
  nowMs?: number;
  retryAfterMs?: number | null;
  jitterUnit?: number;
  threadStatus?: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  turnTerminal?: boolean;
}): BridgeContinuationDecision {
  if (input.failure.willRetry === true) return Object.freeze({ kind: 'wait', reason: 'codex_internal_retry' });
  if (input.activeFlags?.includes('waitingOnApproval')) {
    return Object.freeze({ kind: 'wait', reason: 'waiting_on_approval' });
  }
  if (input.activeFlags?.includes('waitingOnUserInput')) {
    return Object.freeze({ kind: 'wait', reason: 'waiting_on_user_input' });
  }
  const threadStatus = input.threadStatus || 'unknown';
  if (threadStatus === 'active' && input.turnTerminal !== true) {
    return Object.freeze({ kind: 'wait', reason: 'thread_active' });
  }
  if (threadStatus === 'unknown' && input.turnTerminal !== true) {
    return Object.freeze({ kind: 'wait', reason: 'thread_state_unknown' });
  }
  if (threadStatus === 'not_loaded' || threadStatus === 'system_error') {
    return Object.freeze({ kind: 'wait', reason: 'thread_not_ready' });
  }
  if (!input.policy.enabled) return Object.freeze({ kind: 'stop', reason: 'policy_disabled' });

  const rule = input.policy.rules[input.failure.failureClass];
  if (rule.action === 'stop') {
    return input.failure.recoverability === 'terminal'
      ? Object.freeze({ kind: 'dead', reason: 'unrecoverable_failure' })
      : Object.freeze({ kind: 'stop', reason: 'policy_stop' });
  }

  const nowMs = Number.isFinite(input.nowMs) ? Math.max(0, Math.trunc(input.nowMs as number)) : Date.now();
  const startedAtMs = Number.isFinite(input.taskStartedAtMs)
    ? Math.max(0, Math.trunc(input.taskStartedAtMs))
    : nowMs;
  if (input.policy.maxElapsedMs !== null && nowMs - startedAtMs > input.policy.maxElapsedMs) {
    return Object.freeze({ kind: 'dead', reason: 'elapsed_limit' });
  }

  const continuationCount = Math.max(0, Math.trunc(input.continuationCount));
  if (rule.limit.mode === 'bounded' && continuationCount >= rule.limit.maxContinuations) {
    return Object.freeze({ kind: 'dead', reason: 'attempt_limit' });
  }
  const continuationNumber = continuationCount + 1;
  const delayMs = computeBridgeContinuationDelay({
    backoff: input.policy.backoff,
    continuationNumber,
    retryAfterMs: input.retryAfterMs,
    jitterUnit: input.jitterUnit,
  });
  return Object.freeze({
    kind: 'schedule',
    method: 'turn/start',
    continuationNumber,
    routeAction: routeActionForRule(rule.action),
    prompt: input.policy.continuePrompt,
    delayMs,
    nextRunAtMs: nowMs + delayMs,
  });
}

export type BridgeTurnSubmissionDecision =
  | Readonly<{
    kind: 'wait';
    reason: 'interaction_response_required' | 'thread_active' | 'active_turn_id_unknown' | 'active_turn_not_steerable' | 'thread_not_ready';
  }>
  | Readonly<{
    kind: 'request';
    method: 'turn/start' | 'turn/steer';
    threadId: string;
    expectedTurnId?: string;
    input: readonly [{ readonly type: 'text'; readonly text: string }];
  }>;

export function resolveBridgeTurnSubmission(input: {
  source: 'automatic' | 'manual';
  threadId: string;
  prompt: string;
  threadStatus: CodexThreadStatus;
  activeFlags?: readonly CodexThreadActiveFlag[];
  activeTurnId?: string | null;
  activeTurnSteerable?: boolean;
}): BridgeTurnSubmissionDecision {
  if (input.activeFlags?.length) {
    return Object.freeze({ kind: 'wait', reason: 'interaction_response_required' });
  }
  if (input.threadStatus === 'system_error' || input.threadStatus === 'unknown') {
    return Object.freeze({ kind: 'wait', reason: 'thread_not_ready' });
  }
  if (input.source === 'automatic' && input.threadStatus === 'not_loaded') {
    return Object.freeze({ kind: 'wait', reason: 'thread_not_ready' });
  }
  const textInput = Object.freeze([{ type: 'text' as const, text: normalizePrompt(input.prompt) }]) as readonly [{
    readonly type: 'text';
    readonly text: string;
  }];
  if (input.source === 'automatic') {
    if (input.threadStatus === 'active') return Object.freeze({ kind: 'wait', reason: 'thread_active' });
    return Object.freeze({ kind: 'request', method: 'turn/start', threadId: input.threadId, input: textInput });
  }
  if (input.threadStatus === 'active') {
    if (input.activeTurnSteerable === false) {
      return Object.freeze({ kind: 'wait', reason: 'active_turn_not_steerable' });
    }
    const activeTurnId = input.activeTurnId?.trim();
    if (!activeTurnId) return Object.freeze({ kind: 'wait', reason: 'active_turn_id_unknown' });
    return Object.freeze({
      kind: 'request',
      method: 'turn/steer',
      threadId: input.threadId,
      expectedTurnId: activeTurnId,
      input: textInput,
    });
  }
  return Object.freeze({ kind: 'request', method: 'turn/start', threadId: input.threadId, input: textInput });
}
