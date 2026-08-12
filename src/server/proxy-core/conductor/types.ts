import type {
  AttemptCommitState,
  ReplaySafety,
  RetryBudgetLimits,
  RetryBudgetState,
  RetryErrorScope,
  RetryOwner,
} from '../../services/proxyRetryContract.js';

export type SelectedChannelLike = {
  channel: {
    id: number;
    routeId?: number;
    retryOwner?: unknown;
    upstreamRetryMode?: unknown;
  };
  site: Record<string, unknown>;
  account: Record<string, unknown>;
  tokenName?: string;
  tokenValue?: string;
  actualModel?: string;
};

export type AttemptSuccess = {
  ok: true;
  response: Response;
  latencyMs?: number | null;
  cost?: number | null;
};

export type AttemptFailureAction =
  | 'retry_same_channel'
  | 'refresh_auth'
  | 'failover'
  | 'terminal'
  | 'stop';

export type AttemptFailure = {
  ok: false;
  action: AttemptFailureAction;
  status?: number;
  rawErrorText?: string;
  error?: unknown;
  retryOwner?: RetryOwner;
  replaySafety?: ReplaySafety;
  commitState?: AttemptCommitState;
  errorScope?: RetryErrorScope;
  upstreamRetryable?: boolean;
};

export type AttemptResult = AttemptSuccess | AttemptFailure;

export type ExecuteAttemptContext = {
  selected: SelectedChannelLike;
  attemptIndex: number;
  excludeChannelIds: number[];
  retryBudget: RetryBudgetState;
  retryOwner: RetryOwner;
  replaySafety: ReplaySafety;
};

export type ProxyConductorDependencies = {
  selectChannel: (requestedModel: string, downstreamPolicy?: unknown) => Promise<SelectedChannelLike | null>;
  previewSelectedChannel?: (requestedModel: string, downstreamPolicy?: unknown) => Promise<SelectedChannelLike | null>;
  selectNextChannel: (
    requestedModel: string,
    excludeChannelIds: number[],
    downstreamPolicy?: unknown,
  ) => Promise<SelectedChannelLike | null>;
  recordSuccess?: (channelId: number, metrics: { latencyMs: number | null; cost: number | null }) => Promise<void> | void;
  recordFailure?: (channelId: number, failure: { status?: number; rawErrorText?: string }) => Promise<void> | void;
  refreshAuth?: (
    selected: SelectedChannelLike,
    failure: { status?: number; rawErrorText?: string },
  ) => Promise<SelectedChannelLike | null>;
};

export type ExecuteInput = {
  requestedModel: string;
  downstreamPolicy?: unknown;
  retryBudget?: RetryBudgetLimits;
  retryOwner?: RetryOwner;
  replaySafety?: ReplaySafety;
  /** Per-request opt-in for replaying an ambiguous send. */
  explicitReplay?: boolean;
  attempt: (context: ExecuteAttemptContext) => Promise<AttemptResult>;
  onTerminalFailure?: (
    selected: SelectedChannelLike,
    failure: { status?: number; rawErrorText?: string },
  ) => Promise<void> | void;
};

export type ExecuteResult =
  | {
    ok: true;
    selected: SelectedChannelLike;
    response: Response;
    attempts: number;
  }
  | {
    ok: false;
    reason: 'no_channel' | 'failed' | 'terminal' | 'budget_exhausted';
    selected?: SelectedChannelLike;
    status?: number;
    rawErrorText?: string;
    attempts: number;
    retryBudget?: RetryBudgetState;
  };
