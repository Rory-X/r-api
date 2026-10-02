import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { isExactTokenRouteModelPattern, matchesTokenRouteModelPattern, parseTokenRouteRegexPattern, isTokenRouteRegexPattern } from '../../shared/tokenRoutePatterns.js';
import { normalizeTokenRouteMode } from '../../shared/tokenRouteContract.js';
import { buildRoutingCandidateKey, loadRoutingModelCandidates, type RoutingModelCandidates, type RoutingModelCandidate } from './routeModelCandidateService.js';
import { clearRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';
import { withRouteMutation } from './routeMutationLock.js';

const EXCLUSIONS_KEY = 'token_route_deleted_model_exclusions_v1';
type Route = typeof schema.tokenRoutes.$inferSelect;
type Channel = typeof schema.routeChannels.$inferSelect;
type Candidate = RoutingModelCandidate & { sourceModel: string; priority: number; weight: number; enabled: boolean };

function isExactSourceRoute(route: Pick<Route, 'routeMode' | 'modelPattern'>): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && isExactTokenRouteModelPattern(route.modelPattern);
}

export function buildPatternChannelIdentity(candidate: RoutingModelCandidate & { sourceModel?: string | null }): string {
  return JSON.stringify([buildRoutingCandidateKey(candidate), (candidate.sourceModel || '').trim().toLowerCase()]);
}

async function readExclusions(): Promise<Set<string>> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, EXCLUSIONS_KEY)).get();
  if (!row) return new Set();
  const parsed: unknown = JSON.parse(row.value);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('Invalid deleted model exclusion setting');
  }
  return new Set(parsed.map((value: string) => value.trim().toLowerCase()).filter(Boolean));
}

export type PatternSyncResult = { createdChannels: number; removedChannels: number; routeIds: number[] };

