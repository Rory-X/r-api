export const SERVICE_LEVEL_OBJECTIVES = Object.freeze({
  evaluationWindowDays: 30,
  indicators: Object.freeze({
    proxyAvailability: Object.freeze({
      target: 0.999,
      metric: 'r_api_proxy_requests_total',
      goodOutcomes: Object.freeze(['succeeded']),
      totalOutcomes: Object.freeze(['succeeded', 'failed', 'cancelled', 'unknown']),
    }),
    proxyFirstByteLatency: Object.freeze({
      target: 0.99,
      thresholdSeconds: 5,
      metric: 'r_api_proxy_first_byte_seconds',
    }),
    controlPlaneAvailability: Object.freeze({
      target: 0.999,
      metric: 'r_api_http_requests_total',
      routePrefix: '/api/',
      serverErrorStatusClass: '5xx',
    }),
    workerFreshness: Object.freeze({
      target: 0.999,
      metric: 'r_api_worker_up',
      enabledMetric: 'r_api_worker_enabled',
    }),
  }),
});
