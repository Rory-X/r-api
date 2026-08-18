import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { formatUtcSqlDateTime, parseStoredUtcDateTime } from "./localTimeService.js";

const DEFAULT_RANGE_HOURS = 24;
const ALLOWED_RANGE_HOURS = new Set([24, 168, 720]);
const MAX_LOG_ROWS = 100_000;

export type RoutingObservabilityChannel = {
  channelId: number;
  label: string;
  siteName: string | null;
  accountName: string | null;
  selectedRequests: number;
  selectedAttempts: number;
  selectionShare: number;
  successfulAttempts: number;
  failedAttempts: number;
  currentFailCount: number;
  currentConsecutiveFailCount: number;
  currentCooldownUntil: string | null;
  enabled: boolean;
};

export type RoutingObservabilityRoute = {
  routeId: number | null;
  routeName: string;
  modelPattern: string | null;
  routingStrategy: string | null;
  enabled: boolean | null;
  requests: number;
  finalSuccessCount: number;
  finalSuccessRate: number;
  firstAttemptSuccessCount: number;
  firstAttemptSuccessRate: number;
  failoverRecoveredCount: number;
  failoverRecoveredRate: number;
  averageAttempts: number;
  p95LatencyMs: number | null;
  p95FirstByteLatencyMs: number | null;
  totalCost: number;
  successfulRequestCost: number | null;
  status503Count: number;
  channels: RoutingObservabilityChannel[];
};

export type RoutingObservabilityResponse = {
  generatedAt: string;
  range: {
    hours: number;
    from: string;
    to: string;
  };
  caveats: string[];
  totals: {
    requests: number;
    finalSuccessCount: number;
    finalFailureCount: number;
    finalSuccessRate: number;
    firstAttemptSuccessCount: number;
    firstAttemptFailureCount: number;
    firstAttemptSuccessRate: number;
    failoverRecoveredCount: number;
    failoverRecoveredRate: number;
    averageAttempts: number;
    p95LatencyMs: number | null;
    p95FirstByteLatencyMs: number | null;
    totalCost: number;
    successfulRequestCost: number | null;
    status503Count: number;
  };
  routes: RoutingObservabilityRoute[];
  sampledLogRows: number;
  truncated: boolean;
};

type ObservabilityLogRow = {
  id: number;
  routeId: number | null;
  channelId: number | null;
  requestId: string | null;
  attemptId: string | null;
  status: string | null;
  httpStatus: number | null;
  firstByteLatencyMs: number | null;
  latencyMs: number | null;
  estimatedCost: number | null;
  retryCount: number | null;
  createdAt: string | null;
};

type ObservabilityRequestRow = {
  requestId: string;
  status: string;
  createdAt: string | null;
  finishedAt: string | null;
};

type ObservabilityRouteRow = {
  id: number;
  modelPattern: string;
  displayName: string | null;
  routingStrategy: string | null;
  enabled: boolean | null;
};

type ObservabilityChannelRow = {
  id: number;
  routeId: number;
  accountName: string | null;
  siteName: string | null;
  failCount: number | null;
  consecutiveFailCount: number | null;
  cooldownUntil: string | null;
  enabled: boolean | null;
};

type AttemptAggregate = {
  key: string;
  channelId: number | null;
  success: boolean;
  failure: boolean;
  latencyMs: number | null;
  firstByteLatencyMs: number | null;
};

type RequestAggregate = {
  key: string;
  routeId: number | null;
  attempts: AttemptAggregate[];
  finalSuccess: boolean;
  firstAttemptSuccess: boolean;
  failoverRecovered: boolean;
  latencyMs: number | null;
  firstByteLatencyMs: number | null;
  totalCost: number;
  status503Count: number;
};

type AggregateInput = {
  logs: ObservabilityLogRow[];
  requests: ObservabilityRequestRow[];
  routes: ObservabilityRouteRow[];
  channels: ObservabilityChannelRow[];
  hours: number;
  from: Date;
  to: Date;
  truncated: boolean;
};

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return round((numerator / denominator) * 100, 1);
}

function percentile(values: Array<number | null>, percentileValue: number): number | null {
  const normalized = values
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (normalized.length === 0) return null;
  const index = Math.max(0, Math.ceil(normalized.length * percentileValue) - 1);
  return normalized[index] ?? null;
}

