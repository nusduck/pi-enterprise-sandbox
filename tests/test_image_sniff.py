"""Content sniffing for inline image reads."""

from __future__ import annotations

import pytest

from sandbox.services.image_sniff import IMAGE_SNIFF_BYTES, sniff_image_mime

PNG = b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + b"\x00" * 16
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 28
GIF = b"GIF89a" + b"\x00" * 26
WEBP = b"RIFF" + b"\x00" * 4 + b"WEBP" + b"\x00" * 20
BMP = b"BM" + (5000).to_bytes(4, "little") + b"\x00" * 26


class TestAcceptedFormats:
    @pytest.mark.parametrize(
        ("data", "expected"),
        [
            (PNG, "image/png"),
            (JPEG, "image/jpeg"),
            (GIF, "image/gif"),
            (WEBP, "image/webp"),
            (BMP, "image/bmp"),
            (b"GIF87a" + b"\x00" * 26, "image/gif"),
        ],
    )
    def test_sniffs_supported_images(self, data: bytes, expected: str) -> None:
        assert sniff_image_mime(data) == expected


class TestRejected:
    def test_rejects_text(self) -> None:
        assert sniff_image_mime(b"hello world" + b"\x00" * 21) is None

    def test_rejects_empty_and_none(self) -> None:
        assert sniff_image_mime(b"") is None
        assert sniff_image_mime(None) is None

    def test_rejects_jpeg_ls(self) -> None:
        """0xF7 marks JPEG-LS, which inline image APIs refuse."""
        assert sniff_image_mime(b"\xff\xd8\xff\xf7" + b"\x00" * 28) is None

    def test_rejects_png_without_ihdr(self) -> None:
        """The signature alone is not a PNG; a real one opens with IHDR."""
        assert sniff_image_mime(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24) is None

    def test_rejects_riff_that_is_not_webp(self) -> None:
        assert sniff_image_mime(b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * 20) is None

    def test_rejects_bmp_with_impossible_size(self) -> None:
        assert sniff_image_mime(b"BM" + (3).to_bytes(4, "little") + b"\x00" * 26) is None

    def test_rejects_an_elf_named_like_an_image(self) -> None:
        """The path never decides; a renamed binary must stay content-less."""
        assert sniff_image_mime(b"\x7fELF\x02\x01\x01" + b"\x00" * 25) is None


class TestTruncatedHead:
    def test_too_short_to_confirm_is_refused(self) -> None:
        """Withholding is the safe answer when the head is incomplete."""
        assert sniff_image_mime(PNG[:10]) is None

    def test_sniff_window_covers_every_signature(self) -> None:
        for sample in (PNG, JPEG, GIF, WEBP, BMP):
            assert sniff_image_mime(sample[:IMAGE_SNIFF_BYTES]) is not None
