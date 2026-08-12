# Local Connector 协议

Local Connector 是本项目的本地优先控制面协议。服务器负责配对、权限、动作队列和审计；本机 Connector 负责在用户设备上读写 Codex/Claude Code 的 Hook、Notify 和 App Server 配置。服务器不执行任意 shell，也不接管 Coding Agent 登录。

## 配对

1. 管理员通过 `POST /api/local-connector/pairings` 创建一次性配对。
2. 本机向公开的 `POST /api/local-connector/public/pairings/claim` 提交 `pairingId + pairingToken + platform`。
3. 服务器只返回一次 `lc_*` Connector 令牌；数据库只保存令牌哈希。
4. 管理员可以通过 `POST /api/local-connector/devices/:id/revoke` 立即撤销设备。撤销会取消该设备所有未完成动作。

配对权限是固定枚举，不接受任意权限字符串：`hooks.manage`、`hooks.emit`、`notify.manage`、`notify.emit`、`browser.recovery`、`app_server.observe`、`app_server.control`。观察与控制是两个独立权限；只有观察权限的设备不能领取续跑命令。

## 本机参考实现

Connector 使用独立 npm 包 `metapi-connector` 发布，不发布整个 Metapi 服务仓库。Node.js 25 或更高版本可全局安装：

```bash
npm install --global metapi-connector
metapi-connector --version
metapi-connector --help
```

仓库开发环境可用 `npm run connector:dev -- --help`。维护者使用 `npm run connector:pack` 生成本地 tarball 并检查内容，确认后再执行 `npm run connector:publish`；两条命令都会先构建服务端，再只复制 `dist/server/local-connector` 到独立发布目录。禁止直接在仓库根目录执行 `npm publish`，否则会把服务端、WebUI 与本地开发产物混入 CLI 包。

```bash
metapi-connector pair \
  --server https://gateway.example.com \
  --pairing-id '<WebUI 生成的 pairingId>' \
  --pairing-token '<WebUI 只显示一次的 pairingToken>'

metapi-connector install-service \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --connector-launchd-label com.metapi.localconnector.example
```

`install-service` 是 macOS 默认推荐路径。它从独立安装的 `metapi-connector` npm 包生成并管理两个 LaunchAgent：Connector 以 `--direct` 方式连接官方 managed App Server；配置 watcher 监控 `auth.json` 和 `config.toml`，配置变化后重载 App Server，再让 Connector 恢复接管、通知和飞书 Prompt 链路。Connector 与 Codex Desktop 因而连接同一个 Thread Manager 和 writer，线上指令进入 Desktop 可见的原会话。`--control-app-server` 仅作为旧脚本兼容别名保留，不表示第二套产品架构。

安装器把 Node、Connector CLI、配置、Codex executable 与 socket 全部写为绝对路径，不写仓库工作目录。原 plist 会备份到 Connector 数据目录下的 `service-backups/<timestamp>/`；新 plist 在停止旧服务前先通过 `plutil` 校验，`launchctl bootstrap` 对 macOS 偶发的 I/O error 做有限重试。升级失败时恢复旧 plist 并重新加载旧服务。安装器拒绝根仓库 `dist` 入口，避免常驻服务再次绑定临时 checkout。

安装命令会等待并检查完整链路。也可以随时执行以下命令复查并打开看板：

```bash
metapi-connector doctor
metapi-connector dashboard --open
```

`doctor` 依次检查本地进程与 PID 一致性、launchd、当前 CLI 与常驻进程版本、本地看板、App Server 控制连接、会话快照上报和线上心跳；只有会话接管所需的检查全部通过才返回退出码 `0`。`status` 输出同一组 JSON 证据但不把链路归约成单个结论：`cliVersion` 与 `runtimeVersion` 用于识别“命令已升级、LaunchAgent 仍在运行旧入口”，`remote.reachable` 表示线上设备心跳是否可达，`local.running` 表示本机 Connector 进程是否真实存活，`dashboard.snapshot` 提供 App Server、会话数量、等待交互和本地积压。状态查询只验证线上令牌与连通性，不会用查询命令自身的版本或 capabilities 覆盖运行中 Connector 的设备元数据。

