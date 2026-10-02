# 发布验收矩阵

本文用于 r-api 发布前的统一验收。它覆盖协议、传输、凭证、路由、故障恢复、安全策略、Local Connector 与备份恢复，目标是让每次发布都能给出可追溯的“通过 / 不通过”结论，而不是只完成零散冒烟。

## 文档信息

| 字段 | 填写内容 |
|------|----------|
| 矩阵建立日期 | `2026-08-18` |
| 发布版本 | `待填写` |
| 构建或 Commit | `待填写` |
| 验收环境 | `待填写` |
| 验收负责人 | `待填写` |
| 开始 / 完成时间 | `待填写` |
| 最终结论 | `待验收` |

结果只使用：`待验收`、`通过`、`失败`、`阻塞`、`不适用`。标记为“不适用”时必须填写原因。

## 发布门禁

| 级别 | 含义 | 发布要求 |
|------|------|----------|
| P0 | 核心请求、安全边界、故障恢复或数据恢复 | 必须全部通过，不接受带病发布 |
| P1 | 重要兼容性、可观测性和管理能力 | 必须通过；例外需记录负责人、影响和到期时间 |
| P2 | 体验、长稳或低频边界 | 可带已知问题发布，但必须有跟踪项 |

发布同时满足以下条件才可判定为通过：

1. 所有 P0 用例通过，且没有未关闭的严重数据一致性、安全或重复计费问题。
2. 关键组合覆盖表全部通过；不支持的组合已明确标记为“不适用”。
3. 自动化回归通过，人工验收留下请求 ID、代理日志、运行账本或 CLI 输出。
4. 任一失败都能从下游请求定位到 Route、Channel、Endpoint 和失败分类。
5. 备份恢复已在独立数据目录或独立实例验证，不能只验证“导出成功”。

## 验收环境

建议准备以下固定夹具，避免每次发布临时拼装环境：

| 夹具 | 最低要求 |
|------|----------|
| 上游 Endpoint | 同一站点至少两个 Endpoint：一个健康，一个可控制返回 401 / 429 / 5xx、超时或断流 |
| Route 候选 | 同一模型至少两个站点、三个 Channel，可分别控制健康、冷却、熔断和恢复 |
| 凭证 | 可用 OAuth、即将过期 OAuth、普通账号会话、直连 API Key 各一组 |
| 下游 Key | 无限制、模型受限、站点/凭证受限、额度耗尽、并发上限为 1 各一把 |
| 流式客户端 | 可记录完整 SSE 事件、断开连接，并校验最终事件和 usage |
| WebSocket 客户端 | 可记录握手头、连续多轮消息、异常断开和服务端关闭码 |
| 文件素材 | 小型 PDF、Markdown、PNG、图片编辑源图与蒙版，以及视频生成素材 |
| Connector | 已安装 CLI 的测试设备，允许断网、重启和重新配对 |
| 备份实例 | 一套有 Route、Endpoint、凭证、下游 Key 和设置的源实例，以及空白目标实例 |

证据统一保存：请求 ID、时间、下游路径、模型、命中的 Route / Channel / Endpoint、HTTP 状态或流终态、代理请求账本、相关告警。仅 UI 特有流程需要浏览器验收，其余优先使用 API、CLI 和自动化测试。

## 关键组合覆盖

这些组合是发布最小覆盖集。单项功能通过但组合失败时，发布仍不通过。

