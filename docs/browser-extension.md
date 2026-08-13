# 浏览器凭证扩展

r-api 提供一个独立的 Chromium/Firefox MV3 扩展参考实现，用于完成 `assisted` 模式的浏览器凭证采集。扩展是浏览器凭证任务协议的客户端，不是第二套凭证中心，也不接管 Coding Agent 登录。

## 构建与加载

```bash
npm run build:browser-extension
```

构建产物在 `dist/browser-extension/`。Chromium 浏览器打开扩展管理页并启用开发者模式，选择“加载已解压的扩展程序”后指向该目录；Firefox 可在调试附加组件页面临时加载同一目录。

## 使用流程

1. 在 r-api WebUI 的“浏览器凭证”页面创建任务并复制一次性凭证采集链接。
2. 在浏览器打开凭证采集链接。页面不会自动领取任务，以便扩展从当前标签页安全接管；没有扩展时可以明确选择手动填写。
3. 打开扩展弹窗并领取当前任务。扩展向 r-api 公共凭证任务路由提交一次性任务令牌，换取短期 claim token。
4. 打开目标站点，完成用户主动登录或站点要求的交互，再点击“采集声明字段”。
5. 扩展只按任务快照中的 `capture` 描述读取目标 Origin 的 Cookie、`localStorage` 或 `sessionStorage` 字段；确认后提交到完成路由，服务端在同一事务中写入加密 Vault。
6. Vault 条目默认只是“已保存的候选凭证”，不会未经验证直接进入代理路由。管理员选择目标账号后调用启用动作，服务端按站点适配器声明的 `browser.runtime` 提取运行时会话，验证成功后更新账号、同步模型并重建路由。

`managed` 模式的任务契约已经预留，但真实独立 Chromium Profile 和自动化登录属于 P2 Managed Browser，不由当前扩展静默执行用户名、密码或验证码操作。

## 采集协议

字段采集策略是声明式的：

- `cookie_header`：读取当前目标 URL 可见范围内的 Cookie，并作为单个字段提交。
- `named_cookie`：只读取适配器指定的 Cookie 名称。
- `storage_value`：只读取指定 Storage 类型中的精确 key。
- `json_path`：读取指定 Storage key 后沿固定 JSON 路径取值。
- `manual`：扩展不读取，要求用户在弹窗中填写。

扩展拒绝 `*` 字段、未知字段、跨 Origin 标签页和过期任务。服务端会再次校验同一份字段与 Origin 白名单，扩展端校验不能替代服务端校验。

## 权限与秘密处理

- 只声明 `activeTab`、`scripting`、`storage`、`tabs`；Cookie 权限和目标 Origin 权限在用户点击操作时按精确 Origin 请求。
- 远端 r-api 服务必须使用 HTTPS；仅 `localhost`、`127.0.0.1` 和 `::1` 允许 HTTP。
- 扩展临时保存任务 claim token 以支持 Service Worker 重启；不保存采集字段、Cookie 或长期凭证。
- 采集结果只在弹窗内存中保留，提交后立即清除任务状态；服务端只保存加密 Vault ciphertext 和非敏感元数据。
- 不读取完整浏览器 Profile、密码管理器、通配 Storage，也不发送推理请求做测活。

该实现参考 All API Hub 的浏览器会话采集和适配器化流程，但代码、协议和安全边界独立重构，不将 AGPL 源码复制进本 MIT 项目。

## 凭证如何进入运行链路

浏览器采集结果保留在凭证中心的 `credential_vault_items` `browser_storage` 条目中，结构是带版本号的 JSON 字段集合。它的用途分成两个阶段：

- **保存阶段**：只校验任务令牌、Origin 和字段白名单，密文入 Vault；这一步不会修改账号的当前会话。
- **启用阶段**：调用受管理员认证保护的 `POST /api/browser-credential-tasks/:id/activate`，可在请求体传 `accountId`。服务端校验任务已完成、账号属于同一站点，从适配器声明的运行字段提取会话，再调用该平台的 `verifyToken`。只有返回 `tokenType=session` 才会写入账号并触发模型同步、默认 Token 收敛和路由重建。

```json
{
  "accountId": 42
}
```

启用失败时 Vault 条目仍保留为 `active`，便于重新选择账号或处理站点兼容问题；启用成功后条目会记录 `accountId`，账号 `extraConfig` 会记录 `browserCredentialId`。这样浏览器凭证既可审计和撤销，又不会绕过现有账号验证与路由收敛流程。