`connector.lock` 是本地唯一真相源；`connector.pid` 仅为旧脚本保留，并在每次启动时自动同步到锁中的 PID。使用 launchd 时可显式校验服务状态：

```bash
metapi-connector status \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --connector-launchd-label com.metapi.localconnector.example
```

输出中的 `local.launchd.pid`、`local.pid` 与 `local.pidFilePid` 应一致。线上暂时不可达时，命令仍返回本地运行态，并在 `remote.error` 说明网络或认证错误。所有命令都有独立帮助，例如 `metapi-connector run --help` 和 `metapi-connector doctor --help`，不需要先读取本机配置。

## 本地运行看板

常驻 `metapi-connector run --direct` 会同时启动独立的 local-first 看板，首选地址为 `http://127.0.0.1:4765/`；如果端口被占用，会选择后续可用端口。运行实例把最终端口、URL、PID 与健康接口原子写入数据目录内权限为 `0600` 的 `connector.dashboard.json`，正常停止时删除；新实例持有独占运行锁后会先清理崩溃遗留的旧 discovery。`metapi-connector dashboard` 会校验 discovery PID、探测 `/healthz` 和 `/api/status` 后输出实际地址，因此脚本和快捷方式不应假定端口永远是 4765。看板数据直接来自 Connector 进程与本地耐久队列，不依赖管理控制台页面：

- Connector 到 Metapi 的连通状态、连续失败次数和当前动作；
- Codex App Server 连接模式、正在运行的 Thread、活动 Turn 和等待标记；
- App Server 审批、用户输入和 MCP elicitation 的本机 pending 状态；
- 普通事件、动作结果、Bridge 事件和 Bridge 结果的离线积压；
- 最近的 Connector、Bridge、Interaction 和 App Server 生命周期事件。

控制模式会调用 Connector 所连接 App Server 的 `thread/list` 补全会话名称和工作目录，再用实时生命周期事件更新运行状态。推荐让 Codex Desktop 和 Connector 同时连接官方 managed local App Server daemon；两者共享同一个 Thread Manager 和 writer，因此飞书或 WebUI Prompt 会进入 Desktop 当前会话，而不是由 Connector 启动第二个 App Server。rollout 观察器仍只解析事件类型、Thread/Turn ID 和时间戳，不解析或展示 Prompt、模型输出、Diff 正文、命令及命令输出。

若 Desktop 尚未切换到 managed daemon，看板会把它识别为 `Codex Desktop · 外部持有`，Connector 只能观察，不能接管该 writer。完成 daemon 配置并重启 Desktop 后，会话会变为同一 App Server 下的可控制状态。观察与接管保持为两个独立能力。

默认只监听本机回环地址。需要在同一局域网的手机查看时，显式监听所有网卡：

```bash
metapi-connector run --direct --dashboard-host 0.0.0.0
```

此时 Connector 会为看板生成随机访问令牌，并打印包含 `?token=...` 的桌面与局域网地址；discovery 文件中的健康和状态 URL 也携带同一令牌。可用 `--dashboard-port 4765` 指定首选端口，或用 `--no-dashboard` 关闭看板。使用 `--no-dashboard` 时 `doctor` 会明确判定会话接管链路未就绪，因为它无法读取本机 App Server 和会话快照状态。

WebUI 的 Local Connector 页面会生成完整配对命令。远端服务器必须使用 HTTPS；只有 `localhost`、`127.0.0.1` 和 `::1` 可以使用 HTTP。配对后设备令牌和本地备份密钥保存在独立 Connector 配置文件中，文件权限为 `0600`，不使用系统 Keychain。

## 动作队列

管理员通过 `POST /api/local-connector/actions` 创建 `hook` 或 `notify` 的 `install`、`backup`、`rollback`、`uninstall` 动作。本地 Connector 使用设备令牌领取：

