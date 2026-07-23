"""Skill package baseline — curated everyday skills must be valid packages."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
SKILL_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
FRAMEWORK = {
    "audit.js",
    "install.js",
    "manager.js",
    "paths.js",
    "validator.js",
}
# Minimum curated set we ship for agent daily use.
REQUIRED_SKILLS = {
    "skill-creator",
    "convert-to-markdown",
    "pdf",
    "docx",
    "pptx",
    "xlsx",
}
RUNTIME_SKILL_PATH_FILES = (
    ROOT / "agent" / "src" / "skills" / "paths.js",
    ROOT / "agent" / "src" / "lib" / "text-redaction.js",
    ROOT / "sandbox" / "isolation" / "bubblewrap.py",
    ROOT / "sandbox" / "services" / "policy_checker.py",
    ROOT / "sandbox" / "Dockerfile",
    ROOT / "docker-compose.yml",
    ROOT / "docker-compose.prod.yml",
)


def _parse_frontmatter(text: str) -> dict[str, str]:
    if text.startswith("\ufeff"):
        text = text[1:]
    assert text.startswith("---"), "SKILL.md must start with YAML frontmatter"
    end = text.find("\n---", 3)
    assert end != -1, "frontmatter must be closed"
    fm = text[3:end]
    fields: dict[str, str] = {}
    for line in fm.splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$", line)
        if not m:
            continue
        val = m.group(2).strip()
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        fields[m.group(1)] = val
    return fields


def test_skill_framework_remains_available() -> None:
    names = {path.name for path in (ROOT / "agent" / "src" / "skills").iterdir()}
    assert FRAMEWORK <= names
    assert "tools.js" not in names
    assert not (ROOT / "agent" / "packages" / "enterprise-agent-kit").exists()


def test_runtime_uses_only_the_canonical_skill_path() -> None:
    canonical = "/home/sandbox/skill"
    removed = ("/sandbox/skills", "/app/.pi/skills")
    sources: list[str] = []
    for path in RUNTIME_SKILL_PATH_FILES:
        text = path.read_text(encoding="utf-8")
        sources.append(text)
        for compatibility_path in removed:
            assert compatibility_path not in text, path
    assert canonical in "\n".join(sources)


def test_curated_skills_are_valid_packages() -> None:
    assert SKILLS.is_dir()
    packages = sorted(p for p in SKILLS.iterdir() if p.is_dir())
    assert packages, "expected curated skills under skills/"

    found = {p.name for p in packages}
    missing = REQUIRED_SKILLS - found
    assert not missing, f"missing required skills: {sorted(missing)}"

    for pkg in packages:
        skill_md = pkg / "SKILL.md"
        assert skill_md.is_file(), f"{pkg.name}: missing SKILL.md"
        text = skill_md.read_text(encoding="utf-8")
        fields = _parse_frontmatter(text)
        name = fields.get("name", "").strip()
        desc = fields.get("description", "").strip()
        assert SKILL_NAME_RE.match(name), f"{pkg.name}: invalid name {name!r}"
        assert name == pkg.name, f"{pkg.name}: dir name must match frontmatter name"
        assert desc, f"{pkg.name}: description required"
        # body after second ---
        end = text.find("\n---", 3)
        body = text[end + 4 :].strip()
        assert body, f"{pkg.name}: empty body"
