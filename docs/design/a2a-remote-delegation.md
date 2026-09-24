# 远端 A2A 委派：让 Agent 调用其他部署的 A2A Agent（设计与实施计划）

本文档约束「出站 A2A」能力：**Run 执行中，模型通过一个工具把自包含任务发给运维登记过的
远端 A2A Agent（其他团队、其他部署，也可以是本部署自己的 A2A 面），等待结果**。

同 org 内的委派见 [`agent-delegation.md`](agent-delegation.md)；本文沿用其配置键 `delegation`
与「缺省不可委派」原则。

---

## 0. 一句话

本仓库目前**只有 A2A 服务端**（ADR 0010 保留的自建协议面），没有客户端：
`rg '@a2a-js/sdk/client|ClientFactory' agent/src` 无结果。本设计用官方
`@a2a-js/sdk/client` 做出站调用，远端清单只来自环境变量（与 `MCP_SERVERS_JSON` 同一纪律），
授权在 AgentVersion 上逐 Agent 声明，工具默认需要人工审批。

---

## 1. 已核实的事实

```bash
# 依赖已在，client 入口由包导出
grep -n '"@a2a-js/sdk"' agent/package.json                      # 1.1.0
grep -n '"./client"' agent/node_modules/@a2a-js/sdk/package.json

# client 支持注入 fetchImpl（超时、鉴权在这里做）与 per-request AbortSignal
grep -n 'fetchImpl\|signal?: AbortSignal' \
  agent/node_modules/@a2a-js/sdk/dist/client/index.d.ts \
  agent/node_modules/@a2a-js/sdk/dist/multitransport-client-*.d.ts

# ADR 0010 否决的只是 SDK 服务端（resubscribe、多租户审计、方法名双轨），不涉及客户端
grep -n '^### ' docs/adr/0010-retain-custom-a2a-server-layer.md   # 三条摩擦均为服务端

# 外部连接清单只走环境变量、凭据只写 env 名的先例
grep -n 'MCP_SERVERS_JSON' docs/deployment.md
grep -n 'MCP_FORBIDDEN_V1_KEYS' agent/src/application/agent-config-validator.ts

# 我们自己的 A2A 服务端：Bearer 凭据、按 Agent 的卡片与 JSON-RPC 端点
sed -n 1,12p agent/src/presentation/a2a/http-handler.ts
```

---

## 2. 目标与非目标

**目标**

- 运维用 `A2A_REMOTE_AGENTS_JSON` 登记远端 Agent（地址、凭据引用、超时）。
- 管理员在 AgentVersion 的 `delegation.remoteAgents` 里授权本 Agent 可调用哪些远端。
- 模型用 `delegate_to_remote_agent` 发任务、前台等待、拿回文本结果。
- 全部出站有超时、有响应大小上限、默认要审批、记入工具账本。

**非目标（本轮不做）**

- 远端返回的文件字节自动导入工作区（只返回产物的名称与链接）。
- 多轮会话 / 续聊（`contextId` 每次新建）、`INPUT_REQUIRED` 的人机往返。
- push notification、gRPC 传输、OAuth 等非 Bearer 鉴权。
- 在数据库里保存远端凭据或由管理员在 UI 上登记远端（没有静态加密设施，见 D2）。

---

## 3. 设计决策

### D1 用官方 SDK 客户端，不自建

ADR 0010 保留自建服务端的三条理由（跨进程续传、多租户审计拦截、方法名双轨）都是服务端
问题。客户端侧我们只需要「取卡片 → 发消息 → 查任务 → 取消」，SDK 的 `ClientFactory`
正好覆盖，且会跟随协议版本演进。用 JSON-RPC 传输（`JsonRpcTransportFactory`）。

### D2 远端清单只来自 `A2A_REMOTE_AGENTS_JSON`