- `GET /api/local-connector/public/commands/next`
- `POST /api/local-connector/public/commands/:id/result`

动作清单使用 `metapi.local-connector.action.v1` 固定协议。安装和卸载动作标记 `requiresBackup=true`；回滚必须携带 Connector 之前产生的 `backupRef`。动作结果只保存受限大小的 JSON 元数据，不保存任意脚本正文。

本机驱动只会操作固定目标：Codex 的 `$CODEX_HOME/hooks.json` / `$CODEX_HOME/config.toml`，以及 Claude Code 的 `$CLAUDE_CONFIG_DIR/settings.json`。服务端不能下发文件路径、executable、argv 或 shell。每次安装/卸载前都创建 AES-256-GCM 本地加密备份；`backupRef` 只是不透明引用，备份正文不会上传服务器。写入使用同目录临时文件和原子替换，回滚会验证 Agent、动作类型和目标路径全部匹配。

## Hook / Notify 事件

安装后的 Connector 可以调用 `POST /api/local-connector/public/events`。`notify` 事件进入现有 Durable Notification Outbox，并使用 Connector 设备与幂等键组成通知幂等键；`hook`、`app_server` 和 `browser_recovery` 事件先写入程序事件审计。浏览器凭证采集继续复用现有一次性任务令牌协议。

浏览器凭证扩展是独立的协议客户端，不需要 Connector 设备令牌。构建和加载方式、按 Origin 请求权限以及字段采集策略见 [浏览器凭证扩展](./browser-extension.md)。扩展只领取一次性浏览器凭证任务并回传适配器声明字段；真实托管浏览器仍由 P2 Managed Browser 承接。

Hook/Notify 命令不直接等待网络：它先把规范化事件写入本地耐久队列，常驻 `metapi-connector run` 再按顺序投递。动作结果也先落本地队列，并优先于普通事件回报；服务器暂时不可达时不会继续领取新动作。

## App Server Bridge 续跑

具备 `app_server.control` 权限的 Connector 可以领取 Bridge 续跑命令：

- `GET /api/local-connector/public/bridge/commands/next`
- `POST /api/local-connector/public/bridge/commands/:id/heartbeat`
- `POST /api/local-connector/public/bridge/commands/:id/result`
- `POST /api/local-connector/public/bridge/commands/:id/events`

命令使用固定的 `metapi.bridge-continuation.command.v1` 协议，只允许 `turn/start`、`turn/steer`、目标 Thread、文本 Prompt、续跑序号以及 `preserve`、`rotate_credential`、`switch_channel` 三种网关路由动作。`turn/steer` 必须携带 `expectedTurnId` 且只能保持当前路由；Connector 不接收任意 executable、argv、cwd 或 shell 内容。WebUI 从 Local Connector 设备进入“会话接管”，只展示该设备实际观测到的 Thread。接管入口会再次校验设备状态、`app_server.control` 权限和 Thread 归属，再创建或复用稳定的 Bridge 会话上下文。

人工 Prompt 继续复用 Bridge 的单会话 `active_slot`、租约和命令结果协议，不存在第二套会话控制状态机。WebUI 支持三种提交模式：`auto` 根据当前 Thread/Turn 状态选择 `turn/steer` 或 `turn/start`，`steer_current` 等待交互阻塞清除后补充预期活动 Turn，`start_next` 等待活动 Turn 完成后开始下一 Turn。新人工 Prompt 会在同一事务中 supersede 当前自动或人工任务；若旧任务的命令已经被领取，旧租约会保留到结果或过期对账完成，新 Prompt 先等待权威 App Server 事件，不会并发派发。

管理员入口为 `POST /api/bridge-continuations/manual-prompts`，要求稳定的 `Idempotency-Key`。Prompt 明文只存在于待派发任务的 `pending_prompt`；Connector 接受派发后即清除，任务与事件审计只保留 SHA-256 指纹和操作者元数据。派发结果不确定或租约过期时进入 `dispatch_outcome_unknown`，不会自动重发 Prompt。

