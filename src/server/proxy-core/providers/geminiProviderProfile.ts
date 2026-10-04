import type { ProviderProfile } from './types.js';

export const geminiProviderProfile: ProviderProfile = {
  id: 'gemini',
  prefersNativeChat(body) {
    return (Array.isArray(body.tools) && body.tools.length > 0)
      || (Array.isArray(body.messages) && body.messages.some((message) => message && typeof message === 'object' && (
        message.role === 'tool' || (Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
      )));
  },
  prepareRequest(input) {
    const action = input.stream ? 'streamGenerateContent' : 'generateContent';
    const headers = { ...input.baseHeaders };
    for (const key of Object.keys(headers)) {
      if (['authorization', 'x-goog-api-key', 'accept'].includes(key.toLowerCase())) delete headers[key];
    }
    headers['x-goog-api-key'] = input.tokenValue;
    headers.Accept = input.stream ? 'text/event-stream' : 'application/json';
    return {
      path: `/models/${encodeURIComponent(input.modelName.replace(/^models\//, ''))}:${action}${input.stream ? '?alt=sse' : ''}`,
      headers,
      body: input.body,
      runtime: { executor: 'gemini-native', modelName: input.modelName, stream: input.stream, action },
    };
  },
};
