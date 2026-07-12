# Design — F6

## Delete path inventory

| Path | Action | Reason |
|------|--------|--------|
| `frontend/src/main.js` | DELETE | Superseded by `main.tsx` + `ChatContext` |
| `frontend/src/render.js` | DELETE | Superseded by React widgets |
| `frontend/src/state.js` | DELETE | Superseded by `shared/state/*` |
| `frontend/src/api.js` | DELETE | Superseded by `shared/api/*` |
| `frontend/src/sse.js` | DELETE | Superseded by `shared/sse/*` |
| `frontend/src/security.js` | DELETE | Superseded by `shared/security/url.ts` |
| `frontend/src/style.css` | DELETE | Superseded by `shared/styles/app.css` + tokens |
| `frontend/src/legacy/*` | DELETE | Duplicate archive of above |
| `shared/sse/legacyAdapter.ts` | KEEP | Active bridge: /chat SSE → RuntimeEvent |

## LocalStorage policy (ADR §4.3)

| Key | Keep? | Purpose |
|-----|-------|---------|
| `sandbox_auth_token` | yes | Auth session |
| `sandbox_conversation_id` | yes | UI pref: last conversation |
| `sandbox_ui_sidebar_open` | yes | UI pref: sidebar |
| `sandbox_messages` | **no** | Message cache — scrubbed / never restored |

## E2E matrix

| Flow | Coverage |
|------|----------|
| login | mock `/api/auth/login` + token header |
| conversation | server normalize + id pref only |
| stream | handleSSEEvent tokens + entity dual-write |
| approval | pendingApproval + markApproval |
| attach | draft → uploaded → user turn |
| cancel | abortStream + canStop + stopRun |
| reconnect | Last-Event-ID + dedupe |

## Responsive / a11y

- CSS `@media` 1100px (inspector drawer) / 768px (sidebar drawer)
- Static checks for `aria-*` / `role` on shell, sidebar, composer, timeline, management pages
