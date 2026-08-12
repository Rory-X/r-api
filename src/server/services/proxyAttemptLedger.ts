import {
  advanceAttemptCommitState,
  type AttemptCommitEvent,
  type AttemptCommitState,
  type ReplaySafety,
  type RetryBudgetState,
  type RetryErrorScope,
  type RetryOwner,
} from './proxyRetryContract.js';

export type ProxyAttemptStatus = 'in_flight' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type ProxyRequestStatus = 'active' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export type ProxyAttemptPolicySnapshot = {
  retryOwner: RetryOwner;
  replaySafety: ReplaySafety;
  retryBudget: RetryBudgetState;
};

export type ProxyAttemptRecord = {
  attemptId: string;
  attemptIndex: number;
  channelId: number | null;
  credentialId: number | null;
  status: ProxyAttemptStatus;
  commitState: AttemptCommitState;
  errorScope: RetryErrorScope | null;
  statusCode: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
};

export type ProxyRequestRecord = {
  requestId: string;
  requestedModel: string;
  downstreamPath: string;
  status: ProxyRequestStatus;
  createdAtMs: number;
  finishedAtMs: number | null;
  policy: ProxyAttemptPolicySnapshot;
  attempts: ProxyAttemptRecord[];
};

export type ProxyAttemptLedger = {
  beginRequest(input: {
    requestId?: string;
    requestedModel: string;
    downstreamPath: string;
    policy: ProxyAttemptPolicySnapshot;
    nowMs?: number;
  }): ProxyRequestRecord;
  beginAttempt(input: {
    requestId: string;
    attemptId?: string;
    attemptIndex: number;
    channelId?: number | null;
    credentialId?: number | null;
    nowMs?: number;
  }): ProxyAttemptRecord;
  markCommit(input: {
    requestId: string;
    attemptId: string;
    event: AttemptCommitEvent;
  }): ProxyAttemptRecord;
  finishAttempt(input: {
    requestId: string;
    attemptId: string;
    status: Exclude<ProxyAttemptStatus, 'in_flight'>;
    statusCode?: number | null;
    errorScope?: RetryErrorScope | null;
    nowMs?: number;
  }): ProxyAttemptRecord;
  finishRequest(input: {
    requestId: string;
    status: Exclude<ProxyRequestStatus, 'active'>;
    nowMs?: number;
  }): ProxyRequestRecord;
  get(requestId: string): ProxyRequestRecord | null;
  list(): ProxyRequestRecord[];
};

type ProxyAttemptLedgerOptions = {
  now?: () => number;
  idFactory?: (prefix: string, sequence: number) => string;
};

function cloneBudget(budget: RetryBudgetState): RetryBudgetState {
  return {
    startedAtMs: budget.startedAtMs,
    limits: { ...budget.limits },
    attempts: budget.attempts,
    credentialRotations: budget.credentialRotations,
    channelSwitches: budget.channelSwitches,
  };
}

function cloneRecord(record: ProxyRequestRecord): ProxyRequestRecord {
  return {
    ...record,
    policy: {
      retryOwner: record.policy.retryOwner,
      replaySafety: record.policy.replaySafety,
      retryBudget: cloneBudget(record.policy.retryBudget),
    },
    attempts: record.attempts.map((attempt) => ({ ...attempt })),
  };
}

function normalizeNow(now: number | undefined, clock: () => number): number {
  if (Number.isFinite(now)) return Math.max(0, Math.trunc(now as number));
  const current = clock();
  return Number.isFinite(current) ? Math.max(0, Math.trunc(current)) : Date.now();
}

function assertRequest(request: ProxyRequestRecord | undefined, requestId: string): ProxyRequestRecord {
  if (!request) throw new Error(`Unknown proxy request ledger id: ${requestId}`);
  return request;
}

function assertAttempt(request: ProxyRequestRecord, attemptId: string): ProxyAttemptRecord {
  const attempt = request.attempts.find((item) => item.attemptId === attemptId);
  if (!attempt) throw new Error(`Unknown proxy attempt ledger id: ${attemptId}`);
  return attempt;
}