| ID | 协议 / 能力 | 凭证 | 传输 | 路由与故障条件 | 级别 | 结果 | 证据 |
|----|-------------|------|------|----------------|------|------|------|
| COV-01 | OpenAI Chat | 普通账号 | SSE | 权重随机；首 Endpoint 5xx 后同站切换 | P0 | 待验收 | 待填写 |
| COV-02 | OpenAI Responses | Codex OAuth | SSE | 稳定优先；Session 粘性；主候选恢复 | P0 | 待验收 | 待填写 |
| COV-03 | OpenAI Responses | Codex OAuth | WebSocket | Session 粘性；并发上限；异常断线 | P0 | 待验收 | 待填写 |
| COV-04 | Claude Messages | Claude OAuth 或 Claude API Key | SSE | 手动顺序；首凭证失败后切下一候选 | P0 | 待验收 | 待填写 |
| COV-05 | Gemini | Gemini CLI OAuth 或 Gemini API Key | SSE | 轮询；Endpoint Failover | P0 | 待验收 | 待填写 |
| COV-06 | Files / Images / Videos | 直连 API Key | HTTP / Multipart | 受限下游 Key；Channel Failover | P0 | 待验收 | 待填写 |
| COV-07 | 全协议核心文本请求 | 任一可用凭证 | HTTP / SSE | 四种 Route 策略下全候选熔断快速失败 | P0 | 待验收 | 待填写 |
| COV-08 | 发布后核心冒烟 | 从备份恢复的凭证 | HTTP / SSE | 恢复 Route、Endpoint 和下游策略后调用 | P0 | 待验收 | 待填写 |

## 协议与传输

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| PRO-01 | OpenAI Chat 非流式 | 调用 `POST /v1/chat/completions`，包含 system、user、tool call | 返回 OpenAI Chat 结构；角色、tool call、finish reason、usage 无丢失 | P0 | 待验收 | 待填写 |
| PRO-02 | OpenAI Chat SSE | `stream=true`，记录所有 chunk | 首字节、delta、终止 chunk 和 `[DONE]` 顺序正确；usage 与日志一致 | P0 | 待验收 | 待填写 |
| PRO-03 | OpenAI Responses 非流式 | 调用 `POST /v1/responses`，包含多类型 input 和工具 | output item、状态、usage、response ID 正确，协议转换不泄漏上游私有字段 | P0 | 待验收 | 待填写 |
| PRO-04 | OpenAI Responses SSE | 流式调用并记录完整事件 | `response.created` 到终态事件顺序合法；只出现一个终态；最终聚合结果完整 | P0 | 待验收 | 待填写 |
| PRO-05 | Claude Messages 非流式 | 调用 `POST /v1/messages`，包含 system、content block、tool use | Claude Messages 结构、stop reason、usage 正确；OpenAI / Claude 转换语义一致 | P0 | 待验收 | 待填写 |
| PRO-06 | Claude Messages SSE | 流式调用，包含文本和工具事件 | message、content block、delta、stop 事件顺序合法，最终内容可聚合 | P0 | 待验收 | 待填写 |
| PRO-07 | Claude Count Tokens | 调用 `POST /v1/messages/count_tokens` | 返回合法 token 计数；认证和模型策略与 Messages 一致 | P1 | 待验收 | 待填写 |
| PRO-08 | Gemini 非流式 | 调用 Gemini `generateContent` 兼容入口，包含文本和工具 | candidates、parts、finish reason、usage metadata 正确 | P0 | 待验收 | 待填写 |
| PRO-09 | Gemini 流式 | 调用流式 Gemini 入口 | SSE chunk 可顺序聚合；思考签名、工具和 usage 不丢失 | P0 | 待验收 | 待填写 |
| SSE-01 | 下游主动断开 | 首个 delta 后关闭连接 | 上游请求被终止或回收；并发租约释放；不记成功、不重复计费 | P0 | 待验收 | 待填写 |
| SSE-02 | 空流 / 仅 DONE | 上游返回空 SSE 或只有终止标记 | 被识别为无有效输出并按重试策略处理，不伪装为成功 | P0 | 待验收 | 待填写 |
| SSE-03 | 中途断流 | 输出部分 delta 后断开 | 已提交请求不进行不安全重放；账本标记实际 commit state 和终态 | P0 | 待验收 | 待填写 |
| WS-01 | WebSocket 握手与鉴权 | 使用有效、无效、禁用和过期下游 Key 连接 Responses WebSocket | 有效 Key 升级成功；无效 Key 在升级阶段拒绝；不泄漏管理接口权限 | P0 | 待验收 | 待填写 |
| WS-02 | WebSocket 多轮会话 | 同一连接连续发送三轮，包含增量 input / previous response | 每轮只有一个终态；会话上下文连续；响应不会串轮 | P0 | 待验收 | 待填写 |
| WS-03 | WebSocket 每轮重新授权 | 建连后禁用或轮换下游 Key，再发下一轮 | 下一轮立即拒绝，不能沿用建连时的过期权限快照 | P0 | 待验收 | 待填写 |
| WS-04 | WebSocket 异常断线 | 请求已发送后关闭客户端或上游连接 | 不盲目重放未知结果；Session 和并发租约释放；账本标记 `unknown` 或真实失败 | P0 | 待验收 | 待填写 |

