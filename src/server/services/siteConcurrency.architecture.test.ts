import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
describe('site capacity architecture', () => {
  it('shares database slot and heartbeat ownership with downstream concurrency', () => {
    for (const file of ['./siteConcurrencyService.ts', './downstreamApiKeyService.ts']) {
      const text = source(file);
      expect(text).toContain('extends DatabaseSlotLease');
      expect(text).toContain('claimDatabaseLeaseSlot(');
      expect(text).not.toContain('setInterval(');
    }
    expect(source('./siteConcurrencyService.ts')).not.toMatch(/from ['"][^'"]*(?:routes|fastify)/);
    expect(source('./databaseSlotLease.ts')).not.toMatch(/new Map/);
  });
  it('owns admission and response lifetime in proxy-core for every transport family', () => {
    const capacity = source('../proxy-core/siteCapacity.ts');
    expect(capacity).toContain('withoutFirstByteObservation(');
    expect(capacity).toContain('acquireSiteConcurrencyLease(site.id!');
    expect(capacity).toContain('highWaterMark: 0');
    expect(capacity).not.toMatch(/from ['"][^'"]*(?:routes|fastify)/);
    const runtime = source('../proxy-core/executors/types.ts');
    expect(runtime).toContain('fetchSiteResponse(input.site,');
    expect(source('../proxy-core/surfaces/sharedSurface.ts')).toContain('site: input.site,');
    for (const name of ['embeddings', 'completions', 'images', 'search', 'videos']) {
      const route = source(`../routes/proxy/${name}.ts`);
      expect(route).toContain('fetchSiteResponse(selected.site,');
      expect(route).not.toMatch(/\bfetch\(/);
      expect(route).not.toContain('acquireSiteConcurrencyLease');
    }
    expect(source('../proxy-core/surfaces/geminiSurface.ts')).toContain('site: selected.site,');
    expect(source('../proxy-core/runtime/codexWebsocketRuntime.ts')).toContain('withSiteCapacityOperation(payload.site,');
    expect(source('../routes/proxy/responsesWebsocket.ts')).toContain('site: codexWebsocketChannel.site,');
    expect(source('../routes/proxy/router.ts')).toContain('withProxyRequestAbortScope(request.raw, reply.raw,');
  });
});
