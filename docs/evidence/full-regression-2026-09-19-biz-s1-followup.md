# Full regression browser evidence — BIZ-01 S1

- Date: 2026-09-19 (Asia/Singapore)
- Method: real UPRC Agent browser run using Jev for browser acceleration and CUA/Playwright for the two synthetic CSV uploads. No production code was changed.
- Scope: BIZ-01 S1 only; synthetic fixture branch, not the private-data branch.
- Data boundary: only the attached synthetic `orders.csv` (315 bytes, 8 data rows) and `refunds.csv` (158 bytes, 3 data rows) were used. No MCP, external network, email, invitation, or other data source was used. No cross-currency conversion was performed.

## Run identity and result

- Status: `Succeeded`
- Tool calls: 45
- Duration: 4m 35s
- Run ID prefix: `01M2WV7HSR21JQ…`
- Started: `2026-09-19T12:46:02.076Z`
- Workspace prefix: `01M2WV6Y8TSTGS…`
- Conversation prefix: `01M2WV6Y8B23VE…`
- Trace prefix: `70638e5e39778d…`
- Model: the Details panel did not expose a model value; the separately recorded runtime evidence identifies the active model path as `deepseek-flash`.

The first attachment attempt reproduced a real missing-attachment failure: the declared `orders.csv` dataset path did not exist while `refunds.csv` was readable. After the user-facing “重新提供 orders.csv，然后我继续” branch, the browser attachment was re-provided and the run read `datasets/ds_e07e32cc9cc84371aa893e49e5b84f65/orders.csv` (315 bytes). The final run then completed with both source files present.

## User input and calculation

- User-selected refund attribution: `按退款发生月统计`.
- Target month: `2026-08`.
- Target currency: `SGD`.
- Independent result from the CSVs:
  - Order lines: 8.
  - Valid August SGD paid orders: 4 (`O001`, `O002`, `O003`, `O004`).
  - Valid paid amount: 540 SGD.
  - Refund lines: 3.
  - Valid August refunds under refund-occurrence-month attribution: 2 (`R001`, `R002`).
  - Valid refund amount: 75 SGD.
  - Net: 465 SGD (`540 - 75`).
  - Unmatched refunds: 0.

Exclusions independently confirmed and shown in the deliverables:

- `O005`: `cancelled`, `paid_at` empty; not revenue.
- `O006`: `pending`, `paid_at` empty; not revenue.
- `O007`: paid in 2026-09, outside the target month.
- `O008`: USD; excluded without FX conversion.
- `R003`: refund occurred on 2026-09-02; excluded under the selected refund-occurrence-month attribution. The deliverables record the alternative paid-month cross-check as 95 SGD refunds and 445 SGD net, but do not use it as the primary result.

## Artifacts

The final run submitted exactly two artifacts. The UI download links exposed these artifact IDs; the two `submit_artifact` tool returns themselves exposed only the filename and byte size, so no additional status or ID is inferred from the tool response.

1. `jev-s1-official-reconciliation-20260919.xlsx`
   - Submitted response: `Submitted artifact jev-s1-official-reconciliation-20260919.xlsx (16192 bytes).`
   - UI artifact ID: `01M2WVFNW73RZY503VN9SR1EWW`
   - Four sheets: `原始订单表`, `原始退款表`, `汇总表`, `口径与排除说明`.
   - 61 formulas; LibreOffice recalculation reported 0 formula errors and cached values matched the independent calculation.
2. `jev-s1-official-reconciliation-20260919.docx`
   - Submitted response: `Submitted artifact jev-s1-official-reconciliation-20260919.docx (13657 bytes).`
   - UI artifact ID: `01M2WVFQ1X1YFC2WNDR1VPQMAS`
   - Chinese report covering data nature, source boundary, selected attribution, results, exclusions, cross-check, limitations, pending confirmations, and reproducibility.
   - `documents` validation: `All validations PASSED`.

## Case status impact

BIZ-01 is upgraded from synthetic-inline-only evidence to a completed synthetic S1 branch, but remains `PARTIAL` for the full case because the test case also requires the X boundary branch and a reopen/second-pass check. This evidence does not close the private-data, authorization, second-organization, destructive, or other blocked branches.

## Safety and cleanup

- No private or repository files were uploaded.
- No destructive UI action or cleanup of user data was performed.
- Temporary build/probe files were removed; the workspace retained only the two submitted deliverables and the two synthetic source CSVs for this branch.
