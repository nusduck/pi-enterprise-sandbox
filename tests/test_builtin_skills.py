"""Tests for built-in sandbox skills."""

from __future__ import annotations

import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"


def run_script(path: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(path), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_builtin_skills_have_skill_docs_and_help():
    for name in ["document-parser", "data-analysis", "sql-query"]:
        skill_dir = SKILLS / name
        assert (skill_dir / "SKILL.md").is_file()
        scripts = list((skill_dir / "scripts").glob("*.py"))
        assert scripts
        for script in scripts:
            result = run_script(script, "--help")
            assert result.returncode == 0, result.stderr
            assert "usage:" in result.stdout.lower()


def test_data_analysis_skill_summarizes_csv(tmp_path):
    csv_path = tmp_path / "sales.csv"
    csv_path.write_text("month,revenue\nJan,10\nFeb,20\n", encoding="utf-8")

    result = run_script(SKILLS / "data-analysis" / "scripts" / "analyze_table.py", str(csv_path))

    assert result.returncode == 0, result.stderr
    assert "revenue" in result.stdout
    assert "mean" in result.stdout


def test_sql_query_skill_allows_readonly_sqlite(tmp_path):
    db_path = tmp_path / "sample.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute("CREATE TABLE items (name TEXT)")
        conn.execute("INSERT INTO items VALUES ('alpha')")

    result = run_script(
        SKILLS / "sql-query" / "scripts" / "query_database.py",
        f"sqlite:///{db_path}",
        "SELECT name FROM items",
    )

    assert result.returncode == 0, result.stderr
    assert "alpha" in result.stdout


def test_sql_query_skill_blocks_writes_by_default(tmp_path):
    db_path = tmp_path / "sample.db"
    db_path.touch()

    result = run_script(
        SKILLS / "sql-query" / "scripts" / "query_database.py",
        f"sqlite:///{db_path}",
        "DROP TABLE items",
    )

    assert result.returncode != 0
    assert "read-only" in result.stderr.lower()
