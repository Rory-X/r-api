import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { ACCOUNT_TOKEN_VALUE_STATUS_READY, isUsableAccountToken } from './accountTokenService.js';
import { requiresManagedAccountTokens, supportsDirectAccountRoutingConnection } from './accountExtraConfig.js';
import { getBlockedBrandRules, isModelBlockedByBrand } from './brandMatcher.js';
import { config } from '../config.js';
import { listEnabledOauthRouteUnitsWithMembers } from './oauth/routeUnitService.js';

export type RoutingModelCandidate = {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId: number | null;
};
export type RoutingModelCandidates = Map<string, Map<string, RoutingModelCandidate>>;

export function buildRoutingCandidateKey(candidate: RoutingModelCandidate): string {
  return candidate.oauthRouteUnitId
    ? `route-unit:${candidate.oauthRouteUnitId}`
    : `${candidate.accountId}:${candidate.tokenId ?? 'account'}`;
}

export async function loadRoutingModelCandidates(): Promise<RoutingModelCandidates> {
  const tokenRows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();
  const usableTokenRows = tokenRows.filter((row) => (
    isUsableAccountToken(row.account_tokens)
    && requiresManagedAccountTokens(row.accounts)
  ));

  const accountRows = await db.select().from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  // Load site-level disabled models
  const disabledModelRows = await db.select().from(schema.siteDisabledModels).all();
  const disabledModelsBySite = new Map<number, Set<string>>();
  for (const row of disabledModelRows) {
    if (!disabledModelsBySite.has(row.siteId)) disabledModelsBySite.set(row.siteId, new Set());
    disabledModelsBySite.get(row.siteId)!.add(row.modelName.toLowerCase());
  }

  function isModelDisabledForSite(siteId: number, modelName: string): boolean {
    const disabled = disabledModelsBySite.get(siteId);
    return !!disabled && disabled.has(modelName.toLowerCase());
  }

  // Load global brand filter
  const blockedBrandRules = getBlockedBrandRules(config.globalBlockedBrands);

  // Load global allowed models whitelist
  const globalAllowedModels = new Set(
    config.globalAllowedModels.map((m) => m.toLowerCase().trim()).filter(Boolean),
  );

  function isModelAllowedByWhitelist(modelName: string): boolean {
    // If whitelist is empty, allow all models (backward compatible)
    if (globalAllowedModels.size === 0) return true;
    // Check if model is in whitelist (case-insensitive)
    return globalAllowedModels.has(modelName.toLowerCase().trim());
  }

  const enabledOauthRouteUnits = await listEnabledOauthRouteUnitsWithMembers();
  const routeUnitByAccountId = new Map<number, {
    routeUnitId: number;
    representativeAccountId: number;
  }>();
  for (const routeUnit of enabledOauthRouteUnits) {
    const activeMembers = routeUnit.members.filter((member) => member.account.status === 'active'
      && member.site.status === 'active' && supportsDirectAccountRoutingConnection(member.account));
    const representativeAccountId = activeMembers[0]?.account.id;
    if (!representativeAccountId) continue;
    for (const member of activeMembers) {
      routeUnitByAccountId.set(member.account.id, {
        routeUnitId: routeUnit.unit.id,
        representativeAccountId,
      });
    }
  }

  const modelCandidates = new Map<string, Map<string, {
    accountId: number;
    tokenId: number | null;
    oauthRouteUnitId: number | null;
  }>>();
  const addModelCandidate = (
    modelNameRaw: string | null | undefined,
    accountId: number,
    tokenId: number | null,
    siteId: number,
    oauthRouteUnitId: number | null = null,
  ) => {
    const modelName = (modelNameRaw || '').trim();
    if (!modelName) return;
    if (!isModelAllowedByWhitelist(modelName)) return;
    if (isModelDisabledForSite(siteId, modelName)) return;
    if (blockedBrandRules.length > 0 && isModelBlockedByBrand(modelName, blockedBrandRules)) return;
    if (!modelCandidates.has(modelName)) modelCandidates.set(modelName, new Map());
    const candidate = { accountId, tokenId, oauthRouteUnitId };
    modelCandidates.get(modelName)!.set(buildRoutingCandidateKey(candidate), candidate);
  };

  for (const row of usableTokenRows) {
    addModelCandidate(row.token_model_availability.modelName, row.accounts.id, row.account_tokens.id, row.accounts.siteId);
  }

  for (const row of accountRows) {
    if (!supportsDirectAccountRoutingConnection(row.accounts)) continue;
    const routeUnit = routeUnitByAccountId.get(row.accounts.id);
    if (routeUnit) {
      addModelCandidate(
        row.model_availability.modelName,
        routeUnit.representativeAccountId,
        null,
        row.accounts.siteId,
        routeUnit.routeUnitId,
      );
      continue;
    }
    addModelCandidate(row.model_availability.modelName, row.accounts.id, null, row.accounts.siteId);
  }

  return modelCandidates;
}
