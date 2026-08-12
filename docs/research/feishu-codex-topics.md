# 飞书话题与 Codex 会话接管调研

> 调研时间：2026-08-11
>
> 范围：飞书群话题（topic/thread）、消息回复、JSON 2.0 卡片表单回传，以及将一个飞书话题绑定到一个 Codex `threadId` 的实现约束。
>
> 资料来源：仅使用飞书开放平台官方文档。文末列出完整链接。

## 结论摘要

1. 飞书话题有独立的 `thread_id`，在当前租户内唯一，格式通常以 `omt_` 开头。话题同时拥有一个消息 `message_id`；两者不是同一个字段，也不能互相替代。
2. 回复接口始终以 `message_id` 作为路径参数。要从普通消息创建话题，调用 `POST /open-apis/im/v1/messages/:message_id/reply`，并在请求体传 `reply_in_thread: true`；成功响应中的 `thread_id` 就是后续话题身份。
3. 后续往同一话题发卡片，最稳妥的方式是保存该话题根消息的 `message_id`，继续调用回复接口。对已经属于话题的消息，官方说明默认按话题方式回复。
4. 查询话题消息使用历史消息接口的 `container_id_type=thread`，`container_id` 传 `thread_id`。在普通群的 `chat` 容器中只能拿到话题根消息，再用 `thread` 容器获取回复消息。
5. JSON 2.0 表单容器可以把输入框和提交按钮的内容一次性回调到服务端。`form_value` 由输入组件的 `name` 映射到用户输入；按钮的 `name` 在回调中用于识别提交按钮。
6. JSON 2.0 卡片回调的上下文包含 `open_message_id` 和 `open_chat_id`，官方回调结构没有把 `thread_id` 作为上下文字段直接返回。因此，回调处理不能只依赖回调 payload 推导话题，必须通过已保存的 `open_message_id` 映射或在卡片 `behaviors[].value` 中携带一个服务端可验证的绑定键。
7. 卡片回调需要在 3 秒内返回 HTTP 200；JSON 2.0 卡片的回传交互和可更新时间统一为 14 天。请求回调仅适用于应用发送的卡片，自定义机器人发送的卡片不支持该交互。

## 话题身份与消息身份

### `thread_id`

飞书官方将 `thread_id` 定义为话题独有的 ID，在当前租户内唯一，示例格式为 `omt_d4be107c616a`。它用于识别一组聚合回复，也可用于：

- 调用转发话题接口；
- 使用历史消息接口获取该话题的全部消息；
- 判断一条消息是否属于话题：消息资源不返回 `thread_id` 时，表示它不是话题消息。

话题根消息也同时具有 `message_id` 和 `thread_id`。实现上应把二者分别存储：`thread_id` 用作业务上的话题主键，`message_id` 用作消息管理和回复 API 的地址。

### `message_id`

`message_id` 是飞书在单个租户内为每一条消息生成的唯一 ID，通常以 `om_` 开头。它可以从发送消息、回复消息的响应，接收消息事件，或历史消息查询结果中获取。

### `root_id` 与 `parent_id`

- 普通消息树中，`root_id` 是根消息的 `message_id`，`parent_id` 是上一层被回复消息的 `message_id`。
- 话题内回复时，所有回复都指向话题根消息，因此 `root_id` 和 `parent_id` 都是话题内根消息的 `message_id`。
- `thread_id` 仍是整组话题的稳定身份，不应使用 `root_id` 代替它。

## 创建话题与发送话题回复

### 方式 A：在普通群的消息上创建话题

接口：`POST https://open.feishu.cn/open-apis/im/v1/messages/:message_id/reply`

请求体核心字段：

```json
{
  "msg_type": "interactive",
  "content": "{\"schema\":\"2.0\",\"body\":{\"elements\":[]}}",
  "reply_in_thread": true,
  "uuid": "optional-idempotency-key"
}
```

官方语义：

