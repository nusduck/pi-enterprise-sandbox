# Full regression 2026-09-19 — AGENT-07 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- In the administrator Agent editor, a synthetic legacy snapshot using
  `schemaVersion=0`, `system_prompt`, `model`, `max_output_tokens`, and a
  `legacyField` was entered as a draft.
- The Agent service returned five explicit diagnostics: `schemaVersion must be
  1`, plus unknown-field diagnostics for each legacy/unsupported field. The
  draft was not publishable and no version was created; the fields remained
  visible rather than being silently discarded.
- The draft was restored to the active flash v2 configuration without saving a
  new version. No historical version was rewritten.

This is migration/refusal evidence for AGENT-07's invalid legacy-field branch.
It does not claim a supported old-schema migration, old-session follow-up after
upgrade, or rollback of a migrated version; no isolated legacy fixture was
available in the browser environment.
