# Agent Runtime Capability Completion

## Goal

补齐企业级 Agent Runtime：同一 Conversation 复用逻辑 Pi SDK Session，支持长进程、流式日志、完整 Tool Ledger、结构化附件、MCP、运行中干预、可恢复审批、Run Budget 与 Model Registry。

**Source:** `docs/adr/0002-backend2712.md`

## Task Map

| Child | Priority | Depends on | Deliverable |
|-------|----------|------------|-------------|
| `07-12-b1-agent-session-persistence` | P0 | — | Conversation 1:1 logical Pi Session + restore |
| `07-12-b2-process-manager` | P0 | — (integrates with B1) | Managed process tools + cleanup |
| `07-12-b3-streaming-execution-events` | P0 | B2 (process logs), bash path | stdout/stderr deltas + SSE sequence |
| `07-12-b4-tool-ledger-completion` | P0 | B1/B2 tool paths | Full ledger + edit/apply_patch |
| `07-12-b5-attachment-mcp-registry` | P1 | B1, B4 | Attachments on message + MCP/ToolRegistry |
| `07-12-b6-runtime-interaction` | P1 | B1, B4 | Steer/follow-up/budget/approval resume |
| `07-12-b7-model-registry` | P1 | B1 | Registry-driven model capabilities |

## P0 Minimum Delivery (parent gate)

- Agent Session 完整持久化恢复
- Process Manager
- Tool Ledger 全覆盖
- 日志流式输出

## Cross-Child Acceptance

- [ ] 同一 Conversation 三轮消息对应一个逻辑 Pi SDK Session
- [ ] Agent 能启动/读日志/停长进程
- [ ] 所有 Tool Path 进入统一 Ledger
- [ ] 命令输出支持实时流式与 sequence 续传
- [ ] P1 能力有独立 child 验收，不得仅写文档宣称完成

## Non-Goals

见 ADR §5：不负责动态 Runner、一次 Run 一个 Pod、替换认证、前端整页重构、多 Agent 协同、Workflow 引擎、Python Agent 恢复。

## Integration Gate

Parent 仅在所有 child 归档（或显式 deferred 到新 active task）且跨 child 验收通过后归档。

## Infrastructure Note (2026-07-12)

**Dedicated PostgreSQL container is approved for this iteration.**

- Dev: `docker compose --profile postgres up -d postgres`
- URL (host): `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`
- URL (compose): `postgresql://sandbox:sandbox_dev_only@postgres:5432/sandbox`
- SQLite remains valid for unit tests / offline CI; live multi-turn session, process, ledger, and streaming integration may use the Postgres container via `SANDBOX_DATABASE_URL` / `TEST_POSTGRES_URL`.
- Weak `sandbox_dev_only` password is development-only; production still requires strong secrets via prod overlay.

