import { and, eq, gte, inArray, lte, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  getLocalRangeStartDayKey,
  toLocalDayKeyFromStoredUtc,
} from './localTimeService.js';
import {
  getUsageAggregationProjectionStatus,
  runUsageAggregationProjectionPass,
  type UsageAggregationProjectionStatus,
} from './usageAggregationService.js';

export type CostAnalyticsGroupBy = 'downstream_key' | 'downstream_project' | 'model' | 'site';

export type CostAnalyticsItem = {
  day: string;
  dimensionType: CostAnalyticsGroupBy;
  dimensionId: number | null;
  dimensionKey: string;
  dimensionName: string;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number | null;
  totalTokens: number;
  totalCost: number;
};

export type CostAnalyticsResult = {
  groupBy: CostAnalyticsGroupBy;
  fromDay: string;
  toDay: string;
  timeZone: string;
  projection: UsageAggregationProjectionStatus;
  items: CostAnalyticsItem[];
};

export type DownstreamKeyUsageTotal = {
  downstreamApiKeyId: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number | null;
  totalTokens: number;
  totalCost: number;
};

export type DownstreamKeyDailyUsage = Omit<DownstreamKeyUsageTotal, 'successRate'> & {
  localDay: string;
  successRate: number | null;
};

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeCostAnalyticsDay(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!DAY_KEY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

export function resolveDefaultCostAnalyticsRange(): { fromDay: string; toDay: string } {
  return {
    fromDay: getLocalRangeStartDayKey(30),
    toDay: toLocalDayKeyFromStoredUtc(new Date()) || new Date().toISOString().slice(0, 10),
  };
}

function roundCost(value: unknown): number {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function toCount(value: unknown): number {
  return Math.max(0, Math.trunc(Number(value || 0)));
}

function toSuccessRate(totalRequests: number, successRequests: number): number | null {
  return totalRequests > 0
    ? Math.round((successRequests / totalRequests) * 1_000) / 10
    : null;
}

function buildDayConditions(
  column: AnyColumn,
  fromDay?: string | null,
  toDay?: string | null,
): SQL[] {
  const conditions: SQL[] = [];
  if (fromDay) conditions.push(gte(column, fromDay));
  if (toDay) conditions.push(lte(column, toDay));
  return conditions;
}

function whereAll(conditions: SQL[]): SQL | undefined {
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export async function readDownstreamKeyUsageTotals(input: {
  downstreamApiKeyIds?: number[];
  fromDay?: string | null;
  toDay?: string | null;
} = {}): Promise<DownstreamKeyUsageTotal[]> {
  await runUsageAggregationProjectionPass();
  const ids = Array.from(new Set(
    (input.downstreamApiKeyIds || [])
      .map((value) => Math.trunc(Number(value)))
      .filter((value) => Number.isFinite(value) && value > 0),
  ));
  if (input.downstreamApiKeyIds && ids.length === 0) return [];

  const conditions = buildDayConditions(
    schema.downstreamKeyDayUsage.localDay,
    input.fromDay,
    input.toDay,
  );
  if (ids.length > 0) {
    conditions.push(inArray(schema.downstreamKeyDayUsage.downstreamApiKeyId, ids));
  }

  const rows = await db.select({
    downstreamApiKeyId: schema.downstreamKeyDayUsage.downstreamApiKeyId,
    totalRequests: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.totalCalls}), 0)`,
    successRequests: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.successCalls}), 0)`,
    failedRequests: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.failedCalls}), 0)`,
    totalTokens: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.totalTokens}), 0)`,
    totalCost: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.totalCost}), 0)`,
  })
    .from(schema.downstreamKeyDayUsage)
    .where(whereAll(conditions))
    .groupBy(schema.downstreamKeyDayUsage.downstreamApiKeyId)
    .all();

  return rows.map((row) => {
    const totalRequests = toCount(row.totalRequests);
    const successRequests = toCount(row.successRequests);
    return {
      downstreamApiKeyId: row.downstreamApiKeyId,
      totalRequests,
      successRequests,
      failedRequests: toCount(row.failedRequests),
      successRate: toSuccessRate(totalRequests, successRequests),
      totalTokens: toCount(row.totalTokens),
      totalCost: roundCost(row.totalCost),
    };
  });
}

export async function readDownstreamKeyDailyUsage(
  downstreamApiKeyId: number,
): Promise<DownstreamKeyDailyUsage[]> {
  await runUsageAggregationProjectionPass();
  const rows = await db.select()
    .from(schema.downstreamKeyDayUsage)
    .where(eq(schema.downstreamKeyDayUsage.downstreamApiKeyId, downstreamApiKeyId))
    .all();
  return rows
    .map((row) => {
      const totalRequests = toCount(row.totalCalls);
      const successRequests = toCount(row.successCalls);
      return {
        localDay: row.localDay,
        downstreamApiKeyId: row.downstreamApiKeyId,
        totalRequests,
        successRequests,
        failedRequests: toCount(row.failedCalls),
        successRate: toSuccessRate(totalRequests, successRequests),
        totalTokens: toCount(row.totalTokens),
        totalCost: roundCost(row.totalCost),
      };
    })
    .sort((left, right) => left.localDay.localeCompare(right.localDay));
}

async function queryDownstreamKeyCosts(input: {
  fromDay: string;
  toDay: string;
  downstreamApiKeyId?: number | null;
}): Promise<CostAnalyticsItem[]> {
  const conditions = buildDayConditions(
    schema.downstreamKeyDayUsage.localDay,
    input.fromDay,
    input.toDay,
  );
  if (input.downstreamApiKeyId) {
    conditions.push(eq(schema.downstreamKeyDayUsage.downstreamApiKeyId, input.downstreamApiKeyId));
  }
  const rows = await db.select({
    day: schema.downstreamKeyDayUsage.localDay,
    dimensionId: schema.downstreamKeyDayUsage.downstreamApiKeyId,
    totalRequests: schema.downstreamKeyDayUsage.totalCalls,
    successRequests: schema.downstreamKeyDayUsage.successCalls,
    failedRequests: schema.downstreamKeyDayUsage.failedCalls,
    totalTokens: schema.downstreamKeyDayUsage.totalTokens,
    totalCost: schema.downstreamKeyDayUsage.totalCost,
  })
    .from(schema.downstreamKeyDayUsage)
    .where(whereAll(conditions))
    .all();
  const names = new Map(
    (await db.select({ id: schema.downstreamApiKeys.id, name: schema.downstreamApiKeys.name })
      .from(schema.downstreamApiKeys)
      .all())
      .map((row) => [row.id, row.name]),
  );

  return rows.map((row) => {
    const totalRequests = toCount(row.totalRequests);
    const successRequests = toCount(row.successRequests);
    return {
      day: row.day,
      dimensionType: 'downstream_key',
      dimensionId: row.dimensionId,
      dimensionKey: String(row.dimensionId),
      dimensionName: names.get(row.dimensionId) || `Key #${row.dimensionId}`,
      totalRequests,
      successRequests,
      failedRequests: toCount(row.failedRequests),
      successRate: toSuccessRate(totalRequests, successRequests),
      totalTokens: toCount(row.totalTokens),
      totalCost: roundCost(row.totalCost),
    };
  });
}

