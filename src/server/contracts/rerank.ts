import { z } from 'zod';

const documentSchema = z.union([z.string(), z.object({ text: z.string() }).passthrough()]);
const rerankSchema = z.object({
  model: z.string().trim().min(1),
  query: z.string().min(1),
  documents: z.array(documentSchema).min(1),
  top_n: z.number().int().positive().optional(),
  return_documents: z.boolean().optional(),
  stream: z.literal(false).optional(),
}).passthrough();

export type RerankRequest = z.output<typeof rerankSchema>;
export function parseRerankRequest(input: unknown): { ok: true; body: RerankRequest } | { ok: false; error: string } {
  const parsed = rerankSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: `Invalid rerank request: ${parsed.error.issues[0]?.path.join('.') || 'body'}` };
  if (parsed.data.top_n !== undefined && parsed.data.top_n > parsed.data.documents.length) return { ok: false, error: 'top_n must not exceed document count' };
  return { ok: true, body: parsed.data };
}

/** Cohere/Jina results and OpenAI-compatible data arrays use the same index/score contract. */
export function isValidRerankResponse(payload: unknown, documentCount: number): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const root = payload as Record<string, unknown>;
  if (root.error) return false;
  const results = root.results ?? root.data;
  if (!Array.isArray(results) || results.length === 0 || results.length > documentCount) return false;
  const indices = new Set<number>();
  return results.every((row) => {
    if (!row || typeof row !== 'object') return false;
    const { index, relevance_score } = row as { index?: unknown; relevance_score?: unknown };
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= documentCount || indices.has(index as number)) return false;
    if (typeof relevance_score !== 'number' || !Number.isFinite(relevance_score)) return false;
    indices.add(index as number);
    return true;
  });
}

/** Ranked documents may themselves contain token-like keys; only accounting containers own usage. */
export function extractRerankUsagePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const meta = payload.meta && typeof payload.meta === 'object' && !Array.isArray(payload.meta) ? payload.meta as Record<string, unknown> : {};
  return {
    usage: payload.usage ?? payload.token_usage ?? payload.tokenUsage ?? meta.tokens ?? meta.billed_units,
    usageMetadata: payload.usageMetadata ?? payload.usage_metadata,
  };
}
