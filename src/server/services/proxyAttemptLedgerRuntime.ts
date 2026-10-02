import { randomUUID } from 'node:crypto';

import type {
  EndpointAttemptCommitStateContext,
  EndpointAttemptContext,
  EndpointAttemptIdentity,
  EndpointAttemptStartContext,
  EndpointAttemptSuccessContext,
} from '../proxy-core/orchestration/endpointFlow.js';
import {
  advanceAttemptCommitState,
  classifyRetryErrorScope,
  type AttemptCommitEvent,
  type AttemptCommitState,
  type RetryErrorScope,
} from './proxyRetryContract.js';
import {
  finishProxyRequest,
  finishProxyRequestAttempt,
  insertProxyRequestAttempt,
  insertProxyRequestLedger,
  updateProxyRequestPolicySnapshot,
  updateProxyRequestAttemptCommit,
} from './proxyAttemptLedgerStore.js';
import type {
  ProxyAttemptPolicySnapshot,
  ProxyRequestStatus,
} from './proxyAttemptLedger.js';
import {
  appendProxyRoutingDecision,
  createProxyRoutingExplanationSnapshot,
  type ProxyRoutingExplanationSnapshot,
  type ProxyRoutingSelectionMode,
} from './proxyRoutingExplanation.js';
import type { RouteDecisionExplanation } from './tokenRouter.js';
import { observeProxyRequest } from '../observability/metrics.js';

type AttemptRecordState = {
  attemptIndex: number;
  finished: boolean;
  commitState: AttemptCommitState;
  status: 'in_flight' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
};

const emittedLedgerWarnings = new Set<string>();

function warnLedgerOnce(key: string, message: string, error: unknown): void {
  if (emittedLedgerWarnings.has(key)) return;
  emittedLedgerWarnings.add(key);
  console.warn(message, error);
}

export type StartProxyAttemptLedgerSessionInput = {
  requestId?: string | null;
  requestedModel: string;
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  clientThreadId?: string | null;
  clientTurnId?: string | null;
  bridgeTaskId?: string | null;
  bridgeRouteAction?: string | null;
  bridgeContinuationNumber?: number | null;
  downstreamApiKeyId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  tokenId?: number | null;
  policy: ProxyAttemptPolicySnapshot;
};

export type ProxyAttemptSelectionContext = {
  channelId?: number | null;
  accountId?: number | null;
  tokenId?: number | null;
};

export type ProxyManualAttemptStartInput = {
  endpoint?: string | null;
  requestPath?: string | null;
  targetUrl?: string | null;
};

export type ProxyManualAttemptCommitInput = {
  attemptId: string;
  event: AttemptCommitEvent;
  statusCode?: number | null;
  errorSummary?: string | null;
};

export type ProxyManualAttemptFinishInput = {
  attemptId: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  commitState?: AttemptCommitState;
  errorScope?: RetryErrorScope | null;
  statusCode?: number | null;
  errorSummary?: string | null;
};

export type ProxyAttemptLedgerRuntimeSession = {
  requestId: string;
  requestRowId: number;
  setRetryOwner: (retryOwner: ProxyAttemptPolicySnapshot['retryOwner']) => Promise<void>;
  setSelection: (selection: ProxyAttemptSelectionContext) => void;
  recordRoutingDecision: (input: {
    retryCount: number;
    selectionMode: ProxyRoutingSelectionMode;
    decision: RouteDecisionExplanation;
  }) => Promise<void>;
  getLatestAttemptId: () => string | null;
  beginAttempt: (input: ProxyManualAttemptStartInput) => Promise<EndpointAttemptIdentity>;
  markAttemptCommit: (input: ProxyManualAttemptCommitInput) => Promise<void>;
  finishAttempt: (input: ProxyManualAttemptFinishInput) => Promise<void>;
  createAttemptIdentity: (ctx: EndpointAttemptStartContext) => EndpointAttemptIdentity;
  onAttemptStart: (ctx: EndpointAttemptStartContext & EndpointAttemptIdentity) => Promise<void>;
  onAttemptCommitState: (ctx: EndpointAttemptCommitStateContext) => Promise<void>;
  onAttemptFailure: (ctx: EndpointAttemptContext & { errText: string }) => Promise<void>;
  onAttemptSuccess: (ctx: EndpointAttemptSuccessContext) => Promise<void>;
  finishRequest: (status: Exclude<ProxyRequestStatus, 'active'>) => Promise<void>;
};

