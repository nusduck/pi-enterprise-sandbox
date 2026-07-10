# 前端开发规范

当前前端是 **Vanilla JavaScript SPA**：Vite 只负责开发服务器和 bundle，生产由 Nginx 静态托管并反向代理 `/api/`。源码没有 React/Vue/Svelte 组件或 hooks。

## 开发前检查

- 先判断变更属于 API/SSE 协议、状态、渲染还是页面样式。
- 新 SSE event 必须同时检查 `api.js` 解析、`main.js::handleSSE`、`render.js` 呈现和 Node `chat.js` 发送端。
- 任何 `innerHTML` 内容都必须区分静态模板和外部数据；外部文本先经 `esc`/`escText` 或改用 `textContent`。
- 会话切换、streaming、artifact、approval 等状态必须走 `state.js::update`，并检查订阅触发范围。

## 详细规范

- [directory-structure.md](directory-structure.md)
- [component-guidelines.md](component-guidelines.md)
- [state-management.md](state-management.md)
- [hook-guidelines.md](hook-guidelines.md)
- [type-safety.md](type-safety.md)
- [quality-guidelines.md](quality-guidelines.md)

## 质量检查

- `node --check` 覆盖修改的 JavaScript。
- 安装依赖后运行 `npm run build --prefix frontend`。
- 手工检查 SSE 增量消息、终止、conversation 切换、移动端 sidebar、upload/download、approval。
- 不把 LLM key、Agent SDK 或安全决策带到浏览器。

