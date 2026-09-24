# Full regression 2026-09-19 — USER-01/USER-02 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- The admin session was logged out through the browser UI. A synthetic ordinary
  user A was registered through the visible Sign In / Register form and the
  account chip reported role `user`.
- User A completed a no-tool browser Run with marker
  `USER01_A_BROWSER_OK_20260919`. The user-facing Settings navigation contained
  Capabilities, Approvals, and Runs, but no Agents or A2A Access management
  entry.
- User A was logged out. A separate synthetic ordinary user B was registered
  through the same UI. Immediately after registration, B's Recent list did not
  contain A's marker, and B's Runs page showed the explicit empty state rather
  than A's Run history.
- User B then completed its own no-tool Run with marker
  `USER02_B_BROWSER_OK_20260919`; B's Recent list contained B's conversation
  and did not contain A's marker.

This is browser evidence for sequential same-organization ordinary-user
registration, role-bound management navigation, and owner-scoped Recent/Runs
projections. It is not a full USER-01 pass: the two identities were not active
concurrently, no second organization was provisioned, and direct resource-ID
replay plus upload/tool/artifact isolation were not repeated in this branch.
