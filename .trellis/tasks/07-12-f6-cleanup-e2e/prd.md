# F6 — Cleanup and E2E

## Goal

删除旧 main.js 编排、手工 DOM render、消息 LocalStorage 恢复（保留 UI 偏好）；补充响应式/无障碍与 E2E。

## Dependencies

F3+ feature complete enough to drop legacy.

## Acceptance Criteria

- [x] Legacy orchestration removed
- [x] Message localStorage restore removed; UI prefs kept
- [x] Core flows E2E covered
- [x] Engineering AC from ADR §20 Engineering satisfied

## Notes (implement)

- Engineering §20: TS code path, Zod schemas, server/UI state split, unit tests on core streams, E2E smoke for key flows.
- Browser Playwright not introduced (per existing frontend quality-guidelines: no Playwright config yet); smoke uses `node:test` + mocked fetch as available harness.