```bash
codex app-server daemon start
export CODEX_APP_SERVER_USE_LOCAL_DAEMON=1
metapi-connector run --direct
```

环境变量需要在 Codex Desktop 启动前生效；首次配置后重启一次 Desktop。`--direct` 通过 control socket 的 WebSocket 协议连接 managed daemon。若使用 launchd 启动 Connector，可把 `--direct` 写入 `ProgramArguments`，并为用户会话持久化 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`。

首次安装或 npm 升级后，重复执行同一条幂等命令即可同步两个 LaunchAgent 的包路径并完成健康验证：

```bash
metapi-connector install-service \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --connector-launchd-label com.metapi.localconnector.example

metapi-connector status \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --connector-launchd-label com.metapi.localconnector.example

metapi-connector doctor \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --connector-launchd-label com.metapi.localconnector.example

metapi-connector dashboard \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --open
```

升级 Connector 时先运行 `npm install --global metapi-connector@latest`，再重复 `install-service`。无需退出 Codex Desktop。卸载常驻服务使用 `uninstall-service`；它只停止并删除 Connector 与 watcher plist，不删除配对配置、本地备份或耐久队列，也不停止 Codex App Server：

```bash
metapi-connector uninstall-service \
  --connector-launchd-label com.metapi.localconnector.example
```

managed daemon 是独立于 Desktop 的长驻进程。仅退出并重新打开 Desktop 不会强制 daemon 重新读取 `auth.json` 或 `config.toml`。如果本机存在切换 API Key、模型提供方或其他 Codex 配置的工作流，应在配置文件变化后执行：

```bash
metapi-connector reload-codex-runtime \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --codex-executable "$HOME/.codex/packages/standalone/current/codex" \
  --connector-launchd-label com.metapi.localconnector.example \
  --app-server-socket "$HOME/.codex/app-server-control/app-server-control.sock"
```

该命令优先调用官方 `codex app-server daemon restart`。如果 Desktop 曾经直接占用了同一个 control socket，官方命令会报告 App Server 未由 daemon 管理；Connector 会先用 `lsof`/`ps` 确认 socket owner 确实是 Codex App Server，安全终止这个非 daemon 进程，再调用 `codex app-server daemon start` 建立唯一 managed owner。之后等待 control socket 恢复、重启 Connector LaunchAgent，并通过配置目录中的 dashboard discovery 验证实际端口和运行版本。无法确认 owner 时不会杀进程，也不会继续重启 Connector。`--connector-health-url` 仍可供不使用 discovery 的独立脚本显式指定固定地址。`install-service` 默认托管以下等价的指纹 watcher：

```bash
metapi-connector watch-codex-runtime \
  --config "$HOME/.config/metapi/deployments/example/config.json" \
  --codex-home "$HOME/.codex" \
  --codex-executable "$HOME/.codex/packages/standalone/current/codex" \
  --connector-launchd-label com.metapi.localconnector.example \
  --app-server-socket "$HOME/.codex/app-server-control/app-server-control.sock"
