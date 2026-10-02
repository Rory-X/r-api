# 🔧 运维手册

[返回文档首页](/)

---

## 数据备份

### 方式一：目录备份（SQLite / Desktop，推荐）

如果当前运行的是 SQLite，最简单的备份方式是直接备份数据目录：

- Docker / 本地开发：仓库内的 `data/`
- Desktop：应用用户数据目录下的 `data/` 子目录

```bash
# 手动备份
cp -r data/ data-backup-$(date +%Y%m%d)/

# 自动备份（crontab）
0 2 * * * cp -r /path/to/metapi/data/ /path/to/backups/metapi-$(date +\%Y\%m\%d)/
```

建议：
- 每日自动备份一次
- 保留最近 7~30 天
- Desktop 备份前先退出应用
- 如果当前运行库已切到 MySQL / Postgres，不能只备份 `data/`
- 备份文件不要提交到 Git

### 方式二：数据库原生备份（MySQL / PostgreSQL）

如果当前运行库已经切到 MySQL / Postgres，请使用数据库自己的备份工具或云快照。

**MySQL 备份示例：**

```bash
# 全量导出（替换为你的实际连接信息）
mysqldump -h <HOST> -u <USER> -p<PASSWORD> metapi > metapi-backup-$(date +%Y%m%d).sql

# 自动备份（crontab，每天凌晨 3 点）
0 3 * * * mysqldump -h <HOST> -u <USER> -p<PASSWORD> metapi | gzip > /path/to/backups/metapi-$(date +\%Y\%m\%d).sql.gz
```

**PostgreSQL 备份示例：**

```bash
# 全量导出
pg_dump -h <HOST> -U <USER> -d metapi -F c -f metapi-backup-$(date +%Y%m%d).dump

# 自动备份（crontab，每天凌晨 3 点，使用 .pgpass 免交互密码）
0 3 * * * pg_dump -h <HOST> -U <USER> -d metapi -F c -f /path/to/backups/metapi-$(date +\%Y\%m\%d).dump
```

**云托管数据库：** RDS、PlanetScale、Neon 等可直接使用平台的自动快照功能。

建议：
- 升级、迁移、执行「重新初始化系统」前先做一次库级备份
- 备份对象是当前 r-api 正在使用的运行库，而不只是本地 `data/`
- 恢复后重启 r-api 一次，确认它重新连接到了正确的运行库
- 建议保留最近 7~30 天的备份，定期清理过期文件

### 方式三：应用内导出

在管理后台 → 「导入/导出」页面：

- **全量导出**：站点、账号、Token、路由、设置
- **仅账号**：站点和账号信息
- **仅偏好**：设置和通知配置

导出为 JSON 文件，可用于跨实例迁移。

## 数据恢复

### 目录恢复（SQLite / Desktop）

服务端 SQLite 可按下面流程恢复；Desktop 则先退出应用，再替换应用用户数据目录下的 `data/` 后重新启动。

```bash
# 1. 停止容器
docker compose down

# 2. 替换数据目录
rm -rf data/
cp -r data-backup-20260228/ data/

# 3. 重新启动
docker compose up -d
```

### 应用内导入

在管理后台 → 「导入/导出」页面上传之前导出的 JSON 文件。系统会自动校验数据完整性。

### 数据库恢复（MySQL / PostgreSQL）

如果当前运行库是 MySQL / Postgres，请先用数据库自己的恢复流程把备份恢复到目标库，再重启 r-api。若实例保存过运行库配置，重启后仍会优先连接该外部库，而不是自动回退到本地 SQLite。

## 日志排查

### Docker 环境

```bash
# 查看实时日志
docker compose logs -f

# 查看最近 100 行
docker compose logs --tail 100

# 只看错误
docker compose logs -f 2>&1 | grep -i error
```

### 本地开发

```bash
npm run dev
# 日志直接输出到终端
```

### Desktop

- 优先使用托盘菜单的 `Open Logs Folder`
- Desktop 内置后端的数据目录和日志目录都位于应用用户数据目录下

### 重点关注的日志

