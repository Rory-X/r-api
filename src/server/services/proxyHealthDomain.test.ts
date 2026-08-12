import { describe, expect, it } from 'vitest';
import {
  buildProxyHealthKey,
  buildProxyHealthMutation,
  classifyProxyHealthDomain,
  resolveProxyHealthDomain,
} from './proxyHealthDomain.js';

describe('proxyHealthDomain', () => {
  it('keeps credential failures scoped to the credential', () => {
    const domain = classifyProxyHealthDomain({ status: 401, errorText: 'access token expired' });
    expect(domain).toBe('credential');
    expect(buildProxyHealthMutation(domain)).toMatchObject({
      target: 'credential',
      affectsCredential: true,
      affectsEndpoint: false,
      affectsModelCapability: false,
    });
  });

  it('keeps transport failures scoped to an endpoint', () => {
    const domain = classifyProxyHealthDomain({ status: 502, errorText: 'fetch failed: ECONNRESET' });
    expect(domain).toBe('endpoint');
    expect(buildProxyHealthMutation(domain)).toMatchObject({
      target: 'endpoint',
      affectsEndpoint: true,
      affectsCredential: false,
    });
  });

  it('keeps unsupported models scoped to model capability', () => {
    const domain = classifyProxyHealthDomain({ status: 400, errorText: 'model is not supported' });
    expect(domain).toBe('model_capability');
    expect(buildProxyHealthMutation(domain)).toMatchObject({
      target: 'model',
      retryable: false,
      affectsModelCapability: true,
      affectsEndpoint: false,
    });
  });

  it('maps gateway throttling separately from transport failures', () => {
    const domain = resolveProxyHealthDomain('upstream_gateway');
    expect(domain).toBe('gateway');
    expect(buildProxyHealthMutation(domain)).toMatchObject({
      target: 'gateway',
      affectsGateway: true,
      affectsEndpoint: false,
    });
  });

  it('does not misclassify protocol routing errors as credential failures', () => {
    expect(classifyProxyHealthDomain({
      status: 403,
      errorText: 'This group does not allow /v1/messages dispatch',
    })).toBe('gateway');
  });

  it('uses token identity when a credential is token-scoped', () => {
    expect(buildProxyHealthKey('credential', {
      accountId: 10,
      tokenId: 20,
    })).toBe('credential:token:20');
    expect(buildProxyHealthKey('credential', {
      accountId: 10,
    })).toBe('credential:account:10');
  });

  it('includes account and model in capability keys', () => {
    expect(buildProxyHealthKey('model_capability', {
      accountId: 10,
      modelName: ' GPT-5.4 ',
    })).toBe('model:account:10:gpt-5.4');
  });
});
