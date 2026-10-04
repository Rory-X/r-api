import { describe, expect, it, vi } from 'vitest';
import { buildOpenAiChatFromGeminiNative, createGeminiNativeChatBridge, createGeminiNativeChatStreamReader } from './nativeChatBridge.js';
import { openAiChatTransformer } from '../../openai/chat/index.js';
import { buildGeminiGenerateContentRequestFromOpenAi } from './requestBridge.js';

const event = (parts: unknown[], finishReason?: string) => ({ candidates: [{ index: 0, content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
const call = (name: string, args: unknown, id?: string) => ({ functionCall: { name, args, ...(id ? { id } : {}) } });
const toolDeltas = (chunks: any[]) => chunks.flatMap((chunk) => chunk.choices || []).flatMap((choice: any) => choice.delta.tool_calls || []);

describe('Gemini native chat bridge', () => {
  it('keeps sequential tools on distinct indices and remembers tools for a later STOP', () => {
    const bridge = createGeminiNativeChatBridge('gemini-3-flash-preview');
    const tools = toolDeltas([...bridge.push(event([call('weather', { city: 'Paris' })])), ...bridge.push(event([call('time', { zone: 'UTC' })]))]);
    expect(tools.map((tool) => tool.index)).toEqual([0, 1]);
    expect(new Set(tools.map((tool) => tool.id)).size).toBe(2);
    const terminal = bridge.push(event([], 'STOP')) as any[];
    expect(toolDeltas(terminal).map((tool) => tool.function.arguments)).toEqual(['{"city":"Paris"}', '{"zone":"UTC"}']);
    expect(terminal.at(-1).choices[0].finish_reason).toBe('tool_calls');
    expect(bridge.end()).toEqual([]);
  });

  it('keeps same-name parallel calls separate, including calls in subsequent events', () => {
    const bridge = createGeminiNativeChatBridge('gemini-3-flash-preview');
    const chunks = [...bridge.push(event([call('Read', { path: '/a' }), call('Read', { path: '/b' })])), ...bridge.push(event([call('Read', { path: '/c' })], 'STOP'))];
    expect(toolDeltas(chunks).filter((tool) => tool.id).map((tool) => tool.index)).toEqual([0, 1, 2]);
  });

  it.each([
    [{ city: 'Paris' }, { city: 'Paris', unit: 'C' }],
    [{ city: 'Paris', unit: 'C' }, { city: 'Paris', unit: null }],
    ['{"city":', '"Paris"}'],
    ['{"city":', '{"city":"Paris"}'],
  ])('aggregates native snapshots and incremental JSON without appending duplicate braces', (first, second) => {
    const bridge = createGeminiNativeChatBridge('gemini-3-flash-preview');
    const chunks = [...bridge.push(event([call('weather', first, 'native-1')])), ...bridge.push(event([call('weather', second, 'native-1')], 'STOP'))];
    const tools = toolDeltas(chunks);
    expect(tools.filter((tool) => tool.id)).toHaveLength(1);
    const args = tools.map((tool) => tool.function?.arguments || '').join('');
    expect(JSON.parse(args)).toMatchObject({ city: 'Paris' });
    if (typeof second === 'object' && 'unit' in second) expect(JSON.parse(args).unit).toBe(second.unit);
  });

  it.each([['STOP', 'tool_calls'], ['MAX_TOKENS', 'length'], ['SAFETY', 'content_filter'], ['RECITATION', 'content_filter']])('maps %s without hiding abnormal tool termination', (native, expected) => {
    const response = buildOpenAiChatFromGeminiNative(event([call('weather', {})], native), 'gemini-3-flash-preview') as any;
    expect(response.choices[0].finish_reason).toBe(expected);
    const normalized = openAiChatTransformer.transformFinalResponse(response, 'gemini-3-flash-preview');
    expect((openAiChatTransformer.serializeFinalResponse(normalized) as any).choices[0].finish_reason).toBe(expected);
    expect((openAiChatTransformer.buildSyntheticChunks(normalized) as any[]).at(-1).choices[0].finish_reason).toBe(expected);
  });

  it('preserves text, thoughts, real tool signatures and usage through chat serialization and replay', () => {
    const response = buildOpenAiChatFromGeminiNative({ ...event([{ text: 'thinking', thought: true }, { text: 'checking' }, { ...call('weather', { city: 'Paris' }, 'call-1'), thoughtSignature: 'real-signature' }], 'STOP'), usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 1, totalTokenCount: 10 } }, 'gemini-3-flash-preview') as any;
    const normalized = openAiChatTransformer.transformFinalResponse(response, 'gemini-3-flash-preview');
    const final = openAiChatTransformer.serializeFinalResponse(normalized, { promptTokens: 5, completionTokens: 5, totalTokens: 10 }) as any;
    expect(final.choices[0].message).toMatchObject({ content: 'checking', reasoning_content: 'thinking', tool_calls: [{ id: 'call-1', provider_specific_fields: { thought_signature: 'real-signature' } }] });
    expect(final.usage).toMatchObject({ completion_tokens_details: { reasoning_tokens: 3 }, prompt_tokens_details: { cached_tokens: 1 } });
    const request = buildGeminiGenerateContentRequestFromOpenAi({ modelName: 'gemini-3-flash-preview', body: { messages: [final.choices[0].message, { role: 'tool', tool_call_id: 'call-1', content: '{"temp":22}' }] } }) as any;
    expect(request.contents.flatMap((content: any) => content.parts)).toContainEqual({ functionCall: { id: 'call-1', name: 'weather', args: { city: 'Paris' } }, thoughtSignature: 'real-signature' });
    expect(request.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: 'call-1', name: 'weather', response: { result: { temp: 22 } } });
  });

  it('fails incomplete EOF and malformed argument fragments instead of fabricating STOP', () => {
    const bridge = createGeminiNativeChatBridge('gemini-3-flash-preview');
    bridge.push(event([call('weather', '{"city":', 'call-1')]));
    expect(bridge.end()).toMatchObject([{ type: 'error', error: { message: expect.stringContaining('before a finish reason') } }]);
    const invalid = createGeminiNativeChatBridge('gemini-3-flash-preview');
    expect(invalid.push(event([call('weather', 'broken')], 'STOP'))).toMatchObject([{ type: 'error' }]);
  });

  it('converts prompt blocking into a filtered completion and fails native error payloads', () => {
    expect((buildOpenAiChatFromGeminiNative({ promptFeedback: { blockReason: 'SAFETY' } }, 'gemini-3-flash-preview') as any).choices[0].finish_reason).toBe('content_filter');
    expect(() => buildOpenAiChatFromGeminiNative({ error: { message: 'bad signature' } }, 'gemini-3-flash-preview')).toThrow('bad signature');
  });

  it('handles split UTF-8 and CRLF SSE and propagates cancellation without emitting success', async () => {
    const text = `data: ${JSON.stringify(event([{ text: '你好' }, call('weather', {}, 'call-1')], 'STOP'))}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
    const reader = createGeminiNativeChatStreamReader(stream.getReader(), 'gemini-3-flash-preview');
    let result = '';
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; result += new TextDecoder().decode(chunk.value); }
    expect(result).toContain('你好');
    expect(result).toContain('"finish_reason":"tool_calls"');
    expect(result.match(/\[DONE\]/g)).toHaveLength(1);
    reader.releaseLock();
    const source = { read: vi.fn(), cancel: vi.fn(async () => {}), releaseLock: vi.fn() };
    const cancelled = createGeminiNativeChatStreamReader(source, 'gemini-3-flash-preview');
    await cancelled.cancel('client disconnected');
    cancelled.releaseLock();
    expect(source.cancel).toHaveBeenCalledWith('client disconnected');
    expect(source.releaseLock).toHaveBeenCalledOnce();
    expect(await cancelled.read()).toEqual({ done: true, value: undefined });
  });
});
