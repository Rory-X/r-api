export type DownstreamAccountTokenCredentialRef = {
  kind: 'account_token';
  siteId: number;
  accountId: number;
  tokenId: number;
};

export type DownstreamDefaultApiKeyCredentialRef = {
  kind: 'default_api_key';
  siteId: number;
  accountId: number;
};

export type DownstreamAccountCredentialRef = {
  kind: 'account_credential';
  siteId: number;
  accountId: number;
};

export type DownstreamCredentialRef =
  | DownstreamAccountTokenCredentialRef
  | DownstreamDefaultApiKeyCredentialRef
  | DownstreamAccountCredentialRef;

export type DownstreamAllowedCredentialRef = DownstreamCredentialRef;
export type DownstreamExcludedCredentialRef = DownstreamCredentialRef;

export interface DownstreamRoutingPolicy {
  supportedModels: string[];
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  excludedSiteIds: number[];
  allowedCredentialRefs?: DownstreamAllowedCredentialRef[];
  excludedCredentialRefs: DownstreamExcludedCredentialRef[];
  denyAllWhenEmpty?: boolean;
}

export const EMPTY_DOWNSTREAM_ROUTING_POLICY: DownstreamRoutingPolicy = {
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  excludedSiteIds: [],
  allowedCredentialRefs: [],
  excludedCredentialRefs: [],
};
