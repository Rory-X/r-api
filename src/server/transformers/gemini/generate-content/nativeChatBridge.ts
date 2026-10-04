import { extractGeminiUsage } from './usage.js';
import { pullSseEventsWithDone } from '../../shared/normalized.js';

type JsonRecord = Record<string, unknown>;
type Tool = { id: string; name: string; args: unknown; signature?: string };
type Choice = { tools: Tool[]; byId: Map<string, Tool>; finished: boolean; roleSent: boolean };
type StreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeArgs(previous: unknown, incoming: unknown, fragments = true): unknown {
  if (typeof incoming === 'string' && fragments) {
    const prefix = typeof previous === 'string' ? previous : '';
    return incoming.startsWith(prefix) ? incoming : `${prefix}${incoming}`;
  }
  if (isRecord(previous) && isRecord(incoming)) {
    const merged = { ...previous };
    for (const [key, value] of Object.entries(incoming)) merged[key] = mergeArgs(previous[key], value, false);
    return merged;
  }
  return incoming === undefined ? (previous ?? {}) : incoming;
}

function serializeArgs(args: unknown): string {
  const parsed = typeof args === 'string' ? JSON.parse(args || '{}') : (args ?? {});
  if (!isRecord(parsed)) throw new Error('Gemini function arguments must be a JSON object');
  return JSON.stringify(parsed);
}

export function geminiChatFinishReason(reason: unknown, hasTools: boolean): string {
  const value = String(reason || '').toUpperCase();
  if (value === 'MAX_TOKENS' || value === 'LENGTH') return 'length';
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(value)) return 'content_filter';
  if (['STOP', 'FUNCTION_CALL', 'TOOL_CALLS'].includes(value)) return hasTools ? 'tool_calls' : 'stop';
  throw new Error(`Gemini generation failed: ${value || 'missing finish reason'}`);
}

// Native object arguments are snapshots, not appendable JSON fragments. Buffer
// them until the candidate finishes so cumulative and partial snapshots produce
// exactly one valid argument object. Tool identity is scoped to the response.
export function createGeminiNativeChatBridge(modelName: string) {
  const choices = new Map<number, Choice>();
  const toolIdPrefix = crypto.randomUUID().replace(/-/g, '');
  let id = `chatcmpl-gemini-${crypto.randomUUID()}`;
  let model = modelName;
  const created = Math.floor(Date.now() / 1000);
  let failed = false;
  let hasOutput = false;
  const chunk = (items: unknown[], usage?: unknown) => {
    hasOutput = true;
    return { id, object: 'chat.completion.chunk', created, model, choices: items, ...(usage ? { usage } : {}) };
  };
  const fail = (message: string) => {
    failed = true;
    return { type: 'error', error: { message, type: 'upstream_error' } };
  };

  return {
    push(payload: unknown): JsonRecord[] {
      if (failed) return [];
      try {
        if (!isRecord(payload)) throw new Error('Invalid Gemini stream payload');
        if (payload.error) {
          const error = isRecord(payload.error) ? payload.error.message : payload.error;
          throw new Error(typeof error === 'string' ? error : 'Gemini upstream error');
        }
        if (typeof payload.responseId === 'string' && !hasOutput) id = payload.responseId;
        if (typeof payload.modelVersion === 'string') model = payload.modelVersion;
        const output: JsonRecord[] = [];
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const feedback = isRecord(payload.promptFeedback) ? payload.promptFeedback : null;
        if (candidates.length === 0 && feedback?.blockReason) {
          choices.set(0, { tools: [], byId: new Map(), finished: true, roleSent: true });
          output.push(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: 'content_filter' }]));
        }
        for (const [position, raw] of candidates.entries()) {
          if (!isRecord(raw)) throw new Error('Invalid Gemini candidate');
          const index = typeof raw.index === 'number' ? raw.index : position;
          let choice = choices.get(index);
          if (!choice) {
            choice = { tools: [], byId: new Map(), finished: false, roleSent: false };
            choices.set(index, choice);
          }
          if (choice.finished) continue;
          const content = isRecord(raw.content) ? raw.content : {};
          const parts = Array.isArray(content.parts) ? content.parts : [];
          for (const part of parts) {
            if (!isRecord(part)) continue;
            const delta: JsonRecord = {};
            if (!choice.roleSent) { delta.role = 'assistant'; choice.roleSent = true; }
            if (typeof part.text === 'string') delta[part.thought === true ? 'reasoning_content' : 'content'] = part.text;
            if (isRecord(part.functionCall)) {
              const call = part.functionCall;
              const nativeId = typeof call.id === 'string' ? call.id : '';
              let tool = nativeId ? choice.byId.get(nativeId) : undefined;
              // Complete calls without IDs are separate calls, even when names
              // match. Only an unfinished JSON fragment can be continued by name.
              if (!tool && !nativeId && typeof call.args === 'string') {
                const pending = choice.tools.filter((item) => item.name === call.name && typeof item.args === 'string' && (() => {
                  try { JSON.parse(item.args); return false; } catch { return true; }
                })());
                if (pending.length > 1) throw new Error('Ambiguous Gemini tool fragments without call IDs');
                tool = pending[0];
              }
              const isNew = !tool;
              if (!tool) {
                if (typeof call.name !== 'string' || !call.name) throw new Error('Gemini function call has no name');
                tool = { id: nativeId || `call_gemini_${toolIdPrefix}_${index}_${choice.tools.length}`, name: call.name, args: undefined };
                choice.tools.push(tool);
                if (nativeId) choice.byId.set(nativeId, tool);
              }
              if (call.name && call.name !== tool.name) throw new Error('Gemini changed the name of an existing tool call');
              tool.args = mergeArgs(tool.args, call.args);
              if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) tool.signature = part.thoughtSignature;
              delta.tool_calls = [{
                index: choice.tools.indexOf(tool),
                ...(isNew ? { id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } } : {}),
                ...(tool.signature ? { provider_specific_fields: { thought_signature: tool.signature } } : {}),
              }];
            }
            if (Object.keys(delta).length > 0) output.push(chunk([{ index, delta, finish_reason: null }]));
          }
          if (raw.finishReason) {
            const finish = geminiChatFinishReason(raw.finishReason, choice.tools.length > 0);
            if (choice.tools.length > 0) output.push(chunk([{
              index, delta: { tool_calls: choice.tools.map((tool, toolIndex) => ({
                index: toolIndex, function: { arguments: serializeArgs(tool.args) },
                ...(tool.signature ? { provider_specific_fields: { thought_signature: tool.signature } } : {}),
              })) }, finish_reason: null,
            }]));
            output.push(chunk([{ index, delta: choice.roleSent ? {} : { role: 'assistant' }, finish_reason: finish }]));
            choice.finished = true;
          }
        }
        if (isRecord(payload.usageMetadata)) {
          const usage = extractGeminiUsage(payload);
          output.push(chunk([], {
            prompt_tokens: usage.promptTokens, completion_tokens: usage.completionTokens, total_tokens: usage.totalTokens,
            prompt_tokens_details: { cached_tokens: usage.cachedTokens },
            completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
          }));
        }
        return output;
      } catch (error) {
        return [fail(error instanceof Error ? error.message : 'Gemini stream conversion failed')];
      }
    },
    end(): JsonRecord[] {
      if (!failed && (choices.size === 0 || [...choices.values()].some((choice) => !choice.finished))) {
        return [fail('Gemini stream ended before a finish reason')];
      }
      return [];
    },
  };
}

