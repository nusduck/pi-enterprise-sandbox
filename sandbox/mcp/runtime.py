"""Direct Sandbox operations used only by the MCP internal bridge.

The facade process never receives a filesystem mount.  It sends opaque formal
identities to this runtime, which derives all physical paths locally and reuses
the normal execution/file isolation services.
"""

from __future__ import annotations

import os
import shutil
import stat
import time
from pathlib import PurePosixPath
from typing import Any

from sandbox.config import settings
from sandbox.paths import temp_id_for_workspace_id
from sandbox.security.path_validation import normalize_user_path, validate_formal_id
from sandbox.services.control_plane_storage import (
    ControlPlaneError,
    artifact_blob_path,
    artifacts_root,
    ensure_artifact_parent,
    open_control_file_read,
    stream_copy_hash_to_control,
)
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.execution_manager import execution_manager
from sandbox.services.file_manager import file_manager
from sandbox.services.file_search import file_search_service
from sandbox.services.workspace_manager import workspace_manager


class McpSandboxRuntime:
    """Small direct-operation surface; no Agent persistence or HMAC claims."""

    @staticmethod
    def _context(sandbox_session_id: str, workspace_id: str) -> SandboxExecutionContext:
        session_id = validate_formal_id(sandbox_session_id, "sandbox_session_id")
        safe_workspace_id = validate_formal_id(workspace_id, "workspace_id")
        workspace = workspace_manager.init_workspace(safe_workspace_id)
        temp = workspace_manager.init_temp(safe_workspace_id)
        return SandboxExecutionContext(
            session_id=session_id,
            workspace_id=safe_workspace_id,
            temp_id=temp_id_for_workspace_id(safe_workspace_id),
            physical_workspace=workspace,
            physical_temp=temp,
            user_id=None,
        )

    def ensure_context(self, sandbox_session_id: str, workspace_id: str) -> dict[str, str]:
        context = self._context(sandbox_session_id, workspace_id)
        return {
            "sandbox_session_id": context.session_id,
            "workspace_id": context.workspace_id,
        }

    def execute_python(
        self,
        *,
        sandbox_session_id: str,
        workspace_id: str,
        code: str,
        timeout_seconds: int,
    ) -> dict[str, Any]:
        if len(code) > settings.mcp_max_code_length:
            raise ValueError("code exceeds MCP size limit")
        if not 1 <= timeout_seconds <= settings.mcp_max_timeout_seconds:
            raise ValueError("timeout_seconds exceeds MCP limit")
        context = self._context(sandbox_session_id, workspace_id)
        result = execution_manager.run_python(
            context.session_id,
            code,
            timeout=timeout_seconds,
            context=context,
            formal_claimed=False,
        )
        return {
            key: result.get(key)
            for key in (
                "status",
                "exit_code",
                "stdout_preview",
                "stderr_preview",
                "duration_ms",
                "truncated",
                "execution_id",
                "python_version",
                "python_mode",
            )
        }

    def execute_shell(
        self,
        *,
        sandbox_session_id: str,
        workspace_id: str,
        command: str,
        timeout_seconds: int,
    ) -> dict[str, Any]:
        if len(command) > settings.mcp_max_command_length:
            raise ValueError("command exceeds MCP size limit")
        if not 1 <= timeout_seconds <= settings.mcp_max_timeout_seconds:
            raise ValueError("timeout_seconds exceeds MCP limit")
        context = self._context(sandbox_session_id, workspace_id)
        result = execution_manager.run_command(
            context.session_id,
            command,
            timeout=timeout_seconds,
            context=context,
            formal_claimed=False,
        )
        return {
            key: result.get(key)
            for key in (
                "status",
                "exit_code",
                "stdout_preview",
                "stderr_preview",
                "duration_ms",
                "truncated",
                "execution_id",
            )
        }

    def write_file(
        self,
        *,
        sandbox_session_id: str,
        workspace_id: str,
        path: str,
        content: str,
        append: bool,
    ) -> dict[str, Any]:
        if len(content.encode("utf-8")) > settings.mcp_max_file_size_bytes:
            raise ValueError("content exceeds MCP file size limit")
        context = self._context(sandbox_session_id, workspace_id)
        response = file_manager.write_file(
            str(context.physical_workspace),
            path,
            content,
            mode="a" if append else "w",
            temp_path=str(context.physical_temp),
        )
        return response.model_dump(mode="json")

    def read_file(
        self,
        *,
        sandbox_session_id: str,
        workspace_id: str,
        path: str,
        offset: int | None,
        limit: int | None,
    ) -> dict[str, Any]:
        context = self._context(sandbox_session_id, workspace_id)
        response = file_manager.read_file(
            str(context.physical_workspace),
            path,
            offset=offset,
            limit=limit,
            temp_path=str(context.physical_temp),
        )
        return response.model_dump(mode="json")

    def list_files(
        self,
        *,
        sandbox_session_id: str,
        workspace_id: str,
        path: str,
        depth: int,
    ) -> dict[str, Any]:
        context = self._context(sandbox_session_id, workspace_id)
        response = file_search_service.ls(
            str(context.physical_workspace),
            path=path,
            depth=depth,
            include_hidden=False,
            temp_path=str(context.physical_temp),
        )
        return response.model_dump(mode="json")

    def submit_artifact(
        self,
        *,
        sandbox_session_id: str,
        workspace_id: str,
        artifact_id: str,
        source_path: str,
    ) -> dict[str, Any]:
        """Snapshot one regular workspace file into the MCP artifact namespace."""
        context = self._context(sandbox_session_id, workspace_id)
        safe_artifact_id = validate_formal_id(artifact_id, "artifact_id")
        relative = normalize_user_path(source_path)
        parts = tuple(part for part in PurePosixPath(relative).parts if part not in (".", ""))
        if not parts:
            raise ValueError("artifact source_path must name a file")
        self._cleanup_expired_artifacts()
        destination = artifact_blob_path("mcp", safe_artifact_id)
        if destination.exists():
            raise ControlPlaneError("ARTIFACT_EXISTS", "artifact already exists", status=409)
        ensure_artifact_parent("mcp", safe_artifact_id)
        digest, size, _identity = stream_copy_hash_to_control(
            context.physical_workspace / relative,
            destination,
            max_bytes=settings.mcp_max_file_size_bytes,
            workspace_path=context.physical_workspace,
            relative_parts=parts,
        )
        return {"artifact_id": safe_artifact_id, "size": size, "sha256": digest}

    @staticmethod
    def _cleanup_expired_artifacts() -> None:
        """Best-effort bounded GC; download authority itself expires in Redis."""
        root = artifacts_root() / "mcp"
        try:
            entries = list(root.iterdir())[:1_000]
        except OSError:
            return
        cutoff = time.time() - settings.mcp_artifact_ttl_seconds
        for entry in entries:
            try:
                artifact_id = validate_formal_id(entry.name, "artifact_id")
                st = entry.lstat()
                if artifact_id != entry.name or not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
                    continue
                if st.st_mtime < cutoff:
                    shutil.rmtree(entry, ignore_errors=True)
            except (OSError, ValueError):
                continue

    @staticmethod
    def artifact_chunks(artifact_id: str, *, chunk_size: int = 64 * 1024):
        safe_artifact_id = validate_formal_id(artifact_id, "artifact_id")
        path = artifact_blob_path("mcp", safe_artifact_id)
        with open_control_file_read(path) as fd:
            while True:
                chunk = os.read(fd, chunk_size)
                if not chunk:
                    break
                yield chunk

    @staticmethod
    def ensure_artifact_exists(artifact_id: str) -> None:
        safe_artifact_id = validate_formal_id(artifact_id, "artifact_id")
        with open_control_file_read(artifact_blob_path("mcp", safe_artifact_id)):
            pass


mcp_sandbox_runtime = McpSandboxRuntime()

__all__ = ["ControlPlaneError", "McpSandboxRuntime", "mcp_sandbox_runtime"]
