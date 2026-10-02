import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';
import { proxyChannelCoordinator } from '../services/proxyChannelCoordinator.js';
import { canRetryProxyChannel } from '../services/proxyChannelRetry.js';
import type { DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';
import { tokenRouter } from '../services/tokenRouter.js';
import { classifyRetryErrorScope, type RetryErrorScope } from '../services/proxyRetryContract.js';
import { localProxyOwnsRetryForFailure } from '../services/proxyRetryOwnership.js';
import type { BridgeProxyRoutePlan } from '../services/bridgeContinuationRouting.js';
import type {
  RouteDecisionExplanation,
  TokenRouterCredentialIdentity,
  TokenRouterSelectionConstraints,
} from '../services/tokenRouter.js';
import type { ProxyRoutingSelectionMode } from '../services/proxyRoutingExplanation.js';

type SelectedChannel = Awaited<ReturnType<typeof tokenRouter.selectChannel>>;

export const TESTER_FORCED_CHANNEL_HEADER = 'x-metapi-tester-forced-channel-id';
export const TESTER_REQUEST_HEADER = 'x-metapi-tester-request';

function headerValueEquals(
  headers: Record<string, unknown> | undefined,
  expectedKey: string,
  expectedValue: string,
): boolean {
  if (!headers) return false;
  const normalizedExpectedKey = expectedKey.trim().toLowerCase();
  const normalizedExpectedValue = expectedValue.trim().toLowerCase();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedExpectedKey) continue;
    if (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === normalizedExpectedValue) {
      return true;
    }
  }
  return false;
}

function isLoopbackClientIp(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  if (trimmed === '::1' || trimmed === '127.0.0.1') return true;
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length).trim() === '127.0.0.1';
  }
  return false;
}

export function normalizeForcedChannelId(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : NaN;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

type TesterRequestInput = {
  headers?: Record<string, unknown>;
  clientIp?: string | null;
};

export function isTrustedTesterRequest(input?: TesterRequestInput): boolean {
  if (!input) return false;
  if (!isLoopbackClientIp(input.clientIp)) return false;
  return headerValueEquals(input.headers, TESTER_REQUEST_HEADER, '1');
}

export function getTesterForcedChannelId(input?: TesterRequestInput): number | null {
  if (!isTrustedTesterRequest(input)) return null;
  const headers = input?.headers;
  if (!headers) return null;
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== TESTER_FORCED_CHANNEL_HEADER) continue;
    return normalizeForcedChannelId(rawValue);
  }
  return null;
}

export function buildForcedChannelUnavailableMessage(forcedChannelId?: number | null): string {
  const normalizedForcedChannelId = normalizeForcedChannelId(forcedChannelId);
  if (normalizedForcedChannelId === null) {
    return 'No available channels for this model';
  }
  return `指定通道 #${normalizedForcedChannelId} 当前不可用，固定通道模式不会自动切换其他通道`;
}

export function canRetryChannelSelection(retryCount: number, forcedChannelId?: number | null): boolean {
  if (normalizeForcedChannelId(forcedChannelId) !== null) return false;
  return canRetryProxyChannel(retryCount);
}

export function canRetryChannelSelectionForFailure(input: {
  retryCount: number;
  forcedChannelId?: number | null;
  selected: {
    channel: {
      retryOwner?: unknown;
      upstreamRetryMode?: unknown;
    };
  };
  status?: number;
  errorText?: string | null;
  errorScope?: RetryErrorScope;
  explicitUpstreamRetryable?: boolean;
}): boolean {
  if (!canRetryChannelSelection(input.retryCount, input.forcedChannelId)) return false;
  return localProxyOwnsRetryForFailure({
    channel: input.selected.channel,
    errorScope: input.errorScope ?? classifyRetryErrorScope({
      status: input.status ?? 0,
      rawErrorText: input.errorText || '',
    }),
    explicitUpstreamRetryable: input.explicitUpstreamRetryable,
  });
}

