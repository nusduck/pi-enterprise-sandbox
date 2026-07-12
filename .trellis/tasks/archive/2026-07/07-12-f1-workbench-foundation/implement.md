# Implement — F1

## Checklist

- [x] Add React+TS+Router deps and Vite config
- [x] Design tokens / base layout shell
- [x] Typed API client + Zod for existing endpoints
- [x] Port conversation/chat/attachment/approval/artifact UX
- [x] Tests for critical client logic
- [x] Build + unit tests green

## Validation

```bash
npm test --prefix frontend
npm run build --prefix frontend
```

## Agent Run Notes

### Files changed

**Config / entry**
- `frontend/package.json` — React, React Router, Zod, TS, Vite React plugin, `tsx` test runner
- `frontend/tsconfig.json` — strict TS (Node >=22)
- `frontend/vite.config.ts` — React plugin + `/api` proxy
- `frontend/index.html` — React `#root` mount

**Shared (typed core)**
- `frontend/src/shared/api/client.ts` — typed API client (legacy chat SSE compatible)
- `frontend/src/shared/schemas/api.ts` — Zod schemas for REST/SSE envelopes
- `frontend/src/shared/sse/parser.ts` — SSE incremental parser
- `frontend/src/shared/security/url.ts` — `/api` URL allowlist
- `frontend/src/shared/state/*` — chat state machine + attachment drafts
- `frontend/src/shared/ui/tokens.css` — design tokens
- `frontend/src/shared/styles/app.css` — migrated chat styles

**App shell (React)**
- `frontend/src/main.tsx`, `app/App.tsx`, `app/router/`, `app/layout/AppShell.tsx`
- `frontend/src/pages/workbench/WorkbenchPage.tsx`
- `frontend/src/features/chat/ChatContext.tsx` — orchestration (port of main.js)
- `frontend/src/features/chat/sseHandler.ts` — SSE event reducer
- `frontend/src/widgets/*` — sidebar, messages, composer, deliverables, flash/approval

**Tests**
- `frontend/test/*.test.ts` — state, attachments, SSE, security, schemas, interrupted

**Legacy retained (F6 cleanup)**
- `frontend/src/legacy/*` — copies of vanilla JS SPA modules
- Original `frontend/src/{main,api,render,state,sse,security}.js` left in place (not deleted)

### Verification

- `npm test --prefix frontend` — 47 passed
- `npm run build --prefix frontend` — tsc + vite build green

### Residual risks

1. **React StrictMode double-mount** may double-fire boot `refreshConversations` / `me` in dev only.
2. **SSE token streaming** still mutates `currentMsg.content` in place (legacy parity); F2 entity architecture will replace this.
3. **Zod soft-fail**: `parseApi` logs validation errors and falls back to raw data so optional backend fields don't break UI.
4. **Legacy JS files** still on disk under `src/` and `src/legacy/` — entry is React; full deletion deferred to F6.
5. **No E2E** yet — unit coverage for client logic only; full chat stream E2E is F6 / later.
6. **pi-web-ui** dependency retained but not yet wired for message rendering (optional F3 polish).
7. **Mobile sidebar** open state uses media query at render time; rapid resize may need a listener (desktop toggle still works).
