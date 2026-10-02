# r-api 资源治理、成本控制与告警升级设计

日期：2026-08-18

## 1. 结论

r-api 已经具备这组能力所需的大部分底座，但目前仍是若干独立功能，尚未形成完整的运营治理闭环：

- 日志、调试记录、代理文件和通知 Outbox 都有保留时长或清理逻辑，但动作基本是直接删除，不支持归档、恢复、保留例外、执行预览和统一运行状态。
- `proxy_requests` / `proxy_request_attempts` 已经构成持久化请求账本，却没有独立保留策略；账本会持续增长，且删除请求时会级联删除尝试明细。
- 站点和模型成本已有增量聚合，单个下游 Key 也能从 `proxy_logs` 查询成本，但 Key 报表仍依赖原始日志。日志清理后，Key 的历史趋势会消失，而站点和模型历史仍保留，三个维度的口径并不对称。
- 下游 Key 已支持累计成本、累计请求数、过期时间和数据库并发租约，但累计额度只能手动重置，没有 RPM、TPM、日/月额度、突发容量、预占与结算。
- 通知链路已有持久化 Outbox、幂等、去重冷静期、指数退避和多渠道投递，但没有“告警事件”的生命周期，也没有确认、恢复、按严重度路由、延迟升级和重复提醒。

建议按以下顺序建设：

1. **先补齐长期成本投影和统一成本查询**，消除日志删除对报表与配额的影响。
2. **再统一资源保留并增加归档清单**，让删除动作有可验证的前置条件。
3. **然后实现数据库一致的时间窗限流与额度预占**，避免多进程下超卖。
4. **最后在现有通知 Outbox 之上增加告警事件与升级策略**，不重写通知渠道。

## 2. 当前能力与缺口

| 领域 | 已有能力 | 主要缺口 | 风险 |
| --- | --- | --- | --- |
| 资源保留 | `logCleanupService` 清理使用日志和程序日志；代理文件、调试记录、通知 Outbox 各自清理 | 多套配置入口；没有统一资源目录、预览、执行记录、归档和保留例外 | 运维无法回答“什么会在何时被删、上次删了什么” |
| 日志归档 | `proxy_logs` 有时间索引，站点/模型有长期聚合 | 原始日志只能删除；没有归档文件、校验和、清单、恢复或下载 | 审计证据不可恢复 |
| 请求账本 | `proxy_requests` 保存策略和重试预算快照，`proxy_request_attempts` 保存尝试链 | 没有保留和归档；终态、活跃态、未知态没有差异化策略 | 表持续膨胀，或未来粗暴删除破坏重试审计 |
| 成本统计 | `site_day_usage`、`site_hour_usage`、`model_day_usage` 增量投影；下游 Key 列表、概览和趋势能查成本 | Key 统计直接扫描 `proxy_logs`；缺少统一 API、成本来源/置信度和投影水位可见性 | 清理后历史口径不一致，大表查询随时间变慢 |
| 限流与配额 | `maxCost`、`maxRequests`、`maxConcurrency`；并发使用数据库 lease | 成本/请求是生命周期累计；鉴权检查与事后记账之间可超额；无时间窗和预占 | 高并发时额度超卖，无法表达常见套餐 |
| 告警 | `events`、`sendNotification()`、durable Outbox、冷静期、重试、多渠道 | 告警调用以标题和消息为主，没有稳定事件键、状态机、确认人、恢复事件和升级步骤 | 同一故障难聚合，通知成功不等于故障被处理 |

### 2.1 资源保留现状

当前至少存在四条保留链路：

- `src/server/services/logCleanupService.ts`：按同一保留天数删除 `proxy_logs` 和 `events`。
- `src/server/services/proxyLogRetentionService.ts`：在新日志清理配置尚未启用时，作为旧版回退直接删除 `proxy_logs`。
- `src/server/services/proxyFileRetentionService.ts`：独立删除代理文件。
- `src/server/services/proxyDebugTraceStore.ts`：写入调试 Trace 时顺带清理过期 Trace。
- `src/server/services/notificationOutboxService.ts`：定期删除已投递或结果未知的 Outbox 和节流状态。

这些服务的时间单位、调度方式、启停语义和可见状态不同。`proxy_requests`、`proxy_request_attempts`、聚合表、公告、后台任务等资源没有进入同一个保留模型。

