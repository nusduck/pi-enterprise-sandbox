# Implement — F3

## Checklist

- [x] Layout shell three panes
- [x] Timeline widgets
- [x] Run status bar
- [x] Inspector tabs
- [x] Responsive drawer for tablet/mobile basics

## Validation

```bash
npm test --prefix frontend
npm run build --prefix frontend
```

## Agent Run Notes

### Files changed

**Layout / shell**
- `frontend/src/app/layout/AppShell.tsx` — three-pane shell (nav | workbench | inspector), inspector toggle
- `frontend/src/app/layout/WorkbenchSelectionContext.tsx` — selected card → inspector tab wiring
- `frontend/src/pages/workbench/WorkbenchPage.tsx` — center pane: header, status bar, messages, runtime timeline, composer

**Navigation**
- `frontend/src/widgets/conversation-sidebar/ConversationSidebar.tsx` — active-run markers, pending-approval hints, runtime summary

**Center workbench**
- `frontend/src/widgets/conversation-header/ConversationHeader.tsx` — title, session/model/workspace/run chips
- `frontend/src/widgets/run-status-bar/RunStatusBar.tsx` — Running · Step · Tool Calls · duration
- `frontend/src/widgets/runtime-timeline/buildTimeline.ts` — pure timeline builders + selection helpers (testable)
- `frontend/src/widgets/runtime-timeline/RuntimeTimeline.tsx` — activity list from entity store
- `frontend/src/widgets/runtime-timeline/cards/ToolExecutionCard.tsx` — args/result/duration expand
- `frontend/src/widgets/runtime-timeline/cards/ProcessCard.tsx` — status + Open Console placeholder (F4)
- `frontend/src/widgets/runtime-timeline/cards/ApprovalCard.tsx` — persistent approve/reject (entity-backed)
- `frontend/src/widgets/runtime-timeline/cards/ArtifactCard.tsx` — traces to run, download
- `frontend/src/widgets/runtime-timeline/cards/SessionEventCard.tsx` — collapsed by default

**Right inspector**
- `frontend/src/widgets/context-inspector/ContextInspector.tsx` — Overview / Files / Processes / Tools / Artifacts / Session

**Chat / entity wiring**
- `frontend/src/features/chat/ChatContext.tsx` — `resolveApproval`, inspector open state
- `frontend/src/features/chat/entityBridge.ts` — `markApproval` optimistic update

**Styles / tokens**
- `frontend/src/shared/styles/app.css` — workbench, cards, inspector, responsive drawers
- `frontend/src/shared/ui/tokens.css` — `--inspector-width` tokens

**Tests**
- `frontend/test/workbench-timeline.test.ts` — timeline order, markers, selection→tab mapping, duration helpers

### Behaviour notes

1. **Three-pane desktop** — left ConversationSidebar, center WorkbenchPage, right ContextInspector (toggle collapses to width 0).
2. **Tablet/mobile** — sidebar + inspector are drawers with backdrops (breakpoint 1100px inspector, 768px nav).
3. **Runtime timeline prefers F2 entities** — tools/processes/approvals/artifacts from `entityStore`; legacy `pendingApproval` shown if dual-write lag.
4. **Approvals persist across navigation** — entity store keeps approvals; sidebar markers use `conversationRunMarkers`; Approve/Reject via `resolveApproval` + `markApproval`.
5. **Process console** — stub link only (“Open Console (soon)”); live logs deferred to F4.
6. **Management pages** — no `/runs` or `/approvals` routes (F5).
7. **Message bubbles** still show tool pills for F1 parity; structured cards are the primary tool view.

### Verification

- `npm test --prefix frontend` — 80 passed
- `npm run build --prefix frontend` — tsc + vite build green

### Residual risks

1. **Entity tools only appear when dual-write / run events fire** — historical conversations loaded from REST may lack tool entities until run rehydrate API is complete.
2. **Inspector Files tab** is a path/artifact stub, not a full workspace tree/diff (later phases).
3. **Token/cost/budget** fields not yet on RunEntity — Overview shows placeholders via available fields only.
4. **Desktop inspector default open** may feel tight on ~1200px screens; user can toggle.
5. **No E2E** for three-pane interaction (F6).
