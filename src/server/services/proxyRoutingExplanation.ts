import type { RouteDecisionCandidate } from '../../shared/tokenRouteContract.js';
import type { RouteDecisionExplanation } from './tokenRouter.js';
import type { ProxyRequestStatus, ProxyAttemptStatus } from './proxyAttemptLedger.js';
import type { AttemptCommitState, RetryErrorScope } from './proxyRetryContract.js';
import {
  classifyOperationalFailure,
  type OperationalAlertCategory,
  type OperationalAlertSeverity,
  type OperationalHealthDomain,
  type OperationalFailureCode,
} from './operationalFailureContract.js';

export type ProxyRoutingSelectionMode = 'initial' | 'failover' | 'sticky' | 'forced' | 'bridge';

export type ProxyRoutingDecisionSnapshot = {
  selectionIndex: number;
  retryCount: number;
  selectionMode: ProxyRoutingSelectionMode;
  recordedAt: string;
  requestedModel: string;
  actualModel: string;
  matched: boolean;
  routeId: number | null;
  routeName: string | null;
  modelPattern: string | null;
  selectedChannelId: number | null;
  selectedAccountId: number | null;
  selectedLabel: string | null;
  summary: string[];
  candidates: RouteDecisionCandidate[];
};

export type ProxyRoutingExplanationSnapshot = {
  version: 1;
  requestedModel: string;
  decisions: ProxyRoutingDecisionSnapshot[];
};

export type ProxyRoutingExplanationAttempt = {
  attemptId: string;
  attemptIndex: number;
  channelId: number | null;
  channelLabel: string | null;
  status: ProxyAttemptStatus;
  commitState: AttemptCommitState;
  statusCode: number | null;
  errorScope: RetryErrorScope | null;
  failureCode: OperationalFailureCode | null;
  healthDomain: OperationalHealthDomain | null;
  alertCategory: OperationalAlertCategory | null;
  alertSeverity: OperationalAlertSeverity | null;
  retryable: boolean | null;
  errorSummary: string | null;
};

export type ProxyRoutingFailover = {
  failoverIndex: number;
  fromChannelId: number | null;
  fromLabel: string | null;
  toChannelId: number | null;
  toLabel: string | null;
  trigger: string | null;
  triggerDetail: string | null;
};

export type ProxyRoutingExplanation = {
  version: 1;
  requestedModel: string;
  route: {
    id: number | null;
    name: string | null;
    modelPattern: string | null;
  } | null;
  candidateCount: number;
  candidates: RouteDecisionCandidate[];
  decisions: ProxyRoutingDecisionSnapshot[];
  attempts: ProxyRoutingExplanationAttempt[];
  failovers: ProxyRoutingFailover[];
  final: {
    status: ProxyRequestStatus;
    channelId: number | null;
    channelLabel: string | null;
  };
};

type RoutingAttemptSource = {
  attemptId: string;
  attemptIndex: number;
  channelId: number | null;
  siteName?: string | null;
  accountUsername?: string | null;
  credentialName?: string | null;
  status: ProxyAttemptStatus;
  commitState: AttemptCommitState;
  errorScope: RetryErrorScope | null;
  statusCode: number | null;
  errorSummary: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cloneCandidates(value: unknown): RouteDecisionCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .filter((candidate) => typeof candidate.channelId === 'number')
    .map((candidate) => ({ ...candidate } as RouteDecisionCandidate));
}

function cloneDecision(value: unknown): ProxyRoutingDecisionSnapshot | null {
  if (!isRecord(value)) return null;
  const requestedModel = asNullableString(value.requestedModel);
  const actualModel = asNullableString(value.actualModel);
  if (!requestedModel || !actualModel) return null;
  const selectionMode = value.selectionMode;
  if (!['initial', 'failover', 'sticky', 'forced', 'bridge'].includes(String(selectionMode))) {
    return null;
  }
  return {
    selectionIndex: Math.max(0, Math.trunc(asNullableNumber(value.selectionIndex) ?? 0)),
    retryCount: Math.max(0, Math.trunc(asNullableNumber(value.retryCount) ?? 0)),
    selectionMode: selectionMode as ProxyRoutingSelectionMode,
    recordedAt: asNullableString(value.recordedAt) ?? '',
    requestedModel,
    actualModel,
    matched: value.matched === true,
    routeId: asNullableNumber(value.routeId),
    routeName: asNullableString(value.routeName),
    modelPattern: asNullableString(value.modelPattern),
    selectedChannelId: asNullableNumber(value.selectedChannelId),
    selectedAccountId: asNullableNumber(value.selectedAccountId),
    selectedLabel: asNullableString(value.selectedLabel),
    summary: Array.isArray(value.summary)
      ? value.summary.filter((item): item is string => typeof item === 'string')
      : [],
    candidates: cloneCandidates(value.candidates),
  };
}

export function createProxyRoutingExplanationSnapshot(
  requestedModel: string,
): ProxyRoutingExplanationSnapshot {
  return {
    version: 1,
    requestedModel,
    decisions: [],
  };
}

