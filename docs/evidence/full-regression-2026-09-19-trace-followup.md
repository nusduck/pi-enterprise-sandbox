# Full regression browser evidence — Runs, Logs, and Trace projection (2026-09-19)

## Observed page behavior

Authenticated ordinary-user navigation to `/settings/runs` displayed the run table with filters `All`, `Running`, `Waiting Approval`, `Waiting Input`, `Failed`, and `Completed`. The table exposed per-run `Open`, `Logs`, and `Trace` actions. The current account could see its synthetic runs, including the latest approval-unavailable probe and the cancelled INPUT-02 probe.

## Run detail probe

Opening `Trace` for the latest synthetic approval probe exposed a durable detail panel with:

- Run ID `01M2WXKZSEWW66W33SV619WSX4`, status `SUCCEEDED`, duration about 2.3s.
- Trace ID `3de66c9ff74848817c18785e724d4654`.
- Organization ID `01M29ZHZV8VF2G344QZFM9MKDN` and user ID `01M2WCB43FZBE9F0GX2TZQVT8M`.
- Three `OK` spans: Run, Queue (26ms wait), and Pi session checkpoint (0ms).

Switching the same panel to `Logs` showed the same run ID, conversation ID, session ID, started/finished timestamps, `error: —`, and `last_sequence: 362` / `last_event_id`.

## Result impact

This is positive evidence for same-owner Run/Trace/Logs projection and trace-to-run correlation. It does not prove cross-user 404 behavior, a failing Run's diagnostic path, or admin-wide management, so TRACE-01 and MGMT-01 remain `PARTIAL`.

