import { describe, expect, it } from 'vitest';
import { buildUpstreamEndpointRequest } from '../../services/upstreamRequestBuilder.js';
import { resolveRuntimeRequestUrl } from './requestUrl.js';

const build = (body: Record<string, unknown>, platform = 'gemini', stream = false, downstreamFormat: 'openai' | 'responses' = 'openai') => ({ endpoint: 'chat' as const, ...buildUpstreamEndpointRequest({ endpoint: 'chat', modelName: 'gemini-3-flash-preview', stream, tokenValue: 'secret-native-key', sitePlatform: platform, siteUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', openaiBody: body, downstreamFormat, downstreamHeaders: { accept: 'application/json' } }) });

describe('Gemini native tool transport', () => {
  it('selects native transport for tool declarations and historical calls/results', () => {
    for (const body of [
      { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }] },
      { messages: [{ role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'weather', arguments: '{}' } }] }] },
      { messages: [{ role: 'tool', tool_call_id: 'call-1', content: '{}' }] },
    ]) {
      const request = build(body);
      expect(request.runtime?.executor).toBe('gemini-native');
      expect(request.headers.Authorization).toBeUndefined();
      expect(request.headers['x-goog-api-key']).toBe('secret-native-key');
      expect(request.body.contents).toBeDefined();
    }
  });
  it('keeps plain Gemini and generic OpenAI requests on the declared compatibility transport', () => {
    expect(build({ messages: [{ role: 'user', content: 'hi' }] }).runtime?.executor).toBe('default');
    expect(build({ tools: [{ type: 'function', function: { name: 'weather' } }] }, 'openai').runtime?.executor).toBe('default');
    expect(build({ tools: [{ type: 'function', function: { name: 'weather' } }] }, 'gemini', true, 'responses').runtime?.executor).toBe('default');
  });
  it.each([
    ['https://example.com', 'https://example.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse'],
    ['https://example.com/v1beta/openai/', 'https://example.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse'],
    ['https://example.com/proxy/v1/openai?trace=1&key=old-secret', 'https://example.com/proxy/v1/models/gemini-3-flash-preview:streamGenerateContent?trace=1&alt=sse'],
  ])('resolves %s once without exposing a query key to dispatch or the ledger', (base, expected) => {
    const request = build({ tools: [{ type: 'function', function: { name: 'weather' } }] }, 'gemini', true);
    expect(resolveRuntimeRequestUrl(base, request)).toBe(expected);
    expect(request.headers.Accept).toBe('text/event-stream');
    expect(request.headers.accept).toBeUndefined();
  });
});
