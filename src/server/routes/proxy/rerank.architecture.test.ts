import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('rerank ownership boundaries', () => {
  it('uses a thin adapter with endpoint flow, shared transport/bookkeeping and explicit ledger identity', () => {
    const route = source('./rerank.ts');
    expect(route).toContain('parseRerankRequest(request.body)');
    expect(route).toContain('handleRerankSurfaceRequest(');
    expect(route).not.toMatch(/fetch|tokenRouter|db|retry/i);
    const surface = source('../../proxy-core/surfaces/rerankSurface.ts');
    for (const boundary of ["executeEndpointFlow<'rerank'>", 'createSurfaceDispatchRequest(', 'selectSurfaceChannelForAttempt(', 'recordSurfaceSuccess(', 'startProxyAttemptLedgerSession(', 'ensureDownstreamDispatchPolicy(', 'beforeDispatch']) expect(surface).toContain(boundary);
    expect(surface).not.toMatch(/from ['"][^'"]*routes\//);
    expect(surface).not.toContain("endpoint: 'chat'");
    expect(source('../../contracts/rerank.ts')).not.toMatch(/from ['"][^'"]*(?:routes|services|fastify)/);
  });
});
