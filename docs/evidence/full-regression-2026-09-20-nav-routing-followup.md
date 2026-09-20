# Full regression NAV-01 routing follow-up (2026-09-20)

## Scope

This is an additive browser observation for `NAV-01`. It does not replace the
larger role, active-navigation, or management-route matrix. No production source
was changed.

## Browser observation

- The authenticated administrator session was already present in the local
  in-app browser.
- Directly opening the legacy `/runs` route redirected to
  `http://127.0.0.1:3000/settings/runs`; the rendered heading was `Active Runs`
  and the Runs table exposed the `Run ID` column.
- Directly opening the legacy `/approvals` route redirected to
  `http://127.0.0.1:3000/settings/approvals`; the rendered heading was
  `Approval Center` and approval-page content was present.
- The route checks were read-only. No run was cancelled and no approval was
  decided.

## Control-path boundary

The mechanical route checks used CUA fallback because the Runs/Chat snapshots
were too large for Jev's guarded snapshot limit. In the same browser
continuation, Jev remained active for attempted navigation and returned a
low-confidence handback when the current IAB page did not expose a reliable
action transition. The send-control issue was not counted as a product pass or
failure: a draft remained unsent and no Run was created.

## Result impact

This strengthens the legacy-route portion of `NAV-01` only. `NAV-01` remains
`PARTIAL` because the full navigation, role-boundary, badge, and Composer
matrix is not closed.