## Files、Images 与 Videos

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| FIV-01 | Files 生命周期 | 上传、列举、读取元信息、读取内容、删除同一文件 | `POST/GET/DELETE /v1/files` 链路完整；内容、MIME、文件名和权限正确 | P0 | 待验收 | 待填写 |
| FIV-02 | 文件进入对话 | 在 Chat / Responses 中引用 PDF、Markdown、JSON 或图片文件 | 本地文件引用被正确解析并按上游能力内联或转发；不支持类型明确拒绝 | P0 | 待验收 | 待填写 |
| FIV-03 | 图片生成 | 调用 `POST /v1/images/generations`，覆盖 URL / base64 响应 | 输出格式、数量、模型映射、日志和计费正确 | P0 | 待验收 | 待填写 |
| FIV-04 | 图片编辑 | Multipart 调用 `POST /v1/images/edits`，包含 image 和 mask | 文件字段未损坏；模型覆盖正确；失败可切换 Endpoint / Channel | P0 | 待验收 | 待填写 |
| FIV-05 | 图片不支持能力 | 调用明确不支持的 variation 或错误素材 | 返回稳定、可理解的 4xx，不伪造成功或错误重试 | P1 | 待验收 | 待填写 |
| FIV-06 | 视频任务生命周期 | `POST /v1/videos` 创建，轮询 `GET /v1/videos/:id`，最后删除 | 对外 public ID 稳定；上游 ID 不泄漏；状态刷新和删除映射正确 | P0 | 待验收 | 待填写 |
| FIV-07 | 视频 Endpoint Failover | 创建或轮询时令首 Endpoint 返回可重试错误 | 同站 Endpoint 切换后 public ID 仍稳定；错误分类、日志和状态快照正确 | P0 | 待验收 | 待填写 |

## 凭证与刷新

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| AUTH-01 | OAuth 授权 | 分别完成 Codex、Claude、Gemini CLI 当前支持的浏览器或手动回调流程 | state / callback 校验有效；凭证入库；初次模型发现失败时账号仍可诊断和恢复 | P0 | 待验收 | 待填写 |
| AUTH-02 | OAuth 主动刷新 | 使用即将过期凭证触发调度器刷新 | 到期前刷新成功；新 token 生效；旧秘密不出现在日志、响应或事件中 | P0 | 待验收 | 待填写 |
| AUTH-03 | 401 后刷新与单飞 | 并发请求命中过期 token，上游返回 401 | 同一凭证只执行一次刷新；等待请求复用结果；没有刷新风暴 | P0 | 待验收 | 待填写 |
| AUTH-04 | 刷新失败后的路由 | 令 refresh token 失效或 OAuth 端点不可达 | 凭证进入正确健康状态；当前请求按安全重试规则处理；后续请求切换健康候选 | P0 | 待验收 | 待填写 |
| AUTH-05 | 普通账号 | 使用面板账号会话完成模型同步和代理请求，再使会话过期 | 有效会话可调用；过期会话型候选被排除；错误原因可见 | P0 | 待验收 | 待填写 |
| AUTH-06 | 直连 API Key | 新增、调用、轮换、禁用一把直连 Key | 新 Key 立即可用；旧 Key 不再被选择；禁用后不参与新请求和 Failover | P0 | 待验收 | 待填写 |
| AUTH-07 | 账号会话与显式 Key 解耦 | 同一账号会话过期，但 Route 显式绑定仍有效的 API Key | 显式 Key Channel 继续可用；依赖账号会话的回退 Channel 被阻止 | P1 | 待验收 | 待填写 |

