# Refactor follow-up

This file tracks the remaining work required before the refactor can satisfy
the final acceptance criteria in `plan.md`. A passing unit-test suite is not a
substitute for these production and integration gates.

## P0 — functional completion

1. **Completed: bind the real `pi-mcp-adapter`.**
   `pi-mcp-adapter@2.11.0` is exact-locked and loaded through Pi's Jiti
   extension loader. The production resolver merges immutable AgentVersion
   references with the deployment registry, resolves environment-backed
   secrets into a per-runtime `0600` file, exposes only exact
   `mcp__{server}__{tool}` wrappers, and removes the file on dispose. The real
   stdio integration test in `agent/tests/pi/mcp-adapter.integration.test.js`
   registers and invokes `mcp__mock__echo`; the former deferred note was
   removed after this gate passed.
2. **Completed: finish the A2A delivery surface.**
   Deployment requires the production public origin and download secret; the
   Agent exposes credential-routed protocol endpoints plus owner-scoped
   Artifact bytes, the BFF and frontend expose admin issue/rotate/revoke and
   A2A configuration, and credentials provision independent service users.
   The live gate in `docs/release-gate-evidence-2026-07-19.md` verifies invoke,
   streaming, reconnect, cancel, audit, and caller-bound Artifact delivery,
   including byte/hash equality and cross-client rejection.
3. **Completed: remove residual Sandbox compatibility persistence.**
   Sandbox startup and the offline suite are MySQL-only. The deleted SQLite
   database/repository/managers/cleanup modules are absent from the import
   graph and filesystem; tests use connection-free fakes or an unreachable
   MySQL-shaped DSN. Explicit non-MySQL settings are retained only for
   fail-closed validation tests. `tests/test_sandbox_mysql_import.py` proves
   the formal import graph and removed public routes, while the full Python
   suite passes without a legacy-runtime marker.
4. **Open: finish durable user interaction and waiting-input recovery.**
   The BFF and frontend expose an interaction-response surface, but the Agent
   still returns `501` for both interaction response and waiting-run
   rehydration. There is no MySQL interaction fact/repository or Worker/Pi
   continuation path, and the residual `agent/services/interaction-waiter.js`
   uses process-local `Map` state. This item requires a durable request and
   response lifecycle, owner-scoped compare-and-set resolution, Pi Session
   checkpoint continuation, and restart/refresh evidence; changing the HTTP
   status alone is not completion.

## P0 — release gates

Run and preserve evidence for:

- **Completed:** real MySQL migration, rollback, foreign-key, and concurrent
  event-sequence tests; see `docs/release-gate-evidence-2026-07-19.md`.
- **Completed:** Redis restart, Outbox retry, lease recovery, and live SSE
  fallback; see the Redis gate evidence.
- Agent/Sandbox restart during model and tool execution;
- **Completed:** cross-tenant and cross-session isolation in a non-privileged
  Bubblewrap Sandbox gate.
- **Completed:** 100 concurrent SSE clients and 50 concurrent Runs; the
  accepted live run received 1,100 sequenced SSE frames.
- **Completed:** 20 concurrent Sandbox executions (the plan's target).
- **Completed:** a 5 GiB streaming Dataset upload with bounded Sandbox RSS.
- **Completed:** end-to-end Dataset → Run → Python/process →
  `submit_artifact` → refresh → download.
- **Completed:** A2A invoke, stream, reconnect, cancel, audit, and
  caller-bound Artifact delivery. See the live gate evidence linked above.

The restart item remains open. Real Pi model/Worker recovery and graceful
Sandbox restart during an in-flight tool have passed, but hard `SIGKILL`
orphan recovery inside the production Bubblewrap Sandbox is not yet proven.

## P1 — cleanup

- **Completed: remove legacy `enterprise-agent-kit`.** Production diagnostics,
  tools, policy, and runtime wiring now use only `agent/src` and the three
  enterprise extensions; the local dependency, Docker COPY, package tree, and
  obsolete compatibility tests were removed.
- **Completed: remove compatibility Skill mount paths.** Agent, Sandbox,
  Bubblewrap, policy checks, and production Compose now expose the shared Skill
  tree only at the canonical read-only `/home/sandbox/skill` path.
- **Completed: resolve persistent `/tmp` versus tmpfs.** ADR 0004 keeps the
  existing Agent Session-private persistent temp tree because long Process
  Handles and multi-Run script materialization require stable semantics. The
  Bubblewrap bind, `0700` directory, joint quota, coupled cleanup, and
  control-plane exclusion tests define the security boundary.
- Add a full distributed trace backend and verify the frontend trace tree.
- Split future work into reviewable commits by subsystem; do not repeat the
  single large PR-02–PR-14 implementation commit.

## Completion rule

Do not mark the refactor complete while any P0 item remains open. Update this
file in the same commit that adds the corresponding implementation and test
evidence.
