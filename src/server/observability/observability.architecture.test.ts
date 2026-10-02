import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('operational observability architecture', () => {
  it('keeps operational routes as adapters over observability owners', () => {
    const route = source('src/server/routes/operations.ts');
    const health = source('src/server/observability/healthService.ts');

    expect(route).toContain("from '../observability/healthService.js'");
    expect(route).toContain("from '../observability/workerHealth.js'");
    expect(route).not.toContain('/db/');
    expect(route).not.toContain('prom-client');
    expect(health).toContain("from '../db/index.js'");
  });

  it('keeps Prometheus labels bounded to declared low-cardinality dimensions', () => {
    const metrics = source('src/server/observability/metrics.ts');

    expect(metrics).not.toMatch(/labelNames:\s*\[[^\]]*(?:model|account|channel|request_id|session)/);
    expect(metrics).toContain("labelNames: ['method', 'route', 'status_class']");
    expect(metrics).toContain("labelNames: ['worker', 'outcome']");
  });

  it('routes worker passes through the shared health registry', () => {
    const schedulers = [
      'src/server/services/notificationOutboxService.ts',
      'src/server/services/usageAggregationService.ts',
      'src/server/services/channelRecoveryProbeService.ts',
      'src/server/services/localConnectorHealthScheduler.ts',
      'src/server/services/checkinScheduler.ts',
      'src/server/services/credentialLifecycleOperationsService.ts',
    ];

    for (const path of schedulers) {
      expect(source(path)).toContain('runObservedWorkerPass(');
    }
  });
});
