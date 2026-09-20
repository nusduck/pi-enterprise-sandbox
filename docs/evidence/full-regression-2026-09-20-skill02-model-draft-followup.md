# SKILL-02 model-created draft follow-up (2026-09-20)

## Scope

- Case: `SKILL-02` in `docs/reviews/2026-09-01-full-regression/test-cases.md`.
- The probe used the authenticated administrator UI and the real model tool
  surface. It was limited to a synthetic user draft under the permitted
  sandbox skill-draft area.
- No Skill was enabled, published, installed, submitted as an artifact, or
  used through MCP. The system Skill roots and network were not touched.

## Observed run

The model created exactly one draft named `jev-model-draft-20260920` with real
`write` calls:

- `SKILL.md` at `/home/sandbox/skill-draft/jev-model-draft-20260920/SKILL.md`
  (19 lines, minimal valid frontmatter).
- `scripts/echo.sh` at
  `/home/sandbox/skill-draft/jev-model-draft-20260920/scripts/echo.sh`
  (6 lines, executable mode `-rwxr-xr-x`).

The model then used `bash` to execute the script. The process exited `0` and
reported:

```text
SKILL02_ECHO_OK_20260920
script=echo.sh host=02dfb70da839 utc=2026-09-19T17:18:47Z
```

Two attempts to load `jev-model-draft-20260920` through the actual `skill`
mechanism both returned:

```text
skill "jev-model-draft-20260920" is unknown or no longer available
```

The model returned the exact probe marker
`SKILL02_DRAFT_SELFTEST_OK_20260920` only after the files, executable
self-test, and unavailable-load result were all present.

## Conclusion

This is positive evidence for model-created draft contents, executable script
self-test, and the fail-closed boundary that an unenabled draft is not
discoverable through `skill`. `SKILL-02` remains `PARTIAL`: the complete
matrix still requires packaging/hash checks, archive traversal and malformed
package cases, system Skill coverage, and persistence/isolation checks.
