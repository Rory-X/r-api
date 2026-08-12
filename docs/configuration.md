# ⚙️ 配置说明

本文档按实际使用场景说明 Metapi 的配置入口。

对大多数用户来说，日常配置优先通过管理后台完成；环境变量主要用于首次启动、部署级参数和当前没有 UI 的高级项。

[返回文档中心](./README.md)

---

## 概述

Metapi 当前有三类主要配置入口：

1. **管理后台「设置」** — 适合日常系统设置与运行时调整
2. **管理后台「通知设置」与「下游密钥」** — 适合通知渠道和项目级下游 Key 管理
3. **环境变量** — 适合首次启动、部署级参数、OAuth client 覆盖、Deploy Helper token 等当前没有 UI 的项

下表可用于快速判断：

| 你要改什么 | 优先去哪里 | 说明 |
|----------|------------|------|
| 日常系统设置 | 管理后台「设置」 | 大部分运行时配置都在这里，保存后直接生效或按提示重启 |
| 通知渠道 | 管理后台「通知设置」 | Webhook / Bark / Server酱 / Telegram / SMTP 都有 UI |
| 下游项目级 Key | 管理后台「下游密钥」 | 不要再回到环境变量里硬塞 |
| 首次启动令牌、端口、数据目录 | `.env` / 容器环境变量 | 这类属于部署级初始化 |
| OAuth 客户端 ID / Secret | `.env` / 容器环境变量 | 当前没有 UI |
| Deploy Helper token / helper 进程参数 | `.env` / helper manifest | 当前没有 UI，且属于集群侧部署参数 |
| 少数高级部署级参数 | `.env` / 容器环境变量 | 例如日志保留、部分探测细粒度参数 |

---

## 配置入口总览

### 1. 管理后台「设置」

侧边栏入口：**系统 → 设置**

当前已经能直接在这里配置的内容包括：

| UI 项 | 对应能力 | 生效方式 |
|------|----------|----------|
| 管理员登录凭据 | Argon2id 管理凭据 | 保存后立即撤销现有管理会话，重新登录后生效 |
| TOTP 双重验证 | 验证器动态码、恢复码和第二因素会话 | 启用/重置/停用后立即生效并撤销其他管理会话 |
| 定时任务 | 签到模式、Cron/间隔、时区窗口、抖动、补签、余额与日志计划 | 保存后即时生效 |
| 系统代理 | `SYSTEM_PROXY_URL` | 保存后即时生效 |
| 代理失败判定 | 失败关键词、空内容失败判定 | 保存后即时生效 |
| Codex 上游传输与会话并发 | WebSocket 开关、并发与队列参数 | 保存后即时生效 |
| 批量测活 | 后台模型可用性探测开关 | 保存后即时生效 |
| 路由策略 | 成本/余额/使用率权重、默认单价、首字超时、协议回退、失败冷却上限 | 保存后即时生效 |
| 全局品牌屏蔽 | 全局品牌屏蔽 | 保存后即时生效，并触发路由重建 |
| 全局模型白名单 | 全局模型白名单 | 保存后即时生效，并触发路由重建 |
| 数据库迁移 / 运行数据库 | `DB_TYPE`、`DB_URL`、`DB_SSL` | 保存后下次后端重启生效 |
| 更新中心 | K3s / Helm 更新中心配置 | 保存后即时生效 |
| 会话与安全 | `ADMIN_IP_ALLOWLIST` | 保存后即时生效 |

> [!TIP]
> `AUTH_TOKEN` 只用于首次初始化管理员凭据；初始化后数据库只保存 Argon2id 哈希。
> `PROXY_TOKEN` 可在「控制台 → 下游密钥 → 全局主密钥」中轮换。它与项目级下游密钥是不同权限边界。

### 2. 管理后台「通知设置」

侧边栏入口：**系统 → 通知设置**

当前已经有独立页面可直接配置：

