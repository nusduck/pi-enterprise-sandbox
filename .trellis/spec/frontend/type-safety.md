# 前端类型与协议安全

## 当前事实

- 前端和 Node API Server 都是普通 JavaScript ESM，没有 TypeScript、`tsconfig.json` 或类型检查脚本。
- 公共 API helper 使用 JSDoc 标注参数/返回值；复杂运行时数据通过显式 guard、optional chaining 和 `Array.isArray` 收窄。
- Agent 工具参数在服务端 `sandbox-tools.js` 使用 TypeBox schema；浏览器自身没有 runtime schema library。

## 现有防御模式

- 外部数组：`Array.isArray(messages)` 后再迭代。
- 可选字段：`body?.title`、`signal?.aborted`、`handlers.onDelete?.(...)`。
- 消息内容：兼容 string、content parts 和 `parts`，实例见 Node `extractMessageText` 与前端 `normalizeServerMessages`。
- HTTP error body：`resp.json().catch(() => ({}))`，再使用 fallback message。
- ID 与路径进入 URL：`encodeURIComponent` 或 `URLSearchParams`。

## 新协议字段

- 在 producer 和 consumer 两端同时记录字段是否必需、fallback 和命名风格。
- 服务端 wire format 保留 `snake_case`；UI state 使用 `camelCase`。
- 不用 truthy 判断替代合法的 `0`/空数组语义；例如 size 使用 `!= null`。
- 对 SSE event 未知 type 保持无副作用忽略；已知 type 缺关键 ID 时提前退出。

## 待确认

- **待确认：** 是否迁移 TypeScript 或启用 `// @ts-check`。当前仓库没有形成此约定。
- **待确认：** 是否为 SSE/REST 响应增加前端 runtime schema 验证。

