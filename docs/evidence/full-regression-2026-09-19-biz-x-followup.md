# Full regression browser evidence — BIZ-01 X follow-up — 2026-09-19

## Scope and boundary

This is the BIZ-01 X synthetic boundary branch. The browser run used only the synthetic `orders-x.csv` and `refunds-x.csv` fixtures under `.runtime/qa/rt-20260919-biz/`; it did not call MCP, external network, email, or another data source, and it did not modify or overwrite the S1 artifacts. The first combined attachment attempt exposed an attachment-materialization defect: only `refunds-x.csv` landed in the sandbox. A bounded retry attached `orders-x.csv` alone and completed successfully after the model confirmed that both files were readable.

## Browser run identity

- UI status: `Succeeded`; duration `1m 10s`; 10 tools; 0 processes; 2 artifacts; 0 approvals.
- Run ID prefix shown by Details: `01M2WVQZKS0ZEQ…`.
- Started: `2026-09-19T12:55:00.509Z`.
- Workspace prefix shown by Details: `01M2WVK71YCRZH…`.
- Conversation prefix shown by Details: `01M2WVK71W7ZSR…`.
- Trace prefix shown by Details: `07205f5d77dae9…`.
- The UI download links exposed artifact IDs `01M2WVSZKP1G77R2A9331R9Q21` (xlsx) and `01M2WVSZMZHARFFN4G8DC974K1` (docx). The submit result text itself returned filename, byte size, and `Submitted`, but no Artifact ID field.

## Observed result

- Original orders: 10 rows; unique orders after order-id de-duplication: 9; duplicate: O002, identical duplicate row.
- Valid August SGD order gross: `O001 100 + O002 240 + O003 150 + O004 50 = 540 SGD`.
- Valid August refunds under the confirmed refund-occurrence-month rule: `R001 25 + R002 50 = 75 SGD`.
- Net: `540 - 75 = 465 SGD`; reported difference from the S1 baseline: `0`.
- Boundary handling observed: duplicate O002 kept once; O009 has missing `paid_amount` and is disclosed/treated as 0 pending confirmation; orphan R004 → O999 is excluded; R003 dated 2026-09 is excluded; O007 (2026-09), O008 (USD), O005 (cancelled), and O006 (pending) are excluded.
- The model reported that order status, `paid_at`, currency, and refund matching passed; R004 was the only unmatched refund.

## Submitted artifacts

The browser displayed exactly these submit results:

| filename | bytes | status |
|---|---:|---|
| `jev-s1-x-reconciliation-20260919.xlsx` | 12069 | Submitted |
| `jev-s1-x-reconciliation-20260919.docx` | 39374 | Submitted |

The xlsx displayed four sheets: raw orders, raw refunds, exception/de-duplication notes, and summary. The displayed summary said formulas (`SUM`, `SUMPRODUCT`, `COUNTIF(S)`, `IF`) reference raw sheets and `fullCalcOnLoad` is set; the model also reported a local formula-engine absence, so independent local recalculation was not available in this run. The docx was reported to contain the synthetic-data boundary, exceptions, limitations, and pending confirmations.

## Test-status impact

BIZ-01 now has browser evidence for the official S1 branch and the X boundary branch, with both X deliverables submitted. It remains `PARTIAL` for the full matrix because the required second-pass/reopen-session verification and any other BIZ-01 acceptance dimensions not covered by these two runs are not yet proven. The attachment-materialization issue and the successful single-file retry are both retained as evidence; no production code was changed.
