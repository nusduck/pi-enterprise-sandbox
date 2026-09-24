# Full regression browser evidence — ordinary-user administrator boundaries

- Date: 2026-09-19 (Asia/Singapore)
- Account: `root@admin.comrt-20260919-a`, UI role `User`
- Scope: read-only direct-route checks; no save, publish, credential, or destructive action was attempted.

## Direct routes

### `/settings/agents`

The ordinary user could load the page and see the organization default agent. The page explicitly rendered `Administrator role is required`; the new-agent `Create Agent` control was disabled, and the existing configuration save controls were disabled with `Validation is unavailable: Administrator role is required. Publishing is blocked.`

This is evidence that the UI does not grant ordinary-user mutation access. It is not evidence of an HTTP 403 for the page or its underlying APIs, so the resource-level administrator assertion remains only partially verified.

### `/settings/a2a`

The ordinary user could load the direct page, but it rendered only the A2A overview and `Administrator role is required`; no credential-management control was available. No credential was created or changed.

## Assessment

- `SEC-01`: **PARTIAL, strengthened**. Ordinary-user direct management actions are visibly blocked in both Agents and A2A pages. A separate unauthenticated 401 probe exists in the auth evidence. Exact ordinary-user API status codes for every admin route were not claimed because direct browser navigation to API JSON was blocked by the browser client.
- `NAV-01`: **PARTIAL, strengthened**. Direct admin routes fail closed at the mutation/UI boundary, while ordinary users can still inspect the organization default agent needed by the conversation picker. Full admin-versus-user route inventory remains incomplete.

