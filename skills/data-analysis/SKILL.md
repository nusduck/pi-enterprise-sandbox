---
name: data-analysis
description: Analyze CSV/Excel tables, summarize columns, and optionally generate simple chart artifacts using pandas/matplotlib.
---

# Data Analysis

Use `scripts/analyze_table.py <table-file> [--chart output.png]` for quick exploratory summaries of CSV or Excel files.

Examples:

```bash
python skills/data-analysis/scripts/analyze_table.py sales.csv
python skills/data-analysis/scripts/analyze_table.py sales.xlsx --chart revenue.png
```

After generating final charts or exports the user should receive, call `submit_artifact` with the file path.
`write` / script output alone stays private in the workspace and does not create a download link.
