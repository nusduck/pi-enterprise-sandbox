# ADR 0014: SSE 契约以真实平台事件为准，取代 ADR 0007「逐字节不变」夹具要求

| 字段 | 值 |
|---|---|
| 状态 | **Accepted / Implemented**（2026-09-30） |
| 日期 | 2026-09-30 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/` 的事件写入、`api-server/` 的 SSE 中继、`frontend/src/shared/state/`、[`api.md`「SSE 事件协议」](../api.md) |
| 关联决策 | [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)（**本 ADR 取代其「验证要求」第 1 条**：「SSE 契约逐字节不变，`tests/fixtures/sse_events.json` 全量通过，`api-server/`、`frontend/` 零改动」；0007 的其余决策与其余两条硬指标不变） |

---

## 背景与问题

ADR 0007 把「SSE 契约逐字节不变」列为三条硬指标之一，依据是共享夹具 `tests/fixtures/sse_events.json`：它描述的是 Pi 时代的产品事件（`token`、`tool_start`、`tool_end`、`file_ready`、`done`、`session`、`session_closed` …），并由 `agent/src/runtime/projection/sse.ts` 的 `projectToSse` 做「内部事件 → 旧事件名」的投影。

DSH 重建落地后的事实（2026-09-30 在运行中的栈上抓取 `GET /api/runs/{id}/events` 核实）：

- 线上事件流**只有点分平台事件**：`run.accepted` / `run.started` / `run.status.changed` / `run.completed`、`message.delta` / `message.completed`、`tool.call.proposed` / `tool.execution.started` / `tool.execution.completed`、`session.snapshot.saved` 等，带持久 `sequence` 与 `event_id`。旧事件名一个都不出现。
- `projectToSse` **生产路径无调用方**，只被自己的测试引用；该夹具因此只能证明「一段没人调用的代码能复现一份自己写的样本」，不能证明真实线形。
- 前端却仍保留一整层旧事件名适配器，测试也用旧事件名驱动，反而掩盖了真实线形；`api.md` 里的事件表列的也是旧名字。

所以「逐字节不变」这条验证要求在 0007 落地时就已经名不副实：它守护的是一个不再存在的契约。

---

## 决策

1. **SSE 契约的权威是 Agent 实际写入 `run_events` 的平台事件，加上 BFF 的中继信封 `{ sequence, event, ts, event_id }`。** 事件族与字段记录在 [`api.md`「SSE 事件协议」](../api.md)；旧事件名（`token`、`tool_start`、`tool_end`、`file_ready`、`done`、`session`、`trace`、`session_closed` 等）**不属于契约**，Agent 不发、前端不认。
2. **验证依据改为真实线上帧**：`frontend/test/fixtures/live-run-sse.json`（从运行栈抓取）经 `frontend/test/live-run-replay.test.ts` 逐帧喂给浏览器同一条摄入路径，配合 reducer 与摄入测试。它能发现 Agent 与前端之间的线形漂移，合成夹具做不到。
3. **前端只认平台事件**：无法规范化（缺 `event_id`、`sequence` 或点分 `type`）的帧被丢弃，不猜测含义、不合成 id。
4. **撤销** ADR 0007 验证要求第 1 条的「`sse_events.json` 全量通过」与「`api-server/`、`frontend/` 零改动」两个具体要求。0007 的另外两条硬指标（组合断言、本机文件系统不可达）不受影响。

---

## 后果

- 事件形状发生变化（新增事件族、字段改名）时，必须同步更新 `api.md` 的事件族表，并在必要时从运行栈重新抓取 `live-run-sse.json`；不再有一份「旧名字」夹具可以对照。
- 已删除：`tests/fixtures/sse_events.json`、`tests/test_sse_contract.py`、`agent/src/runtime/projection/sse.ts` 及其测试、`api-server` 里读取该夹具的用例、前端 `agentEventAdapter.ts`。
- 不影响：BFF 对 Run 事件的字节代理、`Last-Event-ID` / `afterSequence` 续传语义、A2A 侧的事件投影（`agent/src/application/a2a/event-projector.ts`，属 [ADR 0010](0010-retain-custom-a2a-server-layer.md) 的自建协议面）。

## 实施

见 [#59](https://github.com/nusduck/pi-enterprise-sandbox/pull/59)（删除适配层与死契约、改写 `api.md`）。
