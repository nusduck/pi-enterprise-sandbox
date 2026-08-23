# 死代码考古清单 · 2026-08-23

全项目五路并行深度梳理（agent / api-server / sandbox / frontend / 横切资产），
每个候选项均经全局 grep 引用验证，区分「可删的历史包袱」与「有意保留的安全兜底」。

> 前置背景：2026-07-29 已做过一轮清理（`docs/archive/reviews/2026-07-29-dead-code-cleanup.md`），
> 本轮只列当前仍存在的项，并与其已删项去重。

## 分报告

| 文件 | 范围 | 高置信可删估计 |
|------|------|--------------|
| [01-agent.md](01-agent.md) | agent/（Node, ~67K 行） | ~170 行 + 2 个死配置 + 1 个幽灵依赖 |
| [02-api-server.md](02-api-server.md) | api-server/（Node BFF, ~5K 行） | ~95 行 + 配置面收敛 |
| [03-sandbox.md](03-sandbox.md) | sandbox/（Python, ~36K 行） | **~470 行** + 1 个整文件 + 6 个测试 import 迁移 |
| [04-frontend.md](04-frontend.md) | frontend/src（React+TS, ~21K 行） | ~280 行 + 1 个死配置文件 + 4 张图片 + CSS 死变量 |
| [05-infra.md](05-infra.md) | 横切资产（env/compose/docs/tests/scripts） | ~180 行墓碑脚本/注释 + 依赖瘦身 |

## 🟢 零风险速赢清单（可直接删，一个 hygiene PR）

### 整文件删除
- `sandbox/routers/artifacts.py` — sys.modules 兼容 shim，main.py 直接挂载真身，零引用 ✅已验证
- `sandbox/routers/internal_artifacts.py` — 同类 shim，main.py 直连真身
- `tests/e2e_artifact_flow.py` — 调用已删除的 `POST /sessions` 公共路由，必 401，CI/docs 零引用 ✅已验证
- `frontend/vite.trace-gate.config.ts` — 全仓零引用的孤儿 Vite 配置 ✅已验证

### 函数/导出级删除（全部经 grep 验证零生产调用）
- agent: `A2A_MESSAGE_STREAM_KINDS`、`A2A_TASK_STREAM_KINDS`（@deprecated 别名）、`config.FAKE_LLM_ENABLED`
- BFF: `REQUEST_GRACE_MS` + `timeoutForSeconds`（旧单体重构残留）、`resolveUploadTraceId` 的 fallback 参数、`handleProcessAction` 不可达 else
- sandbox: `run_node()` 及 policy_checker 的 `"run_node"` 键；`logs/list_events/subscribe_events/cancel_active_workspace/is_workspace_busy/total_count`（execution_manager）；process_manager 同名死方法 + `_orphans_marked`；workspace_manager 4 方法（含恒返 0 存根）；audit_logger 3 方法；attachment_manager 4 方法；`is_legacy_logical_workspace_path()`、`as_logical()`、`apply_ulimit_env()`、`get_trace_flags()`、`SCHEMA_GAP_NOTES`、`is_table_schema_gap()`
- frontend: `chatState.subscribe/notify`（死订阅机制+update 内无效 diff 循环）、`getDownloadUrl`、`IconSearch`/`IconEye`、`listPendingApprovalsForConversation`、Composer 尾部再导出、`SSEEventSchema`

### 配置/资产清理
- `.env.example`: 删 PI_PROVIDER/PI_MODEL 墓碑注释、TTL 墓碑段(362-367)、`SANDBOX_IPTABLES_ENABLED`(447)、`RESET_DATABASE_NAME`(346)
- compose: api-server 服务块的 `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL` 注入（BFF 不读）；`SANDBOX_HOST` 别名注入
- 依赖: api-server 删 `@opentelemetry/propagator-b3`（未 import），显式声明被 import 却缺失的 `@opentelemetry/semantic-conventions`（agent 侧同样）
- frontend: tsconfig `exclude:["src/legacy"]`（目录不存在）、`@/*` 别名双处定义零使用；public/brand 4 张无引用图片

## 🟡 需要数据迁移或产品确认后再删（勿直接动）

| 项 | 前置条件 |
|----|---------|
| agent `LEGACY_REQUIRED_EXTENSION_NAMES` 三件套隐式升级 | 先一次性回填 MySQL AgentVersion 行，否则 ask_user 静默消失 |
| agent conversation title 读时兜底（list N×500 读放大） | 先跑 title backfill UPDATE |
| agent `_integrity` sibling 剥离 | 确认最老存活 tool_executions 行均已带 `$v` envelope |
| sandbox 6 个 artifact `import *` shim | 同 PR 更新 8 个测试文件的 import |
| sandbox `PolicyChecker.check()` 三级策略门 | HITL 已移除，仅测试引用；建议独立评审后并入 formal runtime 或退役 |
| frontend seq=0 合成通路 + manager 二层补偿 | 确认无仓库外旧部署发无序列号事件 |

## 🔴 明确不要动的「有意保留的安全兜底」（避免误删）

- agent: `LEGACY_EXTENSION_PACKAGE_NAMES` 拒绝表、`isLegacyOrUuidIdentity` 入口守卫 ×8、`AgentSessionRepository.update()` 恒抛、normalizeExecutorResult fail-closed 词表闸门
- sandbox: `cancel_for_session/workspace/run`（review-deferred-items.md:75 记录的未来接线预留）、`approval_timeout_seconds/approval_enabled` env 兼容、`telemetry synthetic_trace_parent` X-Trace-Id 回退（Agent 至今在发）、direct 隔离后端（host 测试默认）、requirements.txt/pyproject 双轨（用户工作负载库 vs API 依赖，分工明确）
- BFF: X-Acting-* 三重剥离、SANDBOX_AUTH_ENABLED 回退、session_id/sandbox_session_id 双名契约
- frontend: terminal 状态别名容忍、capabilities/approvals/datasets soft-fail、camel/snake 双读

## 📝 文档漂移（顺手修）

- `README.md` Skill 段仍描述已删除的 kit package skills / profile.skills / sharedSkills 机制
- `README.md` .runtime 子目录清单与实际不符（smoke/release-gates 为运行时生成）
- `api-server/src/config.js:203` "Surfaced on status for UI" 注释与 status.js 实现脱节
- `.env.example:20` 注释指向不存在的 reset 脚本（实际为 runbook 手工命令）

## 待确认项汇总（需 DB 查证或架构决策）

1. `AGENT_RUN_INIT_TIMEOUT_MS` 是否为预留开关（agent config 解析但无消费者）
2. BFF 5 个前端未调用的已挂载端点（approvals/{id}、processes status/read/kill、cron-jobs/{id}、files/upload）是否有外部 API client
3. `AttachmentUploadResponse.content/truncated` 字段的下游读者
4. otel 自动埋点计划（决定 pyproject 两个 instrumentation beta 依赖去留）
5. `max_attachments_per_turn` 是死配置还是本应生效的功能缺口
6. git 追踪终验：`git ls-files agent/pi-agent-home frontend/dist .runtime pi_enterprise_sandbox.egg-info .claude`（期望空输出）
