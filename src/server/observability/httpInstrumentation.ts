import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  finishHttpRequestObservation,
  normalizeRouteLabel,
  startHttpRequestObservation,
} from './metrics.js';

type RequestObservation = {
  startedAtNs: bigint;
  span: Span | undefined;
  finished: boolean;
};

const observations = new WeakMap<FastifyRequest, RequestObservation>();

function routeFor(request: FastifyRequest): string {
  return normalizeRouteLabel(request.routeOptions?.url || request.url);
}

function finish(request: FastifyRequest, statusCode: number): void {
  const observation = observations.get(request);
  if (!observation || observation.finished) return;
  observation.finished = true;
  const route = routeFor(request);
  finishHttpRequestObservation({
    method: request.method,
    route,
    statusCode,
    startedAtNs: observation.startedAtNs,
  });
  observation.span?.updateName(`${request.method.toUpperCase()} ${route}`);
  observation.span?.setAttributes({
    'http.route': route,
    'http.response.status_code': statusCode,
    'r_api.request.id': request.id,
  });
  if (statusCode >= 500) {
    observation.span?.setStatus({ code: SpanStatusCode.ERROR });
  }
}

export function registerHttpObservabilityHooks(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    observations.set(request, {
      ...startHttpRequestObservation(),
      span: trace.getActiveSpan(),
      finished: false,
    });
  });

  app.addHook('onError', async (request, _reply, error) => {
    const span = observations.get(request)?.span;
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  });

  app.addHook('onResponse', async (request, reply) => {
    finish(request, reply.statusCode);
  });

  app.addHook('onRequestAbort', async (request) => {
    finish(request, 499);
  });
}
