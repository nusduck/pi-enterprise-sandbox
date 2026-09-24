# Full regression browser evidence — unauthenticated and invalid-login boundaries (2026-09-19)

## Scope

An isolated Chrome browser tab with no session cookie was opened against `http://127.0.0.1:3000/`. Only synthetic credentials and a synthetic message were used; no account was created and no existing session was logged out.

## Observed behavior

- Initial page loaded as a usable `New Conversation` shell with `Agent Ready`, a visible `Sign In / Register` control, no recent conversations, and no blank-page or permanent loading state.
- Expanding `Sign In / Register` exposed Login and Register controls. Submitting `not-a-user@example.test` with the synthetic password `wrong-password-20260919` returned the visible error `Invalid credentials`; the tab remained unauthenticated.
- Direct navigation to `/settings/runs` did not expose another user's runs. After loading, the page showed `No runs to display` and retained the `Sign In / Register` control.
- Sending the synthetic message `UNAUTH_SEND_PROBE_20260919` from the unauthenticated Chat shell produced `Connection error: Authentication required`; no Run or conversation appeared in the sidebar.

## Result impact

- ENV-02 is strengthened for the unauthenticated first-open and authentication-error distinction, but offline/backend-unavailable recovery is still untested.
- AUTH-01 is strengthened for one invalid-password attempt and the protected send boundary; valid admin/ordinary login, logout, old-link access after logout, and Cookie attribute inspection remain unverified.
- SEC-01 is strengthened for the unauthenticated browser send path; the full protected-route and acting-header matrix remains open.