- `message_id` 是要回复的消息 ID；
- `reply_in_thread=true` 表示以话题形式回复；
- 如果被回复的消息本身已经是话题消息，默认按话题方式回复；
- 成功响应返回新消息的 `message_id`、`root_id`、`parent_id` 和 `thread_id`；
- `uuid` 用于请求去重，相同值在 1 小时内至多成功回复一条消息，最大长度 50 字符。

对于“第一张 Codex 完成卡片”这一场景，推荐保存：

- 发送完成卡片得到的根 `message_id`；
- 创建话题回复后得到的 `thread_id`；
- 创建话题回复得到的回复消息 `message_id`（便于审计和重试）。

### 方式 B：使用话题形式群

群消息形式可通过群信息中的 `group_message_type` 判断。取值为 `thread` 表示话题形式群；创建或更新普通群时也可将该字段设置为 `thread`。

官方区分：

- **话题群**：群模式 `chat_mode=topic`，创建后仅支持发送话题；
- **话题形式群**：普通对话群 `chat_mode=group`，但 `group_message_type=thread`，群消息以话题形式展示。

官方话题概述推荐使用“话题形式群”。在这种群中发送消息时，响应中的 `thread_id` 可直接作为该新话题的身份。

### 向同一话题继续发送

发送消息接口 `POST /open-apis/im/v1/messages` 的 `receive_id_type` 官方枚举包含 `open_id`、`union_id`、`user_id`、`email`、`chat_id`，不包含 `thread_id`。因此不能把 `thread_id` 当作普通 `receive_id` 直接调用发送消息接口。

推荐做法是：

1. 保存话题根消息 `root_message_id`；
2. 对该根消息调用回复接口；
3. 请求体设置卡片消息和 `reply_in_thread=true`；
4. 校验响应中的 `thread_id` 与本地绑定一致。

如果已有某条消息明确属于目标话题，也可以回复该消息；但以根消息作为稳定锚点更容易审计和恢复。话题内回复在消息字段上会把 `root_id`、`parent_id` 归一到话题根消息。

## 查询话题历史

接口：`GET https://open.feishu.cn/open-apis/im/v1/messages`

查询参数：

```text
container_id_type=thread
container_id=<thread_id>
```

官方行为：

- `container_id_type=chat` 用于查询单聊或群聊；在普通对话群中只能拿到话题根消息；
- `container_id_type=thread` 用于查询话题内的全部消息；
- `container_id` 的值必须与 `container_id_type` 匹配；
- `thread` 容器暂不支持 `start_time`、`end_time` 时间范围参数；
- 结果中的每条消息可包含 `thread_id`，不返回该字段则不是话题消息。

## JSON 2.0 卡片表单

### 表单容器

JSON 2.0 卡片需要显式声明：

```json
{
  "schema": "2.0",
  "body": {
    "elements": [
      {
        "tag": "form",
        "name": "codex_prompt_form",
        "elements": []
      }
    ]
  }
}
```

官方约束：

- 表单容器只能放在卡片根节点下，不能嵌套在其它组件内；
- 表单容器不支持嵌套 `table`、`chart` 和另一个 `form`；
- 表单容器内必须至少有一个带提交属性的按钮；
- 表单容器的 `name` 在同一张卡片内必须全局唯一；
- 表单中的交互组件（包括输入框和按钮）的 `name` 必填且在整张卡片内唯一；
- 表单容器最多支持五层容器嵌套，官方建议避免复杂嵌套；
- 用户填写内容先在客户端本地缓存，点击提交按钮时一次性回调。

### 输入框

输入框使用 `tag: "input"`。放在表单容器中时：

- `name` 是回调 `form_value` 的 key，必须唯一；
- `required: true` 会在客户端做必填校验，未填写时不会向服务端发起回调；
- `input_type` 支持 `text`、`multiline_text`、`password`；
- `max_length` 默认 1000，官方取值范围为 1～1000；
- `multiline_text` 的换行符在回调中以 `\\n` 返回；
- `default_value` 可用于给输入框预填内容。

Codex Prompt 推荐使用 `input_type: "multiline_text"`，同时设置合理的 `max_length`，避免把超大上下文直接放入卡片回调或后续任务队列。

