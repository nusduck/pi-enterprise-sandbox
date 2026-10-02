# 远端委派接入火山引擎 HiAgent（应用对话 API）

日期：2026-10-03。状态：**已实施，待真实链路验收**。
前置：[远端 A2A 委派](a2a-remote-delegation.md)（已实施）。HiAgent 不提供 A2A，只能走其应用 API。

## 0. 一句话

在现有 `delegate_to_remote_agent` 工具与 `A2A_REMOTE_AGENTS_JSON` 登记表上加第二种协议 `hiagent`：
登记条目写 `protocol: "hiagent"`，工具按协议选择客户端。HiAgent 侧会话可以**多轮续聊**：
同一个平台会话里对同一个远端的连续委派，默认续用上一次的 HiAgent 会话。AgentVersion 配置、
审批策略、前端「协作」tab 都不变。

## 1. HiAgent 应用 API（核实来源：官方 SDK 源码）

来源：[volcengine/hiagent-python-sdk](https://github.com/volcengine/hiagent-python-sdk)（Apache-2.0，
2026-07-23 提交 `cb86a8a`），`libs/api/hiagent_api/base.py` 的 `AppAPIMixin` 与 `chat.py` / `chat_types.py`。
SDK 只是 HTTP 封装，本仓库直接用 `fetch` 实现，不引入 Python 依赖：

| 动作 | 请求 | 要点 |
|---|---|---|
| 鉴权 | 请求头 `Apikey: <AppKey>`，`Content-Type: application/json` | AppKey 由 HiAgent 平台「个人中心 → 开发指引」发放 |
| 地址 | `POST {APP_BASE_URL}/{action}` | `APP_BASE_URL` 由部署提供（SDK 读 `HIAGENT_APP_BASE_URL`），各项目域名不同 |
| 建会话 | action `create_conversation`，body `{ AppKey, Inputs: {}, UserID }` | 响应含 `Conversation.AppConversationID` |
| 对话 | action `chat_query_v2`，body `{ AppKey, AppConversationID, Query, ResponseMode: "blocking", UserID }` | 阻塞响应字段：`event, task_id, id, conversation_id, answer, created_at, think_messages?, tool_messages?` |
| 错误 | 响应体含 `ResponseMetadata.Error.{Code, Message}` | SDK 以「包含 ResponseMetadata、Code、Error」判定错误 |

本期只用阻塞模式。流式（SSE）、`chat_again`、长期记忆、工作流接口不做。实现时以 SDK 源码为准核对字段
大小写；任何未知响应形状按错误处理，不猜测。

## 2. 决定

| # | 决定 |
|---|---|
| H1 | 登记表复用 `A2A_REMOTE_AGENTS_JSON`，条目新增可选 `protocol: "a2a" \| "hiagent"`（缺省 `a2a`，现有条目不变）。`hiagent` 条目字段：`id, name, description, baseUrl, authTokenRef（AppKey 所在环境变量名）, timeoutMs, enabled`；`cardUrl` 对 hiagent 不适用，`baseUrl` 对 a2a 不适用，混用 → 启动失败。URL 规则与现有一致（生产必须 https、不得内嵌凭据）。 |
| H2 | 工具名、参数、审批分类不变（`external_high`，默认需审批）。新增可选参数 `new_conversation: boolean`（默认 false）：为 true 时强制新建远端会话。对 A2A 远端该参数被忽略（A2A 仍是一问一答，见其设计 §2 非目标）。 |
| H3 | 远端会话绑定存在服务端：新表记录 `(org_id, user_id, conversation_id, remote_agent_id) → remote_conversation_id`。模型**拿不到也传不进**远端会话 ID，避免借一个 ID 访问别人的远端会话。 |
| H4 | `UserID` 传平台用户的 `user_id`（ULID，稳定、不含姓名邮箱）。 |
| H5 | 远端会话失效（HiAgent 返回会话不存在类错误）时：删绑定、新建会话、**只重试一次**；其他错误直接按工具错误返回。 |
| H6 | 出站调用有超时（条目 `timeoutMs`，缺省同 A2A 600s）与 `AbortSignal`；响应体大小上限与 A2A 客户端一致；返回文本截断规则与 A2A 一致。 |
| H7 | 结果形状沿用 `RemoteDelegationResult`（`remoteAgent, taskId, state, text, artifacts: []`）：`taskId` 取 HiAgent 的 `task_id`，`state` 取 `completed`，`think_messages` / `tool_messages` 不回给模型（体积与泄露面）。 |

## 3. 数据

新迁移（UPspec 命名，`withPartialDdlCleanup`）：`tbl_agsvc_remote_conversations`

| 列 | 说明 |
|---|---|
| `binding_id CHAR(26)` PK | |
| `org_id`, `user_id`, `conversation_id` CHAR(26) NOT NULL | 平台作用域 |
| `remote_agent_id VARCHAR(32) NOT NULL` | 登记表 id |
| `remote_conversation_id VARCHAR(191) NOT NULL` | HiAgent `AppConversationID` |
| `created_at`, `updated_at` DATETIME(3) | |

唯一索引 `(conversation_id, remote_agent_id)`；查询一律带 `org_id` 与 `user_id`。会话删除时的清理结论：
会话删除是软删除（`ConversationRepository.archive` 只改 `status`/`archived_at`，不删行，
`conversation-service.ts` 的删除路径即归档 + Sandbox 工作区 GC），且 `conversation_id` 是永不复用的
ULID——归档后残留的绑定行永远不会被再次命中（新会话拿新 id），查询又一律带 scope，
所以**不需要额外清理**，也没有孤儿外键问题（外键指向的行一直都在）。

## 4. 代码落点

- `agent/src/runtime/providers/a2a-remote-registry.ts`：解析 `protocol` 与 `baseUrl`，类型改为按协议区分的联合类型。
- 新文件 `agent/src/runtime/providers/hiagent-client.ts`：`HiAgentClient.delegate({ entry, prompt, userId, remoteConversationId?, signal })`。
- `delegate-to-remote-agent.ts`：按 `entry.protocol` 分派；hiagent 分支读写会话绑定。
- `run-services.ts`：`remoteDelegation` 增加作用域（`orgId, userId, conversationId`）与绑定存取端口；装配处从 Run 账本填充。
- MySQL 仓储：`remote-conversation-repository.ts`。
- 委派提示词（`application/delegation-prompt.ts`）对 hiagent 远端补一句「同一会话内会延续上下文，需要全新对话时传 `new_conversation: true`」。

## 5. 测试与验收

- 单测：登记表解析（新字段、协议混用、缺省协议、生产 https）；客户端（成功、错误体、非 JSON、超时、超大响应、
  头部带 `Apikey`、body 字段名与大小写）；续聊（首次建会话并落绑定、第二次复用、`new_conversation` 新建、
  会话失效重建且只重试一次）；跨用户：同一 conversation_id 不同 user 查不到绑定。
- 用一个本地假 HiAgent HTTP 服务（测试内起 `node:http`）覆盖端到端，不依赖外网。
- 真实链路：compose 中以假 HiAgent 容器接入 agent 网络，登记一个 hiagent 远端，配置智能体授权，跑两轮委派确认续聊、
  审批照常出现、工具账本有记录。连真实 HiAgent 需要部署方提供 `baseUrl` 与测试应用 AppKey，属最终验收。
- 文档：`deployment.md`（`A2A_REMOTE_AGENTS_JSON` 新字段与示例）、`architecture.md`（出站委派一段）、
  `a2a-remote-delegation.md` 指向本文、`.env.example`（占位示例）、`CHANGELOG.md`。
