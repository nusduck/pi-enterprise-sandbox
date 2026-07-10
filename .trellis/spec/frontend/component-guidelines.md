# DOM 组件与渲染规范

## 当前组件模型

仓库没有框架组件。可复用 UI 单元由 `render.js` 中返回/修改 DOM 的函数表达：

- `renderMsg` 创建消息节点。
- `renderConversationList` 创建会话项并注入 select/delete handler。
- `renderDeliverables` 创建 artifact 下载 chip。
- `applySidebarLayout` 根据 state 与 media query 切换 class。
- `renderMessagesFull` 用于会话切换；`incBubble`/`rerenderLast` 用于流式增量更新。

新增 UI 单元沿用“数据 + handlers -> DOM”的边界，避免在 render helper 内直接发 API 请求或修改全局业务 state。

## DOM 安全

- 外部文本优先赋给 `textContent`，如 conversation title。
- 必须拼 HTML 时先使用 `esc`/`escText`；`renderMsg`、`flashError`、artifact label 已采用该模式。
- 只对代码内固定模板使用未经 escape 的 `innerHTML`。
- 新增含用户输入的 HTML attribute、URL 或 tool result 时，逐字段 escape；不要直接插入 API 返回对象。

## 渲染策略

- 普通 state patch 由 `subscribe` 选择性触发相关区域，避免每次重建整页。
- stream token 使用 `incBubble` 更新最后一个 assistant bubble，保留 tool pills 与 download links。
- conversation 切换必须 `renderMessagesFull`，避免复用上一会话 DOM。
- 修改 DOM 后需要保持 `scrollBottom`、send button 状态和 input disabled 状态一致。

## 事件处理

- 事件 listener 在 `main.js` 启动阶段或元素创建时绑定。
- 对 optional DOM 使用 `?.` 或 guard；核心挂载点由 `initDOM` 一次注入。
- 删除等破坏性用户动作先确认；streaming 中禁止会破坏当前上下文的切换/删除。
- 异步 handler 捕获错误并反馈用户，不产生未处理 Promise rejection。

## 不适用与待确认

- React props/context、Vue composition API、CSS-in-JS、前端 hooks 当前均不适用，不要写成既有规范。
- **待确认：** 是否需要引入可访问性自动检查；当前主要依赖语义元素、`role`、button 和手工行为。