function parseDurationMs(start: string | null, end: string | null): number | null {
  const startDate = parseStoredUtcDateTime(start);
  const endDate = parseStoredUtcDateTime(end);
  if (!startDate || !endDate) return null;
  const duration = endDate.getTime() - startDate.getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function resolveRequestKey(row: ObservabilityLogRow): string {
  const requestId = (row.requestId || "").trim();
  return requestId ? `request:${requestId}` : `log:${row.id}`;
}

function resolveAttemptKey(row: ObservabilityLogRow): string {
  const attemptId = (row.attemptId || "").trim();
  if (attemptId) return `attempt:${attemptId}`;
  if (row.retryCount != null && Number.isFinite(row.retryCount)) {
    return `retry:${Math.max(0, Math.trunc(row.retryCount))}`;
  }
  return `log:${row.id}`;
}

function resolveChannelLabel(channel: ObservabilityChannelRow | undefined, channelId: number): string {
  if (!channel) return `通道 #${channelId}`;
  const siteName = (channel.siteName || "").trim();
  const accountName = (channel.accountName || "").trim();
  if (siteName && accountName) return `${siteName} · ${accountName}`;
  return siteName || accountName || `通道 #${channelId}`;
}

function buildRequestAggregates(
  logs: ObservabilityLogRow[],
  requests: ObservabilityRequestRow[],
): RequestAggregate[] {
  const requestRowsById = new Map(
    requests.map((request) => [request.requestId, request] as const),
  );
  const groupedLogs = new Map<string, ObservabilityLogRow[]>();

  for (const row of logs) {
    const key = resolveRequestKey(row);
    const bucket = groupedLogs.get(key) ?? [];
    bucket.push(row);
    groupedLogs.set(key, bucket);
  }

  return Array.from(groupedLogs.entries()).map(([key, rows]) => {
    const attemptsByKey = new Map<string, AttemptAggregate>();
    for (const row of rows) {
      const attemptKey = resolveAttemptKey(row);
      const current = attemptsByKey.get(attemptKey) ?? {
        key: attemptKey,
        channelId: row.channelId,
        success: false,
        failure: false,
        latencyMs: null,
        firstByteLatencyMs: null,
      };
      current.channelId ??= row.channelId;
      current.success ||= row.status === "success";
      current.failure ||= row.status !== "success";
      if (row.latencyMs != null && Number.isFinite(row.latencyMs) && row.latencyMs >= 0) {
        current.latencyMs = Math.max(current.latencyMs ?? 0, row.latencyMs);
      }
      if (
        row.firstByteLatencyMs != null
        && Number.isFinite(row.firstByteLatencyMs)
        && row.firstByteLatencyMs >= 0
      ) {
        current.firstByteLatencyMs = Math.max(
          current.firstByteLatencyMs ?? 0,
          row.firstByteLatencyMs,
        );
      }
      attemptsByKey.set(attemptKey, current);
    }

    const attempts = Array.from(attemptsByKey.values());
    const requestId = key.startsWith("request:") ? key.slice("request:".length) : null;
    const ledger = requestId ? requestRowsById.get(requestId) : undefined;
    const anySuccess = attempts.some((attempt) => attempt.success);
    const finalSuccess = ledger?.status === "succeeded"
      ? true
      : ledger && ["failed", "cancelled", "unknown"].includes(ledger.status)
        ? false
        : anySuccess;
    const firstAttemptSuccess = attempts[0]?.success === true;
    const firstChannelId = attempts[0]?.channelId ?? null;
    const failoverRecovered = !firstAttemptSuccess
      && firstChannelId != null
      && attempts.slice(1).some((attempt) => (
        attempt.success
        && attempt.channelId != null
        && attempt.channelId !== firstChannelId
      ));
    const successfulAttempt = attempts.find((attempt) => attempt.success);
    const ledgerLatency = ledger
      ? parseDurationMs(ledger.createdAt, ledger.finishedAt)
      : null;
    const fallbackLatency = attempts.reduce((sum, attempt) => (
      sum + (attempt.latencyMs ?? 0)
    ), 0);

    return {
      key,
      routeId: rows.find((row) => row.routeId != null)?.routeId ?? null,
      attempts,
      finalSuccess,
      firstAttemptSuccess,
      failoverRecovered,
      latencyMs: ledgerLatency ?? (fallbackLatency > 0 ? fallbackLatency : null),
      firstByteLatencyMs: successfulAttempt?.firstByteLatencyMs ?? null,
      totalCost: rows.reduce((sum, row) => (
        sum + (row.estimatedCost != null && Number.isFinite(row.estimatedCost)
          ? row.estimatedCost
          : 0)
      ), 0),
      status503Count: rows.filter((row) => row.httpStatus === 503).length,
    };
  });
}

function buildChannelAggregates(
  routeRequests: RequestAggregate[],
  configuredChannels: ObservabilityChannelRow[],
): RoutingObservabilityChannel[] {
  const configuredById = new Map(configuredChannels.map((channel) => [channel.id, channel]));
  const metrics = new Map<number, {
    selectedRequests: number;
    selectedAttempts: number;
    successfulAttempts: number;
    failedAttempts: number;
  }>();

  for (const channel of configuredChannels) {
    metrics.set(channel.id, {
      selectedRequests: 0,
      selectedAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
    });
  }

  for (const request of routeRequests) {
    const seenChannels = new Set<number>();
    for (const attempt of request.attempts) {
      if (attempt.channelId == null) continue;
      const current = metrics.get(attempt.channelId) ?? {
        selectedRequests: 0,
        selectedAttempts: 0,
        successfulAttempts: 0,
        failedAttempts: 0,
      };
      current.selectedAttempts += 1;
      current.successfulAttempts += attempt.success ? 1 : 0;
      current.failedAttempts += attempt.success ? 0 : 1;
      metrics.set(attempt.channelId, current);
      seenChannels.add(attempt.channelId);
    }
    for (const channelId of seenChannels) {
      const current = metrics.get(channelId);
      if (current) current.selectedRequests += 1;
    }
  }

  const totalSelectedAttempts = Array.from(metrics.values()).reduce(
    (sum, item) => sum + item.selectedAttempts,
    0,
  );

  return Array.from(metrics.entries())
    .map(([channelId, channelMetrics]) => {
      const configured = configuredById.get(channelId);
      return {
        channelId,
        label: resolveChannelLabel(configured, channelId),
        siteName: configured?.siteName ?? null,
        accountName: configured?.accountName ?? null,
        selectedRequests: channelMetrics.selectedRequests,
        selectedAttempts: channelMetrics.selectedAttempts,
        selectionShare: rate(channelMetrics.selectedAttempts, totalSelectedAttempts),
        successfulAttempts: channelMetrics.successfulAttempts,
        failedAttempts: channelMetrics.failedAttempts,
        currentFailCount: configured?.failCount ?? 0,
        currentConsecutiveFailCount: configured?.consecutiveFailCount ?? 0,
        currentCooldownUntil: configured?.cooldownUntil ?? null,
        enabled: configured?.enabled ?? false,
      };
    })
    .sort((left, right) => (
      right.selectedAttempts - left.selectedAttempts
      || left.label.localeCompare(right.label, "zh-CN")
    ));
}

function summarizeRequests(requests: RequestAggregate[]) {
  const requestCount = requests.length;
  const finalSuccessCount = requests.filter((request) => request.finalSuccess).length;
  const firstAttemptSuccessCount = requests.filter((request) => request.firstAttemptSuccess).length;
  const firstAttemptFailureCount = requestCount - firstAttemptSuccessCount;
  const failoverRecoveredCount = requests.filter((request) => request.failoverRecovered).length;
  const totalAttempts = requests.reduce((sum, request) => sum + request.attempts.length, 0);
  const totalCost = requests.reduce((sum, request) => sum + request.totalCost, 0);

  return {
    requests: requestCount,
    finalSuccessCount,
    finalFailureCount: requestCount - finalSuccessCount,
    finalSuccessRate: rate(finalSuccessCount, requestCount),
    firstAttemptSuccessCount,
    firstAttemptFailureCount,
    firstAttemptSuccessRate: rate(firstAttemptSuccessCount, requestCount),
    failoverRecoveredCount,
    failoverRecoveredRate: rate(failoverRecoveredCount, firstAttemptFailureCount),
    averageAttempts: requestCount > 0 ? round(totalAttempts / requestCount, 2) : 0,
    p95LatencyMs: percentile(requests.map((request) => request.latencyMs), 0.95),
    p95FirstByteLatencyMs: percentile(
      requests.map((request) => request.firstByteLatencyMs),
      0.95,
    ),
    totalCost: round(totalCost, 8),
    successfulRequestCost: finalSuccessCount > 0
      ? round(totalCost / finalSuccessCount, 8)
      : null,
    status503Count: requests.reduce((sum, request) => sum + request.status503Count, 0),
  };
}

export function normalizeRoutingObservabilityHours(raw: string | number | undefined): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw || "", 10);
  return ALLOWED_RANGE_HOURS.has(parsed) ? parsed : DEFAULT_RANGE_HOURS;
}

