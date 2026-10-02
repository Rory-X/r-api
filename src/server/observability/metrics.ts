import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const observabilityRegistry = new Registry();

observabilityRegistry.setDefaultLabels({ service: 'r-api' });
collectDefaultMetrics({
  prefix: 'r_api_',
  register: observabilityRegistry,
});

const httpRequestsTotal = new Counter({
  name: 'r_api_http_requests_total',
  help: 'HTTP requests completed by method, route, and status class.',
  labelNames: ['method', 'route', 'status_class'] as const,
  registers: [observabilityRegistry],
});

const httpRequestDurationSeconds = new Histogram({
  name: 'r_api_http_request_duration_seconds',
  help: 'HTTP request duration in seconds by method and route.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 180],
  registers: [observabilityRegistry],
});

const httpRequestsInFlight = new Gauge({
  name: 'r_api_http_requests_in_flight',
  help: 'HTTP requests currently being processed.',
  registers: [observabilityRegistry],
});

const proxyRequestsTotal = new Counter({
  name: 'r_api_proxy_requests_total',
  help: 'Final proxy request outcomes by API surface.',
  labelNames: ['surface', 'outcome'] as const,
  registers: [observabilityRegistry],
});

const proxyRequestDurationSeconds = new Histogram({
  name: 'r_api_proxy_request_duration_seconds',
  help: 'End-to-end proxy request duration in seconds by API surface.',
  labelNames: ['surface'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 180, 600],
  registers: [observabilityRegistry],
});

const proxyAttempts = new Histogram({
  name: 'r_api_proxy_attempts',
  help: 'Number of upstream attempts used by each completed proxy request.',
  labelNames: ['surface'] as const,
  buckets: [1, 2, 3, 4, 5, 8, 13],
  registers: [observabilityRegistry],
});