| UI 项 | 说明 | 生效方式 |
|------|------|----------|
| Webhook | 企业微信 / 飞书 / 通用 Webhook | 保存后即时生效 |
| Bark | Bark 推送地址与开关 | 保存后即时生效 |
| Server酱 | SendKey 与开关 | 保存后即时生效 |
| Telegram | API Base URL、Chat ID、Topic ID、Bot Token、是否走系统代理 | 保存后即时生效 |
| SMTP | SMTP 主机、端口、账号、密码、发件/收件地址 | 保存后即时生效 |
| 告警冷静期与投递策略 | `NOTIFY_COOLDOWN_SEC`、`NOTIFY_DELIVERY_POLICY` | 保存后即时生效 |

通知设置页面已经支持：

- 直接保存
- 直接发测试通知
- 屏蔽回显已保存的敏感字段

通知配置可直接在该页面完成，无需先记环境变量名。

### 3. 管理后台「下游密钥」

侧边栏入口：**控制台 → 下游密钥**

「下游密钥」页面统一管理全局主密钥与项目级下游 API Key：

- **全局主密钥（`PROXY_TOKEN`）**：兼容早期客户端，拥有完整权限，不受项目级额度、白名单与有效期限制。
- **项目级下游密钥**：适合按团队或项目分发，可配置细粒度策略。

适合在这里配置的内容：

- Key 名称
- 过期时间
- 费用 / 请求上限
- 模型白名单
- 路由白名单
- 站点权重倍率
- 启停、重置用量、趋势与统计

这类能力可直接在页面里完成，不需要额外依赖环境变量。

---

## 首次启动时，至少准备这些环境变量

**首次把服务跑起来**时，建议先在环境变量里准备以下几项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `AUTH_TOKEN` | 首次初始化使用的管理员登录凭据 | `change-me-admin-token` |
| `AUTH_TOKEN_HASH` | 可选 Argon2id 初始化哈希，设置后优先于 `AUTH_TOKEN` | 空 |
| `ACCOUNT_CREDENTIAL_SECRET` | 独立 Vault/账号凭证加密根密钥；生产环境必须单独生成 | 兼容旧部署时回退到 `AUTH_TOKEN` |
| `ADMIN_SESSION_TTL_MS` | HttpOnly 管理会话绝对有效期 | `43200000`（12 小时） |
| `ADMIN_COOKIE_SECURE` | 强制管理会话 Cookie 使用 `Secure` | `false` |
| `TRUST_PROXY` | 可信反向代理 IP/CIDR 或跳数；默认不信任转发头 | `false` |
| `PROXY_TOKEN` | 初始下游访问令牌 | `change-me-proxy-sk-token` |
| `PORT` | 服务监听端口 | `4000` |
| `DATA_DIR` | 数据目录（SQLite 默认落这里） | `./data` |
| `TZ` | 时区 | `Asia/Shanghai` |

说明：

- `AUTH_TOKEN` 只在当前数据库尚未建立管理员哈希时参与初始化；旧版 `auth_token` 明文设置会在升级后自动迁移并删除。
- 官方 Compose 会要求首次启动时提供 `AUTH_TOKEN` 或 `AUTH_TOKEN_HASH`；数据库已经存在 `admin_password_hash` 后，可以移除启动环境里的 `AUTH_TOKEN`。
- WebUI 登录后使用 HttpOnly Cookie；浏览器只保存会话绑定的 CSRF 元数据，不保存管理员凭据。
- WebUI 可在「系统设置 → 管理员安全」启用 TOTP；Challenge 只保留在当前页面内存，TOTP Secret 和恢复码不会写入浏览器持久化存储。
- 脚本仍可显式使用 `Authorization: Bearer <当前管理员登录凭据>` 调用管理 API；脚本 Bearer 不要求 TOTP，避免破坏无人值守自动化。
- `ACCOUNT_CREDENTIAL_SECRET` 必须与管理员登录凭据分离，修改后既有 Vault/账号密文将无法解密。
- 直接暴露 Metapi 时保持 `TRUST_PROXY=false`；只有在请求必经可信反向代理时才配置代理 IP/CIDR，并由代理覆盖传入的转发头。
- `PROXY_TOKEN` 也只是建议先给一个初始值；后续可在「控制台 → 下游密钥 → 全局主密钥」中轮换。
- `PORT`、`DATA_DIR`、`TZ` 这类属于部署级参数，更适合留在环境变量。

