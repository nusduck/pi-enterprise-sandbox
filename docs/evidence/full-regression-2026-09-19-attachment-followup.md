# Full regression browser evidence — attachment read follow-up

Date: 2026-09-19 (Asia/Singapore)

This file records a new, synthetic-only browser run. It does not replace the
baseline or earlier follow-up evidence.

## TOOL-02 — attachment readability probe

Observed in the local browser UI at `http://127.0.0.1:3000/`:

- Attached the synthetic fixture `.runtime/qa/rt-20260919-biz/orders.csv` through
  the user-facing Attach files control.
- The run finished as `Succeeded` in 5 seconds with 1 tool, 0 processes, 0
  artifacts, and 0 approvals.
- Run ID prefix: `01M2WVYWGFT8JW…`.
- Workspace ID prefix: `01M2WVYP62R85S…`.
- Conversation ID prefix: `01M2WVYP5YSXND…`.
- Trace ID prefix: `aaafd6cc35e531…`.
- The real file-read result reported the sandbox path
  `datasets/ds_a92a1efcff204cf79b8b662db23d068b/orders.csv`.
- The tool observed 9 lines (header plus 8 data rows), with columns
  `order_id,status,paid_at,currency,paid_amount`.
- There was no literal `amount` column; the amount-like column was
  `paid_amount`.
- The measured `paid_amount` sum across all rows was 920. The measured sum for
  rows with `status=paid` was 610 SGD. The fixture also contains one USD row,
  so an unconverted cross-currency total is not a valid financial total.

This proves a real synthetic attachment can be read by the execution path and
that the result is grounded in observed file content. It is not a full TOOL-02
pass: the official fixture, write/execute/restart path, and corruption/recovery
branches were not all exercised in this probe. Current status impact: TOOL-02
remains `PARTIAL`, upgraded from the current-run baseline `BLOCKED`.

No production files, private files, external services, or persistent cleanup
operations were used in this run.
