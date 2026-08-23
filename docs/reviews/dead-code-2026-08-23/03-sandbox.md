# 死代码考古 · sandbox 模块（Python FastAPI, ~36K 行）

> 所有候选项经全仓 grep（含 tests/、agent/、docs/、compose）验证；与 2026-07-29 清理记录去重。

## A. 死代码（完全未被引用或仅剩测试引用）

| # | 位置 | 简摘 | 风险 | 动作 |
|---|------|------|------|------|
| A1 | `routers/artifacts.py:1-5` | 整文件 sys.modules 兼容 shim → artifact.api.public；main.py:436 直接挂载真身 | 低 | **直接删文件** |
| A2 | `services/execution_manager.py:584-633` | `run_node()`：无任何调用方（formal runtime 只走 bash/python） | 低 | 删方法 + policy_checker.py:55 `"run_node"` 键 |
| A3 | execution_manager.py:642-704,761-772 | `logs()`/`list_events()`/`subscribe_events()`/`cancel_active_workspace()`/`is_workspace_busy()`/`total_count` | 低-中 | 删（保留 get_running_execution_id/cancel/get） |
| A4 | process_manager.py:1272-1299,1763-1770 | `list_events()`/`subscribe_events()`/`total_count`/`orphans_marked` 属性（计数器自增自读，同步删 ：126,:451 维护点） | 低 | 删 |
| A5 | workspace_manager.py:150-162 | `get_workspace_path()`/`get_temp_path()`/`workspace_exists()`/`cleanup_stale()`（TTL 子系统删除后的恒返 0 存根） | 低 | 删四方法 + 对应测试 |
| A6 | audit_logger.py:98-166 | `log_execution()`/`log_error()`/`log_session_lifecycle()`：实际审计全走 log_tool_call | 低 | 直接删 |
| A7 | attachment_manager.py:107,174-178,290-328 | `new_idempotency_key()`/`write_bytes()`/`max_turn_bytes()`/`max_attachments_per_turn()` 零调用 | 低 | 直接删 |
| A8 | paths.py:108-115,98-105 | `is_legacy_logical_workspace_path()`、`SandboxPath.as_logical()` 零引用 | 低 | 直接删 |
| A9 | utils/resource_limits.py:289-315 | `apply_ulimit_env()`：Dockerfile 明确不做镜像级 ulimit | 低 | 直接删 |
| A10 | trace.py:163-165 | `get_trace_flags()` 零引用 | 低 | 直接删 |
| A11 | app/persistence/schema_gap.py:259,295-297 | `SCHEMA_GAP_NOTES` 零引用、`is_table_schema_gap()` 恒 False 零引用 | 低 | 直接删 |

## B. Legacy 兼容层

| # | 位置 | 说明 | 建议 |
|---|------|------|------|
| B1 | services/artifact_store.py、artifact_manager.py、formal_artifact_runtime.py（import * shim） | 生产已全直连 sandbox.artifact.*；仅 6 个测试文件仍从旧路径 import | 更新测试后删三 shim |
| B2 | app/domain/internal_artifact_contract.py | shim，仅 1 个测试引用 | 改测试后删 |
| B3 | app/persistence/repositories/artifact_repository.py | import * shim；barrel 无生产消费者 | 合并进 barrel 清理 PR |
| B4 | routers/internal_artifacts.py | sys.modules shim → artifact.api.internal；仅 1 个测试引用 | 改测试后删 |
| B5 | schema_gap.py:255-262,286-289 | SCHEMA_GAP/MISSING_TABLES/report_schema_gap() 兼容名，仅 1 个测试引用 | 测试改用 SCHEMA_CAPABILITY 后删 |
| B6 | policy_checker.py:417-489 + models.py:244-264 | 三级策略门 PolicyChecker.check()——HITL 移除后生产只调 is_blocked_command()；仅测试调用 | **保留但注明**或独立评审整体退役 |
| B7 | execution_manager.py:227-252 等 | workspace_path 参数与 _coerce_context「任意路径拼物理根」兼容分支；生产全传 context= | 测试改传 context 后收紧签名（消除非正式通道） |
| B8 | config.py:297-300,875-884 + compose/entrypoint | SANDBOX_HOST legacy 别名链；settings.port 零读者 | 移除字段 + compose 注入行 + .env.example 行 |
| B9 | models.py:97-99 | AttachmentUploadResponse.content/truncated 路由从不赋值 | [待确认下游读者] 后删字段 |
| B10 | process_manager.py:1667-1762 | cancel_for_session/workspace/run 零调用方——但 review-deferred-items.md:75 记录为**已知功能缺口的预留接线** | **保留但注明** |

## C. 冗余兜底 / 永不可达分支

| # | 位置 | 说明 | 动作 |
|---|------|------|------|
| C1 | workspace_manager.py:62-65,78-81,115-118、path_validation.py:180-182 | Python <3.9 的 except AttributeError + commonpath 回退；项目锁 >=3.11 | 直接删 4 处 |
| C2 | entrypoint.sh:28 | SANDBOX_HOST 回写 legacy 变量无人消费 | 随 B8 清理 |
| C3 | entrypoint.sh:37-52 | NETWORK_MODE alias 归一化仅为 echo 一行，config 内再做一遍 | 简化为直接 echo 原值 |

## D. 过渡残留甄别

- D1 可清：datasets.py:46-56 `_ownership_from_request` 被 del 的三个形参（"kept for call-site compatibility"，调用点全在本文件内）
- D2 命名残留勿删：paths.py:46-47 `LEGACY_AGENT_WORKSPACE_PATH` 实际是**现行规范**路径，建议重命名
- D3 有意保留勿动：config.py:438-446 approval env 兼容 + production guardrail
- D4 有意保留勿动：telemetry.py:122 X-Trace-Id 回退（Agent 至今在发）
- D5 设计取舍：FakeFormal*Repository 双用途实现，保留

## E. 未使用资产

| # | 位置 | 说明 | 动作 |
|---|------|------|------|
| E1 | pyproject.toml:14-15 | opentelemetry-instrumentation-fastapi/httpx==0.60b1 零 import | [待确认 otel 自动埋点计划] 否则删 |
| E2 | requirements.txt vs pyproject 双轨 | **不是冗余**：前者是沙箱内用户工作负载库（pandas 等），分工明确 | 保留现状 |
| E3 | config.py:384-385 | max_attachments_per_turn/max_turn_attachment_mb 唯一读者是 A7 死方法 → 传递性死配置；但若产品本意要限制每轮附件数则是功能缺口 | [待产品确认] |
| E4 | docker-compose.yml:472-473 | 同时注入 BIND_HOST 与 HOST 别名 | 随 B8 处理 |

## 重点专项结论
1. files.py/datasets.py 是活跃公共适配器，**不是** legacy；可清的是 artifacts 侧 shim
2. isolation/direct.py **仍在被选中**（config 默认 direct 用于 host 测试；production 强制 bubblewrap）——有意保留
3. ExecutionManager/ProcessManager 并非整体废弃——formal runtime 组合复用其核心 run_command/run_python/start
4. mcp/ 目录完整存活（独立进程 8082 + HMAC bridge 接入 main.py:444）

## 清理收益估计
- A 类 ≈ **350-400 行**净删 + 一个整文件；消除恒返 0 存根、恒 False 函数等误导性 API 面
- B 类 ≈ 60 行 shim + 8 个测试文件 import 迁移
- C 类 ≈ 30 行不可达分支（安全敏感文件少一层假分支有真实收益）
- E 类：2 个依赖声明 + 2 个死配置字段
