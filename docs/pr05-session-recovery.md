# PR-05 Session recovery and fencing invariants

Status: slice A foundation + slice B (journal, recovery/checkpoint, PiRunExecutor, unique run lease token).
`createPiRunExecutorFactory` is explicit only — **not** the worker production default.

## Formal session statuses (plan §11 exact)

Six statuses:

`CREATING` | `ACTIVE` | `SUSPENDED` | `CLOSING` | `CLOSED` | `FAILED`

Exact adjacent edges (no inventing collapse/abandon shortcuts):

| From | To |
| ---- | -- |
| CREATING | ACTIVE, FAILED |
| ACTIVE | CLOSING, SUSPENDED, FAILED |
| SUSPENDED | ACTIVE, FAILED |
| CLOSING | CLOSED |
| CLOSED / FAILED | (terminal) |

There is **no** `CREATING→CLOSED`, `ACTIVE→CLOSED`, or `SUSPENDED→CLOSED`. Closure is `ACTIVE→CLOSING→CLOSED`.

`Repository.transitionIf` validates every expected→target edge through `SessionStateMachine`. The only non-transition edge allowed is same-status **SUSPENDED re-reason** (update `recovery_reason_code` without changing status).

## RECOVERY_REQUIRED is not a status

When snapshot vs journal disagree (plan §12.5):

- `status = SUSPENDED`
- `recovery_reason_code = 'RECOVERY_REQUIRED'` (or a more specific code)

`markRecoveryRequired` may only:

- transition `ACTIVE → SUSPENDED`, or
- idempotently re-reason an already `SUSPENDED` session

It must **not** perform `CREATING → SUSPENDED`.

## Durable fencing

| Layer | Role |
| ----- | ---- |
| Redis `agent:session-lock:{agentSessionId}` | Short-lived coordination (SET NX PX + token-safe Lua renew/release) |
| MySQL `agent_sessions.execution_fence_token` | Monotonic durable fence; acquire before side effects |
| MySQL `agent_session_snapshots.captured_fence_token` | Fence observed when snapshot committed |

Redis lock absence/busy is **never** Session status. Session lock APIs use session-specific errors (`SessionLockError.agentSessionId`) and `assertAgentSessionId`. Each acquisition should use `generateSessionLockOwnerToken(workerIdentity)` so concurrent executions get distinct tokens even for the same worker.

## Snapshots are acceleration only

Table `agent_session_snapshots` stores append-only versions with:

- **Checksum** = SHA-256 of the exact deterministic **materialized Pi JSONL v3** UTF-8 bytes (shared codec with `PiSessionAdapter`)
- Each JSONL line is recursive-canonical JSON (sorted object keys); `entries[]` append order preserved
- MySQL JSON key reordering cannot change verification (always re-materialize from logical `{header, entries}`)
- `snapshot_format` + **exact** `pi_sdk_version` equality (no same-major/minor soft match; migrator required later)
- `captured_fence_token` + CAS on `status=ACTIVE` + `pi_session_version` + `execution_fence_token`
- `snapshotVersion === expectedPiSessionVersion + 1`
- **Atomic** insert+CAS in one short transaction (no orphan rows on CAS failure)
- Append-only UPDATE/DELETE triggers on snapshot rows
- Snapshot writes refused on SUSPENDED/terminal sessions

**Current pointer** is solely `agent_sessions.pi_session_version`:

- `loadLatest()` owner-loads the session, reads the pointer, returns `null` only when pointer is `0`
- When pointer `> 0`, loads **exactly** that version (never `MAX(snapshot_version)`)
- Missing pointed row, checksum failure, format/SDK invalid, or version mismatch → typed `SessionSnapshotError` (recovery-required class); never silently picks another version
- Only `appendAndAdvance` commits a new current snapshot (no non-pointer archival insert API)

Long-term recovery truth remains **platform messages + run event journal**.

## Pi SDK limitation (`@earendil-works/pi-coding-agent@0.80.3`)

There is **no** native snapshot / hydrate / checkpoint API.
`SessionManager.open` **silently skips** malformed lines → validate fail-closed **before** open.

Correct recovery:

1. Validate logical payload (header type/version/id/timestamp/cwd; exact entry type union; unique ids; parent chain; timestamps).
2. Materialize deterministic version-3 JSONL.
3. `SessionManager.open(path, sessionDir?, cwdOverride?)`.
4. Pass that manager into `createAgentSessionFromServices` (via `createAgentSessionRuntime`).

Do **not**:

- Manually assign or mutate `agent.state.messages`
- Expect `SessionManager.inMemory()` to hydrate raw entries
- Import `dist/core/*`

Preserve full toolCall / toolResult / compaction / branch / custom payloads.

## PiRuntimeFactory

- Exact SDK pin `0.80.3`; `sdk.VERSION` validated immediately after load (`PI_SDK_VERSION_MISMATCH` on mismatch).
- Concrete `agentDir` string required.
- Canonical path only: `createAgentSessionRuntime` once; `createAgentSessionFromServices` exactly once per factory invocation.
- Injected `input.services` are reused **inside** the createRuntime closure (still one runtime + one fromServices); no direct createFromServices bypass.
- Invalid runtime object (no session) is disposed if possible before cleanup; on failure dispose owned materialization and rethrow.
- Dispose is idempotent and disposes the runtime once.
- Agent Version config is deep-cloned and frozen (no runtime credentials re-embedded).
- **Concrete full model required** at create: `input.model ?? bound.model` must be a full pi-ai `Model` (`PI_MODEL_REQUIRED` if neither). Slice B may resolve policy → full model and pass `input.model`. No SDK default model selection.

## PlatformEventProjector (stateless)

| Pi event | Platform |
| -------- | -------- |
| `message_update` / text_delta | `message.delta` |
| `message_end` | `message.completed` + `tool.call.proposed` per toolCall block (order preserved) |
| `tool_execution_start` | `tool.execution.started` |
| `tool_execution_update` | `tool.execution.progress` |
| `tool_execution_end` | `tool.execution.completed` \| `failed` |
| `compaction_end` | `session.compacted` only when `result` present, `aborted=false`, no error; else `error.occurred` or no-op |
| `agent_end` with `willRetry=true` | `model.request.failed` (not success) |
| unknown | `[]` |

No mutable Map correlators — pure field-based mapping.

## Mid-tool resume is not claimed

Slice A does **not** claim resume of in-flight tool side effects. Durable tool ledger / idempotency is required before reconciling sandbox or external side effects after crash.

## Worker production path

`ServiceContainer` registers factories for session repos, session lock, Pi adapter/factory/projector, journal, and `createPiRunExecutorFactory(opts)` (requires `modelResolver` + `workspaceResolver`).
Production worker still **fail-fast** unless an explicit complete `runExecutorFactory` is injected (PR-06). Stub success is not re-enabled. `createPiRunExecutorFactory` is never auto-selected as the default.

## Slice B event ownership

`PiRunExecutor` is the sole durable Pi → RunEvent+Outbox projector for a job. `ExecuteRunService` does not pass `emit`. PR-06 observability must call into that recorder rather than double-writing. No process-local Map is authority.

## Long-term journal

Pi JSONL header + full SessionEntry payloads live in `messages` with `pi_entry_id` / `pi_entry_kind` (migration `20260718000007`). Snapshots remain acceleration; journal rebuild is the fallback when the pointed snapshot is missing/corrupt. Checksum disagreement between snapshot and journal → `SUSPENDED` + `RECOVERY_REQUIRED`.