## Route 策略

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| RTE-01 | 权重随机 `weighted` | 配置两个同优先级 Channel 和一个低优先级 Channel，连续执行小请求 | 只在最高可用优先级层选择；权重、成本、健康和负载影响决策；低层仅在高层不可用时进入 | P0 | 待验收 | 待填写 |
| RTE-02 | 轮询 `round_robin` | 两个健康 Channel 连续请求，再冷却其中一个 | 忽略 P / W 并动态轮转；健康候选命中次数差不超过 1；冷却候选立即退出轮询 | P0 | 待验收 | 待填写 |
| RTE-03 | 稳定优先 `stable_first` | 准备健康主池、弱健康观察池和恢复候选 | 主池优先且按健康与配置顺位轮转；观察池按策略获得灰度流量；成功恢复后返回主池 | P0 | 待验收 | 待填写 |
| RTE-04 | 手动顺序 `manual` | 配置不同 P 和同层顺序，依次令前序候选失败 | P 越小越先；同 P 严格按持久化顺序；失败后进入下一条；权重不改变顺序 | P0 | 待验收 | 待填写 |
| RTE-05 | 策略持久化 | 切换四种策略并重启服务或刷新路由快照 | 保存后的策略、顺序和候选解释保持一致，未知值回退到默认策略 | P1 | 待验收 | 待填写 |

## Failover、粘性与熔断

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| RES-01 | Endpoint Failover | 同一站点首 Endpoint 返回可重试 429 / 5xx 或连接失败，次 Endpoint 正常 | 在同一 Channel 内切到下一 Endpoint；attempt 顺序、endpointId 和最终成功可追溯 | P0 | 待验收 | 待填写 |
| RES-02 | 禁止不安全协议降级 | 关闭跨协议 fallback 后让首 Endpoint 失败 | 不访问被禁用的下一协议 Endpoint，返回规范化错误 | P0 | 待验收 | 待填写 |
| RES-03 | 站点故障与 Channel Failover | Endpoint 失败被分类为站点级故障 | 停止无意义的同站 Endpoint 探测，再按策略尝试下一 Channel；重试预算不超限 | P0 | 待验收 | 待填写 |
| RES-04 | Session 粘性 | 同一 session 连续三次请求 session-scoped OAuth / 账号 Channel | 健康期间保持同一 Channel 或 Route Unit 成员；粘性命中和绑定数可观测 | P0 | 待验收 | 待填写 |
| RES-05 | 粘性失效与恢复 | 当前粘性候选冷却、禁用或过期，再继续同一 session | 自动切到健康候选并更新绑定；旧绑定 TTL 到期后清理 | P0 | 待验收 | 待填写 |
| RES-06 | API Key 不误粘 | 对仅 API Key 的 Channel 重复使用相同 session | 不创建 session sticky binding，不把无状态 Key 误判为会话型资源 | P1 | 待验收 | 待填写 |
| RES-07 | 全候选熔断快速失败 | 将目标 Route 全部候选置为 breaker open / cooldown 后并发请求 | 受控环境 P95 不高于 1 秒；不发起上游请求；返回稳定 503 和可解释的候选排除原因 | P0 | 待验收 | 待填写 |
| RES-08 | Half-open 恢复 | 推进冷却时间并让探测请求成功 | 只放行受控 half-open 请求；首次成功后恢复健康；失败则重新冷却且无请求风暴 | P0 | 待验收 | 待填写 |

