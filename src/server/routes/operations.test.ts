import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetApplicationReadinessForTests,
  setApplicationReadiness,
} from '../observability/healthService.js';
import { resetObservabilityMetricsForTests } from '../observability/metrics.js';
import { resetWorkerHealthForTests } from '../observability/workerHealth.js';
import { operationsRoutes } from './operations.js';
import { config } from '../config.js';

describe('operational routes', () => {
  beforeEach(() => {
    resetApplicationReadinessForTests();
    resetWorkerHealthForTests();
    resetObservabilityMetricsForTests();
  });

  afterEach(() => {
    resetApplicationReadinessForTests();
  });

  it('keeps liveness independent from readiness', async () => {
    const app = Fastify();
    await app.register(operationsRoutes);

    const live = await app.inject({ method: 'GET', url: '/livez' });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: 'alive' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready' });
    await app.close();
  });

  it('exports Prometheus metrics and the SLO contract', async () => {
    setApplicationReadiness(true);
    const app = Fastify();
    await app.register(operationsRoutes);

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    const slo = await app.inject({ method: 'GET', url: '/health/slo' });
    const vocabulary = await app.inject({ method: 'GET', url: '/health/vocabulary' });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers['content-type']).toContain('text/plain');
    expect(metrics.body).toContain('# HELP r_api_readiness_status');
    expect(slo.json()).toMatchObject({
      evaluationWindowDays: 30,
      indicators: { proxyAvailability: { target: 0.999 } },
    });
    expect(vocabulary.json()).toMatchObject({
      failureCodes: expect.arrayContaining(['rate_limited', 'credential_unavailable']),
      healthDomains: expect.arrayContaining(['endpoint', 'gateway']),
      alertCategories: expect.arrayContaining(['availability', 'capacity']),
    });
    await app.close();
  });

  it('optionally protects metrics without protecting health probes', async () => {
    const previous = config.metricsAuthToken;
    config.metricsAuthToken = 'metrics-secret';
    const app = Fastify();
    await app.register(operationsRoutes);

    const unauthorized = await app.inject({ method: 'GET', url: '/metrics' });
    const authorized = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer metrics-secret' },
    });
    const live = await app.inject({ method: 'GET', url: '/livez' });

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    expect(live.statusCode).toBe(200);
    await app.close();
    config.metricsAuthToken = previous;
  });
});
