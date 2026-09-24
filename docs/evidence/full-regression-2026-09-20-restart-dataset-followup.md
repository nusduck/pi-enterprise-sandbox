# Full regression DATA-02 / ART-03 restart dataset follow-up (2026-09-20)

## Scope

This additive record covers the post-restart materialization/read branch for
the synthetic S attachment datasets. No new files were uploaded during this
probe, and the Agent was instructed not to use MCP, network, or artifacts.

## Evidence

- The `sandbox` service was restarted with `docker compose restart sandbox` and
  returned to the healthy state before the browser probe.
- The existing BIZ-01 conversation was reopened after the restart. A new
  follow-up Run was sent; the previous transcript was explicitly excluded as
  an answer source.
- The new Run re-read the persisted bytes from disk and reported both files
  present after restart:
  - `orders.csv`: 315 B, 8 data rows, columns
    `order_id,status,paid_at,currency,paid_amount`.
  - `refunds.csv`: 158 B, 3 data rows, columns
    `refund_id,order_id,refunded_at,currency,amount`.
- The Run also reported byte-integrity fingerprints matching the original S
  branch (`orders.csv` MD5 `d6e886704a29168de83f9660f38d6523`; `refunds.csv`
  MD5 `18b66311262a2d9491164081aa21afe7`) and returned
  `DATA02_RESTART_DATASET_READ_OK_20260920`.

## Result

This strengthens DATA-02 and ART-03 with a real sandbox-restart,
post-restart fresh-read branch. The cases remain `PARTIAL`: cross-owner
isolation, cross-session import, download/reopen behavior, and the complete
office-artifact matrix still require separate evidence.
