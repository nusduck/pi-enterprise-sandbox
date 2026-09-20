# Full regression 2026-09-19 — capability and run-management follow-up

## Read-only browser evidence

The same ordinary synthetic user session was used: `root@admin.comrt-20260919-a` (`User`). No run-control, account, configuration, or deletion action was invoked.

### Jev capability navigation

Using the Jev bridge (`typesafe`, `jev-1.13.0`) and independently refreshing AX state after each action:

- `Models` was selected. The page showed `deepseek-flash` and `qwen3.8-27b`, both `Enabled`, with context window `262144`, max output `65536`, and tool calls enabled.
- `Extension diagnostics` was selected. The page showed `pi-enterprise-agent @ 4.0.0`, profile `coding-agent @ 4.0.0`, view `configured`, audit `built-in`, allowed tools `15`, shared skills policy `all`, and a generated-at timestamp.

Both actions returned Jev's expected `needs_verification` handoff and passed the independent UI-state checks. They were read-only tab selections.

### Runs, logs, trace, and status filters

The Runs table is too large for the Jev bridge's 24,000-character AX guard, so the route into Runs and the table controls below used CUA as an explicitly recorded fallback. The fresh page showed `Active Runs`, filters for `All`, `Running`, `Waiting Approval`, `Waiting Input`, `Failed`, and `Completed`, plus the `Open`, `Logs`, and `Trace` actions.

- The first visible run's Logs detail opened read-only and showed status `SUCCEEDED`, a run/conversation/session ID tuple, timestamps, `last_sequence: 14`, and a last event ID.
- Its Trace tab opened read-only and showed Trace ID `8c11469b2efb09bd2ccea3e19d856bed` with three `Status: ok` spans: run, queue, and session checkpoint.
- The `Completed` filter could be selected. The `Failed` filter selected cleanly and showed `No runs to display — No runs match “Failed”`.
- `Waiting Approval` and `Waiting Input` filters also selected cleanly and showed their corresponding empty-state messages. Empty approval/input filters are UI evidence only; they do not establish approval or waiting-input feature success.

## Interpretation

This follow-up strengthens read-only `CAP-01`, `MGMT-01`, and `TRACE-01` observations. It does not close the full cases: the approval center remains empty, the run-management matrix lacks all state/control branches, and no claim is made for a complete regression pass.

## Runs-page cancel attempt (2026-09-20)

- A fresh administrator conversation started a harmless foreground `sleep 30`
  Run. The Runs page displayed that Run as `Running`, with the expected
  `Open`, `Logs`, `Trace`, and `Cancel` actions.
- Jev could not act on the oversized Runs table, so the visible `Cancel` row
  was activated through the browser fallback. The product raised a native
  confirmation dialog; the automation handoff did not accept it, and the Run
  later completed naturally at about 33 seconds. The Agent explicitly reported
  that no cancellation was delivered.
- A second attempt left only an unsent draft because the new-conversation send
  control did not transition into a Run. No further cancel click was issued.

- A fresh administrator conversation was then used for a second independent
  `sleep 30` probe. The new Runs tab visibly showed the exact row as `Running`
  with `Cancel`; activating `Cancel` raised the browser-native confirmation,
  but the in-app browser handoff could not complete that dialog interaction.
A separate fresh Runs tab later showed the same row as `Succeeded` after
about 32 seconds, so this branch also provides negative evidence only.

- The completed conversation projection later displayed `Succeeded · 1 tool ·
  32s` while its assistant text contained the requested cancellation marker.
  Because the authoritative Runs row was `Succeeded`, that text is treated as
  model output contradicted by the Run status, not as cancellation evidence.

This is negative evidence that the first attempt was not a cancellation pass;
`MGMT-01` remains `PARTIAL` until the confirmation dialog is accepted and the
same Run is observed as `Cancelled` from the Runs table.
