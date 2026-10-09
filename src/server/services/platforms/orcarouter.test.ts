import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { OrcaRouterAdapter } from './orcarouter.js';

const mocks = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));

// Stub the transport boundary so parallel catalog scans do not depend on
// Vitest's concurrent dynamic-import mocking of Undici.
class DiscoveryTestAdapter extends OrcaRouterAdapter {
  protected override async fetchJson<T>(url: string, options?: UndiciRequestInit): Promise<T> {
    return mocks.fetchJson(url, options);
  }
}

afterEach(() => vi.resetAllMocks());

describe('OrcaRouter model discovery', () => {
  it('uses the versioned endpoint and preserves sourced model context metadata', async () => {
    mocks.fetchJson.mockResolvedValue({ data: [{ id: 'orcarouter/auto', context_length: 128000 }] });

    const models = await new DiscoveryTestAdapter().discoverModels('https://api.orcarouter.ai/v1', 'sk-orca-test');

    expect(mocks.fetchJson).toHaveBeenCalledWith('https://api.orcarouter.ai/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-orca-test' }),
    }));
    expect(models).toEqual([{
      modelName: 'orcarouter/auto', contextLength: 128000, contextSource: 'orcarouter.models:context_length',
    }]);
  });

  it('isolates concurrent credential scans and discards missing context metadata on refresh', async () => {
    let firstCredentialScans = 0;
    mocks.fetchJson.mockImplementation(async (_url: string, options: { headers: Record<string, string> }) => {
      const firstCredential = options.headers.Authorization === 'Bearer sk-orca-first';
      const contextLength = firstCredential
        ? (++firstCredentialScans === 1 ? 128000 : undefined)
        : 64000;
      return { data: [{ id: 'shared', context_length: contextLength }] };
    });
    const adapter = new DiscoveryTestAdapter();

    const [first, second] = await Promise.all([
      adapter.discoverModels('https://api.orcarouter.ai', 'sk-orca-first'),
      adapter.discoverModels('https://api.orcarouter.ai', 'sk-orca-second'),
    ]);

    expect(first[0]?.contextLength).toBe(128000);
    expect(second[0]?.contextLength).toBe(64000);
    expect(await adapter.discoverModels('https://api.orcarouter.ai', 'sk-orca-first')).toEqual([{ modelName: 'shared' }]);
  });
});
