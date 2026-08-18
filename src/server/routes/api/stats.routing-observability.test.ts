import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUtcSqlDateTime } from "../../services/localTimeService.js";

type DbModule = typeof import("../../db/index.js");

describe("stats routing observability route", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "metapi-routing-observability-"));
    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./stats.js");
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.proxyRequestAttempts).run();
    await db.delete(schema.proxyRequests).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it("groups attempts by request and reports failover recovery and channel selection share", async () => {
    const now = Date.now();
    const at = (offsetMs: number) => formatUtcSqlDateTime(new Date(now + offsetMs));
    const site = await db.insert(schema.sites).values({
      name: "观测站点",
      url: "https://routing-observability.example.com",
      platform: "new-api",
    }).returning().get();
    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: "account-a",
      accessToken: "access-a",
      status: "active",
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: "account-b",
      accessToken: "access-b",
      status: "active",
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: "gpt-4.1",
      displayName: "GPT 4.1 主路由",
      routingStrategy: "stable_first",
      enabled: true,
    }).returning().get();
    const channelA = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      enabled: true,
      failCount: 4,
      consecutiveFailCount: 1,
      cooldownUntil: at(60_000),
    }).returning().get();
    const channelB = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountB.id,
      enabled: true,
      failCount: 2,
      consecutiveFailCount: 0,
    }).returning().get();

    await db.insert(schema.proxyRequests).values([
      {
        requestId: "request-failover",
        requestedModel: "gpt-4.1",
        downstreamPath: "/v1/chat/completions",
        status: "succeeded",
        policySnapshotJson: "{}",
        retryBudgetJson: "{}",
        createdAt: at(-50_000),
        finishedAt: at(-48_000),
      },
      {
        requestId: "request-first-success",
        requestedModel: "gpt-4.1",
        downstreamPath: "/v1/chat/completions",
        status: "succeeded",
        policySnapshotJson: "{}",
        retryBudgetJson: "{}",
        createdAt: at(-40_000),
        finishedAt: at(-39_000),
      },
      {
        requestId: "request-all-failed",
        requestedModel: "gpt-4.1",
        downstreamPath: "/v1/chat/completions",
        status: "failed",
        policySnapshotJson: "{}",
        retryBudgetJson: "{}",
        createdAt: at(-30_000),
        finishedAt: at(-29_500),
      },
    ]).run();

    await db.insert(schema.proxyLogs).values([
      {
        routeId: route.id,
        channelId: channelA.id,
        accountId: accountA.id,
        requestId: "request-failover",
        attemptId: "attempt-failover-0",
        status: "failed",
        httpStatus: 503,
        latencyMs: 600,
        retryCount: 0,
        createdAt: at(-49_500),
      },
      {
        routeId: route.id,
        channelId: channelB.id,
        accountId: accountB.id,
        requestId: "request-failover",
        attemptId: "attempt-failover-1",
        status: "success",
        httpStatus: 200,
        latencyMs: 900,
        firstByteLatencyMs: 120,
        estimatedCost: 0.2,
        retryCount: 1,
        createdAt: at(-48_500),
      },
      {
        routeId: route.id,
        channelId: channelA.id,
        accountId: accountA.id,
        requestId: "request-first-success",
        attemptId: "attempt-first-success-0",
        status: "success",
        httpStatus: 200,
        latencyMs: 1_000,
        firstByteLatencyMs: 80,
        estimatedCost: 0.1,
        retryCount: 0,
        createdAt: at(-39_500),
      },
      {
        routeId: route.id,
        channelId: channelB.id,
        accountId: accountB.id,
        requestId: "request-all-failed",
        attemptId: "attempt-all-failed-0",
        status: "failed",
        httpStatus: 502,
        latencyMs: 500,
        retryCount: 0,
        createdAt: at(-29_700),
      },
    ]).run();

    const response = await app.inject({
      method: "GET",
      url: "/api/stats/routing-observability?hours=24",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      range: { hours: number };
      caveats: string[];
      totals: Record<string, number | null>;
      routes: Array<{
        routeId: number;
        routeName: string;
        routingStrategy: string;
        requests: number;
        finalSuccessRate: number;
        firstAttemptSuccessRate: number;
        failoverRecoveredCount: number;
        status503Count: number;
        channels: Array<Record<string, unknown>>;
      }>;
    };

    expect(body.range.hours).toBe(24);
    expect(body.caveats[0]).toContain("当前路由配置");
    expect(body.totals).toMatchObject({
      requests: 3,
      finalSuccessCount: 2,
      finalFailureCount: 1,
      finalSuccessRate: 66.7,
      firstAttemptSuccessCount: 1,
      firstAttemptSuccessRate: 33.3,
      failoverRecoveredCount: 1,
      failoverRecoveredRate: 50,
      averageAttempts: 1.33,
      p95LatencyMs: 2_000,
      p95FirstByteLatencyMs: 120,
      totalCost: 0.3,
      successfulRequestCost: 0.15,
      status503Count: 1,
    });

    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]).toMatchObject({
      routeId: route.id,
      routeName: "GPT 4.1 主路由",
      routingStrategy: "stable_first",
      requests: 3,
      finalSuccessRate: 66.7,
      firstAttemptSuccessRate: 33.3,
      failoverRecoveredCount: 1,
      status503Count: 1,
    });
    expect(body.routes[0]?.channels).toEqual([
      expect.objectContaining({
        channelId: channelA.id,
        label: "观测站点 · account-a",
        selectedRequests: 2,
        selectedAttempts: 2,
        selectionShare: 50,
        successfulAttempts: 1,
        failedAttempts: 1,
        currentFailCount: 4,
        currentConsecutiveFailCount: 1,
      }),
      expect.objectContaining({
        channelId: channelB.id,
        label: "观测站点 · account-b",
        selectedRequests: 2,
        selectedAttempts: 2,
        selectionShare: 50,
        successfulAttempts: 1,
        failedAttempts: 1,
        currentFailCount: 2,
        currentConsecutiveFailCount: 0,
      }),
    ]);
  });

  it("falls back to the supported 24-hour range for unknown values", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/stats/routing-observability?hours=999",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().range.hours).toBe(24);
  });
});