export function appendProxyRoutingDecision(
  snapshot: ProxyRoutingExplanationSnapshot,
  input: {
    retryCount: number;
    selectionMode: ProxyRoutingSelectionMode;
    decision: RouteDecisionExplanation;
    recordedAt?: Date;
  },
): ProxyRoutingExplanationSnapshot {
  const nextDecision: ProxyRoutingDecisionSnapshot = {
    selectionIndex: snapshot.decisions.length,
    retryCount: Math.max(0, Math.trunc(input.retryCount)),
    selectionMode: input.selectionMode,
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    requestedModel: input.decision.requestedModel,
    actualModel: input.decision.actualModel,
    matched: input.decision.matched,
    routeId: input.decision.routeId ?? null,
    routeName: input.decision.routeName ?? null,
    modelPattern: input.decision.modelPattern ?? null,
    selectedChannelId: input.decision.selectedChannelId ?? null,
    selectedAccountId: input.decision.selectedAccountId ?? null,
    selectedLabel: input.decision.selectedLabel ?? null,
    summary: [...input.decision.summary],
    candidates: input.decision.candidates.map((candidate) => ({ ...candidate })),
  };
  return {
    version: 1,
    requestedModel: snapshot.requestedModel,
    decisions: [...snapshot.decisions, nextDecision],
  };
}

export function parseProxyRoutingExplanationSnapshot(
  value: unknown,
): ProxyRoutingExplanationSnapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const requestedModel = asNullableString(value.requestedModel);
  if (!requestedModel) return null;
  return {
    version: 1,
    requestedModel,
    decisions: Array.isArray(value.decisions)
      ? value.decisions.map(cloneDecision).filter((item): item is ProxyRoutingDecisionSnapshot => !!item)
      : [],
  };
}

function buildChannelLabel(attempt: RoutingAttemptSource): string | null {
  const siteName = attempt.siteName?.trim() || '';
  const accountName = attempt.accountUsername?.trim() || '';
  const credentialName = attempt.credentialName?.trim() || '';
  const primary = [siteName, accountName].filter(Boolean).join(' / ');
  if (primary && credentialName) return `${primary} / ${credentialName}`;
  return primary || credentialName || (attempt.channelId ? `Channel #${attempt.channelId}` : null);
}

export function classifyProxyRoutingFailureCode(input: {
  statusCode: number | null;
  errorScope: RetryErrorScope | null;
  errorSummary: string | null;
}): OperationalFailureCode | null {
  if (input.statusCode == null && !input.errorSummary && !input.errorScope) return null;
  return classifyOperationalFailure({
    status: input.statusCode ?? undefined,
    rawErrorText: input.errorSummary,
    errorScope: input.errorScope,
  }).code;
}

export function buildProxyRoutingExplanation(input: {
  snapshot: ProxyRoutingExplanationSnapshot | null;
  requestedModel: string;
  status: ProxyRequestStatus;
  attempts: RoutingAttemptSource[];
}): ProxyRoutingExplanation | null {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.decisions.length === 0) return null;
  const firstDecision = snapshot.decisions[0];
  const attempts: ProxyRoutingExplanationAttempt[] = input.attempts.map((attempt) => {
    const classification = attempt.status === 'succeeded'
      ? null
      : classifyOperationalFailure({
        status: attempt.statusCode ?? undefined,
        rawErrorText: attempt.errorSummary,
        errorScope: attempt.errorScope,
      });
    return {
      attemptId: attempt.attemptId,
      attemptIndex: attempt.attemptIndex,
      channelId: attempt.channelId,
      channelLabel: buildChannelLabel(attempt),
      status: attempt.status,
      commitState: attempt.commitState,
      statusCode: attempt.statusCode,
      errorScope: attempt.errorScope,
      failureCode: classification?.code ?? null,
      healthDomain: classification?.healthDomain ?? null,
      alertCategory: classification?.alertCategory ?? null,
      alertSeverity: classification?.alertSeverity ?? null,
      retryable: classification?.retryable ?? null,
      errorSummary: attempt.errorSummary,
    };
  });
  const failovers = snapshot.decisions.slice(1).map((decision, index): ProxyRoutingFailover => {
    const previous = snapshot.decisions[index];
    const triggerAttempt = [...attempts]
      .reverse()
      .find((attempt) => (
        attempt.channelId === previous.selectedChannelId
        && attempt.status !== 'succeeded'
        && attempt.status !== 'in_flight'
      ));
    return {
      failoverIndex: index + 1,
      fromChannelId: previous.selectedChannelId,
      fromLabel: previous.selectedLabel,
      toChannelId: decision.selectedChannelId,
      toLabel: decision.selectedLabel,
      trigger: triggerAttempt?.failureCode ?? null,
      triggerDetail: triggerAttempt?.errorSummary ?? null,
    };
  });
  const successfulAttempt = [...attempts].reverse().find((attempt) => attempt.status === 'succeeded');
  const lastDecision = snapshot.decisions.at(-1) ?? firstDecision;
  return {
    version: 1,
    requestedModel: snapshot.requestedModel || input.requestedModel,
    route: firstDecision.matched
      ? {
        id: firstDecision.routeId,
        name: firstDecision.routeName,
        modelPattern: firstDecision.modelPattern,
      }
      : null,
    candidateCount: firstDecision.candidates.length,
    candidates: firstDecision.candidates.map((candidate) => ({ ...candidate })),
    decisions: snapshot.decisions.map((decision) => ({
      ...decision,
      summary: [...decision.summary],
      candidates: decision.candidates.map((candidate) => ({ ...candidate })),
    })),
    attempts,
    failovers,
    final: {
      status: input.status,
      channelId: successfulAttempt?.channelId ?? lastDecision.selectedChannelId,
      channelLabel: successfulAttempt?.channelLabel ?? lastDecision.selectedLabel,
    },
  };
}
