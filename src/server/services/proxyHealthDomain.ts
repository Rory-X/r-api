import {
  classifyRetryErrorScope,
  type RetryErrorScope,
} from './proxyRetryContract.js';

export type ProxyHealthDomain =
  | 'endpoint'
  | 'credential'
  | 'model_capability'
  | 'gateway'
  | 'stream'
  | 'request'
  | 'unknown';

export type ProxyHealthTarget =
  | 'endpoint'
  | 'credential'
  | 'model'
  | 'gateway'
  | 'stream'
  | 'request'
  | 'none';

export type ProxyHealthMutation = {
  domain: ProxyHealthDomain;
  target: ProxyHealthTarget;
  retryable: boolean;
  affectsEndpoint: boolean;
  affectsCredential: boolean;
  affectsModelCapability: boolean;
  affectsGateway: boolean;
};

export type ProxyHealthKeyInput = {
  siteId?: number | null;
  endpointId?: number | null;
  accountId?: number | null;
  tokenId?: number | null;
  modelName?: string | null;
};

function normalizeId(value: number | null | undefined): string {
  return Number.isFinite(value) && (value ?? 0) > 0 ? String(Math.trunc(value as number)) : 'unknown';
}

function normalizeModel(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase() || 'unknown';
}

export function resolveProxyHealthDomain(scope: RetryErrorScope): ProxyHealthDomain {
  switch (scope) {
    case 'transport':
      return 'endpoint';
    case 'credential':
      return 'credential';
    case 'model_capability':
      return 'model_capability';
    case 'upstream_gateway':
      return 'gateway';
    case 'stream':
      return 'stream';
    case 'request':
      return 'request';
    default:
      return 'unknown';
  }
}

export function classifyProxyHealthDomain(input: {
  scope?: RetryErrorScope | null;
  status?: number;
  errorText?: string | null;
}): ProxyHealthDomain {
  const errorText = String(input.errorText || '').trim();
  if (/unsupported\s+model|model\s+(?:is\s+)?not\s+supported|model\s+unsupported|unknown\s+model|no\s+such\s+model|model.*does\s+not\s+exist/i.test(errorText)) {
    return 'model_capability';
  }
  if (/unsupported\s+(?:legacy\s+)?protocol|unsupported\s+endpoint|unknown\s+endpoint|unknown\s+path|no\s+route\s+matched|does\s+not\s+allow\s+\/v1\//i.test(errorText)) {
    return 'gateway';
  }
  if (/econn(?:reset|refused)|enotfound|network\s+error|fetch\s+failed|dns|socket\s+(?:hang\s+up|error)/i.test(errorText)) {
    return 'endpoint';
  }
  const scope = input.scope || classifyRetryErrorScope({
    status: input.status,
    rawErrorText: errorText,
  });
  return resolveProxyHealthDomain(scope);
}

export function buildProxyHealthMutation(domain: ProxyHealthDomain): ProxyHealthMutation {
  switch (domain) {
    case 'endpoint':
      return {
        domain,
        target: 'endpoint',
        retryable: true,
        affectsEndpoint: true,
        affectsCredential: false,
        affectsModelCapability: false,
        affectsGateway: false,
      };
    case 'credential':
      return {
        domain,
        target: 'credential',
        retryable: true,
        affectsEndpoint: false,
        affectsCredential: true,
        affectsModelCapability: false,
        affectsGateway: false,
      };
    case 'model_capability':
      return {
        domain,
        target: 'model',
        retryable: false,
        affectsEndpoint: false,
        affectsCredential: false,
        affectsModelCapability: true,
        affectsGateway: false,
      };
    case 'gateway':
      return {
        domain,
        target: 'gateway',
        retryable: true,
        affectsEndpoint: false,
        affectsCredential: false,
        affectsModelCapability: false,
        affectsGateway: true,
      };
    case 'stream':
      return {
        domain,
        target: 'stream',
        retryable: false,
        affectsEndpoint: false,
        affectsCredential: false,
        affectsModelCapability: false,
        affectsGateway: false,
      };
    case 'request':
      return {
        domain,
        target: 'request',
        retryable: false,
        affectsEndpoint: false,
        affectsCredential: false,
        affectsModelCapability: false,
        affectsGateway: false,
      };
    case 'unknown':
    default:
      return {
        domain: 'unknown',
        target: 'none',
        retryable: false,
        affectsEndpoint: false,
        affectsCredential: false,
        affectsModelCapability: false,
        affectsGateway: false,
      };
  }
}

export function buildProxyHealthKey(domain: ProxyHealthDomain, input: ProxyHealthKeyInput): string {
  switch (domain) {
    case 'endpoint':
      return `endpoint:site:${normalizeId(input.siteId)}:endpoint:${normalizeId(input.endpointId)}`;
    case 'credential':
      return input.tokenId && input.tokenId > 0
        ? `credential:token:${normalizeId(input.tokenId)}`
        : `credential:account:${normalizeId(input.accountId)}`;
    case 'model_capability':
      return `model:account:${normalizeId(input.accountId)}:${normalizeModel(input.modelName)}`;
    case 'gateway':
      return `gateway:site:${normalizeId(input.siteId)}`;
    case 'stream':
      return `stream:request:${normalizeModel(input.modelName)}`;
    case 'request':
      return `request:model:${normalizeModel(input.modelName)}`;
    case 'unknown':
    default:
      return 'unknown';
  }
}
