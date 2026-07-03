---
name: document-parser
description: Convert PDF, Word, Excel, PowerPoint and other office documents to Markdown/text using MarkItDown and related preinstalled libraries.
---

# Document Parser

Use `scripts/parse_document.py <input-file> [--output output.md]` to extract readable Markdown/text from common documents. The script runs inside the sandbox and writes output under the workspace when requested.

Examples:

```bash
python skills/document-parser/scripts/parse_document.py report.pdf --output report.md
python skills/document-parser/scripts/parse_document.py workbook.xlsx
```