export function createGeminiNativeChatStreamReader(reader: StreamReader, modelName: string) {
  const bridge = createGeminiNativeChatBridge(modelName);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let done = false;
  let cancelled = false;
  const queue: Uint8Array[] = [];
  const emit = (payloads: JsonRecord[]) => {
    for (const payload of payloads) queue.push(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
  const consume = (text: string) => {
    const parsed = pullSseEventsWithDone(text);
    buffer = parsed.rest;
    for (const event of parsed.events) {
      if (event.data === '[DONE]') { done = true; break; }
      try { emit(bridge.push(JSON.parse(event.data))); }
      catch { emit(bridge.push({ error: { message: 'Invalid Gemini SSE JSON' } })); }
    }
  };
  return {
    async read() {
      while (queue.length === 0 && !done && !cancelled) {
        const result = await reader.read();
        if (result.done) {
          consume(`${buffer}${decoder.decode()}\n\n`);
          done = true;
        } else if (result.value) {
          consume(buffer + decoder.decode(result.value, { stream: true }));
        }
        if (done) {
          emit(bridge.end());
          queue.push(encoder.encode('data: [DONE]\n\n'));
        }
      }
      return queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined };
    },
    cancel(reason?: unknown) { cancelled = true; queue.length = 0; return reader.cancel(reason); },
    releaseLock() { reader.releaseLock(); },
  };
}

export function buildOpenAiChatFromGeminiNative(payload: unknown, modelName: string): JsonRecord {
  const bridge = createGeminiNativeChatBridge(modelName);
  const chunks = [...(Array.isArray(payload) ? payload : [payload]).flatMap((item) => bridge.push(item)), ...bridge.end()];
  const error = chunks.find((item) => item.type === 'error');
  if (error) throw new Error(String((error.error as JsonRecord).message));
  const choices = new Map<number, { index: number; message: JsonRecord; finish_reason: unknown }>();
  let usage: unknown;
  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    for (const raw of chunk.choices as JsonRecord[]) {
      let choice = choices.get(raw.index as number);
      if (!choice) {
        choice = { index: raw.index as number, message: { role: 'assistant', content: '' }, finish_reason: null };
        choices.set(choice.index, choice);
      }
      const delta = raw.delta as JsonRecord;
      for (const key of ['content', 'reasoning_content']) if (typeof delta[key] === 'string') choice.message[key] = String(choice.message[key] || '') + delta[key];
      if (Array.isArray(delta.tool_calls)) {
        const tools = (choice.message.tool_calls ||= []) as JsonRecord[];
        for (const item of delta.tool_calls as JsonRecord[]) {
          const toolIndex = item.index as number;
          const tool = (tools[toolIndex] ||= { type: 'function', function: {} });
          if (item.id) tool.id = item.id;
          if (item.provider_specific_fields) tool.provider_specific_fields = item.provider_specific_fields;
          if (isRecord(item.function)) Object.assign(tool.function as JsonRecord, item.function);
        }
      }
      if (raw.finish_reason) choice.finish_reason = raw.finish_reason;
    }
  }
  return { id: chunks[0]?.id, object: 'chat.completion', created: chunks[0]?.created, model: chunks[0]?.model, choices: [...choices.values()], ...(usage ? { usage } : {}) };
}
