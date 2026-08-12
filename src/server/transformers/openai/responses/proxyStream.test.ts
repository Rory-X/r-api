import { describe, expect, it } from 'vitest';

import { createResponsesProxyStreamSession } from './proxyStream.js';

describe('createResponsesProxyStreamSession', () => {
  it('serializes non-SSE fallback payloads into canonical responses SSE closeout events', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_fallback_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.2',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_fallback_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"type":"response.completed"');
    expect(output).toContain('"output_text":"hello from responses upstream"');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves the canonical [DONE] terminator after an explicit response.completed SSE event', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves response.incomplete SSE terminals instead of coercing them to response.failed', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete_1","model":"gpt-5","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
    expect(output).not.toContain('event: response.failed');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves non-SSE incomplete fallback payloads as response.incomplete', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_incomplete_fallback_1',
      object: 'response',
      status: 'incomplete',
      incomplete_details: {
        reason: 'max_output_tokens',
      },
      model: 'gpt-5.2',
      output_text: 'partial answer',
      output: [
        {
          id: 'msg_incomplete_1',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'partial answer' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"output_text":"partial answer"');
    expect(output).not.toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('keeps lifecycle-only response.failed streams eligible for pre-output failover', async () => {
    const lines: string[] = [];
    let meaningfulOutputCount = 0;
    const chunk = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_overloaded","model":"gpt-5","status":"in_progress","output":[]}}',
      '',
      'event: response.failed',
      'data: {"type":"response.failed","response":{"id":"resp_overloaded","model":"gpt-5","status":"failed","error":{"message":"Our servers are currently overloaded. Please try again later."}}}',
      '',
    ].join('\n');
    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => ({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      }),
      onMeaningfulOutput: () => {
        meaningfulOutputCount += 1;
      },
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });

    expect(result).toEqual({
      status: 'failed',
      errorMessage: 'Our servers are currently overloaded. Please try again later.',
    });
    expect(meaningfulOutputCount).toBe(0);
    expect(lines.join('')).toContain('event: response.failed');
  });

  it('marks text output before a later stream failure can be considered for replay', async () => {
    let meaningfulOutputCount = 0;
    const chunk = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_partial","model":"gpt-5","status":"in_progress","output":[]}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_partial","type":"message","role":"assistant","status":"in_progress","content":[]}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_partial","delta":"partial"}',
      '',
      'event: response.failed',
      'data: {"type":"response.failed","response":{"id":"resp_partial","model":"gpt-5","status":"failed","error":{"message":"Our servers are currently overloaded. Please try again later."}}}',
      '',
    ].join('\n');
    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => ({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptTokensIncludeCache: null,
      }),
      onMeaningfulOutput: () => {
        meaningfulOutputCount += 1;
      },
      writeLines: () => {},
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });

    expect(result.status).toBe('failed');
    expect(meaningfulOutputCount).toBe(1);
  });
});
