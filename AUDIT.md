# Design Doc → Implementation Audit

> ⚠️ **OUTDATED / HISTORICAL SNAPSHOT** — 本文档记录早期设计对照，**不能**作为当前实现的权威来源。  
> 多项 ❌ 状态已在后续迭代中修复（例如 trace_id、SQLite WAL、artifact 流程、auth 公开路由等）。  
> 当前事实以代码、`tests/`、`docs/`、`.trellis/spec/` 与 `.github/workflows/test.yml` 为准。  
> 全栈硬化证据见 `.trellis/tasks/07-11-quality-operations-docs/research/verification-evidence.md`。

## 一期必须做 (Section 15.1) — 25 items

| # | Feature | Status | File |
|---|---|---|---|
| 1 | Pi 二次开发工程初始化 | ✅ | Project structure |
| 2 | Enterprise Tool Adapter | ✅ | agent/enterprise-sandbox-ext/index.ts |
| 3 | read/write/edit/bash 工具替换 | ✅ | Same as above |
| 4 | SandboxClient | ✅ | Extension's sandboxFetch |
| 5 | Sandbox Service | ✅ | sandbox/main.py |
| 6 | SessionManager | ✅ | sandbox/services/session_manager.py |
| 7 | WorkspaceManager | ✅ | sandbox/services/workspace_manager.py |
| 8 | ExecutionManager | ✅ | sandbox/services/execution_manager.py |
| 9 | File API | ✅ | sandbox/routers/files.py |
| 10 | Artifact API | ✅ | sandbox/routers/artifacts.py |
| 11 | Python / Bash Runtime | ✅ | ExecutionManager |
| 12 | Node.js Runtime 预置 | ❌ | Defined in config, no `run_node` path |
| 13 | Pi 常规 Skill 兼容 | ✅ | Skills dir mounted |
| 14 | skills 只读挂载 | ✅ | docker-compose.yml |
| 15 | Sandbox MCP Server | ✅ | sandbox/mcp/ |
| 16 | 非 root 执行 | ✅ | USER 10001 in Dockerfile |
| 17 | safe_env | ✅ | sandbox/security/safe_env.py |
| 18 | 路径逃逸防护 | ✅ | sandbox/security/path_validation.py |
| 19 | timeout + kill process group | ✅ | sandbox/utils/resource_limits.py |
| 20 | stdout/stderr preview 限制 | ✅ | max_output_chars=50000 |
| 21 | 同 session 串行锁 | ✅ | execution_manager.is_session_busy() |
| 22 | MCP Header Token 鉴权 | ❌ | config defined, never enforced |
| 23 | 基础限流 | ✅ | MCPServerAdapter.check_rate_limit() |
| 24 | 审计日志 | ✅ | sandbox/services/audit_logger.py |
| 25 | /health /ready /metrics | ✅ | sandbox/routers/health.py |

## 建议做 (Section 15.2) — 8 items

| # | Feature | Status | Notes |
|---|---|---|---|
| 1 | output/<execution_id>/ 产物隔离 | ❌ | Missing |
| 2 | workspace quota | ❌ | Config value, no enforcement |
| 3 | cgroup / ulimit 资源限制 | ❌ | Config values, not applied to subprocess |
| 4 | Prometheus metrics | ✅ | /metrics with 8 counters/gauges |
| 5 | trace_id 贯穿链路 | ❌ | Missing |
| 6 | SQLite WAL 或外部数据库 | ❌ | All in-memory |
| 7 | artifact metadata 自动登记 | ❌ | Missing |
| 8 | 敏感信息脱敏 | ✅ | sanitize_for_log in safe_env.py |

## 安全基线 (Section 10) — Critical gaps

| Feature | Status | Notes |
|---|---|---|
| 10.5 网络策略 - 禁止出站 | ❌ | default_deny_network=True but no enforcement |
| 10.5 动态依赖安装限制 | ❌ | pip install not blocked in bash |
| 10.6 资源限制 (ulimit/cgroup) | ❌ | Not applied to subprocess |
