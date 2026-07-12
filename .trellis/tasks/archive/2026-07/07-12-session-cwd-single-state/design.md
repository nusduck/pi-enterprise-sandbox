# Design — session cwd 与单一运行时状态源

## 现状与问题

### Agent cwd

数据流当前为：

```text
Sandbox SessionManager.create
  -> workspace_id + internal _physical_workspace
  -> public SessionResponse (only workspace_id)
  -> Agent resolveConversationAndSession
  -> Pi SDK objects (cwd hard-coded /tmp)
```

Sandbox 已正确隐藏物理路径，但 Agent 没有把 session 工作区逻辑契约带入 Pi SDK，导致 session
header、资源加载和 SDK 上下文都声称 cwd 是 `/tmp`。

### 前端状态

同一 `/chat` SSE 当前同时经过：

```text
SSE -> legacyAdapter -> Run reducer -> EntityStore
  \-> sseHandler -> ChatState.currentMsg/pending* 
```

React 又把 `EntityStore.activeRunId` 镜像到独立 `activeRunId` state。运行状态可因 stale generation、
异步 setState 顺序或 conversation 切换而分叉。

## 设计决策

### 1. Session cwd 契约

- 在 Agent 配置集中定义 session 工作区逻辑 cwd，默认 `/home/sandbox/workspace`，与 Sandbox 的
  `AGENT_WORKSPACE_PATH` 契约一致。
- `resolveConversationAndSession` 返回 `sessionCwd`，其值在 Sandbox session 创建/复用完成后确定。
- `runAgentTurn` 将 `sessionCwd` 显式传给 `resolveAgentSessionManager`，并用于 SettingsManager、
  DefaultResourceLoader 和 `createAgentSession`。
- `resolveAgentSessionManager` 将同一 cwd 用于 in-memory、新建和恢复 SessionManager；新建 header
  fallback 也只引用该变量。
- 恢复时以当前 Sandbox session 解析出的 cwd 覆盖 materialized JSONL header 的旧 cwd 语义；数据库
  中持久化的新 header 保持统一。不得信任客户端传入的物理路径。
- Agent 仍不挂载或直接读写 Sandbox workspace；custom tools 继续只接受相对路径并通过 REST 执行。

### 2. EntityStore 为 runtime 唯一 source of truth

- `/chat` SSE 边界只调用一次 legacy adapter + Run reducer。删除 `handleSSEEvent` 对 runtime 字段的
  第二次归约路径。
- EntityStore 持有 run、增量 assistant message、tool、process、approval、artifact、session entity 与
  active run selection。
- `activeRunId` 直接读取 `entityStore.activeRunId`；移除独立 `useState`。
- UI 通过 selector/projection 获取当前 run message、状态、审批与 artifacts。`displayMessages` 由
  服务端历史 `ChatState.messages` 加当前 run 的 EntityStore 消息投影组成，并按稳定 id/归属去重。
- run 终止时不把 EntityStore 消息复制回 ChatState；服务端 conversation history 仍是跨刷新历史来源，
  下一次加载 conversation 时替换历史 snapshot。
- flash/status、上传草稿、sidebar、auth 等纯 UI 状态继续留在 ChatState。由 runtime event 触发的 UI
  side effect 从已归约 EntityStore 的变化派生，不能再自行解析并存储同一业务实体。

## 兼容与边界

- 保留 legacy `/chat` wire protocol；本次只移除浏览器内部双写，不要求后端切换为新 Run SSE API。
- 保留现有 `ChatController.state` API，逐步缩小 ChatState runtime 字段使用；删除字段时同步所有组件和测试。
- 后台 run manager 生命周期不受 conversation focus 影响；Stop 只停止指定 run。
- 旧持久化 Pi header 中的 `/tmp` 可读取，但恢复出的当前 SessionManager cwd 必须用新契约。

## 风险与控制

- Entity reducer 若缺少 legacy event 映射会造成 UI 行为回退：为 token/tool/approval/artifact/error/done
  建立映射/selector 回归测试。
- 历史消息与当前 run 消息可能重复：投影使用 run/message id，并在服务端历史刷新边界清晰替换。
- SDK ResourceLoader 面对逻辑 cwd 不存在于 Agent 容器：验证 SDK 对缺失目录的行为；如要求目录存在，只创建
  空的逻辑占位目录，不挂载物理 workspace，也不改变安全边界。
- 配置漂移：compose、Agent 默认值、Sandbox 默认值和文档测试共同断言 `/home/sandbox/workspace`。

## Rollback

- cwd 变更可通过 Agent 配置恢复为 `/tmp`，不涉及 Sandbox 数据迁移。
- 前端按提交整体回滚到 dual-write bridge；不改变后端存储 schema 或 wire protocol。