### JSON 2.0 提交按钮

JSON 2.0 表单按钮使用：

```json
{
  "tag": "button",
  "name": "submit_prompt",
  "form_action_type": "submit",
  "text": {"tag": "plain_text", "content": "继续对话"},
  "type": "primary"
}
```

清空按钮使用 `form_action_type: "reset"`。

官方 JSON 2.0 表单容器文档另外列出 `action_type` 作为“历史属性”，其旧值为 `form_submit` / `form_reset`；该写法属于旧属性兼容说明。新实现应以 JSON 2.0 文档当前示例的 `form_action_type: "submit"` / `"reset"` 为准，并在本项目的卡片发送测试中验证线上客户端兼容性。

### 传递服务端绑定键

交互组件可以在 `behaviors` 中配置 `type: "callback"`，并通过 `value` 传递自定义对象。例如：

```json
{
  "type": "callback",
  "value": {
    "binding_id": "opaque-server-side-id",
    "action": "start_next_turn"
  }
}
```

回调会把该对象放在 `event.action.value`。不要只信任客户端回传的 `thread_id` 或 Codex ID；`binding_id` 应映射到服务端数据库，并在处理前再次校验租户、适配器、操作者和状态。

## 卡片回调结构与时限

新版回调类型是 `card.action.trigger`，回调顶层结构为 `schema: "2.0"`，核心字段包括：

- `header.event_id`：本次回调唯一标识，适合做回调去重键；
- `header.token`：应用 Verification Token；
- `header.tenant_key`、`header.app_id`：应用和租户信息；
- `event.operator.open_id`（以及按权限返回的 `user_id`、`union_id`）：操作者身份；
- `event.token`：用于更新卡片的临时 token，有效期 30 分钟，最多更新 2 次；
- `event.action.value`：组件 `behaviors` 自定义的回传对象；
- `event.action.form_value`：表单组件 `name -> 用户提交值`；
- `event.action.name`：用户点击的表单按钮 `name`；
- `event.context.open_message_id`：卡片所在消息 ID；
- `event.context.open_chat_id`：卡片所在会话 ID。

官方回调结构没有把 `thread_id` 列为 `event.context` 字段。对话题绑定来说，建议优先使用 `event.action.value.binding_id` 查本地绑定；同时将 `open_message_id` 作为消息级回退索引。若要核对话题归属，可再调用“获取指定消息”或历史消息接口读取该消息的 `thread_id`。

处理要求：

1. 服务端在 3 秒内返回 HTTP 200；超时客户端会显示请求错误；
2. 不要返回 HTTP 3xx 重定向；
3. 可以返回空对象 `{}`，仅收集点击；也可以立即返回 Toast 或更新后的卡片；
4. 需要异步执行 Codex 任务时，应先在 3 秒内确认回调，再由后台队列执行，不要把会话接管、网络调用和飞书回复阻塞在回调请求中；
5. 需要更新卡片时，使用回调中的 `event.token`，且要在其 30 分钟有效期内完成，最多更新两次；
6. JSON 2.0 卡片的回传交互和可更新时间统一为 14 天，超过期限的已发送卡片不能再依赖交互回调；
7. 请求回调只适用于通过应用发送的卡片，使用群自定义机器人发送的卡片不支持该能力；
8. 若同时订阅新版和旧版卡片回调，飞书可能发送两份请求，官方建议只保留新版 `card.action.trigger`，避免重复处理。

## 面向“一个话题 = 一个 Codex 会话”的实现建议

### 本地绑定模型

建议建立一张持久化绑定表（名称可按现有 schema 规范调整）：

| 字段 | 作用 |
| --- | --- |
| `id` / `binding_id` | 服务端不透明绑定键，放入卡片 `behaviors.value` |
| `tenant_key` | 飞书租户边界；`thread_id` 的唯一性只在当前租户内成立 |
| `adapter_id` | 发送该卡片的 Feishu 适配器或凭证配置 |
| `chat_id` | 话题所在群，校验回调来源和发送权限 |
| `feishu_thread_id` | 飞书话题身份，唯一约束建议覆盖租户和适配器边界 |
| `root_message_id` | 话题根消息 ID，用于回复接口定位 |
| `codex_thread_id` | 唯一绑定的 Codex 会话 ID |
| `status` | active / closed / revoked 等本地状态 |
| `created_at`、`updated_at` | 审计和恢复 |

