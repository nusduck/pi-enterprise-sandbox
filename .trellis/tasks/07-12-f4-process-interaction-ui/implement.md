# Implement — F4

## Checklist

- [x] Process console widget
- [x] Steer/follow-up API client + UI
- [x] Budget bar
- [x] Resume UX
- [x] Tests for composer mode switching

## Validation

```bash
npm test --prefix frontend
npm run build --prefix frontend
```

## Agent Run Notes

### Files changed

**API clients**
- `frontend/src/shared/api/runs.ts` — `steerRun`, `followUpRun`, `resumeApproval` (soft-fail 404/501)
- `frontend/src/shared/api/processes.ts` — process logs / stdin / signal / cancel (soft-fail)
- `frontend/src/shared/api/index.ts` — re-exports

**Entity / events**
- `frontend/src/entities/types.ts` — `budgetUsage` / `budgetLimits` / `budgetWarning` on `RunEntity`
- `frontend/src/entities/store.ts` — createRun defaults
- `frontend/src/shared/state/runReducer.ts` — budget.warning / budget.exceeded store usage; rehydrate budget
- `frontend/src/shared/sse/legacyAdapter.ts` — map `budget_warning` / `budget_exceeded` legacy SSE

**Process console**
- `frontend/src/widgets/process-console/logHelpers.ts` — pure log filter / download / interactive helpers
- `frontend/src/widgets/process-console/ProcessConsole.tsx` — full-screen sheet: live logs, pause auto-scroll, search, stdout/stderr filter, offset history, stdin, signals, cancel, download
- `frontend/src/widgets/runtime-timeline/cards/ProcessCard.tsx` — Open Console
- `frontend/src/widgets/context-inspector/ContextInspector.tsx` — Open Console + budget on Overview
- `frontend/src/app/layout/WorkbenchSelectionContext.tsx` — `consoleProcessId` + open/close
- `frontend/src/app/layout/AppShell.tsx` — console state wiring
- `frontend/src/pages/workbench/WorkbenchPage.tsx` — mount ProcessConsole sheet
- `frontend/src/widgets/runtime-timeline/RuntimeTimeline.tsx` — `onOpenProcessConsole`

**Composer modes (ADR §7)**
- `frontend/src/widgets/composer/composerMode.ts` — Idle / Running / Waiting Approval pure helpers
- `frontend/src/widgets/composer/Composer.tsx` — mode UI: Steer / Follow-up / Stop; approval banner; resume banner
- `frontend/src/features/chat/ChatContext.tsx` — `steerRun`, `followUpRun`, `stopRun`, `resumeInterrupted`

**Budget + resume**
- `frontend/src/widgets/budget-bar/budget.ts` — pure budget formatters
- `frontend/src/widgets/budget-bar/BudgetBar.tsx` — compact usage bar
- `frontend/src/widgets/run-status-bar/RunStatusBar.tsx` — BudgetBar + Resume button

**Styles**
- `frontend/src/shared/styles/app.css` — process console, composer modes, budget bar

**Tests**
- `frontend/test/composer-mode.test.ts` — mode switching, resume entry, capability flags
- `frontend/test/process-console.test.ts` — log filter + budget helpers

### Behaviour notes

1. **Process Console** — sheet over workbench; primary log source is entity `stdout`/`stderr` (SSE dual-write). History load / stdin / signal / cancel call `/api/processes/*` and soft-fail when BFF proxy missing.
2. **Composer Idle** — send new task (unchanged attachments gate).
3. **Composer Running** — textarea stays enabled; Steer / Follow-up toggle; Stop aborts stream + `POST /api/runs/:id/cancel`.
4. **Composer Waiting Approval** — banner with Approve / Reject / Cancel run; follow-up still available.
5. **Budget** — shown only when usage is present (SSE `budget.*` or GET run rehydrate).
6. **Resume** — interrupted run/message shows Resume on status bar + composer; rehydrates in-progress runs and focuses input (resume-approval when waiting_approval).
7. **No F5 management pages**; no full layout rebuild.

### Verification

- `npm test --prefix frontend` — **96 passed**
- `npm run build --prefix frontend` — tsc + vite build green

### Residual risks

1. Process BFF proxy (`/api/processes/*`) may not be wired yet — console still shows live entity logs; history/stdin soft-fail with status message.
2. Steer/follow-up require a real agent run id (synthetic local ids from `/chat` path may 404 until run-centric create is used).
3. Budget only appears after backend emits usage (or GET /runs returns budget).
4. Resume does not invent a new agent turn automatically — user continues via message / follow-up after focus.