### 2.2 成本统计现状

`src/server/services/usageAggregationService.ts` 已经通过 `analytics_projection_checkpoints` 增量消费 `proxy_logs`，生成：

- 站点日聚合；
- 站点小时聚合；
- 站点与模型日聚合。

投影有水位、lease、重算请求和错误状态，是长期统计的正确底座。

下游 Key 统计则由 `src/server/routes/api/downstreamApiKeys.ts` 和 `src/server/services/downstreamApiKeyTrendService.ts` 直接聚合 `proxy_logs`。因此：

- Key 的 `all` 趋势会随原始日志清理而缩短；
- 站点/模型报表和 Key 报表对“全量历史”的定义不同；
- Key 的长期趋势需要扫描不断增长的原始明细；
- 无法在清理前验证 Key 维度已经完成投影。

另外，当前成本字段主要是 `estimated_cost`，缺少统一暴露的成本来源。上游精确账单、响应 usage 推算、模型价格表推算和平台 token/quota 回退都可能得到一个数值，但运营侧无法判断它是“已结算”还是“估算”。

### 2.3 下游限流现状

`src/server/services/downstreamApiKeyService.ts` 已经实现：

- 过期、禁用、累计成本上限和累计请求上限检查；
- 数据库并发 slot lease、续租与释放；
- 使用量的数据库原子自增；
- Key 策略快照和请求期间的撤销/轮换检查。

主要问题不是“完全没有配额”，而是配额模型太窄：

- `maxCost`、`maxRequests` 是永久累计值，只有手动重置，没有自然窗口；
- 请求进入时只检查已使用量，请求结束后才结算成本和次数，多个并发请求可同时越过余额线；
- 没有 RPM、TPM、日成本、月成本、模型级额度或软阈值；
- 没有标准化的 `Retry-After`、剩余额度和窗口重置响应头；
- Key 页面无法看到当前窗口、已预占、已结算和下一次重置时间。

### 2.4 告警现状

现有通知链路适合“可靠投递消息”，但还不是完整告警系统：

```text
业务代码 -> events + sendNotification -> notification_outbox -> 渠道
```

缺少的控制层位于 `events` 与 `notification_outbox` 之间：

```text
信号 -> 告警规则 -> 告警事件 -> 升级步骤 -> notification_outbox -> 渠道
```

当前 `reportTokenExpired()` 和 `reportProxyAllFailed()` 会直接生成事件并通知。标题、消息和级别同时承担展示、去重与路由语义，无法稳定表达“同一站点的同一故障仍在持续”。

## 3. 目标架构

### 3.1 单一资源保留注册表

新增 `resourceRetentionService`，由它统一注册可治理资源。路由和定时任务只调用服务，不各自拥有清理规则。

建议第一阶段支持以下资源键：

| 资源键 | 热数据建议 | 归档建议 | 最终删除建议 | 特殊约束 |
| --- | ---: | ---: | ---: | --- |
| `proxy_logs` | 30 天 | 365 天 | 365 天后 | 归档前必须越过所有成本投影水位 |
| `proxy_request_ledger` | 30 天 | 365 天 | 365 天后 | 只处理终态；请求与 attempts 一起归档 |
| `program_events` | 90 天 | 可选 | 365 天后 | 未读 critical 事件不得自动删除 |
| `proxy_debug_traces` | 24 小时 | 不归档 | 24 小时后 | 可能包含敏感请求体，默认短保留 |
| `proxy_files` | 7 天 | 可选 | 30 天后 | 删除数据库记录和文件对象必须一致 |
| `notification_outbox` | 30 天 | 不归档 | 30 天后 | 只删除终态，pending/processing 不删除 |

上述天数应作为默认建议，不应在迁移时覆盖用户现有值。

统一策略至少包含：

```ts
type RetentionPolicy = {
  resource: RetentionResource;
  enabled: boolean;
  hotDays: number;
  archiveEnabled: boolean;
  archiveDays: number | null;
  deleteDays: number | null;
  batchSize: number;
  schedule: string;
};
```

需要额外支持：

- dry-run：返回候选数量、最早/最晚时间和预计归档体积；
- legal hold：至少支持按时间段或实体 ID 阻止自动处理；
- 执行历史：开始时间、结束时间、扫描数、归档数、删除数、失败原因；
- 每种资源自己的 eligibility 判断，不能只套一个 `created_at < cutoff`；
- 单实例和多实例都使用数据库 lease，避免重复归档。