建议约束：

- `(tenant_key, adapter_id, feishu_thread_id)` 唯一：一个飞书话题不可绑定两个 Codex 会话；
- `(adapter_id, codex_thread_id)` 唯一：一个 Codex 会话在同一适配器下只对应一个话题；
- `root_message_id` 唯一：避免将一个根消息误分配给多个绑定；
- `binding_id` 永久稳定且不可由客户端任意构造出另一条会话。

### 推荐链路

1. Codex 会话第一次完成：发送根完成卡片，保存返回的 `root_message_id`。
2. 对根消息调用回复接口并传 `reply_in_thread=true`，得到 `thread_id`；将 `thread_id` 与 `codex_thread_id` 原子写入绑定表。
3. 需要在该会话继续发送状态或完成卡片时，读取绑定表，以 `root_message_id` 调用回复接口；每次校验返回的 `thread_id` 等于绑定值。
4. 完成卡片中的 JSON 2.0 表单使用 `binding_id` 和动作类型（如 `start_next_turn`）作为回传值，Prompt 文本由 `form_value.prompt` 读取。
5. 收到回调后先验证 Verification Token/回调签名和 `header.event_id` 去重，再校验操作者 allowlist、`tenant_key`、`open_chat_id`、绑定状态和动作类型。
6. 回调在 3 秒内返回确认；随后调用现有 Bridge/Codex continuation 队列，使用绑定的 `codex_thread_id` 发起下一 turn。
7. 记录飞书回调事件、消息 ID、`thread_id`、Codex turn ID 和 idempotency key，保证回放和故障恢复时不会创建第二个会话。

### 不应采用的映射

- 不要只按 `chat_id` 映射 Codex 会话：同一群可以有多个话题；
- 不要把 `root_id` 当成 `thread_id`：前者是消息树根消息 ID，后者是话题 ID；
- 不要把 `thread_id` 直接作为发送消息接口的 `receive_id`：官方 `send message` 的 `receive_id_type` 不包含 `thread_id`；
- 不要只依赖回调里的 `open_message_id` 推导唯一会话：卡片可能在同一话题中发送多条消息，应使用不透明 `binding_id` 加数据库校验；
- 不要在飞书卡片回调请求内同步等待 Codex 完成；必须快速确认，再异步调度。

## 关键权限与运行限制

- 发送或回复消息要求应用启用机器人能力；机器人需要在目标群内且有发言权限。
- 查询群历史消息需要相应消息读取权限；查询群消息通常还需要“获取群组中所有消息”等权限，具体以应用身份和用户身份的官方权限说明为准。
- 同一用户或同一群消息发送限频为 5 QPS；接口本身还标注 1000 次/分钟、50 次/秒的调用频率限制，应用应做队列和退避。
- 文本消息请求体最大 150 KB，卡片和富文本消息请求体最大 30 KB。Prompt 输入应设置上限并在服务端再次校验。
- 应用需要发布版本，权限、机器人能力和回调配置才会生效。

## 官方资料

- [话题概述](https://open.feishu.cn/document/im-v1/message/thread-introduction)
- [消息管理概述](https://open.feishu.cn/document/server-docs/im-v1/message/intro)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)
- [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)
- [获取会话历史消息](https://open.feishu.cn/document/server-docs/im-v1/message/list)
- [表单容器（JSON 2.0）](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)
- [输入框组件（JSON 2.0）](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input)
- [按钮组件（JSON 2.0）](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)
- [卡片 JSON 中配置卡片交互](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions)
- [卡片回传交互回调](https://open.feishu.cn/document/feishu-cards/card-callback-communication)
- [处理卡片回调](https://open.feishu.cn/document/feishu-cards/handle-card-callbacks)

