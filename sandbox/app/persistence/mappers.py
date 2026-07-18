"""Map MySQL snake_case rows ↔ domain records."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sandbox.app.domain.types import (
    ArtifactRecord,
    AuditRecord,
    DatasetRecord,
    ExecutionRecord,
    ProcessRecord,
    SandboxSessionRecord,
)


def parse_json_column(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    if isinstance(value, str):
        if value == "":
            return None
        return json.loads(value)
    raise TypeError(f"Unsupported JSON column value type: {type(value)!r}")


def dumps_json(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def format_datetime(value: Any) -> str | None:
    """Normalize DB datetime to ISO-8601 UTC string."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if "T" not in raw:
            raw = raw.replace(" ", "T", 1)
        if raw.endswith("Z") or re_has_offset(raw):
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(
                timezone.utc
            ).isoformat().replace("+00:00", "Z")
        return (
            datetime.fromisoformat(raw)
            .replace(tzinfo=timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
    raise TypeError(f"Unsupported datetime value: {type(value)!r}")


def re_has_offset(raw: str) -> bool:
    return len(raw) >= 6 and (raw[-6] in "+-") and raw[-3] == ":"


def to_mysql_datetime(value: datetime | str | None = None) -> str:
    """Format for MySQL DATETIME(3) UTC storage: ``YYYY-MM-DD HH:mm:ss.sss``."""
    if value is None:
        d = datetime.now(timezone.utc)
    elif isinstance(value, datetime):
        d = value
    else:
        raw = str(value).strip()
        if "T" not in raw:
            raw = raw.replace(" ", "T", 1)
        d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    d = d.astimezone(timezone.utc)
    # 2026-07-18 04:31:22.417
    return d.strftime("%Y-%m-%d %H:%M:%S.") + f"{int(d.microsecond / 1000):03d}"


def map_sandbox_session(row: dict[str, Any]) -> SandboxSessionRecord:
    return SandboxSessionRecord(
        sandbox_session_id=str(row["sandbox_session_id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]),
        agent_session_id=str(row["agent_session_id"]),
        workspace_id=str(row["workspace_id"]),
        status=str(row["status"]),
        created_at=format_datetime(row["created_at"]) or "",
        updated_at=format_datetime(row["updated_at"]) or "",
        closed_at=format_datetime(row.get("closed_at")),
    )


def _nullable_str(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _nullable_int(value: Any) -> int | None:
    """Map nullable integer columns without coercing NULL → 0."""
    if value is None:
        return None
    return int(value)


def map_execution(row: dict[str, Any]) -> ExecutionRecord:
    result = parse_json_column(row.get("result_json"))
    return ExecutionRecord(
        execution_id=str(row["execution_id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]),
        sandbox_session_id=str(row["sandbox_session_id"]),
        run_id=str(row["run_id"]),
        agent_session_id=str(row["agent_session_id"]),
        kind=str(row["kind"]),
        status=str(row["status"]),
        created_at=format_datetime(row["created_at"]) or "",
        started_at=format_datetime(row.get("started_at")),
        completed_at=format_datetime(row.get("completed_at")),
        exit_code=int(row["exit_code"]) if row.get("exit_code") is not None else None,
        error_code=str(row["error_code"]) if row.get("error_code") is not None else None,
        trace_id=str(row["trace_id"]) if row.get("trace_id") is not None else None,
        result_json=result if isinstance(result, dict) else None,
        # PR-07B claim fields — preserve NULL (never coerce to 0 / "").
        tool_execution_id=_nullable_str(row.get("tool_execution_id")),
        tool_call_id=_nullable_str(row.get("tool_call_id")),
        request_hash=_nullable_str(row.get("request_hash")),
        request_hash_version=_nullable_int(row.get("request_hash_version")),
        execution_fence_token=_nullable_int(row.get("execution_fence_token")),
    )


def map_process(row: dict[str, Any]) -> ProcessRecord:
    cmd = parse_json_column(row.get("command_json"))
    if cmd is None:
        cmd = {}
    return ProcessRecord(
        process_id=str(row["process_id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]),
        sandbox_session_id=str(row["sandbox_session_id"]),
        run_id=str(row["run_id"]),
        execution_id=str(row["execution_id"]),
        command_json=cmd,
        status=str(row["status"]),
        created_at=format_datetime(row["created_at"]) or "",
        pid=int(row["pid"]) if row.get("pid") is not None else None,
        exit_code=int(row["exit_code"]) if row.get("exit_code") is not None else None,
        stdout_path=(
            str(row["stdout_path"]) if row.get("stdout_path") is not None else None
        ),
        stderr_path=(
            str(row["stderr_path"]) if row.get("stderr_path") is not None else None
        ),
        started_at=format_datetime(row.get("started_at")),
        ended_at=format_datetime(row.get("ended_at")),
    )


def map_dataset(row: dict[str, Any]) -> DatasetRecord:
    return DatasetRecord(
        dataset_id=str(row["dataset_id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]),
        conversation_id=str(row["conversation_id"]),
        agent_session_id=str(row["agent_session_id"]),
        original_filename=str(row["original_filename"]),
        stored_relative_path=str(row["stored_relative_path"]),
        status=str(row["status"]),
        created_at=format_datetime(row["created_at"]) or "",
        mime_type=str(row["mime_type"]) if row.get("mime_type") is not None else None,
        size_bytes=(
            int(row["size_bytes"]) if row.get("size_bytes") is not None else None
        ),
        sha256=str(row["sha256"]) if row.get("sha256") is not None else None,
        completed_at=format_datetime(row.get("completed_at")),
    )


def map_artifact(row: dict[str, Any]) -> ArtifactRecord:
    return ArtifactRecord(
        artifact_id=str(row["artifact_id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]),
        conversation_id=str(row["conversation_id"]),
        agent_session_id=str(row["agent_session_id"]),
        run_id=str(row["run_id"]),
        relative_path=str(row["relative_path"]),
        display_name=str(row["display_name"]),
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
        status=str(row["status"]),
        created_at=format_datetime(row["created_at"]) or "",
        mime_type=str(row["mime_type"]) if row.get("mime_type") is not None else None,
    )


def map_audit(row: dict[str, Any]) -> AuditRecord:
    payload = parse_json_column(row.get("payload_json"))
    return AuditRecord(
        audit_id=str(row["audit_id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]),
        event_type=str(row["event_type"]),
        created_at=format_datetime(row["created_at"]) or "",
        sandbox_session_id=(
            str(row["sandbox_session_id"])
            if row.get("sandbox_session_id") is not None
            else None
        ),
        execution_id=(
            str(row["execution_id"]) if row.get("execution_id") is not None else None
        ),
        process_id=(
            str(row["process_id"]) if row.get("process_id") is not None else None
        ),
        trace_id=str(row["trace_id"]) if row.get("trace_id") is not None else None,
        payload_json=payload if isinstance(payload, dict) else None,
    )
