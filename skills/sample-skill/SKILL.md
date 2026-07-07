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
3. Use Python to generate summary statistics.
4. Call `submit_artifact` to make generated files downloadable.

## Notes

- Use relative paths within the workspace.
- Do not assume network access is available.
- Keep generated files under the current workspace.
