# 日志与追踪规范

## Python 日志

`sandbox/main.py::_configure_logging` 使用标准库 `logging`：

```text
%(asctime)s [%(levelname)s] %(name)s: %(message)s
```

- logger 按职责命名：`sandbox`、`sandbox.access`、`sandbox.cleanup`、`sandbox.audit`、`sandbox.workspace`、`sandbox.mcp.fastmcp`。
- 服务启动/停止、路径配置、session 清理数量使用 `info`。
- 可恢复且预期的兼容降级使用 `debug`，如无法创建 agent-visible symlink。
- 后台非预期异常使用 `logger.exception` 保留 stack。
- 不为普通 4xx 业务分支打印 stack；请求访问日志统一记录 method/path/status/duration。

## 审计日志

`sandbox/services/audit_logger.py` 同时：

1. 将 JSON 结构写到 `sandbox.audit` logger。
2. 通过 `AuditRepository` 持久化到 `audit_logs`。

事件当前包括 `tool_call`、`execution`、`error`、`session_lifecycle`。字段优先保持结构化：timestamp、session/execution/trace ID、risk、duration、exit code 等。

新增安全敏感操作时应复用 `audit_logger`，而不是仅打印自由文本。错误 message 在写审计前通过 `sanitize_for_log`；新增敏感 key 同步到 `Settings.sensitive_keys`。

## Trace ID

- Node `sandbox-client.js` 为 Sandbox 调用设置 `X-Trace-Id`；chat turn 使用 UUID。
- FastAPI `trace_id_middleware` 将 ID 放入 `ContextVar` 并在响应头回显。
- Execution 与 Audit Repository 保存 trace ID；`GET /traces/{trace_id}` 用于串联查询。
- 新跨服务调用必须继续透传 trace header；不要在同一请求中无故生成新 ID。

## Node 与浏览器日志

- Node 使用带模块前缀的 `console.log/warn/error`：`[server]`、`[agent]`、`[conversations]`、`[artifacts]` 等。
- `info/log` 用于启动、session create/reuse、history restore；`warn` 用于可降级持久化/健康问题；`error` 用于请求或 agent turn 失败。
- 前端 console 只辅助调试，用户可行动错误同时通过 `flashError` 或 `setStatus` 展示。

## 禁止记录

- LLM/API token、Authorization/Cookie、密码、完整 `os.environ`。
- 不必要的完整用户文件内容、上传正文或超长模型 transcript。
- 可被攻击者构造的未脱敏 secret 文本。

## 待确认

- **待确认：** 生产日志是否需要统一 JSON formatter；目前只有审计 entry 是 JSON，普通 access/lifecycle 日志是文本。
- **待确认：** 日志保留期、采集平台、PII 分类和 trace ID 对外暴露策略，仓库中没有权威配置。

