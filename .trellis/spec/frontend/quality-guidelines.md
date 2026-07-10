# 前端编码与质量规范

## JavaScript 风格

- ESM、显式 `.js` 导入、2 空格缩进、单引号和分号是 `frontend/src` 的主要风格。
- `const` 优先，只有需要重绑定的 state/局部值使用 `let`；不使用 `var`。
- 异步流程使用 `async/await` 和边界 `try/catch/finally`。
- API、state、render、orchestration 职责分离；不要在 `render.js` 直接 fetch，也不要在 `api.js` 操作 DOM。
- 注释解释协议、生命周期和安全原因，不复述显而易见的语句。

注意：`frontend/vite.config.js` 当前使用双引号，与 `src/` 主体风格不一致。修改现有文件时保持该文件局部风格；是否统一 formatter 为待确认事项。

## CSS 风格

根据 `CONTRIBUTING.md` 与当前 `style.css`：

- 主题值使用 `:root` custom properties。
- 默认深色，light theme 使用 `[data-theme="light"]` 覆盖。
- 响应式行为通过 media query 和 class 切换实现；移动端 sidebar 与 desktop collapsed 分开处理。
- 新 class 延续语义短名，但不要依赖只能由内联 onclick 理解的隐式全局状态。

## 验证

```bash
# 无依赖语法检查
find frontend/src -name '*.js' -type f -exec node --check {} \;

# 单元测试（node:test，frontend/test/*.test.js）
npm test --prefix frontend

# 安装与生产构建
npm ci --prefix frontend
npm run build --prefix frontend

# 本地联调
npm run dev --prefix frontend
```

`frontend/package.json` 提供 `test` script：`node --test test/**/*.test.js`。覆盖 SSE 分片/abort、state 切换与 security/a11y 相关断言。当前**没有** ESLint、Prettier、Vitest/Jest/Playwright 配置；不要在交付说明中声称这些检查已经存在。

## 手工回归清单

- 初次发送、SSE token 增量、tool start/end、停止生成和错误事件。
- 新建/选择/删除 conversation，刷新后 server/local history 恢复。
- upload retry、raw file download、artifact-first download 与去重。
- approval approve/reject 与 timeout/错误反馈。
- desktop sidebar、移动端 backdrop、输入框快捷键与滚动。
- 用户文本、tool args/result、文件名等内容不会形成 DOM 注入。

## 待确认

- **待确认：** 是否引入浏览器级 E2E（Playwright 等）覆盖完整对话流。
- **待确认：** ESLint/Prettier 是否成为强制门禁，以及 quote/line-width 的统一规则。
- **待确认：** 正式的 WCAG 等级和可访问性验收方式（当前有基础 a11y 单测与手工清单）。

