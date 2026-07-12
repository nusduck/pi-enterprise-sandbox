# Implement — F2

## Checklist

- [x] Entity types + Zod event schemas
- [x] Run event reducer
- [x] SSE manager with Last-Event-ID
- [x] Wire create-run + events split (when API ready; adapter for legacy chat SSE)
- [x] Unit tests for reducer/dedupe/order

## Validation

```bash
npm test --prefix frontend
npm run build --prefix frontend
```

## Agent Run Notes

### Files changed

**Entities (normalized stores — ADR §13)**
- `frontend/src/entities/types.ts` — Conversation, AgentSession, Run, Message, ToolExecution, Process, Approval, Artifact, Attachment + RunSSEState
- `frontend/src/entities/store.ts` — EntityStore CRUD, selectors, `setActiveConversation` (no run cancel)
- `frontend/src/entities/index.ts` — barrel

**Schemas / reducer**
- `frontend/src/shared/schemas/events.ts` — RuntimeEvent Zod envelope + create-run/run-detail schemas
- `frontend/src/shared/schemas/api.ts` — re-exports runtime event types
- `frontend/src/shared/state/runReducer.ts` — pure Run Event Reducer (dedupe, out-of-order, gap, rehydrate)
- `frontend/src/shared/state/index.ts` — exports reducer

**SSE Manager + legacy adapter**
- `frontend/src/shared/sse/manager.ts` — per-run SSE Manager (lastEventId, connectionStatus, retryCount, abortController, Last-Event-ID, reconnect)
- `frontend/src/shared/sse/legacyAdapter.ts` — maps legacy `/chat` SSE → RuntimeEvent

**API adapters (stub-safe)**
- `frontend/src/shared/api/runs.ts` — createRun / getRun / cancelRun / streamRunEvents / listRuns (soft-fail when backend incomplete)
- `frontend/src/shared/api/index.ts` — exports runs

**Chat integration**
- `frontend/src/features/chat/entityBridge.ts` — dual-write bridge; focusConversation does NOT cancel background runs
- `frontend/src/features/chat/ChatContext.tsx` — beginRun + ingestLegacyEvent on send; conversation switch detaches UI only; rehydrate on boot/select

**Tests**
- `frontend/test/entities.test.ts` — store, reducer, multi-run, rehydrate, dedupe, gap
- `frontend/test/sse-manager.test.ts` — Last-Event-ID resume, multi-run isolation, sequence resume
- `frontend/test/legacy-adapter.test.ts` — legacy mapping + entity bridge dual-write
- `frontend/test/events-schema.test.ts` — Zod envelope validation

### Behaviour notes

1. **Normalized entities** — Run holds `messageIds` / `toolExecutionIds` / `processIds` / `approvalIds` / `artifactIds` (IDs only; no nesting in `currentMsg.content` for entity path).
2. **Reducer is immutable** — message deltas produce new `MessageEntity` snapshots (no in-place `currentMsg` mutation on entity path). Legacy UI path still uses `handleSSEEvent` for F1 parity.
3. **SSE Manager** — one connection bookkeeping entry per `runId`; reconnect sends `Last-Event-ID` + `after_sequence` query; auto-closes on terminal run status.
4. **Conversation switch** — UI generation bump + clear ephemeral state; does **not** abort fetch/SSE managers. Only user Stop (`cancelStream`) disconnects.
5. **Multi-run** — independent status/cursors in `runsById`; bridge dual-writes each run separately.
6. **Refresh rehydrate** — `listRuns` / `getRun` soft-return empty when API missing; when present, resumes SSE from `lastEventId`.
7. **Legacy adapter** — keeps `/chat` SSE working until POST `/runs` + GET `/runs/{id}/events` fully land.

### Verification

- `npm test --prefix frontend` — 73 passed
- `npm run build --prefix frontend` — tsc + vite build green

### Residual risks

1. **Legacy UI still mutates `currentMsg.content`** via `sseHandler` for live bubble rendering; entity path is the source of truth for multi-run. F3 timeline should prefer entities.
2. **Background legacy `/chat` fetch** continues after conversation switch (AbortController kept); server may still complete the run — intended. Network cost until run-centric API.
3. **createRun / listRuns soft-fail** when backend 404/501 — rehydrate is a no-op until B-side run API ships.
4. **Synthetic run ids** (`run_<ts>_<rand>`) used until POST `/runs` returns real ids.
5. **No E2E** for multi-run UI yet (F3/F6).
6. **SSE Manager reconnect backoff** is client-side only; server must honour Last-Event-ID / after_sequence for true resume.