const proxyFirstByteSeconds = new Histogram({
  name: 'r_api_proxy_first_byte_seconds',
  help: 'Observed upstream first-byte latency in seconds by API surface.',
  labelNames: ['surface'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [observabilityRegistry],
});

const workerUp = new Gauge({
  name: 'r_api_worker_up',
  help: 'Whether a background worker is healthy (1) or unhealthy (0).',
  labelNames: ['worker'] as const,
  registers: [observabilityRegistry],
});

const workerEnabled = new Gauge({
  name: 'r_api_worker_enabled',
  help: 'Whether a background worker is expected to run.',
  labelNames: ['worker'] as const,
  registers: [observabilityRegistry],
});

const workerRunsTotal = new Counter({
  name: 'r_api_worker_runs_total',
  help: 'Background worker passes by outcome.',
  labelNames: ['worker', 'outcome'] as const,
  registers: [observabilityRegistry],
});

const workerRunDurationSeconds = new Histogram({
  name: 'r_api_worker_run_duration_seconds',
  help: 'Background worker pass duration in seconds.',
  labelNames: ['worker'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 180],
  registers: [observabilityRegistry],
});

const workerLastSuccessTimestampSeconds = new Gauge({
  name: 'r_api_worker_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful background worker pass.',
  labelNames: ['worker'] as const,
  registers: [observabilityRegistry],
});

const workerConsecutiveFailures = new Gauge({
  name: 'r_api_worker_consecutive_failures',
  help: 'Current consecutive failure count for a background worker.',
  labelNames: ['worker'] as const,
  registers: [observabilityRegistry],
});

const readinessStatus = new Gauge({
  name: 'r_api_readiness_status',
  help: 'Whether the application is ready to receive traffic.',
  registers: [observabilityRegistry],
});

const dependencyUp = new Gauge({
  name: 'r_api_dependency_up',
  help: 'Whether a readiness dependency is available.',
  labelNames: ['dependency'] as const,
  registers: [observabilityRegistry],
});

export function normalizeRouteLabel(value: unknown): string {
  const route = String(value || '').trim();
  if (!route) return 'unmatched';
  return route.split('?')[0] || 'unmatched';
}

export function proxySurfaceFromPath(value: unknown): string {
  const path = normalizeRouteLabel(value).toLowerCase();
  if (path.includes('/chat/completions')) return 'chat_completions';
  if (path.includes('/responses')) return 'responses';
  if (path.includes('streamgeneratecontent')) return 'gemini_stream_generate_content';
  if (path.includes('generatecontent')) return 'gemini_generate_content';
  if (path.includes('/messages')) return 'anthropic_messages';
  if (path.includes('/embeddings')) return 'embeddings';
  if (path.includes('/models')) return 'models';
  return 'other';
}

export function startHttpRequestObservation(): { startedAtNs: bigint } {
  httpRequestsInFlight.inc();
  return { startedAtNs: process.hrtime.bigint() };
}

export function finishHttpRequestObservation(input: {
  method: string;
  route: string;
  statusCode: number;
  startedAtNs: bigint;
}): void {
  httpRequestsInFlight.dec();
  const statusClass = Number.isFinite(input.statusCode)
    ? `${Math.max(0, Math.trunc(input.statusCode / 100))}xx`
    : 'unknown';
  const labels = {
    method: input.method.toUpperCase(),
    route: normalizeRouteLabel(input.route),
  };
  httpRequestsTotal.inc({ ...labels, status_class: statusClass });
  httpRequestDurationSeconds.observe(
    labels,
    Number(process.hrtime.bigint() - input.startedAtNs) / 1_000_000_000,
  );
}

export function observeProxyRequest(input: {
  downstreamPath: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  durationMs: number;
  attemptCount: number;
}): void {
  const surface = proxySurfaceFromPath(input.downstreamPath);
  proxyRequestsTotal.inc({ surface, outcome: input.outcome });
  proxyRequestDurationSeconds.observe({ surface }, Math.max(0, input.durationMs) / 1_000);
  proxyAttempts.observe({ surface }, Math.max(0, input.attemptCount));
}

export function observeProxyFirstByte(downstreamPath: string, firstByteLatencyMs: number | null | undefined): void {
  if (typeof firstByteLatencyMs !== 'number' || !Number.isFinite(firstByteLatencyMs) || firstByteLatencyMs < 0) return;
  proxyFirstByteSeconds.observe(
    { surface: proxySurfaceFromPath(downstreamPath) },
    firstByteLatencyMs / 1_000,
  );
}

export function observeWorkerRun(input: {
  worker: string;
  outcome: 'success' | 'failure';
  durationMs: number;
  lastSuccessAtMs: number | null;
  consecutiveFailures: number;
}): void {
  workerRunsTotal.inc({ worker: input.worker, outcome: input.outcome });
  workerRunDurationSeconds.observe({ worker: input.worker }, Math.max(0, input.durationMs) / 1_000);
  workerConsecutiveFailures.set({ worker: input.worker }, input.consecutiveFailures);
  if (input.lastSuccessAtMs !== null) {
    workerLastSuccessTimestampSeconds.set({ worker: input.worker }, input.lastSuccessAtMs / 1_000);
  }
}

export function setWorkerMetric(
  worker: string,
  healthy: boolean,
  consecutiveFailures: number,
  enabled = true,
): void {
  workerUp.set({ worker }, healthy ? 1 : 0);
  workerEnabled.set({ worker }, enabled ? 1 : 0);
  workerConsecutiveFailures.set({ worker }, consecutiveFailures);
}

export function removeWorkerMetric(worker: string): void {
  workerUp.remove(worker);
  workerEnabled.remove(worker);
  workerConsecutiveFailures.remove(worker);
  workerLastSuccessTimestampSeconds.remove(worker);
}

export function setReadinessMetric(ready: boolean): void {
  readinessStatus.set(ready ? 1 : 0);
}

export function setDependencyMetric(dependency: string, available: boolean): void {
  dependencyUp.set({ dependency }, available ? 1 : 0);
}

export function resetObservabilityMetricsForTests(): void {
  observabilityRegistry.resetMetrics();
}
