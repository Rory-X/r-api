import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RerankRequest } from '../../contracts/rerank.js';
import { isValidRerankResponse, extractRerankUsagePayload } from '../../contracts/rerank.js';
import { getProxyAdmissionError } from '../../contracts/proxyAdmission.js';
import { config } from '../../config.js';
import { getProxyAuthContext } from '../../middleware/auth.js';
import {
  isModelAllowedByPolicyOrAllowedRoutes,
  recordManagedKeyCostUsage,
  recordManagedKeyTokenUsage,
} from '../../services/downstreamApiKeyService.js';
import { ensureDownstreamDispatchPolicy } from '../../services/downstreamDispatchPolicy.js';
import { EMPTY_DOWNSTREAM_ROUTING_POLICY } from '../../services/downstreamPolicyTypes.js';
import { startProxyAttemptLedgerSession } from '../../services/proxyAttemptLedgerRuntime.js';
import { createRetryBudget, canRetryLocally, classifyRetryErrorScope, type AttemptCommitState } from '../../services/proxyRetryContract.js';
import { resolveApiChannelRetryPolicy, upstreamClaimsRetryForFailure } from '../../services/proxyRetryOwnership.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { getSiteApiEndpointIdFromError, runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import { resolveRerankCapability } from '../../services/platforms/rerankCapability.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { withProxyRequestAbortScope, getProxyRequestSignal } from '../requestAbortContext.js';
import { getTesterForcedChannelId, canRetryChannelSelection, buildForcedChannelUnavailableMessage } from '../channelSelection.js';
import { executeEndpointFlow, type EndpointAttemptSuccessContext } from '../orchestration/endpointFlow.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { readRuntimeResponseText } from '../executors/types.js';
import { parseProxyUsage, hasProxyUsagePayload } from '../../services/proxyUsageParser.js';
import { createSurfaceDispatchRequest, createSurfaceFailureToolkit, selectSurfaceChannelForAttempt, recordSurfaceSuccess } from './sharedSurface.js';

class RerankRetryBudgetError extends Error {
  readonly localProxyAdmissionFailure = true;
  readonly status = 503;
  readonly code = 'proxy_retry_budget_exhausted';
  constructor() { super('Rerank outgoing attempt budget exhausted'); }
}

export async function handleRerankSurfaceRequest(request: FastifyRequest, reply: FastifyReply, body: RerankRequest) {
  return withProxyRequestAbortScope(request.raw, reply.raw, () => runRerankRequest(request, reply, body));
}