### 3.2 归档格式与提交协议

第一阶段使用本地文件归档，后续再增加 S3/WebDAV adapter。文件建议采用 gzip 压缩的 NDJSON，而不是数据库方言相关 dump：

```text
data/archives/<resource>/<yyyy>/<mm>/<manifest-id>.ndjson.gz
```

每个归档清单记录：

- `resource`、`schemaVersion`、`status`；
- `rowCount`、`minId`、`maxId`、`minCreatedAt`、`maxCreatedAt`；
- `storageDriver`、`objectKey`、`byteSize`、`sha256`；
- `createdAt`、`committedAt`、`deletedAt`、`lastError`。

归档批次采用以下顺序：

1. 用稳定游标选择一个只读批次。
2. 验证资源前置条件，例如成本投影水位已覆盖 `maxId`。
3. 写临时文件并计算行数、大小和 SHA-256。
4. 原子 rename 为最终对象。
5. 在数据库提交 `archive_manifests(status='committed')`。
6. 按清单记录的精确 ID 范围删除源数据。
7. 将清单标记为 `source_deleted`。

进程在任一步崩溃后，都可根据清单状态继续或回收临时对象。禁止“先删后传”。

请求账本归档时，每行应包含一个请求及其 attempts 数组。只归档 `succeeded`、`failed`、`cancelled` 等终态；`active` 和 `unknown` 必须先经过现有恢复/判定流程，不能按年龄直接删除。

### 3.3 长期成本投影

保留现有站点/模型表，新增下游 Key 日聚合：

```text
downstream_key_day_usage
  local_day + downstream_api_key_id
  calls / success / failed / tokens / cost

downstream_key_model_day_usage
  local_day + downstream_api_key_id + model
  calls / tokens / cost

downstream_key_site_day_usage
  local_day + downstream_api_key_id + site_id
  calls / tokens / cost
```

如果第一阶段只需要三个独立维度，可先落 `downstream_key_day_usage`，复用现有 `model_day_usage(site_id, model)` 满足模型和站点查询；Key 与模型、Key 与站点交叉表按实际报表需求再增加，避免无控制地放大维度基数。

投影输入仍以 `proxy_logs.id` 为水位。投影批次同时更新站点、模型和 Key 聚合，并在同一事务推进 checkpoint。原始日志归档必须检查 checkpoint：

```text
archive_batch.max_proxy_log_id <= analytics_projection_checkpoints.last_proxy_log_id
```

成本值应输出下面的统一口径：

```ts
type CostMeasure = {
  amount: number;
  currency: 'USD';
  source: 'upstream_billing' | 'response_usage' | 'pricing_table' | 'platform_fallback';
  confidence: 'settled' | 'estimated' | 'fallback';
};
```

聚合表至少分别累计 `settled_cost`、`estimated_cost` 和 `fallback_cost`，API 再返回总额。这样配额执行可以明确选择“按实时估算拦截”，财务报表则可优先展示已结算值。

统一查询 API：

```text
GET /api/stats/costs
  ?groupBy=downstream_key|model|site
  &from=2026-08-01
  &to=2026-08-18
  &downstreamKeyId=
  &model=
  &siteId=
  &granularity=day
```

响应统一返回 `calls`、`tokens`、`cost`、`settledCost`、`estimatedCost`、`fallbackCost` 和维度标签。原有接口可以继续保留，并改为调用同一个查询服务。

### 3.4 时间窗限流与额度

不建议继续往 `downstream_api_keys` 堆固定字段。新增规范化策略表，使请求、token、成本和未来的模型级规则共享同一执行器：

```text
downstream_key_limit_policies
  id
  downstream_api_key_id
  metric: requests | input_tokens | output_tokens | total_tokens | cost
  scope_type: key | model | site
  scope_value
  window_type: fixed | calendar_day | calendar_month
  window_seconds
  limit_value
  burst_value
  enforcement: hard | soft
  warning_thresholds_json
  enabled

downstream_key_usage_windows
  policy_id
  window_start
  window_end
  used_value
  reserved_value
  version
```

首版建议只开放：

- 请求/分钟；
- token/分钟；
- 成本/日；
- 成本/月；
- 现有最大并发。

请求生命周期：

