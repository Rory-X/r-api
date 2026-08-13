# Cockpit Tools 多渠道凭证管理与 r-api 接入差距调研

> 调研时间：2026-08-13
>
> 对比基线：Cockpit Tools `main` 提交 [`045a478148b430108e77052cd0ca8967cbfc2837`](https://github.com/jlcodes99/cockpit-tools/commit/045a478148b430108e77052cd0ca8967cbfc2837)（v1.3.17）；r-api 提交 `4b5a19e63fdc4510918dba624ecd47c4c1bbe27b`。
>
> 本文只讨论凭证控制面：凭证发现、格式识别、规范化、导入导出、校验、去重、刷新、失效/撤销、审计，以及适配 NewAPI/OneAPI、Sub2API、原生 OAuth 和通用 API Key。中转、协议转换和本地网关均视为已有能力，不作为本次主要缺口。
>
> 实施状态：截至 2026-08-13，本文识别的六项凭证基础设施和凭证中心工作台已经在 r-api 内完成第一阶段交付。第 4、5 节已按实际实现更新，前面的 Cockpit 观察仍作为设计背景保留。

## 结论先行

Cockpit 最值得借鉴的不是页面，也不是代理，而是一个很清晰的分层模式：**统一迁移编排器 + 每个渠道独立的凭证适配器**。它把平台列表、导出包版本、逐平台进度和部分失败处理统一起来；但每个平台的字段解析、身份判定、落盘格式、刷新和可恢复性仍由 adapter 负责。`account-transfer` 只是一层 envelope，不是可以直接当作通用凭证标准的 payload。

r-api 原本已经拥有目标端的很多“最后一公里”能力：OAuth 交换与账号池、NewAPI/OneAPI 风格的登录会话/API Key、Sub2API 的 access token + refresh token + expiry、通用 API Key、加密账号凭证、Credential Vault、验证、模型同步、token 同步和撤销。本轮在这些真相源之上补齐了**中立、版本化、可预览、可审计的凭证摄取管线**：

```text
文件 / 粘贴 JSON / Cockpit bundle / 平台导入任务
  -> 格式检测
  -> provider parser
  -> canonical credential candidate
  -> 预览、逐项校验、去重决策
  -> 目标 adapter（OAuth / NewAPI / Sub2API / API Key）
  -> 复用现有验证、加密落库、模型同步和路由重建
```

这条“来源凭证 -> canonical candidate -> 目标渠道凭证”的中间层现在已经落地；剩余工作不再是搭基础管线，而是扩充更多 Cockpit 平台私有 parser、增强到期告警/失败重试运营，以及提供更完整的审计检索。

## 0. 当前交付状态

| 能力 | 状态 | r-api 落点 |
| --- | --- | --- |
| 格式检测与规范化 | 已交付 | `credentialIngestionService.ts`；支持 Cockpit transfer、r-api transfer/backup、原生 OAuth、Sub2API、NewAPI/OneAPI、浏览器材料和 API Key |
| 目标 promotion | 已交付 | `credentialPromotionService.ts`；目标为 `new_api`、`sub2api`、`native_oauth`、`api_key`、`vault` |
| 预览、校验、去重和幂等 | 已交付 | `credentialImportJobService.ts`；持久化任务、批次指纹、操作者范围幂等键和逐项结果 |
| 来源 provenance | 已交付 | `credential_import_provenance`；关联来源 schema/version、操作者、冲突策略和目标实体 |
| 导出与恢复 | 已交付 | metadata-only、scrypt + AES-256-GCM 加密备份、显式确认的明文迁移 |
| 生命周期 | 已交付 | 统一状态、refresh owner、验证/刷新/启停/本地撤销批量动作 |
| 管理工作台 | 已交付 | `/settings/credentials` 下的统一凭证、导入、导入任务和 Vault 四视图 |
| 管理 API 文档 | 已交付 | `docs/management-api.md` 的凭证中心接口章节 |

第一阶段实现坚持两个边界：不复制 Cockpit 的平台内部代码；不让来源 parser 直接写账号或 Vault，而是复用 r-api 已有账号、OAuth、Sub2API、Vault、验证、审计和路由工作流。

## 1. Cockpit 的凭证管理模式

### 1.1 统一编排，平台独立解析

Cockpit 的 `src/services/accountTransferService.ts` 定义了统一的 `TransferAdapter`：

```ts
interface TransferAdapter {
  listAccounts: () => Promise<AccountWithId[]>;
  exportAccounts: (accountIds: string[]) => Promise<string>;
  importFromJson: (jsonContent: string) => Promise<unknown[]>;
}
```

编排层提供以下稳定行为：

- schema `cockpit-tools.account-transfer`、version `1`；
- bundle 级 `exported_at`、平台数和账号数汇总；
- 每个平台 `account_count` + `exported_data`；
- 按平台报告进度，允许部分平台成功、失败或跳过；
- 空平台和不支持平台不会阻塞整包导入；
- 约 18 个用户可见账号渠道分别注册 adapter，包括 Antigravity、Codex、Claude、Copilot、Windsurf、Kiro、Cursor、Qoder、Trae、Zed、ZCode、WorkBuddy 等。

重要边界：Grok 的导出是元数据性质，不能恢复登录，因此被刻意排除在通用凭证备份/恢复管线之外。这说明导出时必须明确区分“可恢复秘密”“可重新授权信息”和“仅元数据”，不能看到一个 JSON 就默认它可迁移。

### 1.2 平台 adapter 实际承载的差异

Cockpit 不试图把所有平台压成同一种 token。实际存在的凭证形态包括：

| 来源形态 | 典型平台 | 可迁移信息 | 主要风险 |
| --- | --- | --- | --- |
| OAuth access/refresh token | Codex、Claude、Kiro、Copilot、Windsurf、Cursor、Trae | access token、refresh token、过期时间、账号标识、套餐 | refresh token 轮换和 provider 绑定 |
| 本机客户端 JSON / JSONL | Codex `auth.json`、各 IDE 本地状态 | provider 私有字段、当前账号、设备或项目上下文 | 路径/字段是实现细节，版本变化快 |
| Session token / cookie | 部分 IDE、Web 登录态 | session、cookie、用户标识 | 很可能绑定设备、Origin 或浏览器状态 |
| API Key + Base URL | Claude、Codex、Grok、ZCode 等 | key、端点、模型配置 | 不能误判为可 refresh 的 OAuth |
| 用户名/密码或设备流 | Windsurf、NewAPI 类站点、部分 OAuth | 登录材料或一次性授权状态 | 需要显式同意，不能静默搬运 |
| 元数据报告 | Grok 等特殊路径 | 邮箱、套餐、额度、状态 | 不能用于凭证恢复 |

所以可复用的设计是“统一 orchestration contract”，不是 Cockpit 各 adapter 的内部 JSON。r-api 需要自己的 canonical candidate 和 target adapter。

## 2. r-api 现有目标能力

### 2.1 原生 OAuth

r-api 的 OAuth 服务已经能解析原生 OAuth JSON，提取：

- `access_token` 或 `session_token`；
- 可选 `refresh_token`；
- `expires_at` / `token_expires_at` / `expired`；
- `id_token` 中的 email、provider 账号标识、套餐；
- Codex/Antigravity 等 provider-specific data、project id。

导入后会进入现有 OAuth 交换、账号创建/更新、加密存储、模型同步和 OAuth Route Unit 流程。问题在于，当前解析器直接绑定 `/api/oauth` 的 native OAuth JSON 合同，并且明确拒绝 `sub2api-data`、`sub2api-bundle`、带 `accounts`/`proxies`/`version`/`exported_at` 的 envelope：

```text
native oauth json expected; sub2api envelopes are no longer supported
```

这个拒绝本身是合理的边界，但它也暴露出缺少上游的格式检测层：现在是“进入 OAuth 路由后才发现格式不对”，而不是先检测并把候选交给正确目标 adapter。

### 2.2 NewAPI / OneAPI 风格站点

现有账号创建和验证支持以下常见模式：

- 用户名/密码登录后得到 session/access token；
- 已有 session/access token；
- API Key / `apiToken`；
- 可选平台用户 ID、账号名和额外配置；
- API Key 批量创建与逐项验证。

这已经足以承接 NewAPI/OneAPI 的多数“站点 + 账号 + token”场景，但入口参数和 `credentialMode` 分散在账号路由、手工创建服务和站点 adapter 中。缺的是一个能把外部包中的 `username`、`password`、`access_token`、`api_key`、`user_id` 等别名映射成统一候选，并在导入前告诉用户最终会落成 session 还是 apikey。

### 2.3 Sub2API

r-api 已有 Sub2API 专用语义：

- 当前 `accessToken` 用于请求；
- `extraConfig.sub2apiAuth.refreshToken` 保存 refresh token；
- `extraConfig.sub2apiAuth.tokenExpiresAt` 保存过期时间；
- `sub2apiManagedAuth` 负责 token refresh 和更新 extra config；
- 不支持把 Sub2API 当作普通账号密码登录。

这套实现已经覆盖目标端落库和刷新，但输入侧没有中立的 Sub2API envelope parser，也没有把 Sub2API 凭证候选与 native OAuth 候选统一起来。当前做法是“目标路由知道如何拒绝错误格式”，而不是“格式检测器知道应该把它送到 Sub2API adapter”。

### 2.4 通用 API Key 与 Vault

通用 API Key 可批量创建账号；Credential Vault 和浏览器凭证恢复可以加密保存 secret，并带 kind、来源和任务状态。它们适合成为 canonical candidate promotion 的落点，但目前各入口仍各自解析请求体，缺少统一的：

- secret fingerprint；
- source/provenance；
- target compatibility；
- import batch/job id；
- dry-run 预览与逐项结果。

## 3. 来源格式到目标 adapter 矩阵

| 来源格式/凭证种类 | 规范化后的候选 | NewAPI / OneAPI | Sub2API | 原生 OAuth | 通用 API Key |
| --- | --- | --- | --- | --- | --- |
| Cockpit `account-transfer` | `platform_bundle`，拆成 provider 子候选 | 需 provider parser 后再决定 | 需 Sub2API parser | 适用于 Codex/Claude/Gemini/Antigravity 等 | 适用于明确 key 的平台 |
| 原生 OAuth JSON | `oauth_token_set` | 通常不直接适配 | 不直接适配 | 直接适配 | 不适配 |
| Sub2API bundle/data | `oauth_token_set` 的 Sub2API 变体 | 不直接适配 | 直接适配 access/refresh/expiry | 不应送 native OAuth | 不适配 |
| NewAPI/OneAPI 账号 JSON | `username_password` 或 `session_token` | 直接适配 | 仅在站点声明兼容时适配 | 不适配 | 可在明确 key 时适配 |
| 单个 `sk-*` / API key 文本 | `api_key` | 适配为 apikey 账号 | 适配为 Sub2API access token 需显式选择 | 不适配 | 直接适配 |
| 客户端 `auth.json` / 本地状态 | provider-specific candidate | 先 provider parser | 仅 provider 明确支持时 | 先提取 OAuth 字段 | 先提取 key 字段 |
| Cookie / browser storage | `browser_storage` | 进入浏览器恢复或人工确认 | 通常不直接适配 | 通常不直接适配 | 不适配 |
| 仅额度/邮箱/套餐报告 | `metadata_only` | 不可创建凭证 | 不可创建凭证 | 不可创建凭证 | 不可创建凭证 |

核心原则：**目标 adapter 负责最终校验和 promotion，来源 parser 只负责识别与提取。** 不要让 Cockpit parser 直接写 `accounts` 或 `accountTokens`。

## 4. 已交付能力与剩余差距

### 4.1 中立凭证摄取与 canonical candidate：已交付

`credentialIngestionService` 已独立于路由实现格式检测、规范化、安全预览和目标兼容性校验；`credentialPromotionService` 负责调用目标流程。当前 canonical candidate 包含：

```ts
type CredentialCandidate = {
  source: { format: string; version?: string; platform?: string; importJobId: string };
  provider?: string;
  kind: 'api_key' | 'session_token' | 'oauth_token_set' | 'username_password'
      | 'browser_storage' | 'platform_bundle' | 'metadata_only';
  identity?: { externalId?: string; email?: string; username?: string; accountKey?: string };
  secretPresence: { accessToken?: boolean; refreshToken?: boolean; apiKey?: boolean; password?: boolean };
  expiresAt?: number;
  disabled?: boolean;
  fingerprint: string;
  warnings: string[];
  compatibleTargets: Array<'new_api' | 'sub2api' | 'native_oauth' | 'api_key' | 'vault'>;
};
```

预览和日志只展示 presence、fingerprint 和安全身份摘要，不回显 token、密码、Cookie 或完整导出包。

### 4.2 格式检测和首批 parser：已交付

当前已覆盖：

- Cockpit `account-transfer` v1 envelope；
- r-api `credential-transfer` v1 和 `credential-backup` v1；
- 原生 OAuth JSON；
- Sub2API data/bundle；
- NewAPI/OneAPI 常见账号、Session 和 API Key 字段；
- 单 key 文本与 JSON 数组批量 key；
- Cookie / browser storage；
- metadata-only 和未知 platform bundle 的可解释结果。

仍缺的是 Cockpit 约 18 个平台里更广的私有 payload parser，尤其是强依赖本机状态、设备上下文或 provider 特殊字段的平台。后续应按 r-api 是否存在明确目标渠道逐个扩展，而不是一次性复刻 Cockpit。

### 4.3 去重、幂等和 upsert：已交付

已实现：

- provider 稳定身份、账号 key、email/username、站点范围和 secret fingerprint 的匹配；
- `skip`、`update`、`create_duplicate` 三种显式策略；
- 原生 OAuth 身份收敛，禁止创建重复 OAuth 身份；
- 操作者范围的幂等键；相同键配不同输入返回 `409`；
- `importJobId + batchFingerprint` 和原始输入的二次校验；
- 完成/部分成功任务的结果重放，避免重复触发上游。

### 4.4 目标 promotion：已交付

统一流程已经形成：

```text
preview -> validate -> promote -> verify -> sync -> audit
```

- `native_oauth`：复用 OAuth 身份收敛、加密、刷新和路由流程；
- `new_api`：映射为 session、用户名密码或 API Key，并复用账号登录/更新；
- `sub2api`：写入 access token、refresh token、expiry 和托管刷新配置；
- `api_key`：创建或更新 API Key 账号；
- `vault`：加密保存秘密，不自动变成可路由账号。

来源 parser 不直接写 `accounts`、`accountTokens` 或 Vault，路由也只做参数适配。

### 4.5 Cockpit bundle 与可恢复性：第一阶段已交付

现在可以识别 Cockpit envelope，逐平台拆分 payload，并展示：

- 成功提取多少账号；
- 哪些只是 metadata-only；
- 哪些缺 refresh token、设备绑定或项目上下文；
- 哪些能独立迁移到 r-api，哪些只能继续留在本机 Cockpit；
- 每项验证和去重结果。

Cockpit 平台私有 JSON 不会成为 r-api 的长期公共 schema；导入时转成 canonical candidate，并将原始 schema/version 保存为 provenance。剩余差距是增加更多平台私有 parser 和“只能重新授权”操作引导。

### 4.6 导出模式和备份安全：已交付

已明确区分：

- `metadata_only`：身份、站点、provider、状态、kind、到期时间、指纹、可恢复性和 secret presence，不含秘密；
- `encrypted_backup`：scrypt + AES-256-GCM，支持过期时间和原样重新导入；
- `portable_secret`：面向跨系统迁移，强制字面确认 `EXPORT_SECRETS`、审计和 UI 二次确认。

导出条目标注 `recoverable`、`reauthorization_required` 或 `metadata_only`，审计不写秘密或口令。

### 4.7 生命周期：已交付基础运营，告警与策略仍可增强

统一状态已包含 `active`、`expiring`、`expired`、`refreshing`、`refresh_failed`、`revoked`、`invalid`、`disabled`、`metadata_only`。

每个凭证声明 refresh owner：

- `r_api`：复用 OAuth lease/CAS 或 Sub2API singleflight 托管刷新；
- `external`：Session 等由外部系统续期；
- `none`：API Key、Vault 或不支持自动刷新的凭证。

批量 `validate`、`refresh`、`enable`、`disable`、`revoke` 已落地。账号撤销明确是本地控制面撤销，不虚假声称上游 revoke。

后续增强项：

- 到期提醒通知和可配置提前量；
- refresh failure 的自动退避/重试队列与运营视图；
- provider 限流、认证失败、额度耗尽等失败域更细的统一分类；
- refresh owner 冲突的显式租约/接管流程。

### 4.8 审计与可解释性：基础已交付，查询面仍可增强

导入 provenance 已持久化来源 schema/version、操作者、冲突策略、动作、指纹和目标实体；导入、生命周期和导出均写安全审计事件。统一列表会显示最近 provenance。

剩余差距是独立的审计检索/导出界面，以及按操作者、来源、动作、目标和时间范围的查询 API。

## 5. 里程碑结果与下一阶段

### 已完成里程碑

1. 统一摄取内核：格式检测、canonical candidate、安全预览和目标兼容性。
2. Cockpit interoperability：识别 `account-transfer` v1，保留来源 schema/version 和可恢复性。
3. 目标接入：NewAPI/OneAPI、Sub2API、原生 OAuth、通用 API Key 和 Vault。
4. 持久化导入任务：幂等、原子执行抢占、结果重放、逐项 provenance。
5. 导出与生命周期：metadata、加密备份、明文迁移、批量验证/刷新/启停/撤销。
6. 凭证中心工作台：统一凭证、导入、导入任务、Vault 四个视图。

### 下一阶段优先级

#### P1：扩展高价值 Cockpit provider parser

- 按实际接入需求优先支持 Codex、Claude、Gemini/Antigravity 等可映射到现有 OAuth 目标的私有 payload；
- 对设备绑定、项目上下文缺失和只能重新授权的材料给出明确操作；
- 为每个 parser 增加独立 fixture、版本兼容和 secret-free 回归测试。

#### P1：生命周期运营自动化

- 可配置的到期提前量、提醒渠道和批量刷新计划；
- refresh failure 退避、重试队列、失败域分类和一键重试；
- 本地控制面撤销后的旧秘密清理策略与运营报表。

#### P1：审计查询面

- 按操作者、来源格式、目标实体、动作和时间范围查询；
- 提供导入、导出、刷新、撤销的关联时间线；
- 支持导出不含秘密的审计报告。

#### P2：可用性增强

- 大批量导入的分页预览、只执行选中项和失败项重试；
- 按 provider、kind、来源、到期区间和 provenance 的更多筛选；
- 为 metadata-only / reauthorization-required 提供重新授权跳转。

## 6. 不建议做的事

1. 不把 Cockpit 私有数据目录当成稳定数据库读取。
2. 不直接复刻 18 个平台 adapter；先确认该凭证是否有明确的 r-api 目标渠道。
3. 不把 `account-transfer` envelope 当作 universal secret schema。
4. 不让来源 parser 直接写 `accounts`、`accountTokens` 或 Vault 表。
5. 不把 Sub2API envelope 混进 native OAuth parser。
6. 不让同一个 refresh token 在两个系统同时刷新。
7. 不把 metadata-only 导出当成可恢复备份。
8. 不复制 Cockpit 代码到商业项目。其仓库声明 CC BY-NC-SA 4.0，企业内部商业使用需另行授权；建议做协议级互操作和独立实现。

## 最终判断：现在还差什么

第一阶段的六项凭证基础设施已经完成：统一检测、canonical candidate、preview/validate/promote、去重幂等、生命周期、来源与审计。

因此现在真正还差的不是另一套中转、本地网关或平行账号系统，而是三类增强：

1. **Provider 覆盖深度**：继续补 Cockpit 高价值平台的私有 payload parser，并明确哪些材料只能重新授权。
2. **生命周期自动化**：把已有批量动作升级为提醒、计划、退避重试和 refresh owner 接管策略。
3. **审计运营面**：将已有 provenance 和安全审计做成可筛选、可关联、可导出的查询能力。

NewAPI/OneAPI、Sub2API、原生 OAuth、通用 API Key 和 Vault 现在已经共享同一套凭证控制面，不再是互相割裂的导入系统。

## 主要来源

### Cockpit Tools

- [README：平台、账号管理、安全与许可证](https://github.com/jlcodes99/cockpit-tools/blob/045a478148b430108e77052cd0ca8967cbfc2837/README.md)
- [账号迁移编排与 `account-transfer` schema](https://github.com/jlcodes99/cockpit-tools/blob/045a478148b430108e77052cd0ca8967cbfc2837/src/services/accountTransferService.ts)
- [本机账号自动发现](https://github.com/jlcodes99/cockpit-tools/blob/045a478148b430108e77052cd0ca8967cbfc2837/src-tauri/src/modules/auto_local_import.rs)
- [provider token keeper](https://github.com/jlcodes99/cockpit-tools/blob/045a478148b430108e77052cd0ca8967cbfc2837/src-tauri/src/modules/provider_token_keeper.rs)
- [各平台账号 service 与导入/导出 adapter](https://github.com/jlcodes99/cockpit-tools/tree/045a478148b430108e77052cd0ca8967cbfc2837/src/services)

### r-api

- `src/server/services/credentialIngestionService.ts`
- `src/server/services/credentialPromotionService.ts`
- `src/server/services/credentialImportJobService.ts`
- `src/server/services/credentialExportService.ts`
- `src/server/services/credentialLifecycleService.ts`
- `src/server/routes/api/credentialImports.ts`
- `src/server/routes/api/credentialExports.ts`
- `src/server/routes/api/credentialLifecycle.ts`
- `src/web/pages/CredentialVault.tsx`
- `src/web/pages/credential-management/`
- `src/server/services/oauth/service.ts`
- `src/server/routes/api/oauth.ts`
- `src/server/routes/api/accounts.ts`
- `src/server/services/manualAccountCreationService.ts`
- `src/server/services/accountExtraConfig.ts`
- `src/server/services/sub2apiManagedAuth.ts`
- `src/server/services/accountCredentialService.ts`
- `src/server/services/credentialVaultService.ts`
- `src/server/services/browserCredentialActivationService.ts`
- `src/server/contracts/accountsRoutePayloads.ts`
