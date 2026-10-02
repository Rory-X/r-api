import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('cost analytics architecture boundaries', () => {
  it('keeps long-term cost reads on projected tables instead of raw proxy logs', () => {
    const service = source('src/server/services/costAnalyticsService.ts');
    const route = source('src/server/routes/api/stats.ts');

    expect(service).toContain('schema.downstreamKeyDayUsage');
    expect(service).toContain("dimensionType: 'downstream_project'");
    expect(service).toContain('schema.downstreamApiKeys.groupName');
    expect(service).toContain('schema.modelDayUsage');
    expect(service).toContain('schema.siteDayUsage');
    expect(service).not.toContain('schema.proxyLogs');
    expect(route).toContain('queryCostAnalytics');
  });
});