```jsonc
[
  {
    "id": "finance-bot",                  // [A-Za-z0-9_-]{1,32}，AgentVersion 引用它
    "name": "财务助手",
    "description": "查询报销与预算",       // 进系统提示，给模型看
    "cardUrl": "https://finance.example/a2a/agents/01J.../.well-known/agent-card.json",
    "authTokenRef": "A2A_FINANCE_TOKEN",   // 环境变量名；明文只在进程内存
    "timeoutMs": 600000,                   // 单次委派总时限，默认 600000，上限 3600000
    "enabled": true
  }
]
```

- 理由与 `MCP_SERVERS_JSON` 相同：地址与凭据是运维面，不进提交的 YAML、不进 AgentVersion
  快照、不进数据库。仓库没有静态加密设施，把 Bearer 凭据写进 MySQL 等于明文落库。
- 进程启动时解析，**非法即拒绝启动**（fail-closed）：重复 id、id 格式错、`cardUrl` 不是
  绝对 URL、`authTokenRef` 指向的变量不存在或为空、`timeoutMs` 越界。
- 生产环境拒绝 `http:`（`agent/config.ts` 启动时解析即拒）；开发 Compose 允许 `http:` 以便
  指向本部署的 `agent` 服务做回环验证。
- 不参与 `/ready`：远端是按需调用，不是常驻依赖；一个远端宕机不应让整个 Agent 下线。
  调用失败以工具错误返回。

### D3 授权：`delegation.remoteAgents` 白名单，缺省拒绝

```jsonc
"delegation": { "agents": ["data-analyst"], "remoteAgents": ["finance-bot"] }
```

保存期校验每个 id 都在当前 `A2A_REMOTE_AGENTS_JSON` 的启用清单里（否则
`DELEGATION_REMOTE_AGENT_UNKNOWN`）；运行时再校验一次（清单可能随重启变化）。
AgentVersion 里**不接受**地址、凭据、超时（与 `mcpServers` 的 `MCP_FORBIDDEN_V1_KEYS` 同理）。

### D4 模型入口 `delegate_to_remote_agent`，默认需要审批

参数：`agent`（远端 id）、`description`、`prompt`。

- 风险分类为 `external_high`：它把本会话内容发到外部系统。平台默认
  `high → require_approval`；租户只能再收紧。运维确需免审批时改 `tool-risk.json`。
- 模型**不能**提供 URL：地址只来自登记表，因此没有 SSRF 面。
- 可调用的远端（名称 + 描述）与 `agent-delegation.md` D4 同一段系统提示一起列出。

### D5 调用流程与超时

1. 取卡片：`cardUrl`，单请求超时 10 s；进程内按 id 缓存 5 min。卡片声明的 JSON-RPC 端点
   必须与 `cardUrl` **同源**，否则拒绝（防卡片把凭据引向第三方）。
2. 发送：`sendMessage`，`configuration.returnImmediately = true`；`messageId` =
   `sha256(runId + ":" + callId)` 派生的 UUID，同一次工具调用重试时远端可据此去重。
3. 若返回的是 `Task` 且未到终态：`getTask` 轮询，2 s 起指数退避到 15 s，直到终态或总时限。
4. 终态映射：`COMPLETED` → 成功；`FAILED` / `REJECTED` / `CANCELED` → 工具错误；
   `INPUT_REQUIRED` / `AUTH_REQUIRED` → 工具错误 `A2A_REMOTE_NEEDS_INPUT`（本轮不支持往返）。
5. 超时或 `AbortSignal`（父 Run 被取消）：尽力发一次 `cancelTask`（5 s 超时），然后返回错误。
6. 每个 HTTP 请求都经注入的 `fetchImpl`：加 `Authorization: Bearer <token>`、单请求 30 s 超时、
   响应体上限 1 MiB，超出即中止。

### D6 结果

