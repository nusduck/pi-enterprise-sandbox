"""Skill runtime assets moved to exec/ with the TypeScript execution plane."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_skill_runtime_scripts_live_under_exec() -> None:
    skill_dir = ROOT / "exec" / "skill-runtime"
    for name in (
        "baoyu-chromium",
        "baoyu-format-markdown",
        "baoyu-markdown-to-html",
    ):
        path = skill_dir / name
        assert path.is_file(), path
        assert path.stat().st_size > 0
