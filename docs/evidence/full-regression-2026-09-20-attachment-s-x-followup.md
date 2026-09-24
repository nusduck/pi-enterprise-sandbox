# Full regression TOOL-02 / BIZ-01 attachment follow-up (2026-09-20)

## Scope

This additive record covers the real browser upload/read branch for the
synthetic S and X CSV packages. The files are repository-local regression
fixtures; no private data or external credentials were used.

## S branch

- In a fresh administrator conversation, the file chooser uploaded
  `orders.csv` (315 B) and `refunds.csv` (158 B). Both rendered `Ready` before
  sending.
- The sent message visibly retained both attachments. The Agent read the
  materialized datasets and reported 8 order rows with columns
  `order_id,status,paid_at,currency,paid_amount`, and 3 refund rows with
  columns `refund_id,order_id,refunded_at,currency,amount`.
- The independent result was: August 2026 SGD paid revenue `540 SGD`, August
  refunds `75 SGD` after excluding the September refund, and net `465 SGD`.
  Cancelled, pending, September, and USD rows were explicitly excluded.
- Duplicate order/refund IDs and unmatched refund checks were all clear in the
  S branch. The response returned
  `BIZ01_ATTACHMENT_ORACLE_OK_20260920` and the Run succeeded after five tool
  steps.

## X branch

- In the same conversation, `orders-x.csv` (388 B) and `refunds-x.csv` (195 B)
  were uploaded and both rendered `Ready` before the follow-up was sent.
- The response reported exactly the intended anomalies: duplicate `order_id`
  `O002`, blank `paid_amount` for `O009`, and orphan refund `R004 → O999`.
- The previously approved S totals remained unchanged at `540 / 75 / 465 SGD`;
  the response explicitly rejected the naive inflated `780 / 85` totals.
- The response returned `BIZ01_X_ANOMALIES_OK_20260920` and the Run succeeded
  after five tool steps.

## Remove-before-send branch

- A separate fresh conversation uploaded `orders.csv`, showed it as `Ready`,
  and then activated the visible `Remove orders.csv` control before any prompt
  was sent.
- The Composer returned to an empty draft with Send disabled. The remaining
  `orders.csv` text was only in Recent Conversations history, not in the
  Composer attachment area; no Run was created for the removed draft.

## Result impact

This upgrades `TOOL-02` from upload/read-only evidence to a real S/X
attachment-and-model-read branch, and strengthens `BIZ-01`'s oracle and anomaly
preservation assertions. Both cases remain `PARTIAL`: same-name isolation,
restart/Dataset persistence, cross-session Artifact import, and the full
office-delivery/reopen matrix remain unverified.
