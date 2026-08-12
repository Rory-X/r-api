import { like } from 'drizzle-orm';

const DEMO_PREFIX = '[交互验证]';

type DemoChannel = {
  accountIndex: number;
  priority: number;
  sortOrder: number;
  weight: number;
  enabled?: boolean;
  successCount?: number;
  failCount?: number;
  totalLatencyMs?: number;
  lastFailAt?: string | null;
  cooldownUntil?: string | null;
  manualOverride?: boolean;
};

async function main() {
  const { config } = await import('../../src/server/config.js');
  const {
    closeDbConnections,
    db,
    runtimeDbDialect,
    schema,
  } = await import('../../src/server/db/index.js');

  if (runtimeDbDialect !== 'sqlite') {
    throw new Error(`This local demo seed only supports SQLite; current dialect is ${runtimeDbDialect}`);
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const coolingUntil = new Date(now.getTime() + 30 * 60_000).toISOString();

  try {
    const result = await db.transaction(async (tx: typeof db) => {
      await tx.delete(schema.tokenRoutes)
        .where(like(schema.tokenRoutes.displayName, `${DEMO_PREFIX}%`))
        .run();
      await tx.delete(schema.sites)
        .where(like(schema.sites.name, `${DEMO_PREFIX}%`))
        .run();

      const siteSpecs = [
        { name: `${DEMO_PREFIX} 上海低延迟`, url: 'https://routing-demo-shanghai.invalid', platform: 'new-api' },
        { name: `${DEMO_PREFIX} 广州主站`, url: 'https://routing-demo-guangzhou.invalid', platform: 'one-api' },
        { name: `${DEMO_PREFIX} 东京备用`, url: 'https://routing-demo-tokyo.invalid', platform: 'openai' },
        { name: `${DEMO_PREFIX} 冷却演示`, url: 'https://routing-demo-cooling.invalid', platform: 'new-api' },
      ];

      const sites: Array<typeof schema.sites.$inferSelect> = [];
      const accounts: Array<typeof schema.accounts.$inferSelect> = [];
      const tokens: Array<typeof schema.accountTokens.$inferSelect> = [];
      for (const [index, spec] of siteSpecs.entries()) {
        const site = await tx.insert(schema.sites).values({
          ...spec,
          status: 'active',
          globalWeight: index + 1,
          sortOrder: index,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).returning().get();
        const account = await tx.insert(schema.accounts).values({
          siteId: site.id,
          username: `route-demo-${String.fromCharCode(97 + index)}`,
          accessToken: `demo-access-token-${index + 1}-not-real`,
          apiToken: `demo-api-token-${index + 1}-not-real`,
          balance: 100 - index * 15,
          quota: 1_000_000,
          valueScore: 100 - index * 10,
          status: 'active',
          sortOrder: index,
          checkinEnabled: false,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).returning().get();
        const token = await tx.insert(schema.accountTokens).values({
          accountId: account.id,
          name: `${DEMO_PREFIX} 通道 ${String.fromCharCode(65 + index)}`,
          token: `sk-demo-routing-${String.fromCharCode(97 + index)}-not-real`,
          tokenGroup: index < 2 ? '主力池' : '备用池',
          source: 'manual',
          enabled: true,
          isDefault: true,
          createdAt: nowIso,
          updatedAt: nowIso,
        }).returning().get();
        sites.push(site);
        accounts.push(account);
        tokens.push(token);
      }

      const createRoute = async (input: {
        modelPattern: string;
        displayName: string;
        routingStrategy: 'weighted' | 'round_robin' | 'stable_first' | 'manual';
        routeMode?: 'pattern' | 'explicit_group';
        enabled?: boolean;
      }) => await tx.insert(schema.tokenRoutes).values({
        modelPattern: input.modelPattern,
        displayName: input.displayName,
        routeMode: input.routeMode ?? 'pattern',
        routingStrategy: input.routingStrategy,
        enabled: input.enabled ?? true,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).returning().get();

      let channelCount = 0;
      const addChannels = async (
        route: { id: number; modelPattern: string },
        specs: DemoChannel[],
      ) => {
        for (const spec of specs) {
          const account = accounts[spec.accountIndex];
          const token = tokens[spec.accountIndex];
          if (!account || !token) throw new Error(`Missing demo account at index ${spec.accountIndex}`);
          await tx.insert(schema.routeChannels).values({
            routeId: route.id,
            accountId: account.id,
            tokenId: token.id,
            sourceModel: route.modelPattern,
            priority: spec.priority,
            sortOrder: spec.sortOrder,
            weight: spec.weight,
            enabled: spec.enabled ?? true,
            manualOverride: spec.manualOverride ?? false,
            successCount: spec.successCount ?? 0,
            failCount: spec.failCount ?? 0,
            totalLatencyMs: spec.totalLatencyMs ?? 0,
            lastFailAt: spec.lastFailAt ?? null,
            cooldownUntil: spec.cooldownUntil ?? null,
          }).run();
        }
        channelCount += specs.length;
      };

      const manualRoute = await createRoute({
        modelPattern: 'demo-manual-order',
        displayName: `${DEMO_PREFIX} 1. 手动顺序`,
        routingStrategy: 'manual',
      });
      await addChannels(manualRoute, [
        { accountIndex: 0, priority: 0, sortOrder: 0, weight: 1, manualOverride: true, successCount: 98, failCount: 2, totalLatencyMs: 19_600 },
        { accountIndex: 1, priority: 0, sortOrder: 1, weight: 100, manualOverride: true, successCount: 90, failCount: 5, totalLatencyMs: 22_500 },
        { accountIndex: 2, priority: 1, sortOrder: 0, weight: 10_000, manualOverride: true, successCount: 45, failCount: 3, totalLatencyMs: 13_500, lastFailAt: nowIso, cooldownUntil: coolingUntil },
        { accountIndex: 3, priority: 1, sortOrder: 1, weight: 1_000_000, manualOverride: true, enabled: false, successCount: 10, failCount: 8, totalLatencyMs: 8_000 },
      ]);

      const weightedRoute = await createRoute({
        modelPattern: 'demo-auto-weighted',
        displayName: `${DEMO_PREFIX} 2. 自动权重`,
        routingStrategy: 'weighted',
      });
      await addChannels(weightedRoute, [
        { accountIndex: 0, priority: 0, sortOrder: 3, weight: 10, successCount: 120, failCount: 2, totalLatencyMs: 24_000 },
        { accountIndex: 1, priority: 0, sortOrder: 2, weight: 60, successCount: 95, failCount: 4, totalLatencyMs: 20_900 },
        { accountIndex: 2, priority: 0, sortOrder: 1, weight: 30, successCount: 70, failCount: 6, totalLatencyMs: 18_900 },
        { accountIndex: 3, priority: 1, sortOrder: 0, weight: 100, successCount: 20, failCount: 10, totalLatencyMs: 9_000 },
      ]);

      const roundRobinRoute = await createRoute({
        modelPattern: 'demo-auto-round-robin',
        displayName: `${DEMO_PREFIX} 3. 自动轮询`,
        routingStrategy: 'round_robin',
      });
      await addChannels(roundRobinRoute, [
        { accountIndex: 0, priority: 2, sortOrder: 2, weight: 1, successCount: 40, failCount: 1, totalLatencyMs: 8_000 },
        { accountIndex: 1, priority: 0, sortOrder: 0, weight: 1_000, successCount: 38, failCount: 1, totalLatencyMs: 8_360 },
        { accountIndex: 2, priority: 1, sortOrder: 1, weight: 50, successCount: 35, failCount: 2, totalLatencyMs: 8_750 },
      ]);

      const stableRoute = await createRoute({
        modelPattern: 'demo-auto-stable',
        displayName: `${DEMO_PREFIX} 4. 自动稳定`,
        routingStrategy: 'stable_first',
      });
      await addChannels(stableRoute, [
        { accountIndex: 0, priority: 0, sortOrder: 2, weight: 10, successCount: 180, failCount: 1, totalLatencyMs: 32_400 },
        { accountIndex: 1, priority: 0, sortOrder: 1, weight: 90, successCount: 110, failCount: 8, totalLatencyMs: 26_400 },
        { accountIndex: 2, priority: 0, sortOrder: 0, weight: 40, successCount: 55, failCount: 12, totalLatencyMs: 18_150, lastFailAt: nowIso },
      ]);

      const sourceA = await createRoute({
        modelPattern: 'demo-group-source-a',
        displayName: `${DEMO_PREFIX} 来源 A`,
        routingStrategy: 'manual',
      });
      await addChannels(sourceA, [
        { accountIndex: 0, priority: 0, sortOrder: 0, weight: 1, manualOverride: true, successCount: 80, failCount: 1, totalLatencyMs: 15_200 },
        { accountIndex: 1, priority: 1, sortOrder: 0, weight: 100, manualOverride: true, successCount: 65, failCount: 3, totalLatencyMs: 14_300 },
      ]);

      const sourceB = await createRoute({
        modelPattern: 'demo-group-source-b',
        displayName: `${DEMO_PREFIX} 来源 B`,
        routingStrategy: 'manual',
      });
      await addChannels(sourceB, [
        { accountIndex: 2, priority: 0, sortOrder: 1, weight: 1000, manualOverride: true, successCount: 52, failCount: 2, totalLatencyMs: 12_480 },
        { accountIndex: 3, priority: 1, sortOrder: 1, weight: 10_000, manualOverride: true, successCount: 30, failCount: 5, totalLatencyMs: 9_900 },
      ]);

      const groupRoute = await createRoute({
        modelPattern: `${DEMO_PREFIX} 5. 聚合模型组`,
        displayName: `${DEMO_PREFIX} 5. 聚合模型组`,
        routeMode: 'explicit_group',
        routingStrategy: 'manual',
      });
      const sharedGroupRoute = await createRoute({
        modelPattern: `${DEMO_PREFIX} 6. 共享来源影响`,
        displayName: `${DEMO_PREFIX} 6. 共享来源影响`,
        routeMode: 'explicit_group',
        routingStrategy: 'manual',
      });
      for (const group of [groupRoute, sharedGroupRoute]) {
        await tx.insert(schema.routeGroupSources).values([
          { groupRouteId: group.id, sourceRouteId: sourceA.id },
          { groupRouteId: group.id, sourceRouteId: sourceB.id },
        ]).run();
      }

      const routeModels = [
        manualRoute.modelPattern,
        weightedRoute.modelPattern,
        roundRobinRoute.modelPattern,
        stableRoute.modelPattern,
        sourceA.modelPattern,
        sourceB.modelPattern,
      ];
      for (const [accountIndex, account] of accounts.entries()) {
        for (const modelName of routeModels) {
          await tx.insert(schema.modelAvailability).values({
            accountId: account.id,
            modelName,
            available: true,
            isManual: true,
            latencyMs: 180 + accountIndex * 45,
            checkedAt: nowIso,
          }).run();
          await tx.insert(schema.tokenModelAvailability).values({
            tokenId: tokens[accountIndex].id,
            modelName,
            available: true,
            latencyMs: 180 + accountIndex * 45,
            checkedAt: nowIso,
          }).run();
        }
      }

      return {
        sites: sites.length,
        accounts: accounts.length,
        tokens: tokens.length,
        routes: 8,
        channels: channelCount,
        groups: 2,
      };
    });

    console.log(`[model-routing-demo] database=${config.dbUrl || `${config.dataDir}/hub.db`}`);
    console.log(`[model-routing-demo] seeded ${JSON.stringify(result)}`);
    console.log(`[model-routing-demo] open ${DEMO_PREFIX} 1. 手动顺序 first, then compare routes 2-4 and group 5`);
  } finally {
    await closeDbConnections();
  }
}

main().catch((error) => {
  console.error('[model-routing-demo] failed');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
