# Design

Sandbox service 使用安全目录遍历和流式文本扫描，不调用 shell。每个工具在 path resolver 后执行，使用 monotonic deadline 与扫描预算；响应统一为 `{items|matches, skipped, stats, truncated, stop_reason}`。

Agent 以 Extension 注册同名工具覆盖 SDK built-ins，全部调用 Sandbox REST。未知/无效参数在 Agent 早拒绝，Sandbox重复验证。

回滚只移除 Agent 工具注册；Sandbox endpoints 可保留但不对外暴露。不得回滚为 Agent 进程本地文件扫描。

