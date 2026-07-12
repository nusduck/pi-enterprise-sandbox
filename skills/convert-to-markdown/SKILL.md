---
name: convert-to-markdown
description: Convert or summarize documents and web content via Markdown (PDF, DOCX, HTML, TXT, URLs). Use when the user asks to convert to markdown, 总结/摘要文档, extract text, summarize a doc/docx/pdf, or turn a page/file into .md then summarize.
---

# Convert to Markdown

Turn common source formats into readable Markdown inside the sandbox workspace.

## When to use

- "convert this PDF/DOCX/HTML to markdown"
- "turn this URL into markdown"
- "extract text from this document as .md"

## Workflow

1. **Locate the source** in the workspace (`ls` / `find`). Prefer relative paths under the session cwd.
2. **Choose a conversion path** (pick the simplest that works):

### A. Plain text / code / logs
- Read the file and write a `.md` with a short title + fenced code block if needed.

### B. HTML
- Prefer `pandoc` when available:
  ```bash
  pandoc input.html -t gfm -o output.md
  ```
- Fallback: strip tags carefully and preserve headings/lists/links by hand.

### C. DOCX
```bash
pandoc input.docx -t gfm -o output.md
```
If pandoc is missing, use the `docx` skill guidance or Python tooling if available.

### D. PDF
```bash
pdftotext -layout input.pdf output.txt
pandoc output.txt -t gfm -o output.md
```
For scanned PDFs, OCR may be required — report clearly if tools are unavailable.

### E. URL / web page
- Fetch with `curl -L` only if network policy allows.
- Prefer main content only; drop nav/footer chrome.
- Companion skill `baoyu-url-to-markdown` can help when present.
- Save as `output.md` and note the source URL.

### F. Spreadsheet (CSV/XLSX)
- CSV → Markdown table.
- XLSX → export sheet(s) then tables. Use `xlsx` skill if needed.

3. **Clean the Markdown**
- One H1 title; no skipped heading levels.
- Collapse excess blank lines.
- Preserve useful links/images; drop cookie/share chrome.

4. **Deliver**
- Write `*.md` next to the source (or under `converted/`).
- Summarize source → output path and any fidelity loss.

## Rules

- Do not invent content missing from the source.
- Prefer GitHub-Flavored Markdown.
- If a binary tool is missing, try one alternative, then report the gap.
- Redact secrets/tokens found in documents in any summary.
