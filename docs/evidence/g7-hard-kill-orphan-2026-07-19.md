# G7 live evidence — Hard SIGKILL Bubblewrap orphan recovery

**Date:** 2026-07-19  
**Branch:** `codex/plan-acceptance`  
**STATUS ID:** G7  
**Verdict:** **PASS** (promotes G7 to `done`)

This file is additive. It does **not** rewrite
[`release-gate-2026-07-19.md`](./release-gate-2026-07-19.md).

## Scope

Prove that after a hard service `SIGKILL` of the Sandbox API process:

1. a durable Bubblewrap Process Handle orphan remains alive while the supervisor is down;
2. restart recovery marks the formal process **`lost`** and reclaims the OS orphan;
3. the in-flight formal execution claim becomes **`UNKNOWN`** / `CRASH_RECOVERY_UNKNOWN` with **no** automatic replay or duplicate execution;
4. the Agent-facing outcome is rejected as `TOOL_OUTCOME_UNKNOWN`.

## How it was run

Host: macOS (Darwin arm64) + Docker/OrbStack Linux containers.  
Gate: `scripts/release-gates/sandbox-live-gate.mjs`  
Mode: managed non-privileged container, `SANDBOX_GATE_HARD_KILL=1`.

```sh
SANDBOX_GATE_MYSQL_URL='mysql://sandbox:<redacted>@127.0.0.1:<port>/pi_gate_g7' \
SANDBOX_GATE_MANAGED_CONTAINER=1 \
SANDBOX_GATE_HARD_KILL=1 \
SANDBOX_GATE_DOCKER_NETWORK=pi-refactor-gate-backend-internal \
SANDBOX_GATE_DOCKER_INGRESS_NETWORK=pi-refactor-gate-dev-ingress \
SANDBOX_GATE_IMAGE=enterprise-sandbox:latest \
SANDBOX_GATE_CONTAINER_DB_HOST=pi-refactor-gate-mysql \
SANDBOX_GATE_CONTAINER_REPLAY_REDIS_URL='redis://:<redacted>@pi-refactor-gate-redis:6379/0' \
SANDBOX_GATE_DATASET_BYTES=$((16 * 1024 * 1024)) \
SANDBOX_GATE_RESTART_DELAY_SECONDS=5 \
  node scripts/release-gates/sandbox-live-gate.mjs
```

Dedicated schema `pi_gate_g7` was rolled back in the gate `finally`. Ephemeral
MySQL/Redis containers used for the gate were removed after the run.

**Note:** dataset size for this G7-focused run was **16 MiB** (RSS-bounded). The
full 5 GiB dataset gate remains evidenced separately in
`release-gate-2026-07-19.md`. G7 semantics do not depend on dataset size.

## Observed result (gate JSON summary)

| Field | Value |
|-------|--------|
| `status` | `PASS` |
| `timestamp` | `2026-07-19T08:54:17.138Z` |
| `hardKillRecovery.status` | `PASS` |
| `processStatusBefore` | `running` |
| `processStatusAfter` | `lost` |
| `processPidAliveBeforeKill` | `true` |
| `processPidAliveBeforeRestart` | `true` (orphan survived uvicorn SIGKILL) |
| `processPidAliveAfterRestart` | `false` (orphan reclaimed) |
| `sandboxExecutionStatusAfter` | `UNKNOWN` |
| `sandboxExecutionErrorAfter` | `CRASH_RECOVERY_UNKNOWN` |
| `duplicateExecutionCount` | `1` (no duplicate) |
| `automaticReplay` | `false` |
| client outcome | rejected `TOOL_OUTCOME_UNKNOWN` |

Process snapshot before kill included a durable bwrap line with `--as-pid-1`
and the `hardkill-orphan-process` marker. After recovery that marker was gone.

Companion gates in the same invocation also **PASS**ed: isolation, 20-way
concurrency (~13.9× overlap), dataset/artifact byte path (16 MiB).

## Offline unit proof (same branch)

```text
tests/test_formal_orphan_recovery.py  (3)
tests/test_process_identity.py        (4 related)
tests/test_bubblewrap_isolation.py    (12 related)
→ 19 passed
```

Unit path covers TERM→KILL order on namespace init then outer wrapper, no-signal
without `start_identity`, terminal-row skip, Linux starttime field 22,
`--as-pid-1`, and capability drop before untrusted bwrap exec.

## Subagent

Investigation + live run: general-purpose subagent
`019f7991-286c-7ee3-948e-8124c5a29cab` (G7 orphan hard-kill path). Parent
re-verified unit suite and committed this evidence.
