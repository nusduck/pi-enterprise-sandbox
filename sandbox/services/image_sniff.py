"""Content-sniffed image typing for the internal read plane.

The read tool decides whether to inline a file's bytes for the model by what
the bytes *are*, never by what the path claims: a workspace file is
model-authored, so ``chart.png`` is an assertion by the same party that would
benefit from smuggling something else past the check.

The accepted set matches what the Agent can hand a provider as inline image
content (see ``prompt-image-loader.js``), plus BMP, which the Agent converts to
PNG before use. Formats outside that set stay binary-with-no-content.
"""

from __future__ import annotations

# Longest signature we need to inspect (WEBP needs 12; BMP validation 6).
IMAGE_SNIFF_BYTES = 32

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def sniff_image_mime(head: bytes | None) -> str | None:
    """Return the image MIME type *head* starts with, or None.

    *head* is the first :data:`IMAGE_SNIFF_BYTES` of the file. Returning None
    is the safe answer: the caller then withholds content, exactly as it does
    today for every binary file.
    """
    if not head or type(head) is not bytes:
        return None

    if head.startswith(b"\xff\xd8\xff"):
        # 0xFF 0xD8 0xFF 0xF7 is JPEG-LS, which inline image APIs reject.
        if len(head) >= 4 and head[3] == 0xF7:
            return None
        return "image/jpeg"

    if head.startswith(_PNG_SIGNATURE):
        return "image/png" if _is_png(head) else None

    if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
        return "image/gif"

    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"

    if head.startswith(b"BM") and _is_bmp(head):
        return "image/bmp"

    return None


def _is_png(head: bytes) -> bool:
    """A real PNG opens with a 13-byte IHDR chunk right after the signature."""
    if len(head) < 16:
        return False
    length = int.from_bytes(head[8:12], "big")
    return length == 13 and head[12:16] == b"IHDR"


def _is_bmp(head: bytes) -> bool:
    """BM plus a declared file size that is at least the 14-byte header."""
    if len(head) < 6:
        return False
    return int.from_bytes(head[2:6], "little") >= 14
