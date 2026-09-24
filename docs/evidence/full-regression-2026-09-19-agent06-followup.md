# Full regression 2026-09-19 — AGENT-06 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- Opened two in-app browser tabs with the same administrator session and the
  same `data-analysis-jev-20260919` active v2 as the base.
- Prepared two different valid flash drafts from that same active version:
  tab A used `maxOutputTokens=1000` and marker `AGENT06_A`; tab B used
  `maxOutputTokens=900` and marker `AGENT06_B`. Both showed `Validated by the
  Agent service` before publishing.
- Published tab A first. The UI reported `Created version 4 and made it
  active`.
- Published tab B from its stale v2 base immediately afterward. The UI returned
  `Activation conflict: another administrator changed the active version. Your
  draft was preserved.` The B draft still contained its distinct persona and
  was not silently overwritten; v4 was visible in the version history.
- Activated v2 again in tab A to restore the pre-probe active flash version. The
  second browser tab was closed; no Agent/version was deleted.

This is direct browser evidence for the AGENT-06 optimistic-concurrency branch
and stale-publish protection. Model/options-loading failure, delayed stale
validation responses, network-uncertain retry, and the omitted/null/explicit
`expected_active_version_id` API compatibility variants remain open.
