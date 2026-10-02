import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
describe('pattern group sync boundaries', () => {
  it('keeps candidate policy and synchronization outside controllers', () => {
    const route = read('../routes/api/tokens.ts');
    const model = read('./modelService.ts');
    const sync = read('./patternRouteChannelSyncService.ts');
    const candidate = read('./routeModelCandidateService.ts');
    expect(route).toContain("from '../../services/patternRouteChannelSyncService.js'");
    expect(route).not.toContain('async function getPatternTokenCandidates');
    expect(route).not.toContain('async function populateRouteChannelsByModelPattern');
    expect(model).toContain('await loadRoutingModelCandidates()');
    expect(model).toContain('syncPatternRouteChannels({ candidates: modelCandidates })');
    expect(model).toContain('withRouteMutation(rebuildTokenRoutesFromAvailabilityInternal)');
    expect(sync).toContain('await loadRoutingModelCandidates()');
    expect(sync).toContain('db.transaction(');
    for (const source of [sync, candidate]) {
      expect(source).not.toContain('/routes/');
      expect(source).not.toContain('fastify');
    }
  });
});