async function queryDownstreamProjectCosts(input: {
  fromDay: string;
  toDay: string;
  project?: string | null;
}): Promise<CostAnalyticsItem[]> {
  const conditions = buildDayConditions(
    schema.downstreamKeyDayUsage.localDay,
    input.fromDay,
    input.toDay,
  );
  const normalizedProject = String(input.project || '').trim();
  if (normalizedProject) {
    if (normalizedProject === '__ungrouped__') {
      conditions.push(sql`coalesce(trim(${schema.downstreamApiKeys.groupName}), '') = ''`);
    } else {
      conditions.push(eq(schema.downstreamApiKeys.groupName, normalizedProject));
    }
  }
  const projectKey = sql<string>`coalesce(nullif(trim(${schema.downstreamApiKeys.groupName}), ''), '__ungrouped__')`;
  const rows = await db.select({
    day: schema.downstreamKeyDayUsage.localDay,
    projectKey,
    totalRequests: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.totalCalls}), 0)`,
    successRequests: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.successCalls}), 0)`,
    failedRequests: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.failedCalls}), 0)`,
    totalTokens: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.totalTokens}), 0)`,
    totalCost: sql<number>`coalesce(sum(${schema.downstreamKeyDayUsage.totalCost}), 0)`,
  })
    .from(schema.downstreamKeyDayUsage)
    .leftJoin(
      schema.downstreamApiKeys,
      eq(schema.downstreamKeyDayUsage.downstreamApiKeyId, schema.downstreamApiKeys.id),
    )
    .where(whereAll(conditions))
    .groupBy(schema.downstreamKeyDayUsage.localDay, projectKey)
    .all();

  return rows.map((row) => {
    const totalRequests = toCount(row.totalRequests);
    const successRequests = toCount(row.successRequests);
    const key = row.projectKey || '__ungrouped__';
    return {
      day: row.day,
      dimensionType: 'downstream_project',
      dimensionId: null,
      dimensionKey: key,
      dimensionName: key === '__ungrouped__' ? '未分组项目' : key,
      totalRequests,
      successRequests,
      failedRequests: toCount(row.failedRequests),
      successRate: toSuccessRate(totalRequests, successRequests),
      totalTokens: toCount(row.totalTokens),
      totalCost: roundCost(row.totalCost),
    };
  });
}