async function runRerankRequest(request: FastifyRequest, reply: FastifyReply, body: RerankRequest) {
  const downstreamPath = '/v1/rerank';
  const requestedModel = body.model;
  const auth = getProxyAuthContext(request);
  const signal = getProxyRequestSignal()!;
  const maxRetries = getProxyMaxChannelRetries();
  const clientContext = detectDownstreamClientContext({ downstreamPath, headers: request.headers as Record<string, unknown>, body });
  const ledger = await startProxyAttemptLedgerSession({
    requestedModel, downstreamPath, downstreamApiKeyId: auth?.keyId ?? null,
    clientKind: clientContext.clientKind,
    policy: { retryOwner: 'cooperative', replaySafety: 'safe_only', retryBudget: createRetryBudget({ maxAttempts: maxRetries + 1 }) },
  });
  if (ledger) reply.header('x-metapi-request-id', ledger.requestId);
  const finish = async (status: number, payload: unknown) => {
    await ledger?.finishRequest('failed');
    return reply.code(status).send(payload);
  };
  if (auth && !await isModelAllowedByPolicyOrAllowedRoutes(requestedModel, auth.policy)) {
    return finish(403, { error: { message: `Model not allowed for this API key: ${requestedModel}`, type: 'permission_error' } });
  }
  const checkPolicy = async () => {
    signal.throwIfAborted();
    if (auth) await ensureDownstreamDispatchPolicy(auth.snapshot);
  };
  const failures = createSurfaceFailureToolkit({
    warningScope: 'rerank', endpoint: 'rerank', downstreamPath, maxRetries,
    clientContext, downstreamApiKeyId: auth?.keyId ?? null,
    requestId: ledger?.requestId ?? null, getAttemptId: () => ledger?.getLatestAttemptId() ?? null,
  });
  const excludeChannelIds: number[] = [];
  const forcedChannelId = getTesterForcedChannelId({ headers: request.headers as Record<string, unknown>, clientIp: request.ip });
  let outgoingAttempts = 0;
  try {
    for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
      await checkPolicy();
      const selected = await selectSurfaceChannelForAttempt({
        requestedModel, downstreamPolicy: auth?.policy ?? EMPTY_DOWNSTREAM_ROUTING_POLICY,
        excludeChannelIds, retryCount, forcedChannelId,
        selectionConstraints: { requiredEndpoint: 'rerank' }, onRoutingDecision: ledger?.recordRoutingDecision,
      });
      if (!selected) return finish(503, { error: { message: buildForcedChannelUnavailableMessage(forcedChannelId), type: 'server_error', code: 'rerank_channel_unavailable' } });
      excludeChannelIds.push(selected.channel.id);
      // Forced/mock/legacy channel selectors must still honor the endpoint contract.
      if (resolveRerankCapability(selected.site) !== 'passthrough') return finish(501, { error: { message: 'Selected platform does not provide rerank passthrough', type: 'unsupported_endpoint', code: 'rerank_unsupported' } });
      const modelName = selected.actualModel || requestedModel;
      const policy = resolveApiChannelRetryPolicy(selected.channel);
      await ledger?.setRetryOwner(policy.retryOwner);
      ledger?.setSelection({ channelId: selected.channel.id, accountId: selected.account.id, tokenId: selected.channel.tokenId ?? null });
      const startedAt = Date.now();
      const state: { commit: AttemptCommitState; success: EndpointAttemptSuccessContext<'rerank'> | null } = { commit: 'not_started', success: null };
      const beforeDispatch = async () => {
        await checkPolicy();
        if (outgoingAttempts >= maxRetries + 1) throw new RerankRetryBudgetError();
        outgoingAttempts++;
      };
      try {
        const response = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const dispatch = createSurfaceDispatchRequest({ site: selected.site, siteUrl: target.baseUrl, accountExtraConfig: selected.account.extraConfig, signal, beforeDispatch });
          const flow = await executeEndpointFlow<'rerank'>({
            siteUrl: target.baseUrl, signal, endpointCandidates: ['rerank'], disableCrossProtocolFallback: true,
            firstByteTimeoutMs: Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000)),
            buildRequest: () => ({ endpoint: 'rerank', path: '/v1/rerank', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${selected.tokenValue}` }, body: { ...body, model: modelName } }),
            dispatchRequest: dispatch,
            createAttemptIdentity: ledger?.createAttemptIdentity,
            onAttemptStart: async (ctx) => { state.commit = 'not_started'; await ledger?.onAttemptStart(ctx); },
            onAttemptCommitState: async (ctx) => { state.commit = ctx.commitState; await ledger?.onAttemptCommitState(ctx); },
            onAttemptFailure: ledger?.onAttemptFailure,
            onAttemptSuccess: (ctx) => { state.success = ctx; },
          });
          if (!flow.ok) throw new SiteApiEndpointRequestError(flow.rawErrText || flow.errText, { status: flow.status, rawErrText: flow.rawErrText || flow.errText });
          return flow.upstream;
        }, {
          signal,
          canReplayFailure: (error) => {
            const scope = classifyRetryErrorScope({ status: error instanceof SiteApiEndpointRequestError ? error.status ?? 0 : 0, rawErrorText: error instanceof Error ? error.message : '' });
            return canRetryLocally({ retryOwner: policy.retryOwner, replaySafety: 'safe_only', commitState: state.commit, errorScope: scope, upstreamRetryable: upstreamClaimsRetryForFailure({ policy, errorScope: scope }) });
          },
        });
        const text = await readRuntimeResponseText(response, null);
        signal.throwIfAborted();
        let payload: unknown;
        try { payload = JSON.parse(text); } catch { payload = null; }
        if (!isValidRerankResponse(payload, body.documents.length)) {
          await ledger?.finishRequest('failed');
          await failures.log({ selected, modelRequested: requestedModel, status: 'failed', httpStatus: 502, latencyMs: Date.now() - startedAt, errorMessage: 'Invalid upstream rerank response', retryCount, upstreamPath: '/v1/rerank' });
          return reply.code(502).send({ error: { message: 'Invalid upstream rerank response', type: 'upstream_error' } });
        }
        const usagePayload = extractRerankUsagePayload(payload);
        const usage = parseProxyUsage(usagePayload);
        const success = await recordSurfaceSuccess({
          endpoint: 'rerank', selected, requestedModel, modelName, parsedUsage: usage,
          upstreamUsagePresent: hasProxyUsagePayload(usagePayload), upstreamHeaders: response.headers,
          requestStartedAtMs: startedAt, latencyMs: Date.now() - startedAt, firstByteLatencyMs: getObservedResponseMeta(response)?.firstByteLatencyMs ?? null,
          retryCount, upstreamPath: '/v1/rerank', logSuccess: failures.log,
          recordDownstreamCost: async (cost) => { if (auth?.keyId != null) await recordManagedKeyCostUsage(auth.keyId, cost); },
        });
        if (auth?.keyId != null && success.resolvedUsage.usageSource !== 'unknown') await recordManagedKeyTokenUsage(auth.keyId, success.resolvedUsage.totalTokens, success.resolvedUsage);
        if (state.success) await ledger?.onAttemptSuccess(state.success);
        await ledger?.finishRequest('succeeded');
        return reply.code(response.status).send(payload);
      } catch (error) {
        if (signal.aborted) { await ledger?.finishRequest('cancelled'); return; }
        const admissionError = getProxyAdmissionError(error);
        if (admissionError) {
          await ledger?.finishRequest('failed');
          await failures.log({ selected, modelRequested: requestedModel, status: 'failed', httpStatus: admissionError.status, latencyMs: Date.now() - startedAt, errorMessage: admissionError.message, retryCount });
          return reply.code(admissionError.status).send({ error: { message: admissionError.message, type: 'server_error', code: admissionError.code } });
        }
        const errorMessage = error instanceof Error ? error.message : 'Rerank execution failed';
        if (state.commit === 'response_started') {
          await ledger?.finishRequest('failed');
          await failures.recordStreamFailure({ selected, requestedModel, modelName, errorMessage, latencyMs: Date.now() - startedAt, retryCount, runtimeFailureStatus: 502, httpStatus: 502 });
          return reply.code(502).send({ error: { message: errorMessage, type: 'upstream_error' } });
        }
        const status = error instanceof SiteApiEndpointRequestError ? error.status || 502 : 0;
        const outcome = status
          ? await failures.handleUpstreamFailure({ selected, requestedModel, modelName, status, errText: errorMessage, rawErrText: error instanceof SiteApiEndpointRequestError ? error.rawErrText : null, endpointId: getSiteApiEndpointIdFromError(error), latencyMs: Date.now() - startedAt, retryCount, commitState: state.commit })
          : await failures.handleExecutionError({ selected, requestedModel, modelName, errorMessage, latencyMs: Date.now() - startedAt, retryCount, commitState: state.commit });
        if (outcome.action === 'retry' && canRetryChannelSelection(retryCount, forcedChannelId)) continue;
        await ledger?.finishRequest(state.commit === 'sent_unknown' ? 'unknown' : 'failed');
        return outcome.action === 'respond' ? reply.code(outcome.status).send(outcome.payload) : reply.code(status || 502).send({ error: { message: errorMessage, type: 'upstream_error' } });
      }
    }
    return finish(503, { error: { message: 'No available rerank channels', type: 'server_error' } });
  } catch (error) {
    if (signal.aborted) { await ledger?.finishRequest('cancelled'); return; }
    const admissionError = getProxyAdmissionError(error);
    if (admissionError) return finish(admissionError.status, { error: { message: admissionError.message, type: 'permission_error', code: admissionError.code } });
    await ledger?.finishRequest('failed');
    throw error;
  }
}
