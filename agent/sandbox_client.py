"""SandboxClient — Agent-side SDK for Sandbox HTTP API.

Pi Agent containers do NOT directly mount the workspace.
All file operations and command executions go through this client.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import httpx


class SandboxClient:
    """HTTP client for Sandbox Service API.

    Usage::

        client = SandboxClient(base_url="http://sandbox:8081")
        session = client.create_session(caller_id="pi-agent")
        result = client.run_python(session["session_id"], "print('hello')")
        client.close_session(session["session_id"])
    """

    def __init__(
        self,
        base_url: str = "http://localhost:8081",
        timeout: float = 30.0,
        auth_token: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._client = httpx.Client(timeout=timeout)
        self._headers: dict[str, str] = {}
        if auth_token:
            self._headers["X-Auth-Token"] = auth_token

    # ── Session lifecycle ─────────────────────────────────────────

    def create_session(
        self,
        agent_session_id: str | None = None,
        user_id: str | None = None,
        caller_id: str = "pi-agent",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a new sandbox session. Returns session metadata."""
        body = {
            "agent_session_id": agent_session_id,
            "user_id": user_id,
            "caller_id": caller_id,
            "metadata": metadata or {},
        }
        resp = self._client.post(
            f"{self.base_url}/sessions",
            json=body,
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def get_session(self, session_id: str) -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}",
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def close_session(self, session_id: str) -> None:
        resp = self._client.delete(
            f"{self.base_url}/sessions/{session_id}",
            headers=self._headers,
        )
        resp.raise_for_status()

    # ── Execution ─────────────────────────────────────────────────

    def run_python(
        self,
        session_id: str,
        code: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        body = {"code": code}
        if timeout is not None:
            body["timeout"] = timeout
        if env_overrides:
            body["env_overrides"] = env_overrides

        resp = self._client.post(
            f"{self.base_url}/sessions/{session_id}/executions/python",
            json=body,
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def run_command(
        self,
        session_id: str,
        command: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        body = {"command": command}
        if timeout is not None:
            body["timeout"] = timeout
        if env_overrides:
            body["env_overrides"] = env_overrides

        resp = self._client.post(
            f"{self.base_url}/sessions/{session_id}/executions/command",
            json=body,
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def get_execution(self, session_id: str, execution_id: str) -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/executions/{execution_id}",
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def cancel_execution(self, session_id: str, execution_id: str) -> dict[str, Any]:
        resp = self._client.post(
            f"{self.base_url}/sessions/{session_id}/executions/{execution_id}/cancel",
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    # ── File operations ───────────────────────────────────────────

    def read_file(
        self,
        session_id: str,
        path: str,
        offset: int | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        params = {"path": path}
        if offset is not None:
            params["offset"] = offset
        if limit is not None:
            params["limit"] = limit
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/files/read",
            params=params,
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def write_file(
        self, session_id: str, path: str, content: str, mode: str = "w",
    ) -> dict[str, Any]:
        body = {"path": path, "content": content, "mode": mode}
        resp = self._client.post(
            f"{self.base_url}/sessions/{session_id}/files/write",
            json=body,
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def list_files(self, session_id: str, path: str = ".") -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/files",
            params={"path": path},
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def preview_file(self, session_id: str, path: str) -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/files/preview",
            params={"path": path},
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def download_file(self, session_id: str, path: str, dest: str | Path) -> Path:
        """Download a binary file from workspace to local destination."""
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/files/download",
            params={"path": path},
            headers=self._headers,
            follow_redirects=True,
        )
        resp.raise_for_status()

        dest_path = Path(dest)
        dest_path.write_bytes(resp.content)
        return dest_path

    def delete_file(self, session_id: str, path: str) -> None:
        resp = self._client.delete(
            f"{self.base_url}/sessions/{session_id}/files",
            params={"path": path},
            headers=self._headers,
        )
        resp.raise_for_status()

    # ── Artifacts ─────────────────────────────────────────────────

    def register_artifact(
        self,
        session_id: str,
        name: str,
        path: str,
        mime_type: str = "application/octet-stream",
        source_execution_id: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "name": name,
            "path": path,
            "mime_type": mime_type,
            "source_execution_id": source_execution_id,
        }
        resp = self._client.post(
            f"{self.base_url}/sessions/{session_id}/artifacts/register",
            json=body,
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def get_artifacts(self, session_id: str) -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/artifacts",
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def download_artifact(
        self, session_id: str, artifact_id: str, dest: str | Path,
    ) -> Path:
        resp = self._client.get(
            f"{self.base_url}/sessions/{session_id}/artifacts/{artifact_id}/download",
            headers=self._headers,
            follow_redirects=True,
        )
        resp.raise_for_status()
        dest_path = Path(dest)
        dest_path.write_bytes(resp.content)
        return dest_path

    # ── Health ────────────────────────────────────────────────────

    def health(self) -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/health",
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def ready(self) -> dict[str, Any]:
        resp = self._client.get(
            f"{self.base_url}/ready",
            headers=self._headers,
        )
        resp.raise_for_status()
        return resp.json()

    def close(self) -> None:
        self._client.close()
