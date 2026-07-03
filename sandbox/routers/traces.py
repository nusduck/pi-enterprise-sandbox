"""Trace query router."""

from __future__ import annotations

from fastapi import APIRouter

from sandbox.database import database
from sandbox.repositories import AuditRepository, ExecutionRepository

router = APIRouter(prefix="/traces", tags=["traces"])


@router.get("/{trace_id}")
def get_trace(trace_id: str):
    executions = ExecutionRepository(database).list_by_trace_id(trace_id)
    audit_logs = AuditRepository(database).list_by_trace_id(trace_id)
    session_ids = sorted(
        {item["session_id"] for item in executions + audit_logs if item.get("session_id")}
    )
    return {
        "trace_id": trace_id,
        "sessions": session_ids,
        "executions": executions,
        "audit_logs": audit_logs,
    }