1. 鉴权后计算所有适用策略和当前窗口。
2. 在数据库事务中原子增加 `reserved_value`；任一 hard limit 不足则全部回滚。
3. 返回成功后，用实际 usage 将 reservation 转为 `used_value`。
4. 请求失败或取消时释放 reservation；usage 不确定时按保守估算结算并标记来源。
5. 后台任务回收过期 reservation，处理进程崩溃。

响应建议包含标准语义：

- HTTP `429`；
- `Retry-After`；
- `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`；
- 响应体稳定错误码，例如 `rate_limit_requests`、`quota_daily_cost`、`quota_monthly_cost`。

现有 `maxCost` 和 `maxRequests` 迁移为无自然重置的 legacy policy，保持兼容；现有并发 lease 继续作为并发指标的实现，不重复造第二套并发计数器。

### 3.5 告警事件与升级

保留 `notification_outbox` 作为可靠投递层，在其上新增：

```text
alert_incidents
  fingerprint
  rule_key
  severity
  status: open | acknowledged | resolved | suppressed
  entity_type / entity_id
  occurrence_count
  first_seen_at / last_seen_at
  acknowledged_at / acknowledged_by
  resolved_at
  escalation_step
  next_escalation_at

alert_occurrences
  incident_id
  observed_at
  value_json
  message

alert_policies
  rule_key
  enabled
  open_condition_json
  resolve_condition_json
  grouping_window_sec
  steps_json
```

升级步骤示例：

```json
[
  { "afterSec": 0, "channels": ["feishu"], "repeatSec": 0 },
  { "afterSec": 900, "channels": ["telegram", "smtp"], "repeatSec": 1800 }
]
```

告警引擎需要支持：

- 稳定 fingerprint：规则 + 实体 + 关键维度，而不是整段 message；
- open、repeat、acknowledge、resolve 四类通知；
- 恢复条件和恢复通知；
- acknowledged 后停止升级，但继续记录 occurrence；
- 同一 incident 的 Outbox 使用 incident/step 级幂等键；
- severity 决定默认渠道和是否绕过普通冷静期；
- 升级 worker 使用 lease，复用现有 Outbox 的投递重试。

建议优先内置以下规则：

| 规则 | warning | critical | 恢复 |
| --- | --- | --- | --- |
| 下游 Key 成本额度 | 70% 或 85% | 100% | 窗口重置或额度提高 |
| 下游 Key 限流 | 5 分钟持续出现 | 拒绝率超过阈值 | 连续窗口无拒绝 |
| 代理全失败 | 单次聚合告警 | 同模型/站点持续 5 分钟 | 成功请求恢复 |
| 上游额度耗尽 | 单渠道受限 | 同 Route 无可用渠道 | 渠道恢复可用 |
| 成本投影 | 延迟超过 5 分钟 | 投影失败或延迟超过 30 分钟 | checkpoint 追平 |
| 归档任务 | 单批失败 | 连续失败或磁盘不足 | 后续批次成功 |
| 通知 Outbox | backlog 增长 | 最老 pending 超过阈值 | backlog 回落 |

## 4. 管理 API 与页面

### 4.1 数据与维护

在现有“设置 -> 数据与维护”中增加统一资源保留面板：

- 每个资源显示热保留、归档、最终删除、调度和启停；
- 显示最近成功时间、最近失败、下次执行和待处理数量；
- 支持“预览本次执行”和“立即执行”；
- 归档记录用独立抽屉分页展示，提供校验、下载和删除归档对象操作。

原有日志清理设置迁移到统一面板，API 在过渡期继续接受旧字段，但内部只写新的策略来源。

### 4.2 成本分析

新增一个以表格为主的成本分析视图：

- 分段选择：下游 Key / 模型 / 站点；
- 时间范围与粒度；
- 总成本、请求、token、成功率；
- 成本来源分解；
- 点击维度进入现有 Key、模型或站点管理页。

页面只调用统一成本查询 API，不在前端拼接三个旧接口。

### 4.3 下游 Key

Key 编辑器增加“限制与配额”区域：

- RPM、TPM、日成本、月成本和并发；
- hard/soft 模式；
- 70%/85%/100% 告警阈值；
- 当前窗口、已使用、已预占、剩余和重置时间。

现有累计请求/成本字段在迁移期标记为“历史累计上限”，新建 Key 默认使用窗口策略。

