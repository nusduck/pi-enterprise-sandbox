"""Zero-Skill release baseline regression tests."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"


def test_release_contains_no_skill_packages() -> None:
    assert SKILLS.is_dir()
    assert list(SKILLS.rglob("SKILL.md")) == []
    assert [path for path in SKILLS.iterdir() if path.is_dir()] == []


def test_skill_framework_remains_available() -> None:
    expected = {
        "audit.js",
        "install.js",
        "manager.js",
        "paths.js",
        "tools.js",
        "validator.js",
    }
    assert expected <= {path.name for path in (ROOT / "agent" / "skills").iterdir()}
