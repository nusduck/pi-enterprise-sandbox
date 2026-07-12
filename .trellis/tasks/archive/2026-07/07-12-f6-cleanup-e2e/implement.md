# Implement — F6

## Checklist

- [x] Remove legacy files/paths
- [x] E2E suite
- [x] a11y/responsive checks
- [x] Final parent acceptance sweep

## Validation

```bash
npm test --prefix frontend
npm run build --prefix frontend
npm run test:e2e --prefix frontend
```

## Agent Run Notes

### Legacy deletion (safe, import-verified)

Deleted fully superseded vanilla SPA orchestration:

- `frontend/src/main.js`, `render.js`, `state.js`, `api.js`, `sse.js`, `security.js`, `style.css`
- Entire `frontend/src/legacy/` directory (duplicate copies)

Entry remains `index.html` → `/src/main.tsx`. Grep confirmed no live imports of deleted modules.
`shared/sse/legacyAdapter.ts` is **kept** — it is the active /chat SSE → RuntimeEvent bridge used by `entityBridge` (not the old DOM path).

### Message LocalStorage restore removed

In `shared/state/chatState.ts`:

- Removed `persistMessages` / `loadPersistedMessages`
- Kept UI prefs: `persistConversationId`, `loadPersistedConversationId`, `persistSidebarOpen`, `loadPersistedSidebarOpen`
- `clearPersistedChat` + scrub on load/write remove leftover `sandbox_messages` key
- `ChatContext` boot loads messages from **server only**; never falls back to local message cache

Auth token LocalStorage (`sandbox_auth_token`) retained.

### E2E / integration smoke

- `frontend/test/e2e-smoke.test.ts` — mock-backend flows: login, conversation, stream, approval, attach, cancel, reconnect
- `frontend/test/a11y-responsive.test.ts` — CSS breakpoints (1100/768), aria attributes on shell/sidebar/composer/timeline/mgmt pages, cleanup invariants
- Script: `npm run test:e2e --prefix frontend`

### Build fixes (blocking green)

- Typed `consoleProcessId` / `openProcessConsole` / `closeProcessConsole` on `WorkbenchSelectionValue`
- Wired `onOpenConsole` on `ProcessCard`
- Resolved leftover `<<<<<<< f4` / `>>>>>>> f5` merge conflict in `app.css` (kept both F4 process/composer + F5 management styles)

### Verification

- `npm test --prefix frontend` → **128 pass / 0 fail**
- `npm run build --prefix frontend` → **tsc + vite green** (no CSS conflict warnings)
