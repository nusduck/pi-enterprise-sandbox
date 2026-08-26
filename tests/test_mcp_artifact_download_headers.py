"""MCP public artifact download must not 500 on non-ASCII filenames."""

from __future__ import annotations

from sandbox.artifact.infrastructure.disposition import artifact_filename_header
from sandbox.mcp.app import content_disposition_attachment


def test_content_disposition_is_latin1_encodable_for_chinese_names():
    header = content_disposition_attachment("示例文件.txt")
    header.encode("latin-1")  # Starlette requires this for response headers
    assert 'filename="download.txt"' in header
    assert "示例" not in header.split("filename*=", maxsplit=1)[0]
    assert "filename*=UTF-8''" in header
    assert "%E7%A4%BA%E4%BE%8B" in header  # 示例


def test_content_disposition_ascii_name_unchanged():
    header = content_disposition_attachment("example.txt")
    assert 'filename="example.txt"' in header
    assert "filename*=UTF-8''example.txt" in header


def test_content_disposition_strips_header_injection():
    header = content_disposition_attachment('a\r\nEvil: 1";x.txt')
    assert "\r" not in header and "\n" not in header
    assert "filename=" in header
    header.encode("latin-1")


def test_filename_header_is_latin1_safe_percent_encoding():
    encoded = artifact_filename_header("示例文件.txt")
    encoded.encode("latin-1")
    assert "示例" not in encoded
    assert encoded.endswith(".txt")
