import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('cost analytics routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-cost-analytics-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.analyticsProjectionCheckpoints).run();
    await db.delete(schema.downstreamKeyDayUsage).run();
    await db.delete(schema.modelDayUsage).run();
    await db.delete(schema.siteHourUsage).run();
    await db.delete(schema.siteDayUsage).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns one cost contract for downstream key, model and site dimensions', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cost-site',
      url: 'https://cost.example.com',
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cost-user',
      accessToken: 'cost-token',
      status: 'active',
    }).returning().get();
    const downstreamKey = await db.insert(schema.downstreamApiKeys).values({
      name: 'cost-key',
      key: 'sk-cost-key-001',
      enabled: true,
    }).returning().get();
    await db.insert(schema.proxyLogs).values([
      {
        accountId: account.id,
        downstreamApiKeyId: downstreamKey.id,
        status: 'success',
        modelRequested: 'gpt-5',
        modelActual: 'gpt-5',
        totalTokens: 100,
        estimatedCost: 0.25,
        createdAt: '2026-08-17T01:00:00.000Z',
      },
      {
        accountId: account.id,
        downstreamApiKeyId: downstreamKey.id,
        status: 'failed',
        modelRequested: 'gpt-5',
        modelActual: 'gpt-5',
        totalTokens: 200,
        estimatedCost: 0.5,
        createdAt: '2026-08-18T01:00:00.000Z',
      },
    ]).run();

    const keyResponse = await app.inject({
      method: 'GET',
      url: `/api/stats/costs?groupBy=downstream_key&from=2026-08-17&to=2026-08-18&downstreamKeyId=${downstreamKey.id}`,
    });
    expect(keyResponse.statusCode).toBe(200);
    const keyBody = keyResponse.json();
    expect(keyBody).toMatchObject({
      success: true,
      groupBy: 'downstream_key',
      fromDay: '2026-08-17',
      toDay: '2026-08-18',
      projection: {
        latestProxyLogId: expect.any(Number),
        safeProxyLogId: expect.any(Number),
        lagRows: 0,
      },
    });
    expect(keyBody.items).toHaveLength(2);
    expect(keyBody.items.map((item: any) => item.dimensionName)).toEqual(['cost-key', 'cost-key']);
    expect(keyBody.items.reduce((sum: number, item: any) => sum + item.totalCost, 0)).toBeCloseTo(0.75, 6);

    const modelResponse = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=model&from=2026-08-17&to=2026-08-18&model=gpt-5',
    });
    expect(modelResponse.statusCode).toBe(200);
    expect(modelResponse.json().items).toMatchObject([
      { dimensionType: 'model', dimensionName: 'gpt-5', totalTokens: 100, totalCost: 0.25 },
      { dimensionType: 'model', dimensionName: 'gpt-5', totalTokens: 200, totalCost: 0.5 },
    ]);

    const siteResponse = await app.inject({
      method: 'GET',
      url: `/api/stats/costs?groupBy=site&from=2026-08-17&to=2026-08-18&siteId=${site.id}`,
    });
    expect(siteResponse.statusCode).toBe(200);
    expect(siteResponse.json().items).toMatchObject([
      { dimensionType: 'site', dimensionName: 'cost-site', totalTokens: 100, totalCost: 0.25 },
      { dimensionType: 'site', dimensionName: 'cost-site', totalTokens: 200, totalCost: 0.5 },
    ]);
  });

  it('keeps downstream key cost history after projected proxy logs are deleted', async () => {
    const downstreamKey = await db.insert(schema.downstreamApiKeys).values({
      name: 'retained-cost-key',
      key: 'sk-retained-cost-key-001',
      enabled: true,
    }).returning().get();
    await db.insert(schema.proxyLogs).values({
      downstreamApiKeyId: downstreamKey.id,
      status: 'success',
      totalTokens: 300,
      estimatedCost: 0.6,
      createdAt: '2026-08-17T01:00:00.000Z',
    }).run();

    const initial = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=downstream_key&from=2026-08-17&to=2026-08-18',
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().items).toMatchObject([
      { dimensionName: 'retained-cost-key', totalTokens: 300, totalCost: 0.6 },
    ]);

    await db.delete(schema.proxyLogs).run();
    const retained = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=downstream_key&from=2026-08-17&to=2026-08-18',
    });
    expect(retained.statusCode).toBe(200);
    expect(retained.json().items).toMatchObject([
      { dimensionName: 'retained-cost-key', totalTokens: 300, totalCost: 0.6 },
    ]);
  });

  it('aggregates downstream keys by project group', async () => {
    const [projectKeyA, projectKeyB, ungroupedKey] = await db.insert(schema.downstreamApiKeys).values([
      { name: 'project-a-1', key: 'sk-project-a-001', groupName: 'Project A', enabled: true },
      { name: 'project-a-2', key: 'sk-project-a-002', groupName: 'Project A', enabled: true },
      { name: 'ungrouped', key: 'sk-project-none-001', enabled: true },
    ]).returning().all();
    await db.insert(schema.proxyLogs).values([
      {
        downstreamApiKeyId: projectKeyA.id,
        status: 'success',
        totalTokens: 100,
        estimatedCost: 0.2,
        createdAt: '2026-08-17T01:00:00.000Z',
      },
      {
        downstreamApiKeyId: projectKeyB.id,
        status: 'failed',
        totalTokens: 200,
        estimatedCost: 0.3,
        createdAt: '2026-08-17T02:00:00.000Z',
      },
      {
        downstreamApiKeyId: ungroupedKey.id,
        status: 'success',
        totalTokens: 50,
        estimatedCost: 0.1,
        createdAt: '2026-08-17T03:00:00.000Z',
      },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=downstream_project&from=2026-08-17&to=2026-08-17',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([
      expect.objectContaining({
        dimensionType: 'downstream_project',
        dimensionKey: 'Project A',
        dimensionName: 'Project A',
        totalRequests: 2,
        successRequests: 1,
        failedRequests: 1,
        totalTokens: 300,
        totalCost: 0.5,
      }),
      expect.objectContaining({
        dimensionType: 'downstream_project',
        dimensionKey: '__ungrouped__',
        dimensionName: '未分组项目',
        totalRequests: 1,
        totalTokens: 50,
        totalCost: 0.1,
      }),
    ]);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=downstream_project&from=2026-08-17&to=2026-08-17&project=Project%20A',
    });
    expect(filtered.json().items).toHaveLength(1);
    expect(filtered.json().items[0]).toMatchObject({ dimensionName: 'Project A', totalCost: 0.5 });
  });

  it('rejects invalid grouping and date ranges', async () => {
    const invalidGroup = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=account',
    });
    expect(invalidGroup.statusCode).toBe(400);

    const invalidRange = await app.inject({
      method: 'GET',
      url: '/api/stats/costs?groupBy=site&from=2026-08-18&to=2026-08-17',
    });
    expect(invalidRange.statusCode).toBe(400);
  });
});
