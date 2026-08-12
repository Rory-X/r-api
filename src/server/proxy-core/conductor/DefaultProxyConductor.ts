import {
  failureActionOf,
  isTerminalFailure,
  shouldFailover,
  shouldRefreshAuth,
  shouldRetrySameChannel,
} from './retryPolicy.js';
import type { ExecuteInput, ExecuteResult, ProxyConductorDependencies, SelectedChannelLike } from './types.js';
import { recordFailedAttempt, recordSuccessfulAttempt } from './usageHooks.js';
import {
  canRetryLocally,
  createRetryBudget,
  spendRetryBudget,
} from '../../services/proxyRetryContract.js';
import {
  resolveApiChannelRetryPolicy,
  upstreamClaimsRetryForFailure,
} from '../../services/proxyRetryOwnership.js';

export class DefaultProxyConductor {
  constructor(private readonly deps: ProxyConductorDependencies) {}

  async previewSelectedChannel(requestedModel: string, downstreamPolicy?: unknown): Promise<SelectedChannelLike | null> {
    if (this.deps.previewSelectedChannel) {
      return this.deps.previewSelectedChannel(requestedModel, downstreamPolicy);
    }
    return this.deps.selectChannel(requestedModel, downstreamPolicy);
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const excludeChannelIds: number[] = [];
    let attempts = 0;
    let retryBudget = createRetryBudget(input.retryBudget);
    const replaySafety = input.replaySafety ?? 'safe_only';
    let selected = await this.deps.selectChannel(input.requestedModel, input.downstreamPolicy);
    if (!selected) {
      return {
        ok: false,
        reason: 'no_channel',
        attempts: 0,
      };
    }

    while (selected) {
      const selectedRetryPolicy = resolveApiChannelRetryPolicy(selected.channel);
      const retryOwner = input.retryOwner ?? selectedRetryPolicy.retryOwner;
      const attemptSpend = spendRetryBudget(retryBudget, { attempt: true });
      if (!attemptSpend.allowed) {
        return {
          ok: false,
          reason: 'budget_exhausted',
          selected,
          attempts,
          retryBudget,
        };
      }
      retryBudget = attemptSpend.state;

      const result = await input.attempt({
        selected,
        attemptIndex: attempts,
        excludeChannelIds: [...excludeChannelIds],
        retryBudget,
        retryOwner,
        replaySafety,
      });
      attempts += 1;

      if (result.ok) {
        await recordSuccessfulAttempt(this.deps, selected.channel.id, {
          latencyMs: result.latencyMs ?? null,
          cost: result.cost ?? null,
        });
        return {
          ok: true,
          selected,
          response: result.response,
          attempts,
        };
      }

      const action = failureActionOf(result);
      await recordFailedAttempt(this.deps, selected.channel.id, {
        status: result.status,
        rawErrorText: result.rawErrorText,
      });

      if (isTerminalFailure(action)) {
        await input.onTerminalFailure?.(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
        });
        return {
          ok: false,
          reason: 'terminal',
          selected,
          status: result.status,
          rawErrorText: result.rawErrorText,
          attempts,
        };
      }

      const errorScope = result.errorScope ?? 'unknown';
      const retryAllowed = canRetryLocally({
        retryOwner: result.retryOwner ?? retryOwner,
        replaySafety: result.replaySafety ?? replaySafety,
        commitState: result.commitState ?? 'not_started',
        errorScope,
        upstreamRetryable: upstreamClaimsRetryForFailure({
          policy: selectedRetryPolicy,
          errorScope,
          explicitUpstreamRetryable: result.upstreamRetryable,
        }),
        explicitReplay: input.explicitReplay,
      });
      if (!retryAllowed) {
        return {
          ok: false,
          reason: 'failed',
          selected,
          status: result.status,
          rawErrorText: result.rawErrorText,
          attempts,
          retryBudget,
        };
      }

      if (shouldRetrySameChannel(action)) {
        continue;
      }

      if (shouldRefreshAuth(action) && this.deps.refreshAuth) {
        const refreshed = await this.deps.refreshAuth(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
        });
        if (refreshed) {
          const rotationSpend = spendRetryBudget(retryBudget, { credentialRotation: true });
          if (!rotationSpend.allowed) {
            return {
              ok: false,
              reason: 'budget_exhausted',
              selected,
              status: result.status,
              rawErrorText: result.rawErrorText,
              attempts,
              retryBudget,
            };
          }
          retryBudget = rotationSpend.state;
          selected = refreshed;
          continue;
        }
      }

      if (shouldFailover(action)) {
        excludeChannelIds.push(selected.channel.id);
        const next = await this.deps.selectNextChannel(
          input.requestedModel,
          excludeChannelIds,
          input.downstreamPolicy,
        );
        if (!next) {
          return {
            ok: false,
            reason: 'failed',
            selected,
            status: result.status,
            rawErrorText: result.rawErrorText,
            attempts,
            retryBudget,
          };
        }
        const switchSpend = spendRetryBudget(retryBudget, { channelSwitch: true });
        if (!switchSpend.allowed) {
          return {
            ok: false,
            reason: 'budget_exhausted',
            selected,
            status: result.status,
            rawErrorText: result.rawErrorText,
            attempts,
            retryBudget,
          };
        }
        retryBudget = switchSpend.state;
        selected = next;
        continue;
      }

      return {
        ok: false,
        reason: 'failed',
        selected,
        status: result.status,
        rawErrorText: result.rawErrorText,
        attempts,
        retryBudget,
      };
    }

    return {
      ok: false,
      reason: 'failed',
      attempts,
      retryBudget,
    };
  }
}
