"""Static contract for the exec image's agent-facing toolchain.

These checks intentionally do not build Docker images or reach the network.
They keep the image manifest, the lockfile-backed wrappers and the production
execution contract aligned.

**Why this file is strict.** When the execution plane moved from Python
``sandbox/`` to TypeScript ``exec/``, the entire agent-facing toolchain failed
to come along — the image did not even contain ``python3``, while
``exec/src/shell/python-materialize.ts`` emits argv starting with ``python3``.
This suite had been reduced at the same time to asserting that three shell
shims exist, so it stayed green over a broken image. Assertions here must
describe capabilities the model actually depends on, not files that happen to
be present.
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def _dockerfile() -> str:
    return _read("exec/Dockerfile")


def test_skill_runtime_scripts_live_under_exec() -> None:
    """ADR 0008 D10: the three shims are runtime assets, they follow exec/."""
    skill_dir = ROOT / "exec" / "skill-runtime"
    for name in (
        "baoyu-chromium",
        "baoyu-format-markdown",
        "baoyu-markdown-to-html",
    ):
        path = skill_dir / name
        assert path.is_file(), path
        assert path.stat().st_size > 0


def test_image_installs_python_for_agent_executed_code() -> None:
    """``python3`` is not optional: the Python tool path spawns it by name."""
    dockerfile = _dockerfile()
    assert "\n    python3 \\" in dockerfile, "python3 must be an apt package in the image"
    assert "requirements.txt" in dockerfile, "agent workload libs must be installed"
    # The venv's bin has to be on PATH or `python3` resolves to a bare
    # interpreter with none of the workload libraries importable.
    assert "/opt/pi-python/venv/bin:$PATH" in dockerfile


def test_image_installs_isolation_primitives() -> None:
    """bubblewrap is the boundary; setpriv (util-linux) is fail-closed required."""
    dockerfile = _dockerfile()
    for package in ("bubblewrap", "util-linux"):
        assert f"\n    {package} \\" in dockerfile, package


def test_image_contains_office_pdf_and_browser_runtime() -> None:
    dockerfile = _dockerfile()
    for package in (
        "qpdf",
        "chromium",
        "pandoc",
        "poppler-utils",
        "tesseract-ocr",
        "fonts-noto-cjk",
        "libreoffice-calc",
        "libreoffice-impress",
        "libreoffice-writer",
    ):
        assert f"\n    {package} \\" in dockerfile, package


def test_image_contains_everyday_agent_tooling() -> None:
    """Tools the model reaches for constantly; absence is silent capability loss."""
    dockerfile = _dockerfile()
    for package in ("git", "jq", "ripgrep", "fd-find", "unzip", "zip", "file", "less"):
        assert f"\n    {package} \\" in dockerfile, package


def test_required_package_installation_cannot_be_silently_ignored() -> None:
    """A failed apt install must stop the build, not leave a partial image."""
    dockerfile = _dockerfile()
    assert '$(command -v fdfind || true)' not in dockerfile
    assert 'ln -sf "$(command -v fdfind)" /usr/local/bin/fd\n' in dockerfile


def test_agent_workload_requirements_cover_document_workflows() -> None:
    requirements = _read("exec/requirements.txt")
    for package in ("pypdfium2", "pytesseract", "pdf2image", "reportlab", "pandas"):
        assert package in requirements, package


def test_bundled_skill_versions_are_pinned_in_the_image() -> None:
    pins = json.loads(_read("runtime-versions.json"))["skill_runtime"]
    dockerfile = _dockerfile()
    assert f"ARG BUN_VERSION={pins['bun']}" in dockerfile
    assert f"ARG DOCX_JS_VERSION={pins['docx_js']}" in dockerfile
    assert f"ARG PPTXGENJS_VERSION={pins['pptxgenjs']}" in dockerfile

    package = json.loads(_read("skills/baoyu-format-markdown/scripts/package.json"))
    assert package["dependencies"]["autocorrect-node"] == pins["autocorrect_node"]
    lock = json.loads(_read("skills/baoyu-format-markdown/scripts/package-lock.json"))
    assert (
        lock["packages"]["node_modules/autocorrect-node"]["version"]
        == pins["autocorrect_node"]
    )


def test_baoyu_wrappers_are_network_free_and_use_build_time_runtime() -> None:
    """The bwrap child has no network; the shims must never reach for one."""
    for name in ("baoyu-format-markdown", "baoyu-markdown-to-html"):
        wrapper = ROOT / "exec" / "skill-runtime" / name
        text = wrapper.read_text(encoding="utf-8")
        assert text.startswith("#!/bin/sh")
        assert "/usr/local/bin/bun" in text
        assert "/usr/local/lib/pi-skill-runtime/" in text
        assert "npx" not in text
        assert "npm" not in text


def test_image_provides_the_paths_the_wrappers_hardcode() -> None:
    """The shims hardcode two paths; the image must actually create them."""
    dockerfile = _dockerfile()
    assert "/usr/local/bin/bun" in dockerfile
    assert "/usr/local/lib/pi-skill-runtime/baoyu-format-markdown/" in dockerfile
    assert "/usr/local/lib/pi-skill-runtime/baoyu-markdown-to-html/" in dockerfile
    # baoyu-chromium execs /usr/lib/chromium/chromium directly, bypassing the
    # Debian launcher (which reads /etc/chromium.d/*, outside the bwrap /etc
    # allowlist) — so the chromium package itself must be installed.
    assert "\n    chromium \\" in dockerfile


def test_control_plane_roots_are_created_and_private() -> None:
    """Artifact snapshots live outside the workspace and stay 0700."""
    dockerfile = _dockerfile()
    assert "/var/sandbox/artifacts" in dockerfile
    assert "/var/sandbox/control" in dockerfile
    assert "chmod 0700" in dockerfile
    assert "SANDBOX_ARTIFACTS_ROOT=/var/sandbox/artifacts" in dockerfile
    assert "SANDBOX_CONTROL_ROOT=/var/sandbox/control" in dockerfile
