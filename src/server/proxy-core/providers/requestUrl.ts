import { resolveGeminiGenerateContentUrl } from '../../transformers/gemini/generate-content/urlResolver.js';
import { buildUpstreamUrl } from '../orchestration/upstreamRequest.js';
import type { ProxyRuntimeRequest } from '../executors/types.js';

// Resolve once for dispatch, first-byte observation and the attempt ledger.
// Official native Gemini uses a header key so credentials never enter its URL.
export function resolveRuntimeRequestUrl(siteUrl: string, request: ProxyRuntimeRequest): string {
  if (request.runtime?.executor !== 'gemini-native') return buildUpstreamUrl(siteUrl, request.path);
  const [actionPath, search = ''] = request.path.split('?', 2);
  return resolveGeminiGenerateContentUrl(siteUrl, 'v1beta', actionPath, undefined, search);
}
