import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('site header priority boundaries', () => {
  it('shares the case-insensitive merge policy across HTTP and native websocket transports', () => {
    const http = read('./siteProxy.ts');
    const websocket = read('../proxy-core/runtime/codexWebsocketRuntime.ts');
    const route = read('../routes/proxy/responsesWebsocket.ts');
    expect(http).toContain('mergeSiteRequestHeaders(resolved, options?.headers)');
    expect(http).toContain('mergeSiteRequestHeaders(site, options?.headers)');
    expect(websocket).toContain('mergeSiteRequestHeaders(');
    expect(route).toContain('site: codexWebsocketChannel.site');
    expect(route).not.toContain('mergeSiteRequestHeaders(');
    expect(route).not.toContain('customHeadersOverrideRequestHeaders');
    const policy = read('./siteCustomHeaders.ts');
    expect(policy).not.toContain('/routes/');
    expect(policy).not.toContain('/db/');
    expect(policy).not.toContain('fastify');
  });
});
