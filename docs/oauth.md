# 🔐 官方凭证池

本文档介绍 r-api 的「官方凭证池」。它统一管理 Codex、Claude、Gemini CLI、Antigravity 等官方订阅或 OAuth 凭证，并把它们转换为可观测、可池化、可调度的上游供给。

[返回文档中心](/)

---

## 这页解决什么问题

不是所有上游都适合手填 API Key、Access Token 或 Cookie。

对下面这类官方 provider 账号，更推荐直接进入官方凭证池：

- Codex
- Claude
- Gemini CLI
- Antigravity

这类接法的特点是：

- 使用浏览器授权，而不是手填用户名密码
- 可导入已有官方 OAuth JSON，或从页面发起新的授权
- 可查看账号计划、额度窗口、模型同步和实际调度状态
- 可把多个官方凭证合并为路由池，也可拆回单体参与路由
- 可将选中凭证按受支持的格式接出到其他受信任系统

如果你接的是 New API、One API、Sub2API、CPA、OpenAI-compatible、Claude-compatible 这类**普通站点或网关**，请看 [上游接入](/upstream-integration)。

---

## 入口在哪里

管理后台左侧菜单的入口是：

```text
接入管理 → 官方凭证池
```

它不在「渠道管理」Tab 内。渠道管理负责普通中转站、面板账号和直连 API Key；官方凭证池负责 provider 官方订阅与 OAuth 凭证。

---

## 当前支持的 provider

| Provider | 对应平台 | 内部技术锚点 | 典型用途 |
|------|------|------|------|
| Codex | `codex` | `ChatGPT Codex OAuth` | 直接用 Codex 账号授权 |
| Claude | `claude` | `Anthropic Claude OAuth` | 直接用 Claude / Anthropic 账号授权 |
| Gemini CLI | `gemini-cli` | `Google Gemini CLI OAuth` | 复用 Gemini CLI / Google Cloud 账号授权，可选输入 Project ID |
| Antigravity | `antigravity` | `Google Antigravity OAuth` | 复用 Antigravity 账号授权 |

授权完成后，系统会自动维护对应的 provider 技术锚点，用于兼容现有存储和路由外键。它不会出现在站点管理中，也不代表官方凭证归属于某个普通站点。

---

## 授权前的准备

### 1. 确保 r-api 能访问 provider 的 OAuth 端点

如果你的部署环境访问外网受限，可以：

- 先配置全局 `SYSTEM_PROXY_URL`
- 或在 OAuth 启动 / 重绑时使用单次代理参数

相关环境变量见 [配置说明](/configuration) 里的「OAuth 与 Provider 登录」一节。

### 2. 远程部署要提前考虑回调方式

OAuth 默认使用 r-api 本机上的 loopback 回调地址，例如本机 `127.0.0.1` 端口。

如果你的 r-api 跑在远程服务器上，而浏览器跑在本地电脑上，常见做法有两个：

1. **SSH 隧道**：按页面给出的命令，把回调端口转发到远端
2. **手动回填 callback URL**：如果浏览器已经完成授权，但自动回调没打通，可把最终回调地址手动贴回管理页

### 3. 了解它和普通站点接入的边界

OAuth 连接更适合“provider 原生账号授权”，而不是：

- 面板站点账号密码登录
- New API / One API 后台管理
- CPA / OpenAI-compatible 的普通 API Key 托管

---

## 标准流程

### 步骤 1：打开官方凭证池

进入「接入管理 → 官方凭证池」，等待页面加载 provider 列表、已有凭证和调度状态。

### 步骤 2：点击要连接的 provider

页面会为 provider 发起一个 OAuth 会话，并弹出授权窗口。

r-api 会同时给出：

- 授权链接
- 本机回调端口
- 手动回填等待时间
- 如果当前是远程访问，还会给出 SSH 隧道命令模板

### 步骤 3：在 provider 页面完成授权

完成授权后，r-api 会轮询当前会话状态：

- `pending`：等待回调
- `success`：授权成功
- `error`：授权失败，需要重新检查浏览器回调或网络

### 步骤 4：必要时手动回填 callback URL

如果弹窗里已经能看到类似 `...?code=...&state=...` 的回调地址，但 r-api 页面还没成功：

1. 复制浏览器最终回调 URL
2. 回到「官方凭证池」
3. 粘贴到手动回填区域提交

### 步骤 5：确认凭证与调度状态

成功后应看到：

- 「官方凭证池」里出现新的凭证记录
- 凭证的模型同步与调度状态可正常读取

---

## 和普通站点 / API Key 的区别

| 方式 | 入口 | 适合什么 | 典型例子 |
|------|------|------|------|
| 面板账号 | 渠道管理 → 账号与 API Key → 面板账号 | 有后台面板，需要登录、签到、余额和签发令牌 | New API、One API、DoneHub、AnyRouter、Sub2API |
| 直连 API Key | 渠道管理 → 账号与 API Key → 直连 API Key | 只有 Base URL + Key，只关心代理调用和模型列表 | OpenAI-compatible、Claude-compatible、CPA |
| 官方凭证 | 接入管理 → 官方凭证池 | 需要 provider 官方授权、额度观测、刷新和凭证池调度 | Codex、Claude、Gemini CLI、Antigravity |