## Downstream Key Policy

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| DSK-01 | Key 生命周期 | 分别使用缺失、错误、禁用、过期和轮换后的 Key | 状态码和原因稳定；只有有效 Key 可进入代理；原始 Key 不写日志 | P0 | 待验收 | 待填写 |
| DSK-02 | 模型与 Route 许可 | 配置 `supportedModels`、`allowedRouteIds`、空许可和模式匹配 | 支持模型与 Route 按声明语义生效；`denyAllWhenEmpty` 时空集合拒绝全部 | P0 | 待验收 | 待填写 |
| DSK-03 | 站点与凭证边界 | 配置站点排除、凭证 allowlist / denylist，再令首候选失败 | 初始选择和所有 Failover 始终留在允许边界内，不能因重试越权 | P0 | 待验收 | 待填写 |
| DSK-04 | 站点权重倍率 | 对两个允许站点设置不同 multiplier | 只改变允许池内的决策概率，不让被拒站点重新进入候选池 | P1 | 待验收 | 待填写 |
| DSK-05 | 请求数与成本额度 | 分别耗尽 `maxRequests` 和 `maxCost` | 达限后新请求被拒；成功使用量准确；失败、取消和重试不重复累计 | P0 | 待验收 | 待填写 |
| DSK-06 | 最大并发 | `maxConcurrency=1`，并发启动 HTTP、SSE 或 WS Turn | 只有一个租约进入；其余返回可重试 429；完成、断开和异常都释放租约 | P0 | 待验收 | 待填写 |
| DSK-07 | 运行中策略失效 | 长连接期间删除、禁用、过期或轮换 Key | 新请求、下一次重试和下一 WS Turn 重新校验并拒绝，不继续扩大旧权限 | P0 | 待验收 | 待填写 |

## Connector 配对与恢复

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| CON-01 | 一次性配对 | 生成配对材料并 claim；再次使用同一材料 | 首次成功、二次拒绝；服务端只保存令牌哈希；远端服务器强制 HTTPS | P0 | 待验收 | 待填写 |
| CON-02 | 权限与撤销 | 用不同 scope 执行动作、上报事件和控制 App Server，再撤销设备 | 每个入口重复校验 scope；越权拒绝；撤销后设备令牌立即失效 | P0 | 待验收 | 待填写 |
| CON-03 | 心跳离线与恢复 | 停止 Connector 超过离线阈值后重启 | 设备标记离线并产生可观测事件；恢复后版本、capabilities 和心跳时间刷新 | P0 | 待验收 | 待填写 |
| CON-04 | 离线耐久队列 | 断网期间产生 Hook、Notify、Bridge 结果和事件，随后恢复网络 | 本地记录不丢失；结果优先于事件；使用稳定 deliveryId 重放且服务端幂等 | P0 | 待验收 | 待填写 |
| CON-05 | 配置保留与强制重配 | 带本地备份和队列执行重新配对 | 新设备凭证生效；本地 backup key、耐久队列和允许保留的设置不丢失 | P1 | 待验收 | 待填写 |
| CON-06 | 动作备份与回滚 | 安装 / 卸载 Hook 或 Notify，注入写入失败，再按 `backupRef` 回滚 | 写入原子；备份仅保存在本地并加密；目标校验正确；失败恢复原文件 | P0 | 待验收 | 待填写 |
| CON-07 | 服务升级失败恢复 | 安装新 LaunchAgent 后令 bootstrap 或健康检查失败 | 旧 plist 和服务被恢复、重新加载；不会留下两个运行实例 | P0 | 待验收 | 待填写 |
| CON-08 | App Server 恢复 | 修改 Codex 配置，令 daemon socket 短暂消失后恢复 | watcher 只在指纹稳定后重载；socket 恢复后 Connector 重连；队列继续投递 | P0 | 待验收 | 待填写 |
| CON-09 | Doctor 门禁 | 运行 `metapi-connector status` 和 `doctor` | Connector、dashboard、App Server、session snapshot 和远端 heartbeat 证据完整；失败项使 doctor 非零退出 | P1 | 待验收 | 待填写 |

## 备份导入导出