```

Watcher 每秒读取 `auth.json` 与 `config.toml` 的 SHA-256 指纹。首次启动只建立基线，不重启；指纹变化后等待原子写入稳定，再执行 daemon 与 Connector 重载。这里不使用 launchd `WatchPaths`，因为该机制可能遗漏文件事件，也可能在原子替换尚未完成时触发。

飞书长连接位于在线服务，不会因本机 daemon 重启而中断；Bridge Prompt 和通知使用耐久队列，Connector 恢复后继续处理。配置变更会重启 App Server，可能中断正在执行的 Turn，因此应在 Turn 之间切换配置。

Bridge 命令结果和结构化 App Server 事件也先写入本机 `0600` 文件队列。结果优先于事件投递，每条记录携带稳定的 `deliveryId`；只有服务器确认后才删除本地文件。服务器把 `deliveryId` 写入 Bridge 事件审计并施加唯一约束，因此网络中断、HTTP 响应丢失或 Connector 重启后的重放不会重复推进状态。服务启动时会立即恢复过期租约，之后以单飞 worker 周期扫描；派发是否成功无法确定时任务进入 `dispatch_outcome_unknown`，不会盲目重复开始下一 Turn。

可选的 App Server 观察只转发 Thread/Turn/Item ID、状态和生命周期方法，不上传输出 delta、diff 正文或用户 Prompt。连接已有本机 control socket：

```bash
metapi-connector run --observe-app-server
```

Connector 通过所连接 App Server 观察到的 Codex Thread 会写入服务器侧“已观察会话”索引，只保留设备、Thread ID、状态、等待标记和最后活跃时间，不保存 Prompt 或输出内容。Codex Desktop overlay 也会同步隐私安全的会话元数据：Thread ID、状态、活动 Turn ID、观测时间、`observationSource=codex_desktop` 和 `controlState=external_owner`；不会上传工作目录、标题、Prompt、模型输出、Diff、命令或命令输出。服务端以收到快照的时间作为最后观测时间，客户端事件时间仅用于本地展示。

管理控制台以 `deviceId + threadId` 为唯一会话单位。会话工作台的“当前会话活动”通过 `GET /api/local-connector/devices/:deviceId/sessions/:threadId/activity` 只读聚合现有真相源，不创建第二套状态：Bridge 任务与事件、Interaction Request 与回执、飞书 Prompt Card、卡片 Dispatch/Update、话题绑定，以及完成通知 Outbox。每条活动保留来源类别、状态、时间、引用 ID 和失败摘要；技术元数据默认折叠。普通页面不再要求管理员到多个功能页拼接同一会话的链路。

完成通知 Outbox 目前沿用稳定的消息契约，通过 `线程 ID：<threadId>` 与会话关联；Bridge、Interaction、飞书卡片和话题绑定则使用结构化的 `device_id` / `thread_id` 外键字段。聚合逻辑封装在 `localConnectorThreadActivityService`，未来为 Outbox 增加结构化 Thread 字段时无需修改 WebUI。

观察权与控制权保持分离。`external_owner` 会话会出现在本地和线上看板中，但管理控制台禁用接管，飞书主动 Prompt 也不能选择或操作该会话，避免 Connector 对另一个 App Server 持有的 writer 发起 `turn/start` 或 `turn/steer`。Desktop 切换到同一 managed daemon 后，下一次快照会从共享控制连接返回权威状态。管理台不允许用手填 Thread 绕过 Connector 会话归属和控制权校验。

也可以显式启动隔离的 owned App Server；执行参数固定为 `<executable> app-server`，并始终使用 `shell=false`。该模式适合 Connector 自有会话，不能把 Prompt 注入另一个 Codex Desktop App Server 已持有的会话：

```bash
metapi-connector run --observe-app-server --owned-app-server /absolute/path/to/codex
```

## App Server Interaction 与飞书

Connector 会把 App Server 的命令审批、文件变更审批、权限审批、用户输入和 MCP elicitation 归一化为耐久 Interaction Request。每个请求保留原始参数、连接 ID、Thread/Turn/Item ID 和到期时间；管理员从 Local Connector 设备进入“交互与飞书”处理，Connector 再领取响应并调用原始 in-memory responder。`serverRequest/resolved` 使用稳定 `deliveryId` 回传，网络重放不会重复推进状态。

“交互与飞书”页面同时管理当前 Connector 的飞书 Interaction Adapter：App ID、接收目标、控制台公开 URL、操作者白名单和回调 URL。每个 Adapter 必须归属一个 active 且具备 `app_server.control` 权限的 Connector，只会投递该设备产生的 Interaction；旧的未归属 Adapter 不参与自动投递。App Secret 与 Verification Token 存入独立 Credential Vault，编辑时不会回显；秘密输入留空表示保持当前版本。

飞书卡片投递与普通 Notification Outbox 分离。已知失败按 Retry-After/指数退避重试；请求已发出但结果不确定时进入 `delivery_unknown`，不会自动再发卡片，管理员确认可能重复后才能重新入队。卡片动作使用有签名、会过期、只能消费一次的票据，并在同一数据库事务中提交 Interaction Response。白名单拒绝、失效票据和过期请求会返回卡片内提示，同时用成功 HTTP 状态确认回调，避免飞书重复投递同一动作。

Interaction 卡片还包含人工 Prompt 表单，可选择“补充当前轮”或“下一轮发送”。Prompt 动作使用独立票据，不会取消同卡片上的审批票据；飞书标准回调从 `event.action.form_value` 读取表单值。服务端只在 Bridge 待派发状态保存 Prompt 明文，飞书票据和回调事件元数据不保存正文。

管理控制台还可以主动发送不依赖 Interaction Request 的飞书 Prompt Card。管理员在当前 Connector 下选择 Adapter 和已观测的 Bridge/Thread 会话，并设置 5 分钟至 24 小时有效期；服务端会校验 Adapter 与会话属于同一设备。卡片内由飞书操作者输入 Prompt 和选择“补充当前轮/下一轮发送”。卡片本身只保存会话上下文、TTL、请求指纹和消费结果，Prompt 明文不写入卡片、Action Ticket 或回调审计。

主动 Prompt Card 与 Interaction 卡片共用同一套 Dispatch/Ticket 投递引擎，因此继续遵守 Retry-After、指数退避、租约恢复和 `delivery_unknown` 人工确认规则。两个提交按钮共享卡片 Subject 的 Bridge 幂等键；第一个成功消费后会记录生成的 Bridge Task 并取消另一个票据，同一会话仍由 Bridge 的单活跃槽保证只有一个控制任务。

首次发卡成功后，原始 Dispatch 保持为 `delivered`，后续状态回写由独立的 `interaction_card_updates` 作业处理。Interaction 进入 `response_pending` 时会立即关闭剩余 Action Ticket，并把原卡片 PATCH 为“已提交、等待 Connector”；之后进入 `resolved` 时会生成新的全卡片指纹并再次 PATCH。Interaction 的 `cancelled` / `expired`，以及主动 Prompt Card 的 `consumed` / `cancelled` / `expired` 也会换成不含按钮和表单的只读卡片。

卡片更新使用飞书 `PATCH /open-apis/im/v1/messages/:message_id`，只在原消息送达后的 14 天窗口内执行。已知失败继续服从 `Retry-After` 和指数退避；网络中断导致 PATCH 结果不确定时进入独立的 `delivery_unknown`，不会自动重放，管理员可在投递记录或主动 Prompt 卡片列表中确认重试。更新作业按 Dispatch 串行化，较新的 Subject 状态会 supersede 尚未发送的旧状态，避免旧卡片覆盖新卡片。

飞书后台需要把事件回调地址设置为 WebUI 展示的公开 URL，并配置相同的 Verification Token。管理台可选填写 Encrypt Key；该密钥和 App Secret、Verification Token 一样只存入独立 Vault，编辑时留空表示保持原版本。配置 Encrypt Key 后，回调入口会使用原始 HTTP JSON 正文和 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce`、`X-Lark-Signature` 验证 SHA-256 签名，再以 Encrypt Key 的 SHA-256 摘要作为 AES-256-CBC key、密文前 16 字节作为 IV 解密正文。签名失败发生在解密、票据查询和状态提交之前；密钥轮换会撤销旧 Vault 版本。

首次 URL 校验的明文 `url_verification` challenge 仅校验 Verification Token，不要求签名请求头；实际卡片交互回调仍必须通过签名校验。

## 安全约束

- 公共 Connector 路由不使用管理员令牌，但每个请求都要求设备令牌。
- 设备令牌、配对令牌只存哈希；配对领取是一次性的。
- 设备权限在动作创建和事件提交时再次检查，不能靠客户端自报权限。
- Factory Reset 会清除设备、配对和动作队列。
- Connector 实现必须使用固定 executable/argv、无 `shell:true` 的执行器；本协议只传声明式动作，不传 shell 命令。
