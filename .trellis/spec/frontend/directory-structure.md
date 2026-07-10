# 前端目录结构

```text
frontend/
├── index.html          # 页面骨架、DOM 挂载点与静态控件
├── src/
│   ├── main.js         # 应用编排、事件绑定、SSE handler、会话/上传流程
│   ├── api.js          # /api fetch、SSE stream reader、URL builder
│   ├── state.js        # 单一状态对象、订阅/更新、本地持久化与消息规范化
│   ├── render.js       # DOM 引用、全量/增量渲染、侧栏和交付物
│   └── style.css       # 主题、布局、响应式和组件样式
├── vite.config.js      # dev server :5173，/api -> :4000，dist 输出
├── nginx.conf          # 生产静态托管、SSE 友好 /api 反代、SPA fallback
├── Dockerfile          # Vite build -> Nginx 多阶段镜像
└── package.json
```

## 新代码落点

- HTTP/SSE 协议和 endpoint helper：`src/api.js`。
- 顶层用户流程、异步编排、事件监听：`src/main.js`。
- 共享 UI state、持久化、server/UI message shape 转换：`src/state.js`。
- DOM 创建、更新、展示 helper：`src/render.js`。
- 视觉规则、响应式与主题 token：`src/style.css`。

当前模块较少，尚无按 feature 拆目录的既有模式。新增单个 helper 应留在所属模块；只有当一个职责形成多个独立文件时再引入子目录。

## 命名

- 文件名：当前为简短小写名；未来多词文件优先 `kebab-case.js`，与服务端 JS 一致。
- 函数/变量/state 字段：`camelCase`；常量：`UPPER_SNAKE_CASE`。
- DOM 引用在 `render.js` 的 `dom` 对象中集中保存，HTML ID 当前使用 `kebab-case`。
- API JSON 字段保留服务端 `snake_case`，映射到本地时使用 `camelCase`，如 `sandbox_session_id -> sessionId`。

## 待确认

- **待确认：** 文件规模继续增长后是否按 feature 拆分；仓库尚未形成该模式。
- **待确认：** `@earendil-works/pi-web-ui` 依赖是否仍计划使用；当前源码没有 import。