返回 `{ remoteAgent, taskId, state, text, artifacts: [{ name, mimeType, url? }] }`。
`text` 取最终状态消息与文本类 artifact 的文本部分，合计截断到 16 000 字符；字节内容不下载。
两处都没有文本时，再带 `historyLength` 读一次 `GetTask`，取 history 里最后一条 agent 消息——
本仓库自己的 A2A 面就只把回答放在 history 里（2026-09-24 真实链路发现）。仍读不到则报
`A2A_REMOTE_UNAVAILABLE`，不把「读不到答案」报成「完成但没有回答」。

### D7 审计

不新增表。工具账本（`tool_executions`，含 `started` / `ended` / `unknown` 三态）已记录参数、
结果与审批；另打一行结构化日志 `[a2a-client] remote=<id> task=<taskId> state=<state> ms=<n>`，
**不记录 prompt 与 token**。需要按远端汇总的审计报表时再加表。

---

## 4. 权威边界

| 层 | 职责 |
|---|---|
| `agent/src/runtime/providers/a2a-remote-registry.ts` | 清单解析（`agent/config.ts` 启动时调用，生产拒绝 `http:`） |
| `agent/src/runtime/providers/a2a-remote-client.ts` | SDK 客户端封装（fetchImpl、超时、大小上限、同源检查） |
| `agent/src/runtime/providers/delegate-to-remote-agent.ts` | `delegate_to_remote_agent` 插件 |

> 客户端放在 `runtime/providers/` 而不是 `infrastructure/`：工具插件在 runtime 层，而 runtime 不得反向依赖
> infrastructure（`tool-names.ts` 文件头）。它与同层的 `exec-rpc.ts` 同一性质——出站 RPC 客户端。
| `agent/src/application/agent-config-validator.ts` | `delegation.remoteAgents` 校验 |
| `api-server/` / `frontend/` | 本轮无改动 |

---

## 5. 错误码

| 码 | 何时 |
|---|---|
| `DELEGATION_NOT_CONFIGURED` | 本 Agent 无 `delegation.remoteAgents` |
| `DELEGATION_AGENT_NOT_ALLOWED` | `agent` 不在白名单或不在当前登记表 |
| `A2A_REMOTE_UNAVAILABLE` | 取卡片 / 发送失败、HTTP 非 2xx、响应过大、同源检查失败 |
| `A2A_REMOTE_TIMEOUT` | 超过 `timeoutMs` |
| `A2A_REMOTE_FAILED` | 远端任务终态为失败 / 拒绝 / 取消 |
| `A2A_REMOTE_NEEDS_INPUT` | 远端要求补充输入或鉴权 |
| `DELEGATION_REMOTE_AGENT_UNKNOWN`（保存期） | 配置引用未登记的远端 |

---

## 6. 实施阶段

1. **清单**：`A2A_REMOTE_AGENTS_JSON` 解析与启动期校验、生产配置拒绝 `http:`；
   `.env.example` 与 `deployment.md` 同步。
2. **客户端**：SDK 封装 + 单测（用本地 HTTP 假服务端覆盖：成功、轮询、失败终态、超时后
   cancel、响应过大、卡片端点跨源）。
3. **配置与工具**：`delegation.remoteAgents` 校验与投影；`delegate_to_remote_agent` 插件、
   风险分类 `external_high`、系统提示段。
4. **文档**：`architecture.md`、`api.md`、`deployment.md`、`CHANGELOG.md`。

---

## 7. 验收

- 单测如上；`npm test --prefix agent`、类型检查、`uv run pytest -q`。
- **真机回环**（重建 `agent` / `agent-worker`）：在本部署签发一个 A2A 凭据，
  `A2A_REMOTE_AGENTS_JSON` 指向本部署 Agent B 的卡片；Agent A 授权该远端后发起委派：
  1. 工具先进入审批 → 批准 → 远端（即本部署）生成 A2A task 与 Run → 结果文本回到父 Run；
  2. 拒绝审批 → 不发出任何出站请求（远端没有新 task）；
  3. 未授权的 Agent 调用 → `DELEGATION_AGENT_NOT_ALLOWED`，无出站请求；
  4. 取消父 Run → 远端 task 收到 cancel。
