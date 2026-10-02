import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerHttpObservabilityHooks } from './httpInstrumentation.js';
import { observabilityRegistry, resetObservabilityMetricsForTests } from './metrics.js';

describe('HTTP observability hooks', () => {
  beforeEach(() => {
    resetObservabilityMetricsForTests();
  });

  it('records route templates instead of raw dynamic URLs', async () => {
    const app = Fastify();
    registerHttpObservabilityHooks(app);
    app.get('/items/:id', async () => ({ ok: true }));

    const response = await app.inject({ method: 'GET', url: '/items/12345' });
    const metrics = await observabilityRegistry.metrics();

    expect(response.statusCode).toBe(200);
    expect(metrics).toContain('route="/items/:id"');
    expect(metrics).not.toContain('route="/items/12345"');
    await app.close();
  });
});
