# Pi Enterprise Sandbox — 重构执行方案

> 版本：v2.0 · 2026-07-04
> 执行人：Hermes Agent
> 状态：🔄 执行中

---

## 一、重构目标

| # | 目标 | 优先级 | 当前状态 |
|---|------|--------|---------|
| 1 | 升级到 `@earendil-works/pi-agent-core`（新版 SDK，支持 Extension） | P0 | ❌ |
| 2 | Extension 统一工具注册，删除 agent-factory.js | P0 | ❌ |
| 3 | 替换 WebUI 为 `@earendil-works/pi-web-ui`（官方组件） | P0 | ❌ |
| 4 | 数据存储：SQLite + PostgreSQL 双后端支持 | P0 | ❌ |
| 5 | Conversation 持久化迁移到数据库 | P0 | ❌ |
| 6 | 后端 SDK + REST API 封装（前端同事调用） | P1 | ❌ |
| 7 | 测试覆盖：编排链路 + 存储双后端 + WebUI API | P1 | ❌ |

---

## 二、执行路线

### Iter 1: 升级依赖 + Extension 统一工具注册

**变更文件清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| ✏️ 修改 | `webui/package.json` | `@mariozechner` → `@earendil-works` |
| ✏️ 修改 | `agent/enterprise-sandbox-ext/package.json` | 添加 `skill_view.ts` 工具 |
| ✏️ 修改 | `agent/enterprise-sandbox-ext/index.ts` | 添加 skill_view 工具注册 |
| ✏️ 修改 | `webui/services/agent-factory.js` | 改为从 Extension import 工具 |
| ✏️ 修改 | `webui/services/sandbox-client.js` | 保持为 API 代理层 |
| ✏️ 修改 | `webui/routes/chat.js` | 适配新版 Agent API |
| ✏️ 修改 | `webui/services/conversation-manager.js` | 适配新版 Agent |

### Iter 2: 替换 WebUI 为 `@earendil-works/pi-web-ui`

**变更文件清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| ✏️ 修改 | `webui/package.json` | 添加 `@earendil-works/pi-web-ui` |
| ✏️ 修改 | `webui/index.html` | 使用 pi-web-ui ChatPanel |
| ✏️ 精简 | `webui/server.js` | 精简为静态文件 + API 代理 |
| 📝 新增 | `webui/api/sessions.js` | REST API: 会话管理 |
| 📝 新增 | `webui/api/chat.js` | REST API: 聊天 |
| 📝 新增 | `webui/api/files.js` | REST API: 文件操作 |
| 📝 新增 | `webui/api/artifacts.js` | REST API: artifact 查询 |

### Iter 3: 数据存储重构

**变更文件清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| ✏️ 修改 | `sandbox/database.py` | 支持 SQLite + PostgreSQL 双后端 |
| ✏️ 修改 | `sandbox/config.py` | 添加 PostgreSQL 连接配置 |
| ✏️ 修改 | `sandbox/repositories.py` | 抽象为 StorageBackend 接口 |
| ✏️ 修改 | `sandbox/services/session_manager.py` | 适配双后端 |
| ✏️ 修改 | `sandbox/services/execution_manager.py` | 适配双后端 |
| ✏️ 修改 | `sandbox/services/artifact_manager.py` | 适配双后端 |
| ✏️ 修改 | `sandbox/services/audit_logger.py` | 适配双后端 |
| ✏️ 修改 | `sandbox/database.py` | 添加 conversations 表 |
| ✏️ 修改 | `webui/services/conversation-manager.js` | 从本地 JSON 迁移到 sandbox DB |

### Iter 4: 后端 SDK + REST API

**变更文件清单：**

| 操作 | 文件 | 说明 |
|------|------|------|
| 📝 新增 | `sdk/index.ts` | SDK 入口 |
| 📝 新增 | `sdk/client.ts` | Sandbox API 客户端 |
| 📝 新增 | `sdk/types.ts` | 类型定义 |
| 📝 新增 | `sdk/package.json` | SDK 包配置 |
| 📝 新增 | `sdk/examples/basic.js` | 示例代码 |
| ✏️ 修改 | `README.md` | 更新 API 文档 |

### Iter 5: 测试与验证

| 测试 | 说明 |
|------|------|
| `tests/test_storage_backends.py` | SQLite / PostgreSQL 双后端 |
| `tests/test_agent_orchestration.py` | Agent + Sandbox 完整链路 |
| `tests/test_conversation_persistence.py` | 对话持久化和恢复 |
| 现有 14 个测试文件 | 确保全部通过 |

---

## 三、当前工作目录状态

- **项目根目录**: `/root/app/pi-sandbox`
- **Git 状态**: 需先 commit 当前工作
- **当前镜像**: `enterprise-sandbox:latest`
- **Node 依赖**: `@mariozechner/pi-agent-core ^0.52.6`（旧版）
- **Sandbox Python**: 3.11-slim + SQLite WAL ✅
- **Extension**: TypeScript，需要 `ts-node` 或编译

---

## 四、关键 API 兼容性注意

### 新版 Agent API (@earendil-works/pi-agent-core)

```typescript
// 新版构造方式
const agent = new Agent({
  initialState: {
    systemPrompt: string,
    model: modelConfig,
    messages: [],
    tools: [],     // 可由 Extension 自动注册
  },
  convertToLlm: defaultConvertToLlm,
});

// 事件订阅
agent.subscribe((event) => {
  // turn_start | message_update | tool_execution_start | tool_execution_end | agent_end
});

// 消息
await agent.prompt(message);
```

### pi-web-ui 使用

```html
<script type="module">
  import { ChatPanel, setAppStorage, AppStorage, SessionsStore } from '@earendil-works/pi-web-ui';
  import { Agent } from '@earendil-works/pi-agent-core';
  
  const agent = new Agent({...});
  const chatPanel = new ChatPanel();
  await chatPanel.setAgent(agent);
  document.body.appendChild(chatPanel);
</script>
```
