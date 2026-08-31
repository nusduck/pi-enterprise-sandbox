---
name: skill-creator
description: "Build Skills for this platform in the writable draft root, then hand them to the user to enable. Use when the user wants a new Skill, wants a repeatable workflow turned into one, wants an existing one improved, or asks why a Skill is not showing up."
---

# Skill Creator

A Skill is a directory containing `SKILL.md` plus any supporting files. `SKILL.md`
carries YAML frontmatter (`name`, `description`) and a body of instructions that
gets loaded when the Skill is used.

Three roots govern everything below, so learn them first. They differ in exactly
two ways — **who can write** and **whether the model sees it** — and that split
is what makes this work:

| Root | Writable by you | In discovery / your prompt |
|---|---|---|
| `/home/sandbox/skill` (system) | no, ever | yes |
| `/home/sandbox/skill-user/<pkg>` (enabled) | no | yes |
| `/home/sandbox/skill-draft` (**draft**) | **yes** | **no** |

- **You build in the draft root, with ordinary tools.** `write`, `edit` and
  `bash` work there exactly as they do in the workspace. There is no
  `skill_create`, no `skill_install`, no `skill_edit`, no `skill_uninstall` —
  those tools do not exist. Do not look for them.
- **Only a human can enable a package.** Enabling copies the bytes into a
  read-only published copy and puts it in the user's prompt. You cannot do it,
  and nothing you write to the draft root changes an already-enabled package.
- **The draft root is per user and persistent.** A package you leave there
  survives the run; the user can enable it later.

## How to build one

Work in `/home/sandbox/skill-draft/<package-name>/`:

```bash
mkdir -p /home/sandbox/skill-draft/my-skill/scripts
```

Then `write` the files. The only required file is `SKILL.md` with `name` and
`description` frontmatter; the `name` must equal the directory name.

Because it is an ordinary directory you can **run the thing before handing it
over** — that is the whole reason to build rather than describe:

```bash
cd /home/sandbox/skill-draft/my-skill && bash scripts/do-the-thing.sh
```

## How the user enables it

Tell them where it is and what it does; they enable it under
**Settings → Capabilities → Skills**. On enable the platform:

1. validates the structure (SKILL.md, frontmatter, name match, size and file
   count, no symlinks, no VCS metadata);
2. **copies the bytes** into a read-only published copy;
3. records the enablement with a content digest.

Two consequences worth stating plainly, because they change how you should work:

- Editing the draft afterwards does **not** change the enabled package. To ship
  a change, edit the draft and ask the user to enable it again.
- A draft that is never enabled costs nothing and reaches nobody. Leaving a
  half-finished package there is fine.

You cannot take the name of a bundled system Skill; enabling such a package is
refused.

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

Frontmatter contract — all of these are enforced **at enable time**, not while
you write. A draft with a bad `SKILL.md` costs nothing until someone tries to
enable it, and then it is refused with the reason:

- `name`: lowercase letters, digits, `-` and `_`, starting with a letter or
  digit, at most 64 characters. It must match the package directory name.
- `description`: required, at most 500 characters. **Quote it** if it contains
  `: ` — an unquoted colon is a YAML parse error and the package is rejected.
- A description is a triggering surface, not a title. Say what the Skill does
  *and* when to reach for it, in the words a user would actually type.
- You cannot take the name of a bundled system Skill; enabling such a package is
  refused. Enabling a name the user already has **replaces** that package
  wholesale — old files disappear rather than accumulating.

Write the body for a competent reader who has none of this conversation's
context. Prefer concrete steps and real commands over description. Keep
reference material the Skill only sometimes needs in separate files and point at
them from `SKILL.md`, so the main file stays small.

## After enabling

`skill` (the factory tool) loads an available Skill's full instructions by name.
The user sees both tiers under Settings → Capabilities → Skills.

To change an enabled Skill: edit the draft copy and ask the user to enable it
again — that replaces the published copy wholesale. To remove one, the user
disables it; the draft is left alone (disabling is not deleting their work).

To read an enabled Skill, `read` its path — for example
`/home/sandbox/skill/skill-creator/SKILL.md`. `ls /home/sandbox/skill-user`
lists what is currently enabled for this user; `ls /home/sandbox/skill-draft`
lists what is still a draft.

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
