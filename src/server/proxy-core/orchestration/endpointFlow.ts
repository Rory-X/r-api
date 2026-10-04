import { resolveRuntimeRequestUrl } from '../providers/requestUrl.js';
import { fetch } from 'undici';
import { readRuntimeResponseText } from '../executors/types.js';
import { fetchWithObservedFirstByte, isObservedFirstByteTimeoutResponse } from '../firstByteTimeout.js';
import { withSiteProxyRequestInit } from '../../services/siteProxy.js';
import {
  buildUpstreamUrl,
  summarizeUpstreamError,
  type UpstreamEndpoint,
} from './upstreamRequest.js';
import {
  advanceAttemptCommitState,
  type AttemptCommitEvent,
  type AttemptCommitState,
} from '../../services/proxyRetryContract.js';

export type BuiltEndpointRequest = {
  endpoint: UpstreamEndpoint;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime?: {
    executor: 'default' | 'codex' | 'gemini-cli' | 'antigravity' | 'claude' | 'gemini-native';
    modelName?: string;
    stream?: boolean;
    oauthProjectId?: string | null;
    action?: 'generateContent' | 'streamGenerateContent' | 'countTokens';
  };
};

export type EndpointAttemptContext = {
  endpointIndex: number;
  endpointCount: number;
  attemptId: string;
  attemptIndex: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
  rawErrText: string;
  commitState: AttemptCommitState;
  recoverApplied?: boolean;
};

export type EndpointAttemptSuccessContext = {
  endpointIndex: number;
  endpointCount: number;
  attemptId: string;
  attemptIndex: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  response: Awaited<ReturnType<typeof fetch>>;
  commitState: AttemptCommitState;
  recoverApplied?: boolean;
};

export type EndpointAttemptCommitStateContext = {
  endpointIndex: number;
  endpointCount: number;
  attemptId: string;
  attemptIndex: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
  commitState: AttemptCommitState;
  event: AttemptCommitEvent;
  response?: Awaited<ReturnType<typeof fetch>>;
};

export type EndpointAttemptStartContext = {
  endpointIndex: number;
  endpointCount: number;
  request: BuiltEndpointRequest;
  targetUrl: string;
};

export type EndpointAttemptIdentity = {
  attemptId: string;
  attemptIndex: number;
};

export type EndpointRecoverResult = {
  upstream: Awaited<ReturnType<typeof fetch>>;
  upstreamPath: string;
  request?: BuiltEndpointRequest;
  targetUrl?: string;
} | null;

export type EndpointFlowResult =
  | {
    ok: true;
    upstream: Awaited<ReturnType<typeof fetch>>;
    upstreamPath: string;
    successHooksCompletion?: Promise<void>;
  }
  | {
    ok: false;
    status: number;
    errText: string;
    rawErrText?: string;
    commitState?: AttemptCommitState;
  };

export type ExecuteEndpointFlowInput = {
  siteUrl: string;
  proxyUrl?: string | null;
  disableCrossProtocolFallback?: boolean;
  endpointCandidates: UpstreamEndpoint[];
  buildRequest: (endpoint: UpstreamEndpoint, endpointIndex: number) => BuiltEndpointRequest;
  dispatchRequest?: (
    request: BuiltEndpointRequest,
    targetUrl: string,
    signal?: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof fetch>>>;
  firstByteTimeoutMs?: number;
  tryRecover?: (ctx: EndpointAttemptContext) => Promise<EndpointRecoverResult>;
  shouldDowngrade?: (ctx: EndpointAttemptContext) => boolean;
  shouldAbortRemainingEndpoints?: (ctx: EndpointAttemptContext & { errText: string }) => boolean;
  onDowngrade?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<void>;
  onAttemptFailure?: (ctx: EndpointAttemptContext & { errText: string }) => void | Promise<void>;
  onAttemptSuccess?: (ctx: EndpointAttemptSuccessContext) => void | Promise<void>;
  deferSuccessHooks?: boolean;
  onAttemptCommitState?: (ctx: EndpointAttemptCommitStateContext) => void | Promise<void>;
  createAttemptIdentity?: (
    ctx: EndpointAttemptStartContext,
  ) => EndpointAttemptIdentity | Promise<EndpointAttemptIdentity>;
  onAttemptStart?: (
    ctx: EndpointAttemptStartContext & EndpointAttemptIdentity,
  ) => void | Promise<void>;
};

export function withUpstreamPath(path: string, message: string): string {
  return `[upstream:${path}] ${message}`;
}

async function runEndpointFlowHook<T>(
  hook: ((ctx: T) => void | Promise<void>) | undefined,
  ctx: T,
  hookName: string,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(ctx);
  } catch (error) {
    console.error(`endpointFlow ${hookName} hook failed`, error);
  }
}

