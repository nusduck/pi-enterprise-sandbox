---
name: sample-skill
description: A sample skill template demonstrating the SKILL.md format and structure.
---

# Data Analysis Skill

## When to Use

Use this skill when the task involves CSV, Excel, database exports, transaction records, or feature analysis.

## Workflow

1. Inspect files with `list` / `read` / `preview`.
2. Understand columns and data types.
3. Use Python to generate summary statistics (`write` / `bash` only touch the private workspace).
4. Call `submit_artifact` on final/important outputs so the user can download them.
   `write` / `edit` alone never share files with the user.

## Notes

- Use relative paths within the workspace.
- Do not assume network access is available.
- Keep generated files under the current workspace.
- Only call `submit_artifact` for deliverables the user should receive — not every intermediate file.