---

## 管理员 TOTP 双重验证

TOTP 默认关闭。启用后，WebUI 密码登录会进入第二阶段，可输入验证器生成的 6 位动态码或一枚恢复码。动态码周期为 30 秒，允许相邻一个时间窗口；同一计数器只能接受一次。

- TOTP Secret 使用 `ACCOUNT_CREDENTIAL_SECRET` 派生密钥做 AES-256-GCM 加密。
- 恢复码只保存带独立 Pepper 的 HMAC 摘要，每枚只能使用一次；新生成恢复码会让旧码立即失效。
- 恢复码仅在启用或重新生成后显示一次，可在 WebUI 复制或下载。
- 普通备份不包含管理员 TOTP Secret、恢复码、管理员密码哈希或管理会话。
- 不要直接更换 `ACCOUNT_CREDENTIAL_SECRET`；它同时保护 Vault、账号凭证和 TOTP Secret。

如果验证器和恢复码同时丢失，只能在服务器或容器本地恢复。恢复命令要求当前管理员登录凭据和固定确认值，且会撤销全部管理会话：

```bash
docker compose stop metapi
export METAPI_ADMIN_RECOVERY_CREDENTIAL='your-current-admin-credential'
export METAPI_ADMIN_TOTP_RESET_CONFIRM='disable-totp'
docker compose run --rm \
  -e METAPI_ADMIN_RECOVERY_CREDENTIAL \
  -e METAPI_ADMIN_TOTP_RESET_CONFIRM \
  metapi npm run admin:reset-totp
unset METAPI_ADMIN_RECOVERY_CREDENTIAL METAPI_ADMIN_TOTP_RESET_CONFIRM
docker compose up -d
```

源码开发环境使用同样两个环境变量执行 `npm run admin:reset-totp:dev`。项目不提供远程 TOTP 绕过端点。

---

## 环境变量配置

### 1. 启动与部署级

这类配置要么属于进程启动参数，要么属于当前确实没有 UI 的部署项：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务监听端口 | `4000` |
| `DATA_DIR` | 数据目录（SQLite 数据库存储位置） | `./data` |
| `TZ` | 时区 | `Asia/Shanghai` |
| `ACCOUNT_CREDENTIAL_SECRET` | Vault、账号凭证及交互签名的独立根密钥 | 兼容旧部署时回退到 `AUTH_TOKEN`；生产必须显式设置 |
| `AUTH_TOKEN_HASH` | 可选 Argon2id 管理员初始化哈希 | 空 |
| `ADMIN_CREDENTIAL_BOOTSTRAP_REQUIRED` | 新数据库缺少显式管理员初始化凭据时拒绝启动；官方 Compose 已启用 | `false` |
| `ADMIN_SESSION_TTL_MS` | 管理会话有效期（毫秒） | `43200000` |
| `ADMIN_SESSION_TOUCH_INTERVAL_MS` | 会话最近访问时间写回间隔（毫秒） | `300000` |
| `ADMIN_COOKIE_SECURE` | 无法从反向代理识别 HTTPS 时强制设置安全 Cookie | `false` |
| `TRUST_PROXY` | Fastify 可信代理配置，可填 `true`、跳数、单个 IP/CIDR 或逗号分隔列表 | `false` |

### 2. OAuth 与 Provider 登录