export async function executeEndpointFlow(input: ExecuteEndpointFlowInput): Promise<EndpointFlowResult> {
  const endpointCount = input.endpointCandidates.length;
  if (endpointCount <= 0) {
    return {
      ok: false,
      status: 502,
      errText: 'Upstream request failed',
    };
  }

  let finalStatus = 0;
  let finalErrText = 'unknown error';
  let finalRawErrText: string | undefined;
  let finalCommitState: AttemptCommitState | undefined;

  for (let endpointIndex = 0; endpointIndex < endpointCount; endpointIndex += 1) {
    const endpoint = input.endpointCandidates[endpointIndex] as UpstreamEndpoint;
    const request = input.buildRequest(endpoint, endpointIndex);
    const defaultTarget = resolveRuntimeRequestUrl(input.siteUrl, request);
    const targetUrl = input.proxyUrl
      ? resolveRuntimeRequestUrl(input.proxyUrl, request)
      : defaultTarget;

    const defaultAttemptIdentity: EndpointAttemptIdentity = {
      attemptId: `endpoint-${endpointIndex}`,
      attemptIndex: endpointIndex,
    };
    let attemptIdentity = defaultAttemptIdentity;
    if (input.createAttemptIdentity) {
      try {
        const created = await input.createAttemptIdentity({
          endpointIndex,
          endpointCount,
          request,
          targetUrl,
        });
        if (created && typeof created.attemptId === 'string' && created.attemptId.trim()) {
          attemptIdentity = {
            attemptId: created.attemptId,
            attemptIndex: Number.isFinite(created.attemptIndex)
              ? Math.max(0, Math.trunc(created.attemptIndex))
              : defaultAttemptIdentity.attemptIndex,
          };
        }
      } catch (error) {
        console.warn('endpointFlow createAttemptIdentity hook failed', error);
      }
    }
    await runEndpointFlowHook(input.onAttemptStart, {
      endpointIndex,
      endpointCount,
      request,
      targetUrl,
      ...attemptIdentity,
    }, 'onAttemptStart');

    const attemptStartedAtMs = Date.now();
    let commitState: AttemptCommitState = 'not_started';
    const emitCommitState = async (
      event: AttemptCommitEvent,
      response?: Awaited<ReturnType<typeof fetch>>,
    ): Promise<void> => {
      const nextState = advanceAttemptCommitState(commitState, event);
      if (nextState === commitState) return;
      commitState = nextState;
      await runEndpointFlowHook(input.onAttemptCommitState, {
        endpointIndex,
        endpointCount,
        request,
        targetUrl,
        ...attemptIdentity,
        commitState,
        event,
        response,
      }, 'onAttemptCommitState');
    };

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetchWithObservedFirstByte(
        async (signal) => (
          input.dispatchRequest
            ? await input.dispatchRequest(request, targetUrl, signal)
            : await fetch(targetUrl, await withSiteProxyRequestInit(targetUrl, {
              method: 'POST',
              headers: request.headers,
              body: JSON.stringify(request.body),
              signal,
            }))
        ),
        {
          firstByteTimeoutMs: input.firstByteTimeoutMs,
          startedAtMs: attemptStartedAtMs,
        },
      );
    } catch (error) {
      await emitCommitState('transport_unknown');
      throw error;
    }

    if (response.ok) {
      const successHooksCompletion = (async () => {
        await emitCommitState('request_sent', response);
        await emitCommitState('response_started', response);
        await runEndpointFlowHook(input.onAttemptSuccess, {
          endpointIndex,
          endpointCount,
          ...attemptIdentity,
          request,
          targetUrl,
          response,
          commitState,
          recoverApplied: false,
        }, 'onAttemptSuccess');
      })();
      if (!input.deferSuccessHooks) {
        await successHooksCompletion;
      }
      return {
        ok: true,
        upstream: response,
        upstreamPath: request.path,
        ...(input.deferSuccessHooks ? { successHooksCompletion } : {}),
      };
    }

    await emitCommitState('request_sent', response);

    let rawErrText = await readRuntimeResponseText(response).catch(() => 'unknown error');
    const baseContext: EndpointAttemptContext = {
      endpointIndex,
      endpointCount,
      ...attemptIdentity,
      request,
      targetUrl,
      response,
      rawErrText,
      commitState,
      recoverApplied: false,
    };
    const isLastEndpoint = endpointIndex >= endpointCount - 1;
    const observedFirstByteTimeout = isObservedFirstByteTimeoutResponse(response);
    if (observedFirstByteTimeout) {
      await emitCommitState('transport_unknown', response);
      baseContext.commitState = commitState;
    }

    if (observedFirstByteTimeout && !isLastEndpoint) {
      const errText = rawErrText.trim() || 'first byte timeout';
      const timeoutContext = {
        ...baseContext,
        errText,
      };
      await runEndpointFlowHook(input.onAttemptFailure, timeoutContext, 'onAttemptFailure');
      finalStatus = response.status || 408;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      finalCommitState = commitState;
      if (input.disableCrossProtocolFallback) {
        break;
      }
      continue;
    }

    if (input.tryRecover) {
      const recovered = await input.tryRecover(baseContext);
      baseContext.recoverApplied = recovered !== null
        || baseContext.request !== request
        || baseContext.response !== response
        || baseContext.rawErrText !== rawErrText;
      if (recovered?.upstream?.ok) {
        const recoveredRequest = recovered.request ?? baseContext.request;
        const recoveredTargetUrl = recovered.targetUrl ?? (
          input.proxyUrl
            ? buildUpstreamUrl(input.proxyUrl, recovered.upstreamPath)
            : buildUpstreamUrl(input.siteUrl, recovered.upstreamPath)
        );
        const successHooksCompletion = (async () => {
          await emitCommitState('response_started', recovered.upstream);
          await runEndpointFlowHook(input.onAttemptSuccess, {
            endpointIndex,
            endpointCount,
            ...attemptIdentity,
            request: recoveredRequest,
            targetUrl: recoveredTargetUrl,
            response: recovered.upstream,
            commitState,
            recoverApplied: true,
          }, 'onAttemptSuccess');
        })();
        if (!input.deferSuccessHooks) {
          await successHooksCompletion;
        }
        return {
          ok: true,
          upstream: recovered.upstream,
          upstreamPath: recovered.upstreamPath,
          ...(input.deferSuccessHooks ? { successHooksCompletion } : {}),
        };
      }
    }

    rawErrText = baseContext.rawErrText;
    response = baseContext.response;
    const errText = withUpstreamPath(
      baseContext.request.path,
      summarizeUpstreamError(response.status, rawErrText),
    );
    await runEndpointFlowHook(input.onAttemptFailure, {
      ...baseContext,
      errText,
    }, 'onAttemptFailure');

    if (input.disableCrossProtocolFallback && !isLastEndpoint) {
      finalStatus = response.status;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      finalCommitState = commitState;
      break;
    }
    const shouldAbortRemainingEndpoints = !isLastEndpoint && !!input.shouldAbortRemainingEndpoints?.({
      ...baseContext,
      errText,
    });
    if (shouldAbortRemainingEndpoints) {
      finalStatus = response.status;
      finalErrText = errText;
      finalRawErrText = rawErrText;
      finalCommitState = commitState;
      break;
    }
    const shouldDowngrade = !isLastEndpoint && !!input.shouldDowngrade?.(baseContext);
    if (shouldDowngrade) {
      await runEndpointFlowHook(input.onDowngrade, {
        ...baseContext,
        errText,
      }, 'onDowngrade');
      continue;
    }

    finalStatus = response.status;
    finalErrText = errText;
    finalRawErrText = rawErrText;
    finalCommitState = commitState;
    break;
  }

  return {
    ok: false,
    status: finalStatus || 502,
    errText: finalErrText || 'unknown error',
    rawErrText: finalRawErrText,
    commitState: finalCommitState,
  };
}