export function aggregateRoutingObservability(input: AggregateInput): RoutingObservabilityResponse {
  const requestAggregates = buildRequestAggregates(input.logs, input.requests);
  const routesById = new Map(input.routes.map((route) => [route.id, route]));
  const channelsByRouteId = new Map<number, ObservabilityChannelRow[]>();
  for (const channel of input.channels) {
    const bucket = channelsByRouteId.get(channel.routeId) ?? [];
    bucket.push(channel);
    channelsByRouteId.set(channel.routeId, bucket);
  }

  const requestGroups = new Map<number | null, RequestAggregate[]>();
  for (const request of requestAggregates) {
    const bucket = requestGroups.get(request.routeId) ?? [];
    bucket.push(request);
    requestGroups.set(request.routeId, bucket);
  }

  const routes = Array.from(requestGroups.entries()).map(([routeId, requests]) => {
    const currentRoute = routeId == null ? undefined : routesById.get(routeId);
    const summary = summarizeRequests(requests);
    return {
      routeId,
      routeName: currentRoute?.displayName?.trim()
        || currentRoute?.modelPattern
        || (routeId == null ? "未识别路由" : `路由 #${routeId}`),
      modelPattern: currentRoute?.modelPattern ?? null,
      routingStrategy: currentRoute?.routingStrategy ?? null,
      enabled: currentRoute?.enabled ?? null,
      ...summary,
      channels: buildChannelAggregates(
        requests,
        routeId == null ? [] : (channelsByRouteId.get(routeId) ?? []),
      ),
    };
  }).sort((left, right) => (
    right.requests - left.requests
    || left.routeName.localeCompare(right.routeName, "zh-CN")
  ));

  return {
    generatedAt: input.to.toISOString(),
    range: {
      hours: input.hours,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
    },
    caveats: [
      "策略字段读取当前路由配置；历史请求尚未保存策略快照，因此不能据此还原请求发生时的策略。",
      "粘黏命中目前没有写入历史统计；本页聚焦请求结果、重试挽救与通道选择分布。",
    ],
    totals: summarizeRequests(requestAggregates),
    routes,
    sampledLogRows: input.logs.length,
    truncated: input.truncated,
  };
}