| ID | 验收项 | 操作与故障注入 | 通过标准 | 级别 | 结果 | 证据 |
|----|--------|----------------|----------|------|------|------|
| BAK-01 | 完整导出与空实例导入 | 导出完整备份，在空白实例导入 | 站点、Endpoint、账号、Token、Route、Channel、分组、禁用模型、下游 Key 和设置关系一致 | P0 | 待验收 | 待填写 |
| BAK-02 | 分区备份 | 分别导出 / 导入 `accounts` 和 `preferences` | 只变更目标分区；未选择的数据不被覆盖或清空 | P0 | 待验收 | 待填写 |
| BAK-03 | 路由语义恢复 | 源实例包含四种策略、Route Group、Endpoint Pool 和下游策略 | 导入后策略、顺序、模型映射、Endpoint 优先级和策略引用一致，核心请求可调用 | P0 | 待验收 | 待填写 |
| BAK-04 | 敏感管理数据排除 | 检查导出 JSON | 不包含管理员 TOTP Secret、恢复码、密码哈希或管理会话；备份文件按秘密材料管理 | P0 | 待验收 | 待填写 |
| BAK-05 | 非法与不完整备份 | 导入非对象、缺 timestamp、缺分区或破坏引用的数据 | 明确拒绝并说明原因；事务失败时不留下半导入状态 | P0 | 待验收 | 待填写 |
| BAK-06 | 兼容与重复导入 | 导入受支持旧格式，并重复导入同一备份 | 兼容数据被规范化；重复导入不产生悬空引用、重复 Route 或错误 Channel 绑定 | P1 | 待验收 | 待填写 |
| BAK-07 | WebDAV 往返 | 配置 WebDAV 后导出、列举 / 下载并导入；注入认证失败 | 成功时内容与本地导出一致；失败不覆盖本地有效数据；错误可诊断 | P1 | 待验收 | 待填写 |

## 建议自动化回归

以下命令覆盖当前仓库已有的高风险自动化。发布流水线可以拆分并行执行，但最终需要汇总为同一验收记录。

```bash
npx vitest run --root . \
  src/server/routes/proxy/chat.stream.test.ts \
  src/server/routes/proxy/responses.codex-oauth.test.ts \
  src/server/routes/proxy/responses.websocket.test.ts \
  src/server/routes/proxy/gemini.test.ts \
  src/server/routes/proxy/files.test.ts \
  src/server/routes/proxy/images.edits.test.ts \
  src/server/routes/proxy/videos.test.ts

npx vitest run --root . \
  src/server/routes/proxy/endpointFlow.test.ts \
  src/server/services/tokenRouter.selection.test.ts \
  src/server/services/proxyChannelCoordinator.test.ts \
  src/server/services/tokenRouter.session-decoupling.test.ts

npx vitest run --root . \
  src/server/routes/api/oauth.test.ts \
  src/server/services/oauth/oauthRefreshScheduler.test.ts \
  src/server/services/oauth/refreshCoordinator.test.ts \
  src/server/routes/api/downstreamApiKeys.test.ts \
  src/server/services/tokenRouter.downstream-policy.test.ts

npx vitest run --root . \
  src/server/routes/api/localConnector.test.ts \
  src/server/local-connector/queue.test.ts \
  src/server/local-connector/runtime.bridge.test.ts \
  src/server/local-connector/launchAgent.test.ts \
  src/server/services/backupService.test.ts \
  src/server/routes/api/settings.backup-webdav.test.ts
```

文档和仓库收尾检查：

```bash
npm run typecheck
npm test
npm run repo:drift-check
npm run docs:test
npm run docs:build
```

## 发布结论模板

| 汇总项 | 数量 |
|--------|------|
| P0 通过 / 总数 | `待填写` |
| P1 通过 / 总数 | `待填写` |
| P2 通过 / 总数 | `待填写` |
| 失败 | `待填写` |
| 阻塞 | `待填写` |
| 不适用 | `待填写` |
| 已知问题 | `待填写` |

最终结论：`允许发布 / 不允许发布`

结论说明需包含发布版本、证据位置、失败或例外清单、回滚条件和签字人。
