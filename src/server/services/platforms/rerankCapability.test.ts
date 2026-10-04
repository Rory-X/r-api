import { describe, expect, it } from 'vitest';
import { resolveRerankCapability } from './rerankCapability.js';
import { getSiteAdapterContract } from './siteAdapterContract.js';

describe('explicit rerank capability', () => {
  it.each(['openai', 'new-api', 'one-api', 'one-hub', 'done-hub', 'veloera'])('declares optional passthrough for compatible %s gateways', (platform) => {
    expect(resolveRerankCapability({ platform, url: 'https://gateway.example.com/v1' })).toBe('passthrough');
  });
  it.each(['gemini', 'gemini-cli', 'antigravity', 'codex', 'claude', 'cliproxyapi', 'sub2api', 'custom-fork'])('does not infer rerank from native/chat support: %s', (platform) => {
    expect(resolveRerankCapability({ platform, url: 'https://gateway.example.com' })).toBe('unsupported');
  });
  it('rejects official OpenAI and isolates cloned capability declarations', () => {
    expect(resolveRerankCapability({ platform: 'openai', url: 'https://api.openai.com' })).toBe('unsupported');
    const contract = getSiteAdapterContract('new-api');
    contract.proxyEndpoints.rerank = 'unsupported';
    expect(getSiteAdapterContract('new-api').proxyEndpoints.rerank).toBe('passthrough');
  });
});
