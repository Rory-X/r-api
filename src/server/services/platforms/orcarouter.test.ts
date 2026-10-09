import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrcaRouterAdapter } from './orcarouter.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('undici', () => ({ fetch: mocks.fetch }));
vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));

afterEach(() => vi.resetAllMocks());

describe('OrcaRouter model discovery', () => {
  it('uses the versioned endpoint and preserves sourced model context metadata', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'orcarouter/auto', context_length: 128000 }],
    })));

    const models = await new OrcaRouterAdapter().discoverModels('https://api.orcarouter.ai/v1', 'sk-orca-test');

    expect(mocks.fetch).toHaveBeenCalledWith('https://api.orcarouter.ai/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-orca-test' }),
    }));
    expect(models).toEqual([{
      modelName: 'orcarouter/auto', contextLength: 128000, contextSource: 'orcarouter.models:context_length',
    }]);
  });

  it('isolates concurrent credential scans and discards missing context metadata on refresh', async () => {
    mocks.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'shared', context_length: 128000 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'shared', context_length: 64000 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'shared' }] })));
    const adapter = new OrcaRouterAdapter();

    const [first, second] = await Promise.all([
      adapter.discoverModels('https://api.orcarouter.ai', 'sk-orca-first'),
      adapter.discoverModels('https://api.orcarouter.ai', 'sk-orca-second'),
    ]);

    expect(first[0]?.contextLength).toBe(128000);
    expect(second[0]?.contextLength).toBe(64000);
    expect(await adapter.discoverModels('https://api.orcarouter.ai', 'sk-orca-first')).toEqual([{ modelName: 'shared' }]);
  });
});
