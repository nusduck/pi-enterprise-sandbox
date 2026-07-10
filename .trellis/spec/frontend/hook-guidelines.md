# 前端生命周期与事件模式

## 说明

本项目没有 React/Vue hooks。本文件记录等价的生命周期和订阅模式，避免未来 Agent 凭空引入框架 hook 约定。

## 当前模式

- 启动：模块加载后 `initDOM`，创建 state，注册 `subscribe`，再绑定 DOM 事件并执行 boot/health 初始化。
- 状态订阅：`state.js::subscribe(fn)` 返回 unsubscribe 函数；长期应用级 subscriber 当前在 `main.js` 注册一次。
- 浏览器事件：通过 `addEventListener` 绑定 click、keyboard、drag/drop、resize/media 等行为。
- 流生命周期：每次 send 创建 `AbortController`；`try/catch/finally` 负责成功、取消、失败和恢复输入状态。
- SSE 生命周期：`api.js::readSSEStream` 获取 reader，并在 `finally` 释放 lock。

## 新增订阅/资源的规则

- 注册临时 listener、timer、reader 或 controller 时，同时定义清理路径。
- 避免在每次 render 重复注册应用级 listener；动态元素 listener 在创建该元素时绑定。
- `subscribe` 用于 state -> UI 通知，不在 subscriber 内发起可能递归更新的无界流程。
- `AbortError` 单独处理；用户取消不是系统失败。

## 待确认

- **待确认：** 是否需要统一应用 teardown/测试 hook。当前 SPA 生命周期等同页面生命周期，没有集中 teardown。

