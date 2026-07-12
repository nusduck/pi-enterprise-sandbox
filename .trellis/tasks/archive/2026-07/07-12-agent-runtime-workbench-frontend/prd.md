# Agent Runtime Workbench Frontend Refactor

## Goal

将 Chat UI 重构为 Agent Runtime Workbench：表达 Conversation → Agent Session → Agent Run 三层，并清晰展示 tool/process/approval/artifact/budget/model。

**Source:** `docs/adr/0003-fronted0712.md`

## Task Map

| Child | Priority | Depends on | Deliverable |
|-------|----------|------------|-------------|
| `07-12-f1-workbench-foundation` | P0 | — | React/TS shell + feature parity migrate |
| `07-12-f2-entity-event-architecture` | P0 | F1 | Entities + SSE manager + event reducer |
| `07-12-f3-runtime-workbench-ui` | P0 | F2 | Three-pane + timeline + inspector |
| `07-12-f4-process-interaction-ui` | P1 | F3 + backend B2/B3/B6 APIs | Process console + steer/follow-up |
| `07-12-f5-management-pages` | P1 | F2 + backend APIs | Runs / Approvals / Capabilities |
| `07-12-f6-cleanup-e2e` | P1 | F3+ | Remove legacy; E2E/a11y |

## Depends On (backend contracts)

Agent Session Persistence API, Run Event API, Process API, Tool Ledger API, Approval Resume API, MCP Registry API, Model Registry API — consume when available; F1 does not block on them.

## Non-Goals

Backend process/session/MCP implementation (ADR 0003 §21).