这一节只在你需要覆盖默认 OAuth client 配置时才看。

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CODEX_CLIENT_ID` | 覆盖内置 Codex OAuth Client ID | 内置默认值 |
| `CLAUDE_CLIENT_ID` | 覆盖内置 Claude OAuth Client ID | 内置默认值 |
| `CLAUDE_CLIENT_SECRET` | 预留的 Claude OAuth Client Secret（默认留空） | 空 |
| `GEMINI_CLI_CLIENT_ID` | 覆盖内置 Gemini CLI OAuth Client ID | 内置默认值 |
| `GEMINI_CLI_CLIENT_SECRET` | 覆盖内置 Gemini CLI OAuth Client Secret | 内置默认值 |

说明：

- `Antigravity` 当前不需要额外环境变量即可启用。
- 如果你的部署环境访问 provider 受限，优先先在 UI 里配置**系统代理**。
- 如果 OAuth 页面运行在远程服务器上，还要考虑 SSH 隧道或手动回填 callback，详见 [OAuth 管理](./oauth.md)。

#### OAuth 刷新协调（高级）

这些参数用于服务器常驻或多实例部署。默认值已经适合单实例，不需要为了接入 Codex 客户端而单独配置。

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `OAUTH_REFRESH_LEASE_TTL_MS` | 单账号刷新 DB 租约 TTL | `60000` |
| `OAUTH_REFRESH_LEASE_HEARTBEAT_MS` | 刷新租约心跳间隔 | `15000` |
| `OAUTH_REFRESH_LEASE_WAIT_MS` | 在线请求等待并复用其他 worker 刷新结果的最长时间 | `10000` |
| `OAUTH_REFRESH_PROVIDER_MIN_INTERVAL_MS` | 同一 Provider 两次刷新启动之间的最小间隔 | `250` |
| `OAUTH_REFRESH_PROVIDER_DEFAULT_CONCURRENCY` | 每个 Provider 的默认刷新槽位数 | `1` |
| `OAUTH_REFRESH_PROVIDER_CONCURRENCY_JSON` | Provider 并发覆盖，例如 `{"codex":2,"claude":1}` | `{}` |
| `OAUTH_REFRESH_TRANSIENT_BACKOFF_BASE_MS` | 临时错误指数退避的基础时长 | `30000` |

刷新协调会使用数据库短租约和凭证版本 CAS，避免多个 worker 同时消费同一个 refresh token。Provider 返回 `Retry-After` 时会进入共享冷却；持久化结果不确定时账号会停止自动刷新并等待重新授权。

### 3. 上游连接与首字速度（高级）

Metapi 会为上游请求复用长连接，并在兼容时优先使用 HTTP/2。默认值适合单实例部署，修改后需要重启后端进程。

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `UPSTREAM_HTTP2_ENABLED` | 是否允许上游连接协商 HTTP/2；遇到不兼容网关时可关闭 | `true` |
| `UPSTREAM_HTTP_CONNECTIONS_PER_ORIGIN` | 每个上游 Origin 的连接池上限 | `100` |
| `UPSTREAM_HTTP_KEEP_ALIVE_TIMEOUT_MS` | 空闲连接保留时间 | `90000` |
| `UPSTREAM_HTTP_KEEP_ALIVE_MAX_TIMEOUT_MS` | 单条长连接允许保留的最长时间 | `600000` |
| `UPSTREAM_HTTP_AUTO_SELECT_FAMILY` | IPv4 / IPv6 快速选择，减少坏链路等待 | `true` |
| `UPSTREAM_HTTP_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS` | 地址族候选连接的切换等待时间 | `250` |

流式 Responses 和 Chat 请求会返回 `Server-Timing`，慢请求也会写入 `[proxy/ttft]` 结构化日志。可重点查看：

| 指标 | 含义 |
|------|------|
| `metapi_route` | 请求进入 Metapi 后，到真正发起上游请求前的路由耗时 |
| `upstream_headers` | 上游从请求发出到返回响应头的耗时 |
| `upstream_first_byte` | 上游从请求发出到返回首个响应字节的耗时 |
| `metapi_stream_start` | Metapi 收到上游首字后，到开始向客户端写流的耗时 |

如果 `upstream_first_byte` 占绝大多数，瓶颈通常在上游模型处理、超长上下文、上游排队或跨地域网络；继续增加连接数不会明显改善。Coding Agent 会话应优先使用自身的压缩/新会话能力，不建议网关静默截断或改写历史消息。

> [!WARNING]
> `PROXY_FIRST_BYTE_TIMEOUT_SEC` 是超时后切换渠道的容错策略，不是加速开关。设置过短可能在原上游仍执行时发起第二次请求，带来重复扣费或重复副作用。

历史首字调度是另一层机制：它读取真实请求积累的首字 EMA，在达到最低样本数后对慢渠道做软降权，不会触发熔断，也不会中断当前请求。运行时优先在 **路由 → 调度策略** 中维护；以下环境变量只提供首次启动或数据库尚未保存策略时的默认值：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `FIRST_BYTE_ROUTING_ENABLED` | 是否让历史首字速度参与 Token Router 调度 | `true` |
| `FIRST_BYTE_ROUTING_BASELINE_MS` | 不降权的首字 EMA 基线（毫秒） | `2500` |
| `FIRST_BYTE_ROUTING_PENALTY_WINDOW_MS` | 超过基线后的线性降权窗口（毫秒） | `10000` |
| `FIRST_BYTE_ROUTING_MAX_PENALTY_RATIO` | 最大降权比例，`0.65` 表示最低保留 `35%` 权重 | `0.65` |
| `FIRST_BYTE_ROUTING_MIN_SAMPLES` | 开始参与调度前需要的有效首字样本数 | `5` |

### 4. K3s 更新中心与 Deploy Helper

这里要分清楚两层：

- **主 Metapi 后台里的日常更新中心配置**：优先在 UI 里填
- **主服务访问 helper 的 token / helper 自己的监听参数**：仍然是环境变量

#### 主 Metapi 服务

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEPLOY_HELPER_TOKEN` | 主服务访问 Deploy Helper 的 Bearer Token | 空 |
| `UPDATE_CENTER_HELPER_TOKEN` | `DEPLOY_HELPER_TOKEN` 的兼容别名，二选一即可 | 空 |

