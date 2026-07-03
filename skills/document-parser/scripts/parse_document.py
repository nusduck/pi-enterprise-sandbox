#!/usr/bin/env python3
"""Parse documents to Markdown/text with MarkItDown fallback helpers."""

from __future__ import annotations

import argparse
from pathlib import Path


def parse_document(path: Path) -> str:
    try:
        from markitdown import MarkItDown

        result = MarkItDown().convert(str(path))
        text = getattr(result, "text_content", None) or str(result)
        return text
    except Exception:
        # Conservative fallback for plain text fixtures / simple docs.
        return path.read_text(encoding="utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert a document to Markdown/text")
    parser.add_argument("input", help="Input document path")
    parser.add_argument("--output", "-o", help="Optional output file path")
    args = parser.parse_args()

    text = parse_document(Path(args.input))
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
