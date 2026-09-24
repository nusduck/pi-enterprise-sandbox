# Full regression 2026-09-19 — Jev bridge follow-up

## Scope

This evidence records the browser-control correction after the operator asked whether Jev was actually being used. It does not change `docs/reviews/2026-09-01-full-regression/test-cases.md`, production source, or the pass/partial/blocker classification of the regression matrix.

Browser: Codex in-app browser, `http://127.0.0.1:3000`, ordinary synthetic user `root@admin.comrt-20260919-a`.

Jev was loaded from `/Users/eddie/.codex/skills/jev-browser-use/bridge.mjs` inside `cua_repl`; provider was `typesafe`, model was `jev-1.13.0`, and the allowed origin was restricted to the local application. Jev returned `needs_verification` as designed; every successful navigation below was checked with a fresh AX snapshot.

## Jev actions and independent checks

1. **Schedules** — Jev clicked the visible `Schedules` link. The final URL was `/schedules`; the fresh AX state contained `Scheduled Runs`, `Create New Scheduled Run`, and the chat link. No schedule was created, edited, run, paused, resumed, or deleted.
2. **Capabilities → MCP Servers** — Jev clicked `Settings`, then selected `MCP Servers`. The MCP selection initially became stale while the page changed; Jev detected the stale state and retried against fresh state. The fresh AX state showed `MCP Servers 1` selected, `exa` as `Connected`, and `Tools 2`.
3. **Capabilities → Tools** — Jev selected `Tools`. The fresh AX state showed `Tools 17` selected and listed the connected Exa tools with `Approval: require_approval`.

The cumulative Jev session metrics after these three tasks were 3 runs, 8 decisions, 4 executed actions, and 0 failed decisions. These are action-loop metrics, not test-case pass counts.

## Boundary and fallback

4. **Runs** — A Jev read-only navigation attempt from the large Tools page was rejected by the bridge with `Snapshot too large; narrow the task`. This is a bridge-size limitation: the Runs page exposes a large table and its AX snapshot is over the bridge's 24,000-character guard. It is not evidence of an application failure and is not counted as a Jev success.

After that rejection, CUA performed only the safe, read-only link click to `/settings/runs`. A fresh AX snapshot independently showed `Active Runs`, the status filters (`All`, `Running`, `Waiting Approval`, `Waiting Input`, `Failed`, `Completed`), and the run table with `Open`, `Logs`, and `Trace` controls. No run-control action was invoked.

## Interpretation

- Confirmed: Jev was used for three real browser action loops, including a stale-state retry, with independent post-action verification.
- Confirmed: the Runs-page Jev attempt was blocked by the bridge snapshot-size guard, so the fallback is explicitly labeled CUA.
- Not established: this follow-up does not close any remaining full-regression cases and does not change the overall matrix status; the regression remains incomplete with partial and blocked cases.