export async function getRoutingObservabilitySnapshot(options: {
  hours?: string | number;
  now?: Date;
} = {}): Promise<RoutingObservabilityResponse> {
  const hours = normalizeRoutingObservabilityHours(options.hours);
  const to = options.now ?? new Date();
  const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
  const fromSql = formatUtcSqlDateTime(from);
  const toSql = formatUtcSqlDateTime(to);

  const [rawLogs, requests, routes, channels] = await Promise.all([
    db.select({
      id: schema.proxyLogs.id,
      routeId: schema.proxyLogs.routeId,
      channelId: schema.proxyLogs.channelId,
      requestId: schema.proxyLogs.requestId,
      attemptId: schema.proxyLogs.attemptId,
      status: schema.proxyLogs.status,
      httpStatus: schema.proxyLogs.httpStatus,
      firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
      latencyMs: schema.proxyLogs.latencyMs,
      estimatedCost: schema.proxyLogs.estimatedCost,
      retryCount: schema.proxyLogs.retryCount,
      createdAt: schema.proxyLogs.createdAt,
    })
      .from(schema.proxyLogs)
      .where(and(
        gte(schema.proxyLogs.createdAt, fromSql),
        lte(schema.proxyLogs.createdAt, toSql),
      ))
      .orderBy(desc(schema.proxyLogs.createdAt), desc(schema.proxyLogs.id))
      .limit(MAX_LOG_ROWS + 1)
      .all(),
    db.select({
      requestId: schema.proxyRequests.requestId,
      status: schema.proxyRequests.status,
      createdAt: schema.proxyRequests.createdAt,
      finishedAt: schema.proxyRequests.finishedAt,
    })
      .from(schema.proxyRequests)
      .where(and(
        gte(schema.proxyRequests.createdAt, fromSql),
        lte(schema.proxyRequests.createdAt, toSql),
      ))
      .all(),
    db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      displayName: schema.tokenRoutes.displayName,
      routingStrategy: schema.tokenRoutes.routingStrategy,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes).all(),
    db.select({
      id: schema.routeChannels.id,
      routeId: schema.routeChannels.routeId,
      accountName: schema.accounts.username,
      siteName: schema.sites.name,
      failCount: schema.routeChannels.failCount,
      consecutiveFailCount: schema.routeChannels.consecutiveFailCount,
      cooldownUntil: schema.routeChannels.cooldownUntil,
      enabled: schema.routeChannels.enabled,
    })
      .from(schema.routeChannels)
      .leftJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .all(),
  ]);

  const truncated = rawLogs.length > MAX_LOG_ROWS;
  const logs = rawLogs
    .slice(0, MAX_LOG_ROWS)
    .sort((left, right) => {
      const timeCompare = (left.createdAt || "").localeCompare(right.createdAt || "");
      return timeCompare || left.id - right.id;
    });

  return aggregateRoutingObservability({
    logs,
    requests,
    routes,
    channels,
    hours,
    from,
    to,
    truncated,
  });
}
