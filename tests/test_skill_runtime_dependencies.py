"""Static contract for bundled Skill dependencies.

These checks intentionally do not build Docker images or access registries. They
keep the image manifest, lockfile-backed wrappers, and the production execution
contract aligned when a future cleanup edits the Sandbox runtime.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_sandbox_image_contains_office_pdf_and_browser_runtime() -> None:
    dockerfile = _read("sandbox/Dockerfile")
    for package in (
        "qpdf",
        "chromium",
        "fonts-noto-cjk",
        "libreoffice-calc",
        "libreoffice-impress",
        "libreoffice-writer",
    ):
        assert f"    {package}" in dockerfile


def test_sandbox_python_requirements_cover_document_workflows() -> None:
    requirements = _read("sandbox/requirements.txt")
    for package in ("pypdfium2", "pytesseract", "pdf2image", "reportlab"):
        assert package in requirements


def test_bundled_skill_versions_are_pinned_in_the_image() -> None:
    pins = json.loads(_read("runtime-versions.json"))["skill_runtime"]
    dockerfile = _read("sandbox/Dockerfile")
    assert f"ARG BUN_VERSION={pins['bun']}" in dockerfile
    assert f"ARG DOCX_JS_VERSION={pins['docx_js']}" in dockerfile
    assert f"ARG PPTXGENJS_VERSION={pins['pptxgenjs']}" in dockerfile

    package = json.loads(
        _read("skills/baoyu-format-markdown/scripts/package.json")
    )
    assert package["dependencies"]["autocorrect-node"] == pins["autocorrect_node"]
    lock = json.loads(
        _read("skills/baoyu-format-markdown/scripts/package-lock.json")
    )
    assert (
        lock["packages"]["node_modules/autocorrect-node"]["version"]
        == pins["autocorrect_node"]
    )


def test_baoyu_wrappers_are_network_free_and_use_build_time_runtime() -> None:
    for name in ("baoyu-format-markdown", "baoyu-markdown-to-html"):
        wrapper = ROOT / "sandbox" / "skill-runtime" / name
        text = wrapper.read_text(encoding="utf-8")
        assert text.startswith("#!/bin/sh")
        assert "/usr/local/bin/bun" in text
        assert "/usr/local/lib/pi-skill-runtime/" in text
        assert "npx" not in text
        assert "npm" not in text
        skill = _read(f"skills/{name}/SKILL.md")
        assert f"/usr/local/bin/{name}" in skill
        assert "${BUN_X}" not in skill
    chrome = _read("sandbox/skill-runtime/baoyu-chromium")
    assert chrome.startswith("#!/bin/sh")
    assert "/usr/lib/chromium/chromium" in chrome
    assert "--no-sandbox" in chrome


def test_child_environment_exposes_only_bundled_node_module_path() -> None:
    safe_env = _read("sandbox/security/safe_env.py")
    assert '"NODE_PATH": "/usr/local/lib/node_modules"' in safe_env
    assert '"BAOYU_CHROME_PATH": "/usr/local/bin/baoyu-chromium"' in safe_env
