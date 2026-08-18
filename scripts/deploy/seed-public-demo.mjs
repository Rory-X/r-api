import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire('/app/package.json');
const Database = require('better-sqlite3');

const demoModeEnabled = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.DEMO_MODE || '').trim().toLowerCase());
if (!demoModeEnabled) {
  throw new Error('Refusing to seed public demo data unless DEMO_MODE=true');
}

const dbPath = resolve(process.argv[2] || '/app/data/hub.db');
const db = new Database(dbPath);

function sqlTimestamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function localDay(date) {
  return date.toISOString().slice(0, 10);
}

function insertAndReturnId(sql, values) {
  return Number(db.prepare(sql).run(values).lastInsertRowid);
}

const now = new Date();
const sites = [
  { name: '北辰低延迟', url: 'https://beichen.public-demo.invalid', platform: 'new-api', balance: 128.64 },
  { name: '云帆主站', url: 'https://yunfan.public-demo.invalid', platform: 'one-api', balance: 86.20 },
  { name: '星港备用', url: 'https://xinggang.public-demo.invalid', platform: 'sub2api', balance: 51.75 },
  { name: '远岚冷却演示', url: 'https://yuanlan.public-demo.invalid', platform: 'openai', balance: 32.40 },
];
const models = ['gpt-5.2', 'claude-sonnet-4.5', 'gemini-3-pro-preview', 'deepseek-v3.2'];

