"""Repository-level regression tests for Trellis completion gates.

These tests intentionally live outside ``.trellis/`` so a future Trellis
template update cannot silently remove the product's completion policy.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
TRELLIS_SCRIPTS = REPO_ROOT / ".trellis" / "scripts"
if str(TRELLIS_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(TRELLIS_SCRIPTS))

from common.completion_validation import acceptance_id, validate_completion
from common.tasks import children_progress, get_all_statuses


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def _task(tmp_path: Path, *, status: str = "in_progress", checked: bool = True) -> Path:
    task = tmp_path / ".trellis" / "tasks" / "07-11-example"
    task.mkdir(parents=True)
    (tmp_path / "spec.md").write_text("spec\n", encoding="utf-8")
    (task / "task.json").write_text(
        json.dumps({"status": status, "children": []}), encoding="utf-8"
    )
    mark = "x" if checked else " "
    (task / "prd.md").write_text(
        f"# Example\n\n## Acceptance Criteria\n\n- [{mark}] Works\n",
        encoding="utf-8",
    )
    (task / "implement.md").write_text("# Plan\n\n- [x] Implemented\n", encoding="utf-8")
    for name in ("implement.jsonl", "check.jsonl"):
        _write_jsonl(task / name, [{"file": "spec.md", "reason": "required"}])
    _write_jsonl(
        task / "validation.jsonl",
        [{
            "command": "pytest -q",
            "commit": "abc1234",
            "exit_code": 0,
            "result": "passed",
            "recorded_at": "2026-07-11T10:00:00+08:00",
        }],
    )
    return task


@pytest.mark.parametrize("status", ["planning", "blocked", "paused"])
def test_completion_rejects_non_completable_status(tmp_path: Path, status: str) -> None:
    report = validate_completion(_task(tmp_path, status=status), tmp_path)
    assert not report.ok
    assert any("status" in finding.message.lower() for finding in report.findings)


@pytest.mark.parametrize("bad_rows", [[], [{"_example": "replace me"}], [{"file": "missing.md"}]])
def test_completion_rejects_empty_placeholder_or_invalid_manifest(
    tmp_path: Path, bad_rows: list[dict]
) -> None:
    task = _task(tmp_path)
    _write_jsonl(task / "check.jsonl", bad_rows)
    report = validate_completion(task, tmp_path)
    assert not report.ok
    assert any("check.jsonl" in finding.message for finding in report.findings)


def test_completion_rejects_missing_validation_evidence(tmp_path: Path) -> None:
    task = _task(tmp_path)
    (task / "validation.jsonl").unlink()
    report = validate_completion(task, tmp_path)
    assert not report.ok
    assert any("validation.jsonl" in finding.message for finding in report.findings)


def test_unchecked_item_requires_complete_approved_deferred_record(tmp_path: Path) -> None:
    task = _task(tmp_path, checked=False)
    item_id = acceptance_id("prd.md", "Works")
    followup = task.parent / "07-11-followup"
    followup.mkdir()
    (followup / "task.json").write_text("{}", encoding="utf-8")
    _write_jsonl(
        task / "deferred.jsonl",
        [{
            "acceptance_id": item_id,
            "reason": "Needs production dependency",
            "risk": "Feature remains unavailable",
            "followup_task": followup.name,
            "approved_by": "product-owner",
            "approved_at": "2026-07-11T10:30:00+08:00",
        }],
    )

    report = validate_completion(task, tmp_path)
    assert report.ok
    assert report.target_status == "completed_with_deferred"

    rows = [json.loads(line) for line in (task / "deferred.jsonl").read_text().splitlines()]
    rows[0].pop("risk")
    _write_jsonl(task / "deferred.jsonl", rows)
    assert not validate_completion(task, tmp_path).ok


def test_checked_task_completes_and_deferred_is_not_counted_done(tmp_path: Path) -> None:
    report = validate_completion(_task(tmp_path), tmp_path)
    assert report.ok
    assert report.target_status == "completed"
    assert children_progress(
        ["complete", "deferred", "active"],
        {"complete": "completed", "deferred": "completed_with_deferred", "active": "in_progress"},
    ) == " [1/3 done, 1 deferred]"


def test_archived_deferred_status_is_available_to_parent_progress(tmp_path: Path) -> None:
    tasks = tmp_path / ".trellis" / "tasks"
    archived = tasks / "archive" / "2026-07" / "07-11-deferred"
    archived.mkdir(parents=True)
    (archived / "task.json").write_text(
        json.dumps({"status": "completed_with_deferred"}), encoding="utf-8"
    )
    statuses = get_all_statuses(tasks)
    assert statuses[archived.name] == "completed_with_deferred"
    assert children_progress([archived.name], statuses) == " [0/1 done, 1 deferred]"


def test_archive_gate_runs_before_task_mutation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from common import task_store

    task = _task(tmp_path, checked=False)
    before = (task / "task.json").read_text(encoding="utf-8")
    monkeypatch.setattr(task_store, "get_repo_root", lambda: tmp_path)
    monkeypatch.setattr(
        task_store,
        "_auto_commit_archive",
        lambda *_args, **_kwargs: pytest.fail("git auto-commit must not run after gate rejection"),
    )

    rc = task_store.cmd_archive(type("Args", (), {"name": task.name, "no_commit": False})())

    assert rc == 1
    assert task.is_dir()
    assert (task / "task.json").read_text(encoding="utf-8") == before


def test_valid_archive_preserves_normal_no_commit_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from common import task_store

    task = _task(tmp_path)
    monkeypatch.setattr(task_store, "get_repo_root", lambda: tmp_path)

    rc = task_store.cmd_archive(type("Args", (), {"name": task.name, "no_commit": True})())

    assert rc == 0
    archived = next((tmp_path / ".trellis" / "tasks" / "archive").glob(f"*/{task.name}"))
    data = json.loads((archived / "task.json").read_text(encoding="utf-8"))
    assert data["status"] == "completed"


def test_valid_deferred_archive_uses_distinct_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from common import task_store

    task = _task(tmp_path, checked=False)
    followup = task.parent / "07-11-followup"
    followup.mkdir()
    (followup / "task.json").write_text("{}", encoding="utf-8")
    _write_jsonl(
        task / "deferred.jsonl",
        [{
            "acceptance_id": acceptance_id("prd.md", "Works"),
            "reason": "External dependency",
            "risk": "Acceptance remains incomplete",
            "followup_task": followup.name,
            "approved_by": "product-owner",
            "approved_at": "2026-07-11T10:30:00+08:00",
        }],
    )
    monkeypatch.setattr(task_store, "get_repo_root", lambda: tmp_path)

    rc = task_store.cmd_archive(type("Args", (), {"name": task.name, "no_commit": True})())

    assert rc == 0
    archived = next((tmp_path / ".trellis" / "tasks" / "archive").glob(f"*/{task.name}"))
    data = json.loads((archived / "task.json").read_text(encoding="utf-8"))
    assert data["status"] == "completed_with_deferred"


def test_completed_journal_requires_validation_evidence() -> None:
    spec = importlib.util.spec_from_file_location("trellis_add_session", TRELLIS_SCRIPTS / "add_session.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    with pytest.raises(ValueError, match="validation evidence"):
        module.generate_session_content(1, "Done", "abc1234", "summary", "changes", "2026-07-11")

    content = module.generate_session_content(
        1,
        "Planning",
        "-",
        "summary",
        "changes",
        "2026-07-11",
        status="planning",
    )
    assert "[~] **Planning**" in content
    assert "Completed" not in content
