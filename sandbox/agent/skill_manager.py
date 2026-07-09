"""Skill discovery and to_prompt conversion."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sandbox.config import settings
from sandbox.paths import AGENT_SKILL_PATH


class SkillManager:
    """List and load skills from the shared read-only skill root."""

    def __init__(self, skills_root: str | Path | None = None) -> None:
        self.skills_root = Path(skills_root or settings.skills_path)

    @property
    def agent_visible_path(self) -> str:
        return AGENT_SKILL_PATH

    def list_skills(self) -> list[dict[str, Any]]:
        root = self.skills_root
        if not root.is_dir():
            return []
        skills: list[dict[str, Any]] = []
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            if not skill_md.is_file():
                continue
            skills.append({
                "name": child.name,
                "path": str(child),
                "agent_path": f"{AGENT_SKILL_PATH}/{child.name}",
                "has_skill_md": True,
            })
        return skills

    def read_skill_md(self, name: str) -> str | None:
        path = self.skills_root / name / "SKILL.md"
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8", errors="replace")

    def to_prompt(self, names: list[str] | None = None) -> str:
        """Convert selected (or all) skills into a compact prompt block."""
        skills = self.list_skills()
        if names is not None:
            want = set(names)
            skills = [s for s in skills if s["name"] in want]
        if not skills:
            return ""
        blocks: list[str] = ["## Available Skills", ""]
        for s in skills:
            body = self.read_skill_md(s["name"]) or ""
            # Keep prompt compact: first ~40 lines
            lines = body.strip().splitlines()[:40]
            blocks.append(f"### Skill: {s['name']}")
            blocks.append(f"Path: {s['agent_path']}")
            blocks.append("\n".join(lines))
            blocks.append("")
        return "\n".join(blocks).strip()