简单判断：

- 你拿到的是 **站点后台地址**，优先看 [上游接入](/upstream-integration)
- 你拿到的是 **provider 登录授权**，优先看这页

---

## 内部技术锚点有什么用

OAuth 成功后，r-api 会确保对应 provider 的内部技术锚点存在。它只用于兼容现有数据库外键和路由结构：

- 路由通道
- 代理与重绑逻辑

产品层面仍按 provider 管理官方凭证：

- 技术锚点不会出现在站点管理
- 调度池要求成员属于同一 provider，不要求属于同一技术站点
- 普通站点、Connector 和安全凭证库不参与官方凭证池归属

---

## 渠道接出

官方凭证池提供两种不同的接出方式：

- **Sub2API / Cockpit**：选中 Codex/OpenAI 官方凭证后，按 Cockpit `sub2api-data` v1 格式下载账号包。文件包含 access token、refresh token、ID token 等明文秘密，必须显式确认后才能生成。
- **NewAPI / OneAPI**：把 r-api 的 `/v1` 作为 OpenAI 兼容上游，并使用 r-api 下游密钥。此方式不导出、也不伪造官方 OAuth 包。

当前 Sub2API 包导出只支持 Codex/OpenAI 官方凭证；其他 provider 仍可在 r-api 内参与调度。

---

## 管理 API 里怎么自动化

如果你想脚本化处理 OAuth，可以用这些接口：

| 接口 | 作用 |
|------|------|
| `GET /api/oauth/providers` | 获取当前可用 provider 列表 |
| `POST /api/oauth/providers/:provider/start` | 启动 OAuth 流程 |
| `GET /api/oauth/sessions/:state` | 轮询会话状态 |
| `POST /api/oauth/sessions/:state/manual-callback` | 手动回填 callback URL |
| `GET /api/oauth/connections` | 列出现有连接 |
| `POST /api/oauth/import` | 导入原生 OAuth JSON 或 Cockpit/Sub2API 凭证包 |
| `POST /api/oauth/export/sub2api` | 显式确认后导出 Cockpit `sub2api-data` v1 包 |
| `POST /api/oauth/connections/:accountId/rebind` | 重绑已有 OAuth 连接 |
| `DELETE /api/oauth/connections/:accountId` | 删除 OAuth 连接 |

脚本示例见 [管理 API](/management-api)。

---

## 常见问题

### provider 显示“当前不可用”

通常说明回调监听器不可用，或当前 provider 的启动条件不满足。优先检查：

1. 服务是否刚启动但回调监听失败
2. 端口是否被占用
3. 当前环境是否缺少必要的 OAuth 配置

### 浏览器授权成功了，但页面一直停在“等待授权完成”

优先怀疑回调链路没通：

1. 如果是远程服务器，先按页面提示建 SSH 隧道
2. 如果不方便建隧道，直接用手动 callback 回填
3. 如果 provider 页面最终没有 `code` / `state` 参数，说明授权本身还没成功

### OAuth 连接需要系统代理吗

有可能需要，尤其是：

- 国内服务器访问 OpenAI / Anthropic / Google OAuth 端点
- 服务器本身不能直连 provider

优先使用：

1. 全局 `SYSTEM_PROXY_URL`
2. OAuth 启动 / 重绑时指定单次代理

### OAuth 成功后为什么数据库里还有 provider 站点

这是内部兼容结构。r-api 需要一个技术锚点承载：

- 账号所属平台
- 路由与通道归属
- 后续重绑 / 刷新逻辑

它不会出现在站点管理，也不代表你新增了一个普通面板站点。

### 多个请求同时遇到 401，会不会重复刷新

不会直接让每个请求各自消费 refresh token。r-api 会先获取账号级数据库短租约；其他请求等待后重读账号，并复用已经轮换的新 access token。服务器多实例部署也使用同一套数据库租约和凭证版本 CAS。

### 429 或 Provider 临时故障会怎样

r-api 会优先遵守 Provider 的 `Retry-After`，否则使用指数退避。定时刷新遇到租约忙、Provider 冷却或账号退避时会记为跳过，不会当成新的账号失败反复重试。

### 为什么连接会要求重新授权

以下两类状态不会继续进入代理路由：

- Provider 明确拒绝 refresh token，例如 `invalid_grant`
- Provider 已返回新凭证，但本地持久化结果无法确认

前者会标记为需要重新授权；后者会进入 `refresh_unknown`，同样停止自动重试，避免继续使用状态不确定的凭证。

---

## 相关文档

- [上游接入](/upstream-integration)
- [管理 API](/management-api)
- [配置说明](/configuration)
- [常见问题 FAQ](/faq)
