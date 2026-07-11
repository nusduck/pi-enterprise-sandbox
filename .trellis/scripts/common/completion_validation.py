"""Fail-closed validation for Trellis task completion.

The validator is deliberately side-effect free.  Archive callers must run it
before changing ``task.json``, clearing session pointers, moving directories,
or staging git changes.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


COMPLETABLE_STATUSES = frozenset({"in_progress", "review"})
DEFERRED_FIELDS = (
    "acceptance_id",
    "reason",
    "risk",
    "followup_task",
    "approved_by",
    "approved_at",
)
VALIDATION_FIELDS = ("command", "commit", "exit_code", "result", "recorded_at")
_CHECKBOX = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$")
_EXPLICIT_ACCEPTANCE_ID = re.compile(r"^\[?(AC-[A-Za-z0-9._-]+)\]?\s*[:：-]?\s*", re.IGNORECASE)


@dataclass(frozen=True)
class CompletionFinding:
    code: str
    message: str


@dataclass(frozen=True)
class CompletionReport:
    findings: tuple[CompletionFinding, ...]
    target_status: str
    incomplete_ids: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return not self.findings


def acceptance_id(source: str, text: str) -> str:
    """Return a stable ID for a checkbox, independent of its line number."""
    normalized = " ".join(text.split())
    explicit = _EXPLICIT_ACCEPTANCE_ID.match(normalized)
    if explicit:
        return explicit.group(1).upper()
    digest = hashlib.sha256(f"{source}:{normalized}".encode("utf-8")).hexdigest()[:12]
    return f"AC-{digest.upper()}"


def _finding(findings: list[CompletionFinding], code: str, message: str) -> None:
    findings.append(CompletionFinding(code=code, message=message))


def _read_jsonl(path: Path, findings: list[CompletionFinding]) -> list[tuple[int, dict]]:
    if not path.is_file():
        _finding(findings, "missing_jsonl", f"{path.name} is required")
        return []

    rows: list[tuple[int, dict]] = []
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            _finding(findings, "invalid_jsonl", f"{path.name}:{number} invalid JSON: {exc.msg}")
            continue
        if not isinstance(value, dict):
            _finding(findings, "invalid_jsonl", f"{path.name}:{number} must be a JSON object")
            continue
        rows.append((number, value))
    return rows


def _is_nonempty(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_iso_datetime(value: object) -> bool:
    if not _is_nonempty(value):
        return False
    try:
        datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _validate_manifests(task_dir: Path, repo_root: Path, findings: list[CompletionFinding]) -> None:
    root = repo_root.resolve()
    for name in ("implement.jsonl", "check.jsonl"):
        rows = _read_jsonl(task_dir / name, findings)
        real_rows = [(line, row) for line, row in rows if "_example" not in row]
        if not real_rows:
            _finding(findings, "empty_manifest", f"{name} has no curated entries")
            continue
        for line, row in real_rows:
            file_value = row.get("file")
            if not _is_nonempty(file_value) or not _is_nonempty(row.get("reason")):
                _finding(findings, "invalid_manifest", f"{name}:{line} requires non-empty file and reason")
                continue
            candidate = (repo_root / str(file_value)).resolve()
            try:
                candidate.relative_to(root)
            except ValueError:
                _finding(findings, "invalid_manifest", f"{name}:{line} path escapes repository")
                continue
            expected = candidate.is_dir() if row.get("type") == "directory" else candidate.is_file()
            if not expected:
                _finding(findings, "invalid_manifest", f"{name}:{line} path not found: {file_value}")


def _unchecked_items(task_dir: Path, findings: list[CompletionFinding]) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in ("prd.md", "implement.md"):
        path = task_dir / name
        if not path.is_file():
            if name == "prd.md":
                _finding(findings, "missing_prd", "prd.md is required")
            continue
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = _CHECKBOX.match(line)
            if not match or match.group(1).lower() == "x":
                continue
            text = match.group(2).strip()
            item_id = acceptance_id(name, text)
            if item_id in result:
                _finding(findings, "duplicate_acceptance", f"{name}:{line_number} duplicates {item_id}")
            result[item_id] = f"{name}:{line_number} {text}"
    return result


def _find_task(tasks_dir: Path, name: str) -> Path | None:
    candidates = [tasks_dir / name]
    candidates.extend(path for path in tasks_dir.glob(f"*-{name}") if path.is_dir())
    archive = tasks_dir / "archive"
    if archive.is_dir():
        candidates.extend(path for path in archive.glob(f"*/{name}") if path.is_dir())
        candidates.extend(path for path in archive.glob(f"*/*-{name}") if path.is_dir())
    return next((path for path in candidates if path.is_dir()), None)


def _validate_deferred(
    task_dir: Path,
    repo_root: Path,
    incomplete: dict[str, str],
    findings: list[CompletionFinding],
) -> None:
    if not incomplete:
        if (task_dir / "deferred.jsonl").is_file():
            rows = _read_jsonl(task_dir / "deferred.jsonl", findings)
            if rows:
                _finding(findings, "unexpected_deferred", "deferred.jsonl exists but no checkbox is incomplete")
        return

    rows = _read_jsonl(task_dir / "deferred.jsonl", findings)
    records: dict[str, dict] = {}
    tasks_dir = repo_root / ".trellis" / "tasks"
    for line, row in rows:
        missing = [field for field in DEFERRED_FIELDS if not _is_nonempty(row.get(field))]
        if missing:
            _finding(findings, "invalid_deferred", f"deferred.jsonl:{line} missing: {', '.join(missing)}")
            continue
        if not _is_iso_datetime(row.get("approved_at")):
            _finding(findings, "invalid_deferred", f"deferred.jsonl:{line} approved_at must be ISO-8601")
            continue
        item_id = str(row["acceptance_id"])
        if item_id in records:
            _finding(findings, "invalid_deferred", f"deferred.jsonl:{line} duplicates {item_id}")
            continue
        records[item_id] = row
        if _find_task(tasks_dir, str(row["followup_task"])) is None:
            _finding(findings, "missing_followup", f"deferred.jsonl:{line} follow-up task not found: {row['followup_task']}")

    for item_id, description in incomplete.items():
        if item_id not in records:
            _finding(findings, "undeferred_acceptance", f"unchecked {item_id} has no approved deferral: {description}")
    for item_id in records:
        if item_id not in incomplete:
            _finding(findings, "unknown_deferred", f"deferred record does not match an unchecked item: {item_id}")


def _validate_evidence(task_dir: Path, has_children: bool, findings: list[CompletionFinding]) -> None:
    rows = _read_jsonl(task_dir / "validation.jsonl", findings)
    valid = 0
    integration = False
    for line, row in rows:
        missing = [field for field in VALIDATION_FIELDS if field not in row]
        if missing:
            _finding(findings, "invalid_validation", f"validation.jsonl:{line} missing: {', '.join(missing)}")
            continue
        if not all(_is_nonempty(row.get(field)) for field in ("command", "commit", "result")):
            _finding(findings, "invalid_validation", f"validation.jsonl:{line} command, commit and result must be non-empty")
            continue
        if type(row.get("exit_code")) is not int or row["exit_code"] != 0:
            _finding(findings, "failed_validation", f"validation.jsonl:{line} exit_code must be 0")
            continue
        if not _is_iso_datetime(row.get("recorded_at")):
            _finding(findings, "invalid_validation", f"validation.jsonl:{line} recorded_at must be ISO-8601")
            continue
        valid += 1
        integration = integration or row.get("scope") == "integration"
    if valid == 0:
        _finding(findings, "missing_validation", "validation.jsonl has no successful evidence")
    if has_children and not integration:
        _finding(findings, "missing_integration", "parent task requires validation evidence with scope=integration")


def _validate_children(task_data: dict, repo_root: Path, findings: list[CompletionFinding]) -> None:
    tasks_dir = repo_root / ".trellis" / "tasks"
    for child_name in task_data.get("children", []):
        child = _find_task(tasks_dir, str(child_name))
        if child is None:
            _finding(findings, "missing_child", f"child task not found: {child_name}")
            continue
        try:
            child_data = json.loads((child / "task.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            _finding(findings, "invalid_child", f"child task metadata invalid: {child_name}")
            continue
        if child_data.get("status") not in {"completed", "done"}:
            _finding(findings, "incomplete_child", f"child task is not fully completed: {child_name} ({child_data.get('status')})")


def validate_completion(task_dir: Path, repo_root: Path) -> CompletionReport:
    """Validate a task without mutating the filesystem or git state."""
    findings: list[CompletionFinding] = []
    task_json = task_dir / "task.json"
    try:
        task_data = json.loads(task_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return CompletionReport(
            findings=(CompletionFinding("invalid_task", f"task.json is invalid: {exc}"),),
            target_status="completed",
        )

    status = task_data.get("status")
    if status not in COMPLETABLE_STATUSES:
        _finding(findings, "invalid_status", f"task status '{status}' cannot be completed; expected in_progress or review")

    incomplete = _unchecked_items(task_dir, findings)
    _validate_manifests(task_dir, repo_root, findings)
    _validate_children(task_data, repo_root, findings)
    _validate_evidence(task_dir, bool(task_data.get("children")), findings)
    _validate_deferred(task_dir, repo_root, incomplete, findings)
    return CompletionReport(
        findings=tuple(findings),
        target_status="completed_with_deferred" if incomplete else "completed",
        incomplete_ids=tuple(sorted(incomplete)),
    )
