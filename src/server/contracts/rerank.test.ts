import { describe, expect, it } from 'vitest';
import { extractRerankUsagePayload, isValidRerankResponse, parseRerankRequest } from './rerank.js';

describe('rerank protocol contract', () => {
  it('preserves provider options and validates structured text documents', () => {
    const body = { model: 'rank', query: 'q', documents: [{ text: 'doc', title: 'title' }], return_documents: true, provider_option: 2 };
    expect(parseRerankRequest(body)).toEqual({ ok: true, body });
    expect(isValidRerankResponse({ data: [{ index: 0, relevance_score: 0.9, document: { text: 'doc' } }] }, 1)).toBe(true);
  });
  it.each([
    { results: [{ index: 2, relevance_score: 1 }] },
    { results: [{ index: 0, relevance_score: '1' }] },
    { results: [{ index: 0, relevance_score: 1 }, { index: 0, relevance_score: 0.5 }] },
    { results: [], error: { message: 'error' } },
  ])('rejects ambiguous/out-of-range scoring %j', (payload) => {
    expect(isValidRerankResponse(payload, 2)).toBe(false);
  });
  it('isolates Jina/Cohere usage containers from token-like document contents', () => {
    expect(extractRerankUsagePayload({ results: [{ document: { input_tokens: 99 } }] }).usage).toBeUndefined();
    expect(extractRerankUsagePayload({ meta: { billed_units: { search_units: 1 } } })).toMatchObject({ usage: { search_units: 1 } });
    expect(extractRerankUsagePayload({ meta: { tokens: { input_tokens: 10 } } })).toMatchObject({ usage: { input_tokens: 10 } });
  });
});
