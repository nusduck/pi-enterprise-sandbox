# Skill visibility & creator-shape closure evidence (2026-08-26)

The two rows below were removed from the "Deferred" table in
[`review-deferred-items.md`](../../review-deferred-items.md). They came out of
the 2026-08-25 external test report as items 9 and 8 respectively — the two the
[triage](../../reviews/2026-08-25-sandbox-issue-triage/README.md) deliberately
left unfixed because neither was a defect.

They are **history**: do not cite them as current state without re-verifying
against code.

## Closed

| Item | Closure evidence |
| --- | --- |
| User Skill visibility in the web UI | `GET /api/capabilities/skills` is now projected per caller. `getExtensionDiagnostics` takes the identity the route already resolved from `X-Acting-User-Id` / `X-Acting-Organization-Id` and calls `resolveSkillScopeForIdentity` — the same resolver a Run uses — so the tab lists exactly what that user's next Run would load. Each package carries `source`: `shared-skill-root` (bundled) or `user-skill-root` (that user's own), and Settings → Capabilities → Skills renders them as "My Skills" / "System Skills". A request without identity projects the system tier only; the user-tier **base** directory is never scanned whole, so one tenant can never enumerate another's installed Skills. |
| Skill creator shape (tool call vs. model writing the package directly) | `skill_install` gained `source: "sandbox"`: the model builds a package with ordinary `write` / `bash` in the workspace or `/tmp`, runs and zips it, and passes the archive path. That is the report's "model writes it directly" — using only pre-existing write surfaces — while the privileged write stays exactly where it was. The bundled `skill-creator` Skill was rewritten to describe this platform instead of the upstream Claude Code workflow it shipped with. No ADR was opened: the constraint an ADR would have adjudicated (the Skill tree is `--ro-bind`, so a controlled write is unavoidable) is satisfied by construction rather than by decision. |

## Why the visibility row closed at less than its original scope

The row asked for four things: which Skills are installed, whether reload
succeeded, whether the mount succeeded, and which Skill a Run used. **Only the
first shipped**, by explicit product decision on 2026-08-26 — the ask was
narrowed to "distinguish the two tiers in the Skills tab, `source` is enough".

The three that did not ship are not lost work; each has a known, cheap seam, so
they are recorded here rather than re-deferred:

- **Reload result.** `createSkillManager` already accepts an `onAfterReload`
  hook that no caller passes (`agent/src/skills/manager.js`). `mutateAndReload`
  currently swallows a failed reload into `{ reloaded: false, error }` that only
  the model sees. Wiring that hook to the Run event recorder would put it on the
  timeline. `capability_registry_updated` is documented in `api.md` and
  `architecture.md` with **no emitter anywhere in the tree** and
  `registry_version: null` — filling that in is the natural home.
- **Mount result.** `sandbox/isolation/bubblewrap.py::_skill_binds` already
  distinguishes bound / absent (ENOENT, normal) / unreadable, and drops the last
  two to a `logger.warning`. Returning that as structured state is close to free;
  it is a cross-service contract change, which is why it was scoped out.
- **Run-level attribution.** `agent/src/extensions/sandbox-bridge/tools/index.js`
  already branches on `norm.area === 'skill'` for every skill read. A per-Run
  deduped event off that branch would attribute usage with no new model-facing
  surface and no way for the model to misreport it. Deriving it offline from
  `tool_executions` instead is **not** reliable: `arguments_json` is read back as
  the redacted `publicJsonView` (see the 2026-08-25 triage, issue 5).

## Verified at closure

- `agent` suite: 1504 tests, 0 failures. `provider-gate.unit.test.js` is
  timing-flaky on this tree independently of these changes (three consecutive
  runs on the same tree gave 7/0/0, 1/0/6, 1/0/6 pass/fail/cancelled; `fail` is
  always 0).
- `frontend` suite: 309 tests, 0 failures; `tsc --noEmit` clean.
- Python: `tests/test_builtin_skills.py`, `test_skill_runtime_dependencies.py`,
  `test_path_validation.py` — 27 passed.
- The rewritten `skills/skill-creator/SKILL.md` passes the platform's own
  `validateSkillPackage`, and its **install segment** was run for real:
  `package_skill.py` output handed to the real `installSkillArchive` as
  `source_type: sandbox_build`.
  The download segment was **not** covered by that run: `manager.install()` for
  `source: "sandbox"` runs `downloadWorkspaceArchive({ path }) →
  readSkillArchiveDownload → installSkillArchive`
  (`agent/src/skills/manager.js`), and the run above skipped the first two hops
  and fed the archive bytes in directly.

  **Closed on 2026-08-26** against the running stack — see
  [`docs/evidence/2026-08-26-skill-ls-and-install-digest.md`](../../evidence/2026-08-26-skill-ls-and-install-digest.md).
  An archive in a real Sandbox workspace was fetched over the real
  `GET /sessions/{id}/files/download` and installed; the bytes that arrived hash
  to what was sent. Read the evidence for what that run does and does not cover
  before citing it.

The packaging command in that Skill needs both `PYTHONPATH` and an explicit
output directory. Without the first the script fails to import its own
validator; without the second it defaults to the current directory, which on the
read-only Skill root it is read from cannot be written.
