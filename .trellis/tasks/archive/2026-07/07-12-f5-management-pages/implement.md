# Implement — F5

## Checklist

- [x] Runs page
- [x] Approvals page
- [x] Capabilities/settings pages
- [x] Route registration + nav links

## Validation

```bash
npm test --prefix frontend
npm run build --prefix frontend
```

## Agent Run Notes

### Files changed

**Routes / shell**
- `frontend/src/app/router/index.tsx` — `/runs`, `/approvals`, `/settings/capabilities` (+ `/settings` alias)
- `frontend/src/app/layout/AppShell.tsx` — hide inspector on management paths; `mgmt-shell` class
- `frontend/src/widgets/conversation-sidebar/ConversationSidebar.tsx` — primary nav links with active-run / pending-approval badges

**Pages**
- `frontend/src/pages/runs/RunsPage.tsx` — Active Runs table: status filters, open/cancel/logs
- `frontend/src/pages/runs/runHelpers.ts` — pure merge/filter/duration helpers
- `frontend/src/pages/approvals/ApprovalsPage.tsx` — Approval Center: decide outside conversation
- `frontend/src/pages/approvals/approvalHelpers.ts` — pure status normalize/merge/filter
- `frontend/src/pages/settings/CapabilitiesPage.tsx` — Skills / MCP / Tools / Models tabs

**API + schemas**
- `frontend/src/shared/api/approvals.ts` — list/get approvals (soft-fail) + decide
- `frontend/src/shared/api/capabilities.ts` — skills/MCP/tools/models soft-fail clients
- `frontend/src/shared/api/index.ts` — re-exports
- `frontend/src/shared/schemas/management.ts` — Zod schemas for management payloads

**Styles / tests**
- `frontend/src/shared/styles/app.css` — sidebar nav + management page styles
- `frontend/test/management-pages.test.ts` — helpers + schema tests

### Behaviour notes

1. **Soft-fail when BFF incomplete** — `GET /api/runs` list, `GET /api/approvals`, and capability registry paths return empty + clear empty states; entity store fills session-local runs/approvals.
2. **Approvals completable outside workbench** — uses existing `resolveApproval` → `POST /api/approvals/:id/decide` + entity `markApproval`.
3. **Runs actions** — Open navigates to conversation workbench; Cancel via `cancelRun`; Logs via `getRun` or entity fallback.
4. **Capabilities** — tries `/api/skills`, `/api/mcp/servers`, `/api/mcp/registry`, `/api/models` (and `/api/capabilities/*` aliases); empty state explains when registry is not proxied yet.
5. **Nav** — sidebar links: Conversations · Active Runs · Approvals · Capabilities with live badges.
6. **Legacy untouched** — F6 cleanup not performed.

### Verification

- `npm test --prefix frontend` — 88 passed
- `npm run build --prefix frontend` — tsc + vite build green

### Residual risks

1. **BFF does not yet proxy list runs / list approvals / MCP-model registry** — pages work offline against entity store; full multi-user lists need BFF routes to sandbox/agent.
2. **No admin edit UI** for registry (read-only cards until backend allows).
3. **Run logs** are detail/status dump, not full SSE replay ledger.
4. **No E2E** for management navigation (F6).
