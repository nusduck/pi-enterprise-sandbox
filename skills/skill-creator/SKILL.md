---
name: skill-creator
description: "Create, edit and package Skills for this platform. Use when the user wants to build a new Skill from scratch, turn a repeatable workflow into a Skill, improve or fix an installed Skill, or understand why a Skill will not install."
---

# Skill Creator

A Skill is a directory containing `SKILL.md` plus any supporting files. `SKILL.md`
carries YAML frontmatter (`name`, `description`) and a body of instructions that
gets loaded when the Skill is used.

Two rules govern everything below, so learn them first:

- **Skill directories are read-only.** They are mounted read-only into the
  sandbox. You cannot `write`, `edit` or `bash` your way into them, in any
  environment. Build packages in the workspace or `/tmp` and install them.
- **Installing is the only way in**, and every install requires the user's
  approval. There is no path that writes a Skill without one.

## Pick the install route

| Situation | Route |
|---|---|
| Instructions only, or a handful of small text files | `skill_create` |
| Scripts, assets, anything you want to test before installing, anything big | Build in the sandbox → `skill_install` |
| The user attached a `.zip` this turn | `skill_install` with the attachment |

Both routes end at the same validation and the same atomic replace. Prefer the
build route whenever you want to *run* the Skill's own scripts before handing it
over — that is the only way to find out that a script is broken before the user
does.

### Route A — `skill_create` (small packages)

One call, no filesystem work:

```
skill_create(
  name="weekly-report",
  description="Generate the weekly ops report from a CSV export.",
  instructions="<the full body of SKILL.md>",
  files=[{path: "template.md", content: "..."}]        # optional
)
```

`SKILL.md` is generated from `name` / `description` / `instructions` — do **not**
put a `SKILL.md` in `files`, it is rejected as a duplicate. Limits: at most 32
extra files and 512KB of content in total.

### Route B — build in the sandbox, then install

Work in a normal writable directory. `/tmp` persists for the session, so it is a
good place for a package you are still iterating on.

1. **Create the package directory.**

   ```
   /tmp/weekly-report/
     SKILL.md
     scripts/build_report.py
     reference.md
   ```

   Use `write` for each file. The directory name must equal the `name` in
   `SKILL.md`.

2. **Test whatever is testable.** Run the scripts with `bash`. A Skill whose
   script fails on first use is worse than no Skill.

3. **Package it.** The bundled script validates first and only writes an
   archive if the package is valid, so this is also your pre-flight check. It
   uses the standard library only:

   ```bash
   SC=/home/sandbox/skill/skill-creator
   PYTHONPATH=$SC python "$SC/scripts/package_skill.py" /tmp/weekly-report /tmp
   ```

   Both arguments matter. `PYTHONPATH` is required — the script imports its own
   validator as `scripts.quick_validate`. The second argument is the output
   directory, and it must be given: the default is the current directory, and
   the Skill root you are reading the script from is read-only.

   It writes `/tmp/weekly-report.skill`, which is a ZIP. `zip -r
   weekly-report.zip weekly-report/` works too where `zip` is installed; both
   extensions are accepted.

4. **Install it.** Pass the archive path — not the directory:

   ```
   skill_install(source="sandbox", path="/tmp/weekly-report.skill")
   ```

   The user approves, the package is validated and installed into their own
   Skill directory, and the Skill list is reloaded in the same step. Do **not**
   ask the user to download the archive and re-upload it; that is not how
   installation works here.

## Writing SKILL.md

```markdown
---
name: weekly-report
description: "Generate the weekly ops report from a CSV export. Use when the user asks for the weekly report or mentions ops-export.csv."
---

# Weekly Report

## When to use this
...

## Steps
1. ...
```

Frontmatter contract — all of these are enforced at install time:

- `name`: lowercase letters, digits, `-` and `_`, starting with a letter or
  digit, at most 64 characters. It must match the package directory name.
- `description`: required, at most 500 characters. **Quote it** if it contains
  `: ` — an unquoted colon is a YAML parse error and the package is rejected.
- A description is a triggering surface, not a title. Say what the Skill does
  *and* when to reach for it, in the words a user would actually type.
- You cannot take the name of a bundled Skill. Installing a name that already
  exists in the user's own Skills replaces that Skill.

Write the body for a competent reader who has none of this conversation's
context. Prefer concrete steps and real commands over description. Keep
reference material the Skill only sometimes needs in separate files and point at
them from `SKILL.md`, so the main file stays small.

## After installing

`skill_list` shows what is installed and which tier each Skill came from. The
user also sees both tiers under Settings → Capabilities → Skills.

To change an installed Skill: `skill_edit` replaces one file in place (good for
a typo or a tightened description); rebuilding and re-installing replaces the
whole package (right for anything structural). `skill_uninstall` removes one.
All three affect only the calling user and all three need approval.

To read an installed Skill, `read` its path — for example
`/home/sandbox/skill/skill-creator/SKILL.md`. **Skill directories are not
searchable**: `ls`, `find` and `grep` cover the workspace and `/tmp` only. Every
installed Skill is already named in your skills section, so read the file
directly instead of trying to list the directory.

## Not available in this environment

This package ships upstream evaluation tooling — `scripts/run_eval.py`,
`scripts/run_loop.py`, `scripts/aggregate_benchmark.py`, `agents/*.md`,
`eval-viewer/`. All of it drives the `claude` CLI and sub-agents, neither of
which exists here. Do not invoke it and do not promise the user an eval run.
(`scripts/quick_validate.py` and `scripts/package_skill.py` do work — those are
the two used above.)

Iterate the honest way instead: write the Skill, install it, use it on a real
task the user actually has, and fix what turns out to be wrong. If the user
wants triggering tuned, edit the `description` — that is the field that decides
whether a Skill gets picked up.
