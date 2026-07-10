# 错误处理规范

## Python HTTP 边界

- 资源不存在：Router 显式 `raise HTTPException(status_code=404, detail="...")`，实例见 `routers/sessions.py`、`routers/artifacts.py`。
- 请求冲突/状态不允许：使用 400 或 409；`routers/executions.py` 将 session busy 的 `conflict` 转为 409。
- 路径/权限：Service/Security 抛 `PermissionError`，Router 或 `main.py` 的全局 handler 转为 403。
- 输入/配额：Service 抛 `ValueError`，转为 400；`routers/files.py` 对写入边界显式捕获。
- 成功创建使用 201；无响应体删除使用 204；等待人工审批使用 202。

Pydantic model 负责结构校验，Router 不重复手写相同字段检查。业务层返回 model 或明确 dict，由 Router 设置 HTTP 语义。

## Service 与后台任务

- 可预期的业务失败尽量返回清晰状态或抛具体异常，不用裸 `Exception` 表达控制流。
- `ExecutionManager` 必须在 `finally` 中持久化最终状态并释放 session lock；异常结果保存 `FAILED`、`exit_code=-1` 和受控错误文本。
- 生命周期/清理等 best-effort 操作允许捕获 `OSError` 并 debug 记录，如 `WorkspaceManager.activate_workspace`。
- 无限后台循环需单独处理 `asyncio.CancelledError` 并退出；其他异常记录 stack 后继续，如 `sandbox/main.py::_cleanup_loop`。

## Node API 边界

- `services/sandbox-client.js::sbFetch` 把非 2xx Sandbox 响应转换为携带 `status`、`path` 的 `SandboxError`。
- `routes/*.js` 在边界 `try/catch`，记录带模块前缀的服务端日志，再返回 `{ error: message }` 和 `err.status || 500`。
- `server.js` 保留最终兜底：未命中返回 404；未处理异常记录完整错误，但客户端只得到通用 `Internal server error`。
- SSE route 一旦写出 stream header，错误以 `{type:'error', message}` 事件传递，并以 `done` 结束，不能再改普通 HTTP status。
- 下载/上传流必须检查上游状态再写响应头；实例见 `api-server/routes/files.js`。

## 前端错误呈现

Frontend API helper 对非 2xx 抛 `Error`；`main.js` 在用户动作边界捕获并使用 `flashError`/状态栏呈现。`AbortError` 是用户取消，不展示为普通连接错误。详见前端质量规范。

## 不要做

- 不把 Python traceback、环境变量、上游 secret 或原始内部对象直接返回客户端。
- 不吞掉会破坏一致性的异常；只有明确 best-effort 的展示 symlink、状态刷新等路径可降级。
- 不在 Service 中混入 HTTP `Response`，HTTP 状态由 Router 控制。
- 不在 catch 后继续使用可能未初始化的 session/workspace。

## 待确认

- **待确认：** 是否引入统一错误码/错误 envelope。当前 Python 返回 FastAPI `{detail}`，Node `/api` 返回 `{error}`，尚未统一。
- **待确认：** SSE 中哪些内部错误文本可以安全暴露给最终用户；当前 `chat.js` 会传 `err.message`。

