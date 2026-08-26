"""ASCII-safe Content-Disposition helpers (RFC 5987).

Starlette encodes response headers as latin-1. User-facing artifact names may
contain CJK / other non-ASCII, so they must never sit verbatim in
``filename="..."``. Keep that parameter as a conservative ASCII fallback
(preserving the original extension) and put the sanitized original in
``filename*``.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from urllib.parse import quote

_ASCII_EXT_RE = re.compile(r"\.([A-Za-z0-9]{1,8})$")


def safe_content_disposition_filename(name: str) -> str:
    base = Path(name or "artifact").name
    base = base.replace("\r", "").replace("\n", "")
    base = re.sub(r'["\\;]', "_", base)
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip() or "artifact"
    return base[:200]


def with_path_extension(name: str, fallback_path: str | None = None) -> str:
    """Sanitized display name, extension borrowed from the stored path.

    ``submit_artifact`` names are user-facing titles (``随机 Markdown 文档``);
    the extension often lives only in the workspace path. Downloading the title
    verbatim saves a file no application will open, so append the path's
    extension when the name itself has none.
    """
    filename = safe_content_disposition_filename(name)
    if _ASCII_EXT_RE.search(filename) or not fallback_path:
        return filename
    matched = _ASCII_EXT_RE.search(PurePosixPath(str(fallback_path)).name)
    if not matched:
        return filename
    ext = matched.group(0)
    return f"{filename[: 200 - len(ext)]}{ext}"


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


def artifact_content_disposition(name: str, fallback_path: str | None = None) -> str:
    filename = with_path_extension(name, fallback_path)
    ascii_fallback = ascii_filename_fallback(filename)
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def artifact_filename_header(name: str, fallback_path: str | None = None) -> str:
    """Percent-encoded basename for ``X-Artifact-Filename`` (latin-1 safe)."""
    return quote(with_path_extension(name, fallback_path), safe="")