### 4.4 告警中心

通知 Outbox 页面继续负责“消息有没有送达”，另建告警事件视图负责“故障有没有处理”：

- 打开中、已确认、已恢复、已抑制；
- 严重度、规则、实体、首次/最近发生时间、次数；
- 确认、恢复、抑制、查看 occurrence 时间线；
- 查看各升级步骤对应的 Outbox 投递结果。

## 5. 实施拆分

### P0：保留安全与成本一致性

1. 扩展 usage projector，新增 `downstream_key_day_usage`。
2. 将 Key 列表、概览和趋势改为优先读取聚合表。
3. 增加统一成本查询 service/API，旧 API 复用它。
4. 暴露 projector checkpoint、延迟和错误状态。
5. 增加架构测试，禁止长期统计重新直接扫描无界 `proxy_logs`。

验收：清理 30 天前的 `proxy_logs` 后，下游 Key、模型和站点的 90 天成本报表不变。

### P1：统一保留与本地归档

1. 新增 retention policy、archive manifest、run history schema 和迁移产物。
2. 实现资源注册表、dry-run、lease 和分批执行器。
3. 先接入 `proxy_logs`，再接入请求账本、events、debug、files 和 Outbox。
4. 增加归档下载、校验和执行状态 API/UI。
5. 旧日志清理服务改为兼容 adapter，最终移除双调度。

验收：任意阶段中断归档进程，不会出现“源数据已删但归档不可用”；重启后可安全继续。

### P2：时间窗限流与额度

1. 新增 limit policy 和 usage window schema。
2. 实现原子预占、结算、释放和过期 reservation 回收。
3. 接入所有 HTTP、流式和 WebSocket 代理表面。
4. 返回统一错误码和 rate-limit headers。
5. 增加 Key 编辑、窗口用量和重置时间 UI。

验收：多进程并发压测下，hard limit 的最终 `used + reserved` 不超过配置值；进程崩溃后 reservation 可回收。

### P3：告警事件与升级

1. 新增 incident、occurrence 和 policy schema。
2. 把现有 token expired、proxy all failed、connector offline 信号接入事件服务。
3. 实现 ack、resolve、suppression、升级 worker 和恢复通知。
4. 接入配额、投影、归档和 Outbox 健康规则。
5. 新增告警中心和策略编辑入口。

验收：同一持续故障只创建一个 incident；未确认时按策略升级；确认后停止升级；恢复后只发送一次恢复通知。

## 6. 关键约束

- **聚合先于归档**：任何会影响长期报表的明细，只有在全部必要投影越过水位后才能归档或删除。
- **账本不是普通日志**：活跃或结果未知的请求不能按时间直接清理。
- **配额必须预占**：只做请求前读取和请求后自增，无法在并发场景保证 hard limit。
- **Outbox 不是 Incident**：投递状态和故障处理状态必须分层保存。
- **归档不等于备份**：归档面向历史查询和合规保留；数据库备份仍负责灾难恢复。
- **路由保持薄**：归档、成本查询、配额和告警升级都由 service 层拥有，API 路由只解析参数和委托。
- **三方言同步**：每个 schema 变化同时更新 Drizzle schema、SQLite migration history 和生成的 MySQL/Postgres artifacts。

## 7. 不建议的实现

1. 不要在清理任务里直接先删 `proxy_logs`，再尝试补算成本聚合。
2. 不要让下游 Key 的长期报表继续依赖原始日志。
3. 不要只在内存里做 RPM/TPM；r-api 支持多实例和多数据库，限流状态必须可协调。
4. 不要把每种配额都新增为 `downstream_api_keys` 的一列。
5. 不要用通知标题和完整 message 作为告警实体身份。
6. 不要重写通知渠道和重试；事件升级应复用现有 durable Outbox。
7. 不要默认长期归档调试请求体和文件内容，它们的敏感性高于普通用量日志。

## 8. 推荐的首个交付切片

第一个可独立上线的切片应只包含：

1. `downstream_key_day_usage` 及增量投影；
2. 统一成本查询 service/API；
3. Key 成本趋势切换到聚合表；
4. 投影水位健康状态；
5. “聚合追平后才允许清理 proxy logs”的保护检查。

这个切片不需要立即引入归档文件、配额策略或告警表，却能先修复最危险的数据一致性问题，并为后续四项能力提供共同底座。