function normalizeRequestId(value: string | null | undefined): string {
  const trimmed = String(value || '').trim();
  return trimmed || `proxy-${randomUUID()}`;
}

function normalizeAttemptIndex(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function inferErrorScope(status: number | undefined, rawErrorText: string | undefined): RetryErrorScope {
  return classifyRetryErrorScope({
    status: typeof status === 'number' ? status : 0,
    rawErrorText: rawErrorText || '',
  });
}

function safeAttemptCommitState(value: AttemptCommitState): AttemptCommitState {
  return value || 'not_started';
}

export async function startProxyAttemptLedgerSession(
  input: StartProxyAttemptLedgerSessionInput,
): Promise<ProxyAttemptLedgerRuntimeSession | null> {
  const requestId = normalizeRequestId(input.requestId);
  const sessionStartedAtMs = Date.now();
  try {
    const created = await insertProxyRequestLedger({
      requestId,
      requestedModel: input.requestedModel,
      downstreamPath: input.downstreamPath,
      clientKind: input.clientKind ?? null,
      sessionId: input.sessionId ?? null,
      clientThreadId: input.clientThreadId ?? null,
      clientTurnId: input.clientTurnId ?? null,
      bridgeTaskId: input.bridgeTaskId ?? null,
      bridgeRouteAction: input.bridgeRouteAction ?? null,
      bridgeContinuationNumber: input.bridgeContinuationNumber ?? null,
      downstreamApiKeyId: input.downstreamApiKeyId ?? null,
      policy: input.policy,
    });

    let nextAttemptIndex = 0;
    let latestAttemptId: string | null = null;
    let requestFinished = false;
    let retryOwner = input.policy.retryOwner;
    let routingExplanation: ProxyRoutingExplanationSnapshot = createProxyRoutingExplanationSnapshot(
      input.requestedModel,
    );
    const attempts = new Map<string, AttemptRecordState>();
    let selection: ProxyAttemptSelectionContext = {
      channelId: input.channelId ?? null,
      accountId: input.accountId ?? null,
      tokenId: input.tokenId ?? null,
    };

    const finishAttemptOnce = async (attemptId: string, details: {
      status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
      commitState?: AttemptCommitState;
      errorScope?: RetryErrorScope | null;
      statusCode?: number | null;
      errorSummary?: string | null;
    }): Promise<void> => {
      const state = attempts.get(attemptId);
      if (!state || state.finished) return;
      state.finished = true;
      state.status = details.status;
      if (details.commitState) {
        state.commitState = details.commitState;
      }
      try {
        await finishProxyRequestAttempt({
          requestRowId: created.requestRowId,
          attemptId,
          status: details.status,
          commitState: details.commitState,
          errorScope: details.errorScope ?? null,
          statusCode: details.statusCode ?? null,
          errorSummary: details.errorSummary ?? null,
        });
      } catch (error) {
        warnLedgerOnce('finish-attempt', '[proxy-ledger] failed to finish attempt', error);
      }
    };

    const createAttemptIdentity = (): EndpointAttemptIdentity => {
      const attemptIndex = nextAttemptIndex;
      nextAttemptIndex += 1;
      const attemptId = `${requestId}:attempt:${attemptIndex}`;
      latestAttemptId = attemptId;
      attempts.set(attemptId, {
        attemptIndex,
        finished: false,
        commitState: 'not_started',
        status: 'in_flight',
      });
      return { attemptId, attemptIndex };
    };

    const insertAttempt = async (
      identity: EndpointAttemptIdentity,
      input: ProxyManualAttemptStartInput,
    ): Promise<void> => {
      try {
        await insertProxyRequestAttempt({
          requestRowId: created.requestRowId,
          attemptId: identity.attemptId,
          attemptIndex: normalizeAttemptIndex(identity.attemptIndex),
          channelId: selection.channelId ?? null,
          accountId: selection.accountId ?? null,
          tokenId: selection.tokenId ?? null,
          endpoint: input.endpoint ?? null,
          requestPath: input.requestPath ?? null,
          targetUrl: input.targetUrl ?? null,
        });
      } catch (error) {
        warnLedgerOnce('start-attempt', '[proxy-ledger] failed to start attempt', error);
      }
    };

    const markAttemptCommit = async (input: ProxyManualAttemptCommitInput): Promise<void> => {
      const state = attempts.get(input.attemptId);
      if (!state || state.finished) return;
      const commitState = advanceAttemptCommitState(state.commitState, input.event);
      if (commitState !== state.commitState) {
        state.commitState = commitState;
        try {
          await updateProxyRequestAttemptCommit({
            requestRowId: created.requestRowId,
            attemptId: input.attemptId,
            commitState,
          });
        } catch (error) {
          warnLedgerOnce('commit-state', '[proxy-ledger] failed to update commit state', error);
        }
      }

      if (input.event === 'transport_unknown') {
        await finishAttemptOnce(input.attemptId, {
          status: 'unknown',
          commitState: 'sent_unknown',
          errorScope: 'transport',
          statusCode: input.statusCode ?? 408,
          errorSummary: input.errorSummary || 'upstream transport outcome is unknown',
        });
      }
    };

    const persistPolicySnapshot = async (): Promise<void> => {
      try {
        await updateProxyRequestPolicySnapshot({
          requestRowId: created.requestRowId,
          retryOwner,
          replaySafety: input.policy.replaySafety,
          routingExplanation: routingExplanation.decisions.length > 0 ? routingExplanation : null,
        });
      } catch (error) {
        warnLedgerOnce('policy-snapshot', '[proxy-ledger] failed to update policy snapshot', error);
      }
    };

    return {
      requestId,
      requestRowId: created.requestRowId,
      async setRetryOwner(nextRetryOwner) {
        if (requestFinished || attempts.size > 0 || retryOwner === nextRetryOwner) return;
        retryOwner = nextRetryOwner;
        await persistPolicySnapshot();
      },
      setSelection(nextSelection) {
        selection = {
          channelId: nextSelection.channelId ?? null,
          accountId: nextSelection.accountId ?? null,
          tokenId: nextSelection.tokenId ?? null,
        };
      },
      async recordRoutingDecision(decisionInput) {
        if (requestFinished) return;
        routingExplanation = appendProxyRoutingDecision(routingExplanation, decisionInput);
        await persistPolicySnapshot();
      },
      getLatestAttemptId() {
        return latestAttemptId;
      },
      async beginAttempt(input) {
        const inFlightAttempt = [...attempts.values()].find((attempt) => !attempt.finished);
        if (inFlightAttempt) {
          throw new Error(`Proxy request already has an in-flight attempt: ${requestId}`);
        }
        const identity = createAttemptIdentity();
        await insertAttempt(identity, input);
        return identity;
      },
      async markAttemptCommit(input) {
        await markAttemptCommit(input);
      },
      async finishAttempt(input) {
        await finishAttemptOnce(input.attemptId, input);
      },
      createAttemptIdentity() {
        return createAttemptIdentity();
      },
      async onAttemptStart(ctx) {
        const state = attempts.get(ctx.attemptId);
        if (!state) {
          attempts.set(ctx.attemptId, {
            attemptIndex: normalizeAttemptIndex(ctx.attemptIndex),
            finished: false,
            commitState: 'not_started',
            status: 'in_flight',
          });
        }
        await insertAttempt(ctx, {
          endpoint: ctx.request.endpoint,
          requestPath: ctx.request.path,
          targetUrl: ctx.targetUrl,
        });
      },
      async onAttemptCommitState(ctx) {
        const state = attempts.get(ctx.attemptId);
        if (state && !state.finished && state.commitState !== safeAttemptCommitState(ctx.commitState)) {
          state.commitState = safeAttemptCommitState(ctx.commitState);
          try {
            await updateProxyRequestAttemptCommit({
              requestRowId: created.requestRowId,
              attemptId: ctx.attemptId,
              commitState: state.commitState,
            });
          } catch (error) {
            warnLedgerOnce('commit-state', '[proxy-ledger] failed to update commit state', error);
          }
        }
        if (ctx.event === 'transport_unknown') {
          await finishAttemptOnce(ctx.attemptId, {
            status: 'unknown',
            commitState: 'sent_unknown',
            errorScope: 'transport',
            statusCode: ctx.response?.status || 408,
            errorSummary: 'upstream transport outcome is unknown',
          });
        }
      },
      async onAttemptFailure(ctx) {
        await finishAttemptOnce(ctx.attemptId, {
          status: ctx.commitState === 'sent_unknown' ? 'unknown' : 'failed',
          commitState: ctx.commitState,
          errorScope: inferErrorScope(ctx.response?.status, ctx.rawErrText),
          statusCode: ctx.response?.status ?? null,
          errorSummary: ctx.errText,
        });
      },
      async onAttemptSuccess(ctx) {
        await finishAttemptOnce(ctx.attemptId, {
          status: 'succeeded',
          commitState: ctx.commitState,
          statusCode: ctx.response.status,
        });
      },
      async finishRequest(status) {
        if (requestFinished) return;
        requestFinished = true;
        let observedStatus = status;
        try {
          for (const [attemptId, state] of attempts.entries()) {
            if (state.finished) continue;
            const ambiguous = state.commitState === 'sent_unknown' || status === 'unknown';
            await finishAttemptOnce(attemptId, {
              status: ambiguous
                ? 'unknown'
                : status === 'cancelled'
                  ? 'cancelled'
                  : status === 'succeeded'
                    ? 'succeeded'
                    : 'failed',
              commitState: ambiguous ? 'sent_unknown' : state.commitState,
              errorScope: ambiguous ? 'transport' : null,
              errorSummary: ambiguous
                ? 'request finished while the upstream outcome remained unknown'
                : null,
            });
          }
          if (status === 'succeeded') {
            for (const [attemptId, state] of attempts.entries()) {
              if (state.status !== 'succeeded' || state.commitState !== 'response_started') continue;
              await updateProxyRequestAttemptCommit({
                requestRowId: created.requestRowId,
                attemptId,
                commitState: 'completed',
              });
              state.commitState = 'completed';
            }
          }
          const effectiveStatus = status !== 'succeeded'
            && [...attempts.values()].some((state) => state.status === 'unknown')
            ? 'unknown'
            : status;
          observedStatus = effectiveStatus;
          await finishProxyRequest({
            requestRowId: created.requestRowId,
            status: effectiveStatus,
          });
        } catch (error) {
          warnLedgerOnce('finish-request', '[proxy-ledger] failed to finish request', error);
        } finally {
          observeProxyRequest({
            downstreamPath: input.downstreamPath,
            outcome: observedStatus,
            durationMs: Date.now() - sessionStartedAtMs,
            attemptCount: attempts.size,
          });
        }
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'proxy attempt ledger schema unavailable') {
      return null;
    }
    warnLedgerOnce('create-request', '[proxy-ledger] failed to create request ledger', error);
    return null;
  }
}

export function buildProxyAttemptLedgerPolicy(input: {
  retryOwner?: ProxyAttemptPolicySnapshot['retryOwner'];
  replaySafety?: ProxyAttemptPolicySnapshot['replaySafety'];
  retryBudget: ProxyAttemptPolicySnapshot['retryBudget'];
}): ProxyAttemptPolicySnapshot {
  return {
    retryOwner: input.retryOwner ?? 'cooperative',
    replaySafety: input.replaySafety ?? 'safe_only',
    retryBudget: input.retryBudget,
  };
}

export type ProxyAttemptLedgerCommitEvent = AttemptCommitEvent;
