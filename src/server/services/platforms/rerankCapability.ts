import { getSiteAdapterContract } from './siteAdapterContract.js';

/** Passthrough is permission to try the declared interface, not a support guarantee. */
export function resolveRerankCapability(site: { platform?: string | null; url?: string }): 'passthrough' | 'unsupported' {
  const contract = getSiteAdapterContract(site.platform || '');
  if (contract.proxyEndpoints.rerank !== 'passthrough') return 'unsupported';
  try {
    if (new URL(site.url || '').hostname.toLowerCase() === 'api.openai.com') return 'unsupported';
  } catch { return 'unsupported'; }
  return 'passthrough';
}