export function buildBridgeTokenRouterSelectionConstraints(input: {
  plan: BridgeProxyRoutePlan;
  excludedCredentials?: readonly TokenRouterCredentialIdentity[];
}): TokenRouterSelectionConstraints {
  const previousCredential = Object.freeze({
    accountId: input.plan.previousSelection.accountId,
    tokenId: input.plan.previousSelection.tokenId,
  });
  const excludedCredentials = [...(input.excludedCredentials || [])];
  if (input.plan.effectiveAction === 'preserve') {
    return Object.freeze({
      allowedSiteIds: Object.freeze([input.plan.previousSelection.siteId]),
      preferredCredential: previousCredential,
    });
  }
  if (input.plan.effectiveAction === 'rotate_credential') {
    return Object.freeze({
      allowedSiteIds: Object.freeze([input.plan.previousSelection.siteId]),
      excludedCredentials: Object.freeze([previousCredential, ...excludedCredentials]),
    });
  }
  return Object.freeze({
    excludedSiteIds: Object.freeze([input.plan.previousSelection.siteId]),
    excludedCredentials: Object.freeze(excludedCredentials),
  });
}

export type ProxyChannelRoutingDecisionEvent = {
  retryCount: number;
  selectionMode: ProxyRoutingSelectionMode;
  decision: RouteDecisionExplanation;
};

type SelectProxyChannelForAttemptInput = {
  requestedModel: string;
  downstreamPolicy: DownstreamRoutingPolicy;
  excludeChannelIds: number[];
  retryCount: number;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
  bridgeRoutePlan?: BridgeProxyRoutePlan | null;
  excludeCredentials?: readonly TokenRouterCredentialIdentity[];
  onRoutingDecision?: (event: ProxyChannelRoutingDecisionEvent) => Promise<void> | void;
};

type ProxyChannelSelectionResult = {
  selected: SelectedChannel;
  selectionMode: ProxyRoutingSelectionMode;
};

async function selectProxyChannelCandidateForAttempt(
  input: SelectProxyChannelForAttemptInput,
): Promise<ProxyChannelSelectionResult> {
  const normalizedForcedChannelId = normalizeForcedChannelId(input.forcedChannelId);
  if (normalizedForcedChannelId !== null) {
    return {
      selected: input.retryCount > 0
        ? null
        : await tokenRouter.selectPreferredChannel(
          input.requestedModel,
          normalizedForcedChannelId,
          input.downstreamPolicy,
          input.excludeChannelIds,
        ),
      selectionMode: 'forced',
    };
  }

  let selected: SelectedChannel = null;
  let refreshedRoutes = false;

  const refreshRoutesForFirstAttempt = async (): Promise<boolean> => {
    if (input.retryCount > 0 || refreshedRoutes) return false;
    refreshedRoutes = true;
    try {
      await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      return true;
    } catch (error) {
      console.warn('[proxy/surface] failed to refresh routes after empty selection', error);
      return false;
    }
  };

  if (input.bridgeRoutePlan) {
    const constraints = buildBridgeTokenRouterSelectionConstraints({
      plan: input.bridgeRoutePlan,
      excludedCredentials: input.excludeCredentials,
    });
    const selectWithBridgePlan = async (): Promise<SelectedChannel> => {
      if (input.bridgeRoutePlan?.effectiveAction === 'preserve') {
        if (input.retryCount > 0) return null;
        return await tokenRouter.selectPreferredChannel(
          input.requestedModel,
          input.bridgeRoutePlan.previousSelection.channelId,
          input.downstreamPolicy,
          input.excludeChannelIds,
          constraints,
        );
      }
      return input.retryCount === 0
        ? await tokenRouter.selectChannel(
          input.requestedModel,
          input.downstreamPolicy,
          constraints,
        )
        : await tokenRouter.selectNextChannel(
          input.requestedModel,
          input.excludeChannelIds,
          input.downstreamPolicy,
          constraints,
        );
    };

    selected = await selectWithBridgePlan();
    if (!selected && input.retryCount === 0) {
      await refreshRoutesForFirstAttempt();
      selected = await selectWithBridgePlan();
    }
    return { selected, selectionMode: 'bridge' };
  }

  if (input.retryCount === 0 && input.stickySessionKey) {
    const preferredChannelId = proxyChannelCoordinator.getStickyChannelId(input.stickySessionKey);
    if (preferredChannelId && !input.excludeChannelIds.includes(preferredChannelId)) {
      selected = await tokenRouter.selectPreferredChannel(
        input.requestedModel,
        preferredChannelId,
        input.downstreamPolicy,
        input.excludeChannelIds,
      );
      if (!selected) {
        const refreshSucceeded = await refreshRoutesForFirstAttempt();
        selected = await tokenRouter.selectPreferredChannel(
          input.requestedModel,
          preferredChannelId,
          input.downstreamPolicy,
          input.excludeChannelIds,
        );
        if (!selected && refreshSucceeded) {
          proxyChannelCoordinator.clearStickyChannel(input.stickySessionKey, preferredChannelId);
        }
      }
      if (selected) return { selected, selectionMode: 'sticky' };
    }
  }

  if (!selected) {
    selected = input.retryCount === 0
      ? await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy)
      : await tokenRouter.selectNextChannel(
        input.requestedModel,
        input.excludeChannelIds,
        input.downstreamPolicy,
      );
  }

  if (!selected && input.retryCount === 0 && !refreshedRoutes) {
    await refreshRoutesForFirstAttempt();
    selected = await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy);
  }

  return {
    selected,
    selectionMode: input.retryCount > 0 ? 'failover' : 'initial',
  };
}