db.pragma('foreign_keys = OFF');
const seed = db.transaction(() => {
  for (const table of [
    'admin_snapshots',
    'analytics_projection_checkpoints',
    'site_hour_usage',
    'site_day_usage',
    'model_day_usage',
    'events',
    'checkin_logs',
    'proxy_request_attempts',
    'proxy_requests',
    'proxy_logs',
    'route_group_sources',
    'route_channels',
    'token_routes',
    'token_model_availability',
    'model_availability',
    'account_tokens',
    'downstream_api_key_leases',
    'downstream_api_keys',
    'accounts',
    'site_api_endpoints',
    'sites',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('default_site_seed_v1', 'true')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('public_demo_seed_v1', ?)")
    .run(JSON.stringify({ seededAt: now.toISOString(), syntheticOnly: true }));

  const downstreamKeyId = insertAndReturnId(
    `INSERT INTO downstream_api_keys
      (name, key, description, group_name, tags, enabled, max_cost, used_cost, max_requests, used_requests, max_concurrency, supported_models, created_at, updated_at)
     VALUES
      (@name, @key, @description, @groupName, @tags, 1, @maxCost, @usedCost, @maxRequests, @usedRequests, @maxConcurrency, @supportedModels, @createdAt, @updatedAt)`,
    {
      name: '公开演示项目',
      key: 'sk-public-demo-not-usable',
      description: '仅用于展示项目级密钥管理，无法发起真实请求',
      groupName: '演示环境',
      tags: JSON.stringify(['demo', 'read-only']),
      maxCost: 25,
      usedCost: 7.42,
      maxRequests: 50000,
      usedRequests: 13842,
      maxConcurrency: 8,
      supportedModels: JSON.stringify(models),
      createdAt: sqlTimestamp(new Date(now.getTime() - 30 * 86_400_000)),
      updatedAt: sqlTimestamp(now),
    },
  );

  const siteRows = [];
  for (const [index, site] of sites.entries()) {
    const siteId = insertAndReturnId(
      `INSERT INTO sites
        (name, url, platform, status, is_pinned, sort_order, global_weight, created_at, updated_at)
       VALUES (@name, @url, @platform, 'active', @isPinned, @sortOrder, @weight, @createdAt, @updatedAt)`,
      {
        ...site,
        isPinned: index < 2 ? 1 : 0,
        sortOrder: index,
        weight: Math.max(1, 4 - index),
        createdAt: sqlTimestamp(new Date(now.getTime() - (45 - index * 4) * 86_400_000)),
        updatedAt: sqlTimestamp(now),
      },
    );
    const accountId = insertAndReturnId(
      `INSERT INTO accounts
        (site_id, username, access_token, api_token, balance, balance_used, quota, unit_cost, value_score, status, is_pinned, sort_order, checkin_enabled, last_checkin_at, last_balance_refresh, extra_config, created_at, updated_at)
       VALUES
        (@siteId, @username, @accessToken, @apiToken, @balance, @balanceUsed, @quota, @unitCost, @valueScore, 'active', @isPinned, @sortOrder, 0, @lastCheckinAt, @lastBalanceRefresh, @extraConfig, @createdAt, @updatedAt)`,
      {
        siteId,
        username: `demo-account-${index + 1}`,
        accessToken: `demo-access-${index + 1}-not-real`,
        apiToken: `sk-demo-upstream-${index + 1}-not-real`,
        balance: site.balance,
        balanceUsed: 14.5 + index * 7.25,
        quota: 1_000_000,
        unitCost: 0.65 + index * 0.08,
        valueScore: 96 - index * 7,
        isPinned: index === 0 ? 1 : 0,
        sortOrder: index,
        lastCheckinAt: sqlTimestamp(now),
        lastBalanceRefresh: sqlTimestamp(now),
        extraConfig: JSON.stringify({ today_income: 0.5 + index * 0.15, demo: true }),
        createdAt: sqlTimestamp(new Date(now.getTime() - 30 * 86_400_000)),
        updatedAt: sqlTimestamp(now),
      },
    );
    const tokenId = insertAndReturnId(
      `INSERT INTO account_tokens
        (account_id, name, token, token_group, value_status, source, enabled, is_default, created_at, updated_at)
       VALUES (@accountId, @name, @token, @tokenGroup, 'ready', 'manual', 1, 1, @createdAt, @updatedAt)`,
      {
        accountId,
        name: `${site.name} 默认通道`,
        token: `sk-demo-channel-${index + 1}-not-real`,
        tokenGroup: index < 2 ? '主力池' : '备用池',
        createdAt: sqlTimestamp(new Date(now.getTime() - 30 * 86_400_000)),
        updatedAt: sqlTimestamp(now),
      },
    );
    siteRows.push({ siteId, accountId, tokenId, ...site });
  }

  const routeRows = models.map((model, index) => {
    const routeId = insertAndReturnId(
      `INSERT INTO token_routes
        (model_pattern, display_name, routing_strategy, enabled, created_at, updated_at)
       VALUES (@model, @displayName, @strategy, 1, @createdAt, @updatedAt)`,
      {
        model,
        displayName: `${model} 智能路由`,
        strategy: ['stable_first', 'weighted', 'round_robin', 'manual'][index],
        createdAt: sqlTimestamp(new Date(now.getTime() - 21 * 86_400_000)),
        updatedAt: sqlTimestamp(now),
      },
    );
    const channels = siteRows.slice(0, index === 3 ? 3 : 4).map((site, channelIndex) => {
      const cooling = index === 0 && channelIndex === 3;
      const channelId = insertAndReturnId(
        `INSERT INTO route_channels
          (route_id, account_id, token_id, source_model, priority, sort_order, weight, enabled, manual_override, success_count, fail_count, total_latency_ms, total_cost, last_used_at, last_selected_at, last_fail_at, consecutive_fail_count, cooldown_level, cooldown_until)
         VALUES
          (@routeId, @accountId, @tokenId, @sourceModel, @priority, @sortOrder, @weight, @enabled, @manualOverride, @successCount, @failCount, @totalLatencyMs, @totalCost, @lastUsedAt, @lastSelectedAt, @lastFailAt, @consecutiveFailCount, @cooldownLevel, @cooldownUntil)`,
        {
          routeId,
          accountId: site.accountId,
          tokenId: site.tokenId,
          sourceModel: model,
          priority: channelIndex < 2 ? 0 : 1,
          sortOrder: channelIndex,
          weight: [45, 30, 18, 7][channelIndex],
          enabled: 1,
          manualOverride: index === 3 ? 1 : 0,
          successCount: 460 - channelIndex * 71 - index * 19,
          failCount: 3 + channelIndex * 2 + index,
          totalLatencyMs: 104_000 + channelIndex * 28_000 + index * 13_000,
          totalCost: 2.4 + channelIndex * 0.7 + index * 0.4,
          lastUsedAt: sqlTimestamp(new Date(now.getTime() - channelIndex * 180_000)),
          lastSelectedAt: sqlTimestamp(new Date(now.getTime() - channelIndex * 240_000)),
          lastFailAt: cooling ? sqlTimestamp(new Date(now.getTime() - 120_000)) : null,
          consecutiveFailCount: cooling ? 3 : 0,
          cooldownLevel: cooling ? 2 : 0,
          cooldownUntil: cooling ? sqlTimestamp(new Date(now.getTime() + 18 * 60_000)) : null,
        },
      );
      return { channelId, ...site };
    });
    return { routeId, model, channels };
  });

  const insertModel = db.prepare(
    `INSERT INTO model_availability (account_id, model_name, available, is_manual, latency_ms, checked_at)
     VALUES (@accountId, @model, 1, 1, @latencyMs, @checkedAt)`,
  );
  const insertTokenModel = db.prepare(
    `INSERT INTO token_model_availability (token_id, model_name, available, latency_ms, checked_at)
     VALUES (@tokenId, @model, 1, @latencyMs, @checkedAt)`,
  );
  for (const [siteIndex, site] of siteRows.entries()) {
    for (const [modelIndex, model] of models.entries()) {
      const latencyMs = 220 + siteIndex * 55 + modelIndex * 38;
      insertModel.run({ accountId: site.accountId, model, latencyMs, checkedAt: sqlTimestamp(now) });
      insertTokenModel.run({ tokenId: site.tokenId, model, latencyMs, checkedAt: sqlTimestamp(now) });
    }
  }

  const insertCheckin = db.prepare(
    `INSERT INTO checkin_logs (account_id, status, message, reward, created_at)
     VALUES (@accountId, @status, @message, @reward, @createdAt)`,
  );
  for (const [index, site] of siteRows.entries()) {
    insertCheckin.run({
      accountId: site.accountId,
      status: index === 3 ? 'failed' : 'success',
      message: index === 3 ? '演示：上游签到窗口已结束' : '签到成功',
      reward: index === 3 ? null : `+${(0.5 + index * 0.2).toFixed(2)}`,
      createdAt: sqlTimestamp(new Date(now.getTime() - (index + 1) * 11 * 60_000)),
    });
  }

  const insertLog = db.prepare(
    `INSERT INTO proxy_logs
      (route_id, channel_id, account_id, downstream_api_key_id, request_id, attempt_id, model_requested, model_actual, status, http_status, is_stream, first_byte_latency_ms, latency_ms, prompt_tokens, completion_tokens, total_tokens, estimated_cost, client_family, client_app_id, client_app_name, client_confidence, error_message, retry_count, created_at)
     VALUES
      (@routeId, @channelId, @accountId, @downstreamKeyId, @requestId, @attemptId, @model, @model, @status, @httpStatus, @isStream, @firstByteLatencyMs, @latencyMs, @promptTokens, @completionTokens, @totalTokens, @estimatedCost, @clientFamily, @clientAppId, @clientAppName, 'high', @errorMessage, @retryCount, @createdAt)`,
  );
  const clientApps = [
    ['codex', 'codex-cli', 'Codex CLI'],
    ['claude', 'claude-code', 'Claude Code'],
    ['openai', 'cursor', 'Cursor'],
    ['openai', 'open-webui', 'Open WebUI'],
  ];
  for (let index = 0; index < 120; index += 1) {
    const route = routeRows[index % routeRows.length];
    const channel = route.channels[index % route.channels.length];
    const failed = index % 17 === 0;
    const recentOffset = index < 8 ? index * 7_000 : (index - 7) * 73 * 60_000;
    const promptTokens = 680 + (index % 9) * 93;
    const completionTokens = failed ? 0 : 310 + (index % 7) * 71;
    const client = clientApps[index % clientApps.length];
    insertLog.run({
      routeId: route.routeId,
      channelId: channel.channelId,
      accountId: channel.accountId,
      downstreamKeyId,
      requestId: `demo-request-${String(index + 1).padStart(4, '0')}`,
      attemptId: `demo-attempt-${String(index + 1).padStart(4, '0')}`,
      model: route.model,
      status: failed ? 'failed' : 'success',
      httpStatus: failed ? 503 : 200,
      isStream: index % 3 === 0 ? 0 : 1,
      firstByteLatencyMs: 310 + (index % 11) * 47,
      latencyMs: 1260 + (index % 13) * 186,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCost: failed ? 0 : Number(((promptTokens + completionTokens) * 0.0000028).toFixed(6)),
      clientFamily: client[0],
      clientAppId: client[1],
      clientAppName: client[2],
      errorMessage: failed ? '演示：上游首字节超时' : null,
      retryCount: failed ? 2 : index % 10 === 0 ? 1 : 0,
      createdAt: sqlTimestamp(new Date(now.getTime() - recentOffset)),
    });
  }

  const insertEvent = db.prepare(
    `INSERT INTO events (type, title, message, level, read, related_id, related_type, created_at)
     VALUES (@type, @title, @message, @level, @read, @relatedId, @relatedType, @createdAt)`,
  );
  [
    ['status', '演示通道自动冷却', '远岚冷却演示连续失败 3 次，已暂停调度 18 分钟', 'warning', 0, siteRows[3].siteId, 'site'],
    ['proxy', '智能路由已切换通道', 'gpt-5.2 请求已从冷却通道切换至北辰低延迟', 'info', 0, routeRows[0].routeId, 'route'],
    ['checkin', '今日自动签到完成', '3 个账号成功，1 个账号未在签到窗口', 'info', 1, null, null],
    ['balance', '余额概览已更新', '当前 4 个模拟账号合计余额 299.00', 'info', 1, null, null],
  ].forEach(([type, title, message, level, read, relatedId, relatedType], index) => {
    insertEvent.run({
      type,
      title,
      message,
      level,
      read,
      relatedId,
      relatedType,
      createdAt: sqlTimestamp(new Date(now.getTime() - (index + 1) * 9 * 60_000)),
    });
  });

  return {
    sites: siteRows.length,
    accounts: siteRows.length,
    routes: routeRows.length,
    logs: 120,
    day: localDay(now),
  };
});

try {
  const result = seed();
  console.log(`[public-demo-seed] database=${dbPath}`);
  console.log(`[public-demo-seed] seeded=${JSON.stringify(result)}`);
} finally {
  db.pragma('foreign_keys = ON');
  db.close();
}