async function queryModelCosts(input: {
  fromDay: string;
  toDay: string;
  model?: string | null;
  siteId?: number | null;
}): Promise<CostAnalyticsItem[]> {
  const conditions = buildDayConditions(schema.modelDayUsage.localDay, input.fromDay, input.toDay);
  if (input.model) conditions.push(eq(schema.modelDayUsage.model, input.model));
  if (input.siteId) conditions.push(eq(schema.modelDayUsage.siteId, input.siteId));
  const rows = await db.select({
    day: schema.modelDayUsage.localDay,
    model: schema.modelDayUsage.model,
    totalRequests: sql<number>`coalesce(sum(${schema.modelDayUsage.totalCalls}), 0)`,
    successRequests: sql<number>`coalesce(sum(${schema.modelDayUsage.successCalls}), 0)`,
    failedRequests: sql<number>`coalesce(sum(${schema.modelDayUsage.failedCalls}), 0)`,
    totalTokens: sql<number>`coalesce(sum(${schema.modelDayUsage.totalTokens}), 0)`,
    totalCost: sql<number>`coalesce(sum(${schema.modelDayUsage.totalSpend}), 0)`,
  })
    .from(schema.modelDayUsage)
    .where(whereAll(conditions))
    .groupBy(schema.modelDayUsage.localDay, schema.modelDayUsage.model)
    .all();

  return rows.map((row) => {
    const totalRequests = toCount(row.totalRequests);
    const successRequests = toCount(row.successRequests);
    return {
      day: row.day,
      dimensionType: 'model',
      dimensionId: null,
      dimensionKey: row.model,
      dimensionName: row.model,
      totalRequests,
      successRequests,
      failedRequests: toCount(row.failedRequests),
      successRate: toSuccessRate(totalRequests, successRequests),
      totalTokens: toCount(row.totalTokens),
      totalCost: roundCost(row.totalCost),
    };
  });
}

async function querySiteCosts(input: {
  fromDay: string;
  toDay: string;
  siteId?: number | null;
}): Promise<CostAnalyticsItem[]> {
  const conditions = buildDayConditions(schema.siteDayUsage.localDay, input.fromDay, input.toDay);
  if (input.siteId) conditions.push(eq(schema.siteDayUsage.siteId, input.siteId));
  const rows = await db.select({
    day: schema.siteDayUsage.localDay,
    dimensionId: schema.siteDayUsage.siteId,
    totalRequests: schema.siteDayUsage.totalCalls,
    successRequests: schema.siteDayUsage.successCalls,
    failedRequests: schema.siteDayUsage.failedCalls,
    totalTokens: schema.siteDayUsage.totalTokens,
    totalCost: schema.siteDayUsage.totalSiteSpend,
  })
    .from(schema.siteDayUsage)
    .where(whereAll(conditions))
    .all();
  const names = new Map(
    (await db.select({ id: schema.sites.id, name: schema.sites.name }).from(schema.sites).all())
      .map((row) => [row.id, row.name]),
  );

  return rows.map((row) => {
    const totalRequests = toCount(row.totalRequests);
    const successRequests = toCount(row.successRequests);
    return {
      day: row.day,
      dimensionType: 'site',
      dimensionId: row.dimensionId,
      dimensionKey: String(row.dimensionId),
      dimensionName: names.get(row.dimensionId) || `Site #${row.dimensionId}`,
      totalRequests,
      successRequests,
      failedRequests: toCount(row.failedRequests),
      successRate: toSuccessRate(totalRequests, successRequests),
      totalTokens: toCount(row.totalTokens),
      totalCost: roundCost(row.totalCost),
    };
  });
}

export async function queryCostAnalytics(input: {
  groupBy: CostAnalyticsGroupBy;
  fromDay?: string | null;
  toDay?: string | null;
  downstreamApiKeyId?: number | null;
  project?: string | null;
  model?: string | null;
  siteId?: number | null;
}): Promise<CostAnalyticsResult> {
  const defaults = resolveDefaultCostAnalyticsRange();
  const fromDay = input.fromDay || defaults.fromDay;
  const toDay = input.toDay || defaults.toDay;
  await runUsageAggregationProjectionPass();
  const projection = await getUsageAggregationProjectionStatus();

  let items: CostAnalyticsItem[];
  if (input.groupBy === 'downstream_key') {
    items = await queryDownstreamKeyCosts({
      fromDay,
      toDay,
      downstreamApiKeyId: input.downstreamApiKeyId,
    });
  } else if (input.groupBy === 'downstream_project') {
    items = await queryDownstreamProjectCosts({
      fromDay,
      toDay,
      project: input.project,
    });
  } else if (input.groupBy === 'model') {
    items = await queryModelCosts({
      fromDay,
      toDay,
      model: input.model,
      siteId: input.siteId,
    });
  } else {
    items = await querySiteCosts({
      fromDay,
      toDay,
      siteId: input.siteId,
    });
  }

  return {
    groupBy: input.groupBy,
    fromDay,
    toDay,
    timeZone: projection.timeZone,
    projection,
    items: items.sort((left, right) => (
      left.day.localeCompare(right.day)
      || right.totalCost - left.totalCost
      || left.dimensionName.localeCompare(right.dimensionName)
    )),
  };
}