async function explainProxyChannelSelection(
  input: SelectProxyChannelForAttemptInput,
): Promise<RouteDecisionExplanation | null> {
  if (typeof tokenRouter.explainSelection !== 'function') return null;
  const selectionConstraints = input.bridgeRoutePlan
    ? buildBridgeTokenRouterSelectionConstraints({
      plan: input.bridgeRoutePlan,
      excludedCredentials: input.excludeCredentials,
    })
    : {};
  return await tokenRouter.explainSelection(
    input.requestedModel,
    input.excludeChannelIds,
    input.downstreamPolicy,
    selectionConstraints,
  );
}

function alignDecisionWithSelectedChannel(
  decision: RouteDecisionExplanation,
  selected: NonNullable<SelectedChannel> | null,
): RouteDecisionExplanation {
  if (!selected) {
    return {
      ...decision,
      selectedChannelId: undefined,
      selectedAccountId: undefined,
      selectedLabel: undefined,
    };
  }
  const candidate = decision.candidates.find((item) => item.channelId === selected.channel.id);
  return {
    ...decision,
    actualModel: selected.actualModel || decision.actualModel,
    selectedChannelId: selected.channel.id,
    selectedAccountId: selected.account.id,
    selectedLabel: candidate
      ? `${candidate.username} @ ${candidate.siteName} / ${candidate.tokenName}`
      : `${selected.account.username || `account-${selected.account.id}`} @ ${selected.site.name || 'unknown'} / ${selected.tokenName || 'default'}`,
  };
}

export async function selectProxyChannelForAttempt(
  input: SelectProxyChannelForAttemptInput,
): Promise<SelectedChannel> {
  const { selected, selectionMode } = await selectProxyChannelCandidateForAttempt(input);
  if (!input.onRoutingDecision) return selected;

  try {
    const decision = await explainProxyChannelSelection(input);
    if (!decision) return selected;
    await input.onRoutingDecision({
      retryCount: input.retryCount,
      selectionMode,
      decision: alignDecisionWithSelectedChannel(decision, selected),
    });
  } catch (error) {
    console.warn('[proxy/channel-selection] failed to record routing explanation', error);
  }

  return selected;
}
