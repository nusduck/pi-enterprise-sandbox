# Spec 轴（plan.md §32 验收标准对照）

审查基准：`docs/plan.md` 第 32 章「最终验收标准」+ `docs/STATUS.md` 一致性核对。
方法：逐条在代码中寻找 file:line 级实现证据；`docs/evidence/` 视为历史快照不作为当前状态证据。

## 结论

**无 P0/P1 缺口。STATUS.md 未发现「声称 done 但无代码证据」的行。**

## Agent Runtime / State / Sandbox / Reliability / Security（五节）

代表性实现证据：

- A3：`pi-mcp-adapter` 精确钉 2.11.0（`agent/package.json:47`）
- B1：SQLite 生产拒绝（`sandbox/config.py:1167`）
- B3：无进程内权威 Run Map，有棘轮测试 `agent/tests/bootstrap/no-authoritative-run-map.unit.test.js`
- B6：`next_event_sequence` 原子分配（`agent/src/infrastructure/mysql/migrations/20260718000001_core_platform_schema.js:228`）
- C1：workspace_id 双 unique（同迁移 :163, :309）
- C3：全局 symlink 明文禁用（`sandbox/services/workspace_manager.py:17`）
- 遗留 `/agent-runs` 双权威已删并有防回归测试（`tests/test_legacy_agent_routes_absent.py`）
- H5/H6 标 `partial` 与现实一致：脱敏与策略代码在库中（`agent/src/infrastructure/pi/event-redaction.js`、`agent/tests/bootstrap/secret-and-mcp-policy.unit.test.js`），生产日志/数据面采样确属运维项。

## Frontend D1–D8 / Artifact E1–E3 / A2A F1–F6

- **D1–D8 全部兑现**：`entityBridge.ts:861` rehydrateConversation、`:764` rehydrateInProgress、`:140` rehydrateTraceSpans；`runReducer.ts:1268/1452`；`runs.ts:228` cancelRun + `RunsPage.tsx:77`；`datasets.ts:65` uploadDataset + `ChatContext.tsx:992`；`ProcessConsole.tsx:32`；`ApprovalsPage.tsx:30` + `approvalDecision.ts:14`；`TracePanel.tsx:171`；`A2aPage.tsx` + BFF `routes/a2a.js:27`。
- **E1/E2**：仅 `submit_artifact` 产生 Artifact（`agent/src/extensions/sandbox-bridge/tools/index.js:867-901`，write 明示不产生用户可见 artifact）；前端 "Never fall back to workspace path download"（`entityBridge.ts:1091`）。
- **E3**：BFF 会话属主校验后代理（`routes/files.js:367`）；A2A 侧 caller-bound + scope 校验（`presentation/a2a/http-handler.js:320,342`）。
- **F1–F6**：Agent Card 路由（`http-handler.js:146,184`）；`message/stream`、tasks/get/cancel/resubscribe（`json-rpc.js:86-89`）；Task↔Run 映射与取消（`task-service.js:196,523`）；断连仅结束订阅（`stream-service.js:9`）；审计三元组由真库测试 `tests/a2a/a2a-audit-correlation.unit.test.js` 驱动。

## P2 保留意见

1. **release-gate 复验成本高**：多个 done 行的关键证据是需真实 MySQL/Redis/Sandbox 的 release-gate 测试与 dated evidence（如 `agent/tests/redis/*.release-gate.test.js`），离线仅单测层可信。STATUS 已如实标注日期与环境，不算虚报。
2. **B3 白名单棘轮**：`no-authoritative-run-map.unit.test.js:297` 的 `new Map(` 白名单靠人工 inventory 维护；有 stale-entry 反查（:343），但结构性保证弱于类型级禁止。
3. **STATUS E1/E2 证据栏空泛**："design / formal artifact runtime" 措辞无具体文件引用（代码可佐证，建议补充）。
4. **D1 浏览器 harness 缺失**：刷新恢复仅有离线矩阵验证，无浏览器 F5 实测 harness（STATUS 已披露，与 plan「真机验证」要求存在已披露差距）。
5. **F5 真实链路 gate 缺失**：stream-service 断连保障主要靠注释+单测 fake，未见针对真实 HTTP SSE 断连的 release-gate 记录。

## 审查局限

- 无法运行 git 确认 STATUS 头部「Last audited at be4a077a」之后 main 是否有新合并触及 done 行。
