import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('context metadata ownership', () => {
  it('keeps discovery evidence request-local and persists it through existing model records', () => {
    const contract = read('../contracts/modelDiscovery.ts');
    const base = read('./platforms/base.ts');
    const service = read('./modelService.ts');
    const context = read('./modelContextService.ts');
    expect(base).toContain('async discoverModels(');
    expect(service).toContain('withAccountModelRefresh(');
    expect(service).toContain('scan.accountRows');
    expect(service).toContain('scan.tokenRows');
    expect(service).toContain('await withRouteMutation(() => db.transaction(');
    expect(context).toContain('schema.tokenModelAvailability');
    expect(context).toContain('schema.modelAvailability');
    expect(context).not.toContain('new Map');
    for (const source of [contract, context]) {
      expect(source).not.toContain('/routes/');
      expect(source).not.toContain('fastify');
      expect(source).not.toContain('DEFAULT_CONTEXT_LENGTH');
    }
  });
  it('aggregates the actual routable credentials and keeps protocol output in the surface', () => {
    const router = read('./tokenRouter.ts');
    expect(router).toContain('this.getCandidateEligibilityReasons(candidate, options)');
    expect(router).toContain('this.getEligibleRouteUnitMembers(candidate, options)');
    expect(router).toContain('return getKnownModelContextLength(refs)');
    const route = read('../routes/proxy/models.ts');
    expect(route).not.toContain('context_length');
    expect(route).not.toContain('schema.modelAvailability');
  });
});
