"""ASCII-safe Content-Disposition helpers (RFC 5987).

Starlette encodes response headers as latin-1. User-facing artifact names may
contain CJK / other non-ASCII, so they must never sit verbatim in
``filename="..."``. Keep that parameter as a conservative ASCII fallback
(preserving the original extension) and put the sanitized original in
``filename*``.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import quote

_ASCII_EXT_RE = re.compile(r"\.([A-Za-z0-9]{1,8})$")


def safe_content_disposition_filename(name: str) -> str:
    base = Path(name or "artifact").name
    base = base.replace("\r", "").replace("\n", "")
    base = re.sub(r'["\\;]', "_", base)
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip() or "artifact"
    return base[:200]


def ascii_filename_fallback(name: str) -> str:
    """Latin-1 filename= value that still carries a usable extension."""
    filename = safe_content_disposition_filename(name)
    ext = ""
    matched = _ASCII_EXT_RE.search(filename)
    if matched:
        ext = matched.group(0).lower()
        body = filename[: matched.start()]
    else:
        body = filename
    ascii_body = "".join(
        char if 0x20 <= ord(char) <= 0x7E else "_" for char in body
    )
    ascii_body = re.sub(r"[_\s.]+", "_", ascii_body).strip("._") or "download"
    return f"{ascii_body}{ext}"[:200]


def artifact_content_disposition(name: str) -> str:
    filename = safe_content_disposition_filename(name)
    ascii_fallback = ascii_filename_fallback(filename)
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def artifact_filename_header(name: str) -> str:
    """Percent-encoded basename for ``X-Artifact-Filename`` (latin-1 safe)."""
    return quote(safe_content_disposition_filename(name), safe="")