// Caller owns withRouteMutation. Coverage rebuilds pass their already filtered
// candidates, so pattern groups cannot bypass site/brand/credential policies.
export async function syncPatternRouteChannels(input: {
  candidates?: RoutingModelCandidates;
  routeIds?: number[];
  includeExact?: boolean;
} = {}): Promise<PatternSyncResult> {
  const candidates = input.candidates ?? await loadRoutingModelCandidates();
  const exclusions = await readExclusions();
  const routes = await db.select().from(schema.tokenRoutes).all();
  const channels = await db.select().from(schema.routeChannels).all();
  const exactRoutes = routes.filter(isExactSourceRoute);
  const sourcesByModel = new Map<string, Route[]>();
  const templatesByRoute = new Map<number, Map<string, Channel>>();
  for (const source of exactRoutes) {
    const key = source.modelPattern.trim().toLowerCase();
    const sources = sourcesByModel.get(key) ?? [];
    sources.push(source);
    sourcesByModel.set(key, sources);
  }
  for (const channel of channels) {
    const templates = templatesByRoute.get(channel.routeId) ?? new Map<string, Channel>();
    templates.set(buildRoutingCandidateKey(channel), channel);
    templatesByRoute.set(channel.routeId, templates);
  }
  const result: PatternSyncResult = { createdChannels: 0, removedChannels: 0, routeIds: [] };
  for (const route of routes) {
    if (normalizeTokenRouteMode(route.routeMode) === 'explicit_group') continue;
    if (!input.includeExact && isExactSourceRoute(route)) continue;
    if (input.routeIds && !input.routeIds.includes(route.id)) continue;
    if (isTokenRouteRegexPattern(route.modelPattern)) {
      const parsed = parseTokenRouteRegexPattern(route.modelPattern);
      if (parsed.error) throw new Error(`Invalid route pattern ${route.id}: ${parsed.error}`);
    }
    const desired = new Map<string, Candidate>();
    for (const [model, modelCandidates] of candidates) {
      if (exclusions.has(model.toLowerCase()) || !matchesTokenRouteModelPattern(model, route.modelPattern)) continue;
      const sources = (sourcesByModel.get(model.toLowerCase()) ?? []).filter((source) => source.id !== route.id);
      if (sources.length > 0 && sources.every((source) => !source.enabled)) continue;
      for (const candidate of modelCandidates.values()) {
        const template = sources.filter((source) => source.enabled)
          .map((source) => templatesByRoute.get(source.id)?.get(buildRoutingCandidateKey(candidate)))
          .find((channel) => channel !== undefined);
        if (template && !template.enabled) continue;
        const value: Candidate = {
          ...candidate, sourceModel: model,
          priority: template?.priority ?? 0, weight: template?.weight ?? 10,
          enabled: template ? !!template.enabled : true,
        };
        desired.set(buildPatternChannelIdentity(value), value);
      }
    }
    // One group delta is atomic; a failed insert must not discard existing rows.
    const delta = await db.transaction(async (tx) => {
      const existing = await tx.select().from(schema.routeChannels).where(eq(schema.routeChannels.routeId, route.id)).all();
      const existingKeys = new Set(existing.map(buildPatternChannelIdentity));
      const nextSortOrder = new Map<number, number>();
      for (const channel of existing) {
        const priority = channel.priority ?? 0;
        nextSortOrder.set(priority, Math.max(nextSortOrder.get(priority) ?? 0, (channel.sortOrder ?? 0) + 1));
      }
      let created = 0;
      let removed = 0;
      let updated = 0;
      for (const [key, candidate] of desired) {
        if (existingKeys.has(key)) {
          const current = existing.find((channel) => buildPatternChannelIdentity(channel) === key);
          if (candidate.oauthRouteUnitId && current && !current.manualOverride && current.accountId !== candidate.accountId) {
            await tx.update(schema.routeChannels).set({ accountId: candidate.accountId })
              .where(eq(schema.routeChannels.id, current.id)).run();
            updated++;
          }
          continue;
        }
        const sortOrder = nextSortOrder.get(candidate.priority) ?? 0;
        await tx.insert(schema.routeChannels).values({ routeId: route.id, ...candidate, sortOrder, manualOverride: false }).run();
        nextSortOrder.set(candidate.priority, sortOrder + 1);
        created++;
      }
      for (const channel of existing) {
        if (channel.manualOverride || desired.has(buildPatternChannelIdentity(channel))) continue;
        await tx.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removed++;
      }
      return { created, removed, updated };
    });
    result.createdChannels += delta.created;
    result.removedChannels += delta.removed;
    if (delta.created > 0 || delta.removed > 0 || delta.updated > 0) result.routeIds.push(route.id);
  }
  if (result.routeIds.length > 0) {
    const dependents = await db.select().from(schema.routeGroupSources).all();
    await clearRouteDecisionSnapshots([...new Set([
      ...result.routeIds,
      ...dependents.filter((source) => result.routeIds.includes(source.sourceRouteId)).map((source) => source.groupRouteId),
    ])]);
    invalidateTokenRouterCache();
  }
  return result;
}

export async function populateRouteChannelsByModelPattern(routeId: number, _modelPattern: string): Promise<number> {
  return withRouteMutation(async () => (await syncPatternRouteChannels({ routeIds: [routeId], includeExact: true })).createdChannels);
}

export async function rebuildAutomaticRouteChannelsByModelPattern(routeId: number, _modelPattern: string): Promise<PatternSyncResult> {
  return withRouteMutation(() => syncPatternRouteChannels({ routeIds: [routeId], includeExact: true }));
}

export async function syncPatternRouteChannelsAfterRouteChanges(input: {
  removedRoutes?: Array<Pick<Route, 'modelPattern' | 'routeMode'>>;
  restoredRoutes?: Array<Pick<Route, 'modelPattern' | 'routeMode'>>;
} = {}): Promise<PatternSyncResult> {
  return withRouteMutation(async () => {
    const exclusions = await readExclusions();
    for (const route of input.removedRoutes ?? []) {
      if (isExactSourceRoute(route)) exclusions.add(route.modelPattern.trim().toLowerCase());
    }
    for (const route of input.restoredRoutes ?? []) {
      if (isExactSourceRoute(route)) exclusions.delete(route.modelPattern.trim().toLowerCase());
    }
    if ((input.removedRoutes?.length ?? 0) + (input.restoredRoutes?.length ?? 0) > 0) {
      await upsertSetting(EXCLUSIONS_KEY, [...exclusions].sort());
    }
    return syncPatternRouteChannels();
  });
}