export function createProxyAttemptLedger(options: ProxyAttemptLedgerOptions = {}): ProxyAttemptLedger {
  const requests = new Map<string, ProxyRequestRecord>();
  let sequence = 0;
  const clock = options.now ?? (() => Date.now());
  const makeId = (prefix: string): string => {
    sequence += 1;
    return options.idFactory?.(prefix, sequence) ?? `${prefix}-${sequence}`;
  };

  return {
    beginRequest(input) {
      const requestId = input.requestId || makeId('req');
      if (requests.has(requestId)) throw new Error(`Proxy request ledger already exists: ${requestId}`);
      const record: ProxyRequestRecord = {
        requestId,
        requestedModel: input.requestedModel,
        downstreamPath: input.downstreamPath,
        status: 'active',
        createdAtMs: normalizeNow(input.nowMs, clock),
        finishedAtMs: null,
        policy: {
          retryOwner: input.policy.retryOwner,
          replaySafety: input.policy.replaySafety,
          retryBudget: cloneBudget(input.policy.retryBudget),
        },
        attempts: [],
      };
      requests.set(requestId, record);
      return cloneRecord(record);
    },

    beginAttempt(input) {
      const request = assertRequest(requests.get(input.requestId), input.requestId);
      if (request.status !== 'active') {
        throw new Error(`Cannot start an attempt for completed proxy request: ${input.requestId}`);
      }
      if (request.attempts.some((attempt) => attempt.status === 'in_flight')) {
        throw new Error(`Proxy request already has an in-flight attempt: ${input.requestId}`);
      }
      const attempt: ProxyAttemptRecord = {
        attemptId: input.attemptId || makeId('attempt'),
        attemptIndex: Math.max(0, Math.trunc(input.attemptIndex)),
        channelId: input.channelId ?? null,
        credentialId: input.credentialId ?? null,
        status: 'in_flight',
        commitState: 'not_started',
        errorScope: null,
        statusCode: null,
        startedAtMs: normalizeNow(input.nowMs, clock),
        finishedAtMs: null,
      };
      request.attempts.push(attempt);
      return { ...attempt };
    },

    markCommit(input) {
      const request = assertRequest(requests.get(input.requestId), input.requestId);
      const attempt = assertAttempt(request, input.attemptId);
      if (attempt.status !== 'in_flight') {
        throw new Error(`Cannot update a finished proxy attempt: ${input.attemptId}`);
      }
      attempt.commitState = advanceAttemptCommitState(attempt.commitState, input.event);
      return { ...attempt };
    },

    finishAttempt(input) {
      const request = assertRequest(requests.get(input.requestId), input.requestId);
      const attempt = assertAttempt(request, input.attemptId);
      if (attempt.status !== 'in_flight') {
        throw new Error(`Proxy attempt is already finished: ${input.attemptId}`);
      }
      attempt.status = input.status;
      attempt.statusCode = input.statusCode ?? null;
      attempt.errorScope = input.errorScope ?? null;
      attempt.finishedAtMs = normalizeNow(input.nowMs, clock);
      if (input.status === 'unknown') {
        attempt.commitState = 'sent_unknown';
      } else if (input.status === 'succeeded') {
        attempt.commitState = advanceAttemptCommitState(attempt.commitState, 'completed');
      }
      return { ...attempt };
    },

    finishRequest(input) {
      const request = assertRequest(requests.get(input.requestId), input.requestId);
      if (request.status !== 'active') {
        throw new Error(`Proxy request is already finished: ${input.requestId}`);
      }
      if (request.attempts.some((attempt) => attempt.status === 'in_flight')) {
        throw new Error(`Cannot finish proxy request with an in-flight attempt: ${input.requestId}`);
      }
      request.status = input.status;
      request.finishedAtMs = normalizeNow(input.nowMs, clock);
      return cloneRecord(request);
    },

    get(requestId) {
      const request = requests.get(requestId);
      return request ? cloneRecord(request) : null;
    },

    list() {
      return [...requests.values()].map(cloneRecord);
    },
  };
}
