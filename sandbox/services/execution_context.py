"""Server-resolved filesystem context for sandbox tool execution.

Callers provide only a session id. Physical workspace/temp paths are derived
from the trusted session binding and are never accepted from API, MCP, or model
arguments.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sandbox.paths import (
    AGENT_TEMP_PATH,
    LEGACY_AGENT_WORKSPACE_PATH,
    ensure_physical_temp,
    ensure_physical_workspace,
    get_session_temp_id,
    get_session_workspace_id,
)


@dataclass(frozen=True)
class SandboxExecutionContext:
    session_id: str
    workspace_id: str
    temp_id: str
    physical_workspace: Path
    physical_temp: Path
    logical_workspace: str = LEGACY_AGENT_WORKSPACE_PATH
    logical_temp: str = AGENT_TEMP_PATH

    @classmethod
    def from_session(cls, session: Any) -> "SandboxExecutionContext":
        session_id = getattr(session, "session_id", None)
        if session_id is None and isinstance(session, dict):
            session_id = session.get("session_id")
        workspace_id = get_session_workspace_id(session)
        if not session_id or not workspace_id:
            raise ValueError("Session is missing filesystem identity")
        return cls(
            session_id=str(session_id),
            workspace_id=str(workspace_id),
            temp_id=get_session_temp_id(session),
            physical_workspace=ensure_physical_workspace(session).resolve(),
            physical_temp=ensure_physical_temp(session).resolve(),
        )