| 关键词 | 含义 | 处理方式 |
|--------|------|----------|
| `auth failed` | 上游站点鉴权失败 | 检查账号凭证是否过期，系统会自动尝试重登录 |
| `no available channel` | 路由无可用通道 | 检查 Token 是否同步、通道是否被冷却；可在路由页查看冷却状态 |
| `channel cooling` | 通道进入冷却期 | 通道在请求失败后自动冷却 10 分钟，期间不会被路由选中；无需干预，会自动恢复 |
| `upstream 429` | 上游限流 | 该上游站点触发了速率限制；路由引擎会自动切换其他通道，冷却期后重试 |
| `upstream 5xx` | 上游服务器错误 | 上游站点临时不可用，路由引擎会自动故障转移到其他通道 |
| `notify failed` | 通知发送失败 | 检查 [通知渠道配置](./configuration.md#通知渠道) |
| `checkin failed` | 签到失败 | 检查账号状态和站点连通性 |
| `balance refresh failed` | 余额刷新失败 | 检查账号凭证，可能需要重新登录 |
| `proxy timeout` | 代理请求超时 | 上游响应过慢；检查网络延迟或考虑切换其他通道 |
| `token expired` | Token 过期 | 系统会自动尝试续签；若反复出现，手动刷新 Token |

## 健康检查

### 标准端点

| 端点 | 用途 | 失败状态 |
|------|------|----------|
| `GET /livez`、`GET /health/live` | Liveness，只证明进程事件循环仍能响应 | 进程不可响应时由运行平台判定失败 |
| `GET /readyz`、`GET /health/ready` | Readiness，检查启动完成、数据库和关键 worker | `503` |
| `GET /health/workers` | 汇总后台 worker 的最近成功、连续失败、卡住和停用状态 | 始终返回快照，查看响应内 `status` |
| `GET /health/slo` | 返回当前统一 SLI/SLO 机器可读契约 | `200` |
| `GET /metrics` | Prometheus text exposition | `200` |

Liveness 不访问数据库或上游，避免依赖故障触发无意义的进程重启。Readiness 会在服务完成启动后打开，在关闭流程开始时立即撤销。

Kubernetes 探针示例：

```yaml
livenessProbe:
  httpGet:
    path: /livez
    port: 4000
  initialDelaySeconds: 10
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /readyz
    port: 4000
  initialDelaySeconds: 5
  periodSeconds: 5
```

### Prometheus 指标

`/metrics` 默认包含 Node.js 进程指标，并额外提供：

| 指标 | 含义 |
|------|------|
| `r_api_http_requests_total` | 按 method、路由模板和状态码类别统计 HTTP 请求 |
| `r_api_http_request_duration_seconds` | HTTP 请求耗时直方图 |
| `r_api_proxy_requests_total` | 按 API surface 和最终 outcome 统计代理请求 |
| `r_api_proxy_request_duration_seconds` | 代理请求端到端耗时 |
| `r_api_proxy_first_byte_seconds` | 成功请求的上游首字节耗时 |
| `r_api_proxy_attempts` | 每个代理请求使用的上游 attempt 数量 |
| `r_api_worker_up` | worker 当前是否健康 |
| `r_api_worker_enabled` | worker 当前是否应当运行 |
| `r_api_worker_runs_total` | worker pass 成功/失败计数 |
| `r_api_worker_last_success_timestamp_seconds` | worker 最近成功时间 |
| `r_api_worker_consecutive_failures` | worker 连续失败次数 |
| `r_api_readiness_status` | 当前 readiness 状态 |
| `r_api_dependency_up` | readiness 依赖状态 |

指标标签只使用固定 API surface、路由模板和 worker 名称，不包含模型名、账号、渠道、请求 ID 或其他高基数字段。

### OpenTelemetry trace

Tracing 默认关闭。配置 OTLP HTTP collector 后，启动入口会在加载 Fastify、HTTP client 和数据库驱动前注册自动 instrumentation；HTTP 请求和 worker pass 会进入同一套 trace。

```bash
OTEL_SERVICE_NAME=r-api
OTEL_TRACES_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

设置 `OTEL_SDK_DISABLED=true` 或 `OTEL_TRACES_EXPORTER=none` 可显式关闭。健康检查和 `/metrics` 不创建入口 span。

如果 metrics 端点不应公开，可设置 `METRICS_AUTH_TOKEN`；抓取时使用 `Authorization: Bearer <METRICS_AUTH_TOKEN>`。`/livez` 和 `/readyz` 不受该配置影响。

### 统一 SLI / SLO

默认评估窗口是 30 天，机器可读值以 `/health/slo` 为准：

| SLI | 目标 |
|-----|------|
| 代理最终成功率 | `99.9%` |
| 5 秒内收到上游首字节的比例 | `99%` |
| 管理 API 非 5xx 比例 | `99.9%` |
| worker 健康时间占比 | `99.9%` |

PromQL 示例：

```text
# 代理最终成功率
sum(rate(r_api_proxy_requests_total{outcome="succeeded"}[5m]))
/
sum(rate(r_api_proxy_requests_total[5m]))

# 5 秒首字节达标率
sum(rate(r_api_proxy_first_byte_seconds_bucket{le="5"}[5m]))
/
sum(rate(r_api_proxy_first_byte_seconds_count[5m]))

# 管理 API 可用率
1 - (
  sum(rate(r_api_http_requests_total{route=~"/api/.*",status_class="5xx"}[5m]))
  /
  sum(rate(r_api_http_requests_total{route=~"/api/.*"}[5m]))
)

# 仅检查已启用 worker
r_api_worker_up and on(worker) (r_api_worker_enabled == 1)
```

代理成功率以请求账本的最终状态为准，不会把内部重试中的单次失败误算成一次用户请求失败。流式请求的完整生成时长受模型输出长度影响，因此延迟 SLO 使用首字节而不是完整响应时长。

### 手动端到端检查

```bash
# 检查进程和 readiness
curl -fsS http://localhost:4000/livez
curl -fsS http://localhost:4000/readyz

# 检查代理端到端响应
curl -sS http://localhost:4000/v1/models \
  -H "Authorization: Bearer <DOWNSTREAM_API_KEY>" | head -5

# 检查特定模型可用性
curl -sS http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <DOWNSTREAM_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'
```

以上示例默认服务端部署监听 `localhost:4000`。Desktop 内置后端默认监听 `0.0.0.0:4000`；本机排查通常可直接使用 `127.0.0.1:4000`，如果显式设置了 `METAPI_DESKTOP_SERVER_PORT`，则按日志里的实际端口访问；局域网排查改用当前机器的实际 IP。

### 自动化监控建议

- 运行平台分别使用 `/livez` 和 `/readyz`，不要用业务请求替代容器探针
- Prometheus 抓取 `/metrics`，告警使用 `/health/slo` 中声明的统一口径
- 定时请求 `/v1/models`，检查返回状态码和模型数量，作为外部 synthetic check
- 定时抽样请求 `/v1/chat/completions`，检查端到端可用性
- SQLite / Desktop：监控磁盘空间（SQLite WAL 日志可能增长）
- MySQL / Postgres：监控外部数据库空间、连接数和慢查询
- 监控 Docker 容器状态

## 常见运维操作

### 清理代理日志

代理日志会持续增长。如果磁盘空间紧张，可在管理后台 → 代理日志页面清理历史记录。

### 重置账号状态

如果面板账号状态异常（`unhealthy`），进入「渠道管理 → 账号与 API Key → 面板账号 → 账号列表」：

1. 点击「刷新」重新检测账号健康状态
2. 如凭证过期，系统会尝试自动重登录
3. 手动禁用/启用账号

### 强制刷新模型

在管理后台手动触发：

- 余额刷新：立即更新所有账号余额
- 模型刷新：重新发现所有上游模型
- 签到：立即执行一次签到

### 系统代理

在「系统与安全 → 设置 → 网络与代理 → 系统代理」中保存全局代理地址后，只有启用了「使用系统代理」的站点才会走这条出站代理。

- 单个站点可在站点页直接开关
- 站点页支持批量开启 / 关闭系统代理
- 修改系统代理地址后，r-api 会自动失效站点代理缓存，通常无需手工重启

### 清理缓存并重建路由

当模型列表（`GET /v1/models`）、路由列表或选择概率明显滞后时，使用以下操作：

| 操作 | 位置 | 适用场景 |
|------|------|----------|
| **清除缓存并重建路由** | 设置 → 数据与维护 → 维护工具 | 全局刷新：清空模型发现缓存、自动路由和自动通道，后台触发模型刷新与路由重建 |
| **重建路由** | 路由 | 局部刷新：调整账号、签发令牌或路由规则后重新生成自动路由 |

优先使用「重建路由」做局部刷新，问题持续时再用全局清除。

### 批量操作

管理后台支持以下批量运维动作：

- 站点：批量启用、禁用、删除、开启系统代理、关闭系统代理
- 账号：批量刷新余额、启用、禁用、删除
- Token：批量启用、禁用、删除

批量操作完成后，界面会返回成功/失败数量；删除站点或账号后，路由相关缓存会自动失效。

### 重新初始化系统

这是高风险操作，位于「系统与安全 → 设置 → 数据与维护 → 危险操作」。

- 会清空当前 r-api 正在使用的全部业务数据
- 如果当前运行在外部 MySQL / Postgres，会先清空该外部库中的 r-api 数据，再切回默认 SQLite
- 管理员 Token 会重置为 `change-me-admin-token`
- 当前登录会话会立即退出，页面刷新后回到首装状态

执行前建议先做一次导出或数据库备份。

## 下一步

- [常见问题](./faq.md) — 常见报错与修复
- [配置说明](./configuration.md) — 环境变量详解
- [上游接入](./upstream-integration.md) — 平台特定的连接与排障
- [客户端接入](./client-integration.md) — 下游客户端对接
