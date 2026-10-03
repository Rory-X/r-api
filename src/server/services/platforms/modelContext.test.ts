import { describe, expect, it, vi } from 'vitest';
import { OpenAiAdapter } from './openai.js';
import { ClaudeAdapter } from './claude.js';
import { CliProxyApiAdapter } from './cliproxyapi.js';
import { OneApiAdapter } from './oneApi.js';
import { OneHubAdapter } from './oneHub.js';
import { DoneHubAdapter } from './doneHub.js';
import { VeloeraAdapter } from './veloera.js';
import { NewApiAdapter } from './newApi.js';
import { AnyRouterAdapter } from './anyrouter.js';
import { Sub2ApiAdapter } from './sub2api.js';
import { GeminiAdapter } from './gemini.js';
import { GeminiCliAdapter } from './geminiCli.js';
import { AntigravityAdapter } from './antigravity.js';
import { CodexAdapter } from './codex.js';

describe('adapter context propagation', () => {
  it.each([OpenAiAdapter, ClaudeAdapter, CliProxyApiAdapter, OneApiAdapter, OneHubAdapter, DoneHubAdapter,
    VeloeraAdapter, NewApiAdapter, Sub2ApiAdapter])('%s returns sourced metadata from its existing model response', async (Adapter) => {
    const adapter = new Adapter();
    vi.spyOn(adapter as any, 'fetchJson').mockResolvedValue({ data: [{ id: 'known', context_length: 128000 }, { id: 'unknown' }] });
    expect(await adapter.discoverModels('https://example.com', 'token', 42)).toEqual([
      { modelName: 'known', contextLength: 128000, contextSource: `${adapter.platformName}.models:context_length` },
      { modelName: 'unknown' },
    ]);
    expect(await adapter.getModels('https://example.com', 'token', 42)).toEqual(['known', 'unknown']);
  });
  it('preserves AnyRouter inherited discovery and fallback scope', async () => {
    const adapter = new AnyRouterAdapter();
    vi.spyOn(adapter as any, 'getOpenAiModelsViaShieldCookie').mockResolvedValue([]);
    vi.spyOn(adapter as any, 'fetchJson').mockResolvedValue({ data: [{ id: 'known', contextLength: 64000 }] });
    expect(await adapter.discoverModels('https://example.com', 'token')).toEqual([
      { modelName: 'known', contextLength: 64000, contextSource: 'anyrouter.models:contextLength' },
    ]);
  });
  it.each([OneHubAdapter, DoneHubAdapter])('propagates %s management fallback metadata', async (Adapter) => {
    const adapter = new Adapter();
    vi.spyOn(adapter as any, 'fetchJson').mockImplementation(async (url: string) => url.endsWith('/api/available_model')
      ? { data: { known: { context_window: 64000 }, unknown: { price: 1 } } } : { data: [] });
    expect(await adapter.discoverModels('https://example.com', 'token')).toEqual([
      { modelName: 'known', contextLength: 64000, contextSource: `${adapter.platformName}.available_model:context_window` },
      { modelName: 'unknown' },
    ]);
  });
  it.each([GeminiAdapter, GeminiCliAdapter])('preserves native names and only explicit context for %s', async (Adapter) => {
    const adapter = new Adapter();
    vi.spyOn(adapter as any, 'fetchJson').mockResolvedValue({ models: [
      { name: 'models/known', context_length: 64000 }, { name: 'models/input-only', inputTokenLimit: 1000000 },
    ] });
    expect(await adapter.discoverModels('https://example.com', 'token')).toEqual([
      { modelName: 'known', contextLength: 64000, contextSource: `${adapter.platformName}.models:context_length` },
      { modelName: 'input-only' },
    ]);
  });
  it('propagates Antigravity object catalog without treating unspecified limits as 1M', async () => {
    const adapter = new AntigravityAdapter();
    vi.spyOn(adapter as any, 'fetchJson').mockResolvedValue({ models: { known: { contextWindow: 32000 }, unknown: {} } });
    expect(await adapter.discoverModels('https://example.com', 'token')).toEqual([
      { modelName: 'known', contextLength: 32000, contextSource: 'antigravity.models:contextWindow' }, { modelName: 'unknown' },
    ]);
    expect(await new CodexAdapter().discoverModels('https://example.com', 'token')).toEqual([]);
  });
  it('keeps overlapping temporary scans isolated even when callers omit scope', async () => {
    const adapter = new OpenAiAdapter();
    vi.spyOn(adapter as any, 'fetchJson').mockImplementation(async (_url: string, init: any) => ({ data: [
      { id: 'same', context_length: init.headers.Authorization === 'Bearer one' ? 32000 : 64000 },
    ] }));
    const results = await Promise.all([adapter.discoverModels('https://example.com', 'one'), adapter.discoverModels('https://example.com', 'two')]);
    expect(results.map((models) => models[0].contextLength)).toEqual([32000, 64000]);
  });
  it('leaves models unknown when a thin adapter ignores the optional metadata callback', async () => {
    class LegacyAdapter extends OpenAiAdapter {
      override async getModels(_baseUrl: string, _token: string): Promise<string[]> { return ['known-name']; }
    }
    expect(await new LegacyAdapter().discoverModels('https://example.com', 'token')).toEqual([{ modelName: 'known-name' }]);
  });
});