#### Deploy Helper 服务

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `DEPLOY_HELPER_HOST` | helper 监听地址 | `0.0.0.0` |
| `DEPLOY_HELPER_PORT` | helper 监听端口 | `9850` |
| `DEPLOY_HELPER_TOKEN` | helper Bearer Token，必须和主服务一致 | 空 |

#### 更新中心里真正建议在 UI 配的字段

这些字段不建议再教用户去改 env，而是直接去：

**设置 → 更新中心**

- `helperBaseUrl`
- `namespace`
- `releaseName`
- `chartRef`
- `imageRepository`
- `githubReleasesEnabled`
- `dockerHubTagsEnabled`
- `defaultDeploySource`

完整接入步骤见 [K3s 更新中心（高级）](./k3s-update-center.md)。

### 5. 签到启动默认值（可被 UI 覆盖）

这些变量只用于服务首次启动或数据库尚未保存运行时设置时的默认值。服务启动后，优先使用 **设置 → 定时任务 → 签到执行窗口** 中保存的策略。

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CHECKIN_SCHEDULE_MODE` | `cron` 或 `interval` | `cron` |
| `CHECKIN_INTERVAL_HOURS` | 间隔模式的账号检查周期（1 到 24 小时） | `6` |
| `CHECKIN_TIME_ZONE` | 签到窗口使用的 IANA 时区，留空使用服务器时区 | 空 |
| `CHECKIN_WINDOW_START` | 自动签到窗口开始时间（`HH:mm`） | `00:00` |
| `CHECKIN_WINDOW_END` | 自动签到窗口结束时间（`HH:mm`），早于开始时间表示跨午夜 | `23:59` |
| `CHECKIN_JITTER_MINUTES` | 按账号和本地日期确定性分散的最大抖动（0 到 180 分钟） | `0` |
| `CHECKIN_CATCH_UP` | 服务错过 Cron 后是否在窗口内补签 | `true` |
| `CHECKIN_SCHEDULE_POLICY_JSON` | 以上字段的 JSON 覆盖，适合容器编排 | 空 |

自动调度只会调用站点适配器声明允许的签到操作；站点能力未知或要求人工验证时会记录 `skipped`，不会以推理请求做测活。

### 6. 当前没有 UI 的高级部署级参数

下面这些参数目前更偏部署级，仍然建议通过环境变量维护：

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `TOKEN_ROUTER_CACHE_TTL_MS` | Token 路由缓存 TTL（毫秒） | `1500` |
| `PROXY_LOG_RETENTION_DAYS` | 代理日志保留天数 | `30` |
| `PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES` | 代理日志清理任务执行间隔（分钟） | `30` |
| `MODEL_AVAILABILITY_PROBE_INTERVAL_MS` | 批量测活间隔（毫秒） | `1800000` |
| `MODEL_AVAILABILITY_PROBE_TIMEOUT_MS` | 批量测活单次探测超时（毫秒） | `15000` |
| `MODEL_AVAILABILITY_PROBE_CONCURRENCY` | 批量测活并发数 | `1` |
| `CHANNEL_RECOVERY_PROBE_ENABLED` | 是否允许渠道恢复调度器发送真实推理请求 | `false` |

注意：

- **批量测活开关本身**已经在 UI 里有了
- **渠道恢复探测默认关闭**。它会产生真实模型调用，只能在所有上游明确允许主动测活时通过环境变量开启
- 这里只剩下间隔、超时、并发这些更高级的细项还没有 UI

---

## 常见配置与入口对照

### 通常已经有 UI 的配置

- 管理员登录凭据
- 全局主密钥（下游密钥页）
- 系统代理
- 定时任务
- 路由策略
- 批量测活开关
- 安全白名单
- 通知渠道
- 下游密钥
- 数据库运行配置
- 更新中心主体配置

### 通常仍需看环境变量的配置

- 端口
- 数据目录
- 时区
- 账号凭证加密密钥
- OAuth client 覆盖
- Deploy Helper token
- helper 进程自身监听参数
- 少数高级部署级性能 / 清理参数

---

## UI 与环境变量的关系

Metapi 当前的配置关系可以概括为：

1. **环境变量负责启动默认值和部署参数**
2. **UI 负责用户日常操作和运行时调整**
3. **UI 保存后的值会持久化到当前运行数据库**
4. **大多数 UI 设置会覆盖原始默认值**

例外主要有两类：

- **纯部署级参数**：例如端口、数据目录
- **保存后需重启的配置**：例如运行数据库类型 / 连接串 / SSL

---

## 通知渠道详细说明

虽然我更推荐直接去「通知设置」页面，但为了方便查字段，这里保留一个速查表。

### Webhook

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `WEBHOOK_ENABLED` | 启用 Webhook 通知 | `true` |
| `WEBHOOK_URL` | Webhook 推送地址 | 空 |

### Bark（iOS 推送）

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `BARK_ENABLED` | 启用 Bark 推送 | `true` |
| `BARK_URL` | Bark 推送地址 | 空 |

### Server酱

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `SERVERCHAN_ENABLED` | 启用 Server酱 通知 | `true` |
| `SERVERCHAN_KEY` | Server酱 SendKey | 空 |

### Telegram Bot

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `TELEGRAM_ENABLED` | 启用 Telegram 通知 | `false` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（形如 `123456:abc`） | 空 |
| `TELEGRAM_CHAT_ID` | 接收消息的 Chat ID（如 `-100xxxx` 或 `@channel`） | 空 |

**配置步骤：**

1. **创建 Bot**：在 Telegram 中搜索 [@BotFather](https://t.me/BotFather)，发送 `/newbot`，按提示设置名称后获取 Bot Token
2. **获取 Chat ID**：
   - 个人聊天：给 Bot 发消息后，通过 `getUpdates` 或 @userinfobot / @getmyid_bot 查看 `chat.id`
   - 群组：把 Bot 拉进群并发送消息后，通过 `getUpdates` 查看群组 Chat ID
   - 频道：可直接使用 `@your_channel`（前提是 Bot 是频道管理员）
3. **填入位置**：优先去 **通知设置** 页面填写
4. **大陆服务器反代**：如果服务器不能直连 Telegram，可在 UI 里填写 `Telegram API Base URL`
5. **测试**：保存后直接点“发送测试通知”

### SMTP 邮件

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `SMTP_ENABLED` | 启用邮件通知 | `false` |
| `SMTP_HOST` | SMTP 服务器地址 | 空 |
| `SMTP_PORT` | SMTP 端口 | `587` |
| `SMTP_SECURE` | 使用 SSL/TLS | `false` |
| `SMTP_USER` | SMTP 用户名 | 空 |
| `SMTP_PASS` | SMTP 密码 | 空 |
| `SMTP_FROM` | 发件人地址 | 空 |
| `SMTP_TO` | 收件人地址 | 空 |

### 告警控制

| UI / 变量 | 说明 | 默认值 |
|--------|------|--------|
| `NOTIFY_COOLDOWN_SEC` | 相同告警冷静期（秒），防止同一事件重复通知 | `300` |
| `NOTIFY_DELIVERY_POLICY` | 投递结果不确定时的全局策略：`prefer_delivery` 继续重试（可能重复）；`prefer_no_duplicate` 停止重试（可能漏发） | `prefer_delivery` |
| `NOTIFY_OUTBOX_POLL_INTERVAL_MS` | Durable Outbox worker 轮询间隔（毫秒） | `1000` |
| `NOTIFY_OUTBOX_LEASE_TTL_MS` | 单条 Outbox 投递 lease 有效期（毫秒） | `30000` |
| `NOTIFY_OUTBOX_RETRY_BASE_MS` | 已知失败和可重试未知结果的指数退避起始值（毫秒） | `5000` |
| `NOTIFY_OUTBOX_RETRY_MAX_MS` | 指数退避最大间隔（毫秒） | `900000` |
| `NOTIFY_OUTBOX_RETENTION_DAYS` | 已投递/已停止重试记录保留天数 | `30` |

---

## 站点公告

管理后台新增了「站点公告」页面，用于保存和浏览 Metapi 已同步到本地的上游公告记录。

- 首次发现的上游公告会写入站内通知，并按现有通知渠道外发一次
- 后续重复同步只更新本地公告记录，不会重复外发同一条公告
- 当前支持的上游公告来源包括 `new-api`、`done-hub` 与 `sub2api`
- 「清空公告」只删除 Metapi 本地保存的公告记录，不会修改上游站点数据

## 更新提醒

更新中心现在会在后台定时检查 GitHub Releases / Docker Hub 的可部署候选，并把结果保存为本地运行时状态。

- 首次发现新的版本候选或新的 Docker digest 时，会写入站内通知，并按现有通知渠道外发一次
- 相同候选后续重复检查只更新本地运行时状态，不会重复外发同一条提醒
- 这类提醒不会自动触发部署，只是把用户带到「设置 → 更新中心」继续手动确认和执行
- K3s 用户可以在收到提醒后直接去更新中心部署；Compose 用户也可以收到提醒，但仍按自己的升级方式处理

## 下一步

- [部署指南](./deployment.md) — Docker Compose 与反向代理
- [K3s 更新中心（高级）](./k3s-update-center.md) — K3s / Helm 用户的后台升级入口
- [客户端接入](./client-integration.md) — 对接下游应用
- [上游接入](./upstream-integration.md) — 添加和管理上游平台
- [OAuth 管理](./oauth.md) — 授权 Codex / Claude / Gemini CLI / Antigravity
- [运维手册](./operations.md) — 备份、日志与健康检查
