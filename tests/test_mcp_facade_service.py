"""Facade context and Artifact behaviour without a real Redis/Sandbox process."""

from __future__ import annotations

import pytest

from sandbox.mcp.context_store import ContextStore
from sandbox.mcp.service import McpFacadeError, McpFacadeService
from sandbox.mcp.settings import McpSettings


class _Redis:
    def __init__(self) -> None:
        self.values: dict[str, object] = {}
        self.expirations: dict[str, int] = {}

    async def ping(self):
        return True

    async def hgetall(self, key):
        value = self.values.get(key)
        return dict(value) if isinstance(value, dict) else {}

    async def hset(self, key, *, mapping):
        self.values[key] = dict(mapping)
        return len(mapping)

    async def expire(self, key, seconds):
        self.expirations[key] = seconds
        return True

    async def set(self, key, value, *, nx=False, ex=None):
        if nx and key in self.values:
            return False
        self.values[key] = value
        if ex is not None:
            self.expirations[key] = ex
        return True

    async def get(self, key):
        return self.values.get(key)

    async def eval(self, _script, _nkeys, key, owner):
        if self.values.get(key) == owner:
            self.values.pop(key, None)
            return 1
        return 0

    async def aclose(self):
        return None


class _Bridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def start(self):
        return None

    async def close(self):
        return None

    async def post(self, path, payload):
        self.calls.append((path, payload))
        if path.endswith("context/ensure"):
            return payload
        if path.endswith("python/execute"):
            return {"status": "SUCCESS", "stdout_preview": "ok\n", "exit_code": 0}
        if path.endswith("shell/execute"):
            return {
                "status": "SUCCESS",
                "stdout_preview": "shell-ok\n",
                "exit_code": 0,
            }
        if path.endswith("artifacts/submit"):
            return {"artifact_id": payload["artifact_id"], "size": 3, "sha256": "abc"}
        return {"path": payload.get("path", "."), "content": "", "size": 0}


@pytest.mark.asyncio
async def test_context_is_provisioned_once_and_artifact_url_is_expiring():
    config = McpSettings(
        token="outer-token",
        internal_token="inner-token",
        download_secret="download-secret",
        redis_url="redis://unit-test",
        public_base_url="https://mcp.example.test",
    )
    redis = _Redis()
    bridge = _Bridge()
    service = McpFacadeService(
        config,
        context_store=ContextStore(config, redis_client=redis),
        bridge=bridge,
    )
    await service.start()

    first = await service.execute_python(context_id="turn-42", code="print('ok')")
    second = await service.execute_python(context_id="turn-42", code="print('again')")
    assert first["context_id"] == second["context_id"] == "turn-42"
    assert [path for path, _ in bridge.calls].count("/internal/mcp/v1/context/ensure") == 1

    artifact = await service.artifact_submit(
        context_id="turn-42", source_path="out.csv", name="out.csv", mime_type="text/csv"
    )
    assert artifact["download_url"].startswith("https://mcp.example.test/artifacts/")
    token = artifact["download_url"].split("token=", 1)[1]
    assert service.verify_artifact_token(artifact["artifact_id"], token) is True
    assert service.verify_artifact_token("A" * 26, token) is False
    metadata = await service.get_artifact(artifact["artifact_id"], token)
    assert metadata == {
        "name": "out.csv",
        "mime_type": "text/csv",
        "size": 3,
        "sha256": "abc",
        "context_id": "turn-42",
    }
    await service.close()


@pytest.mark.asyncio
async def test_execute_shell_validates_limits_and_routes_to_bridge():
    config = McpSettings(
        token="outer-token",
        internal_token="inner-token",
        download_secret="download-secret",
        redis_url="redis://unit-test",
    )
    redis = _Redis()
    bridge = _Bridge()
    service = McpFacadeService(
        config,
        context_store=ContextStore(config, redis_client=redis),
        bridge=bridge,
    )
    await service.start()

    with pytest.raises(McpFacadeError, match="command exceeds MCP size limit"):
        await service.execute_shell(context_id="turn-42", command="x" * (config.max_command_length + 1))
    with pytest.raises(McpFacadeError, match="timeout_seconds exceeds MCP limit"):
        await service.execute_shell(context_id="turn-42", command="echo hi", timeout_seconds=0)
    with pytest.raises(McpFacadeError, match="timeout_seconds exceeds MCP limit"):
        await service.execute_shell(
            context_id="turn-42", command="echo hi", timeout_seconds=config.max_timeout_seconds + 1
        )

    result = await service.execute_shell(context_id="turn-42", command="echo shell-ok")
    assert result["context_id"] == "turn-42"
    assert result["stdout_preview"] == "shell-ok\n"
    shell_calls = [payload for path, payload in bridge.calls if path.endswith("shell/execute")]
    assert shell_calls == [
        {
            "sandbox_session_id": bridge.calls[0][1]["sandbox_session_id"],
            "workspace_id": bridge.calls[0][1]["workspace_id"],
            "command": "echo shell-ok",
            "timeout_seconds": 120,
        }
    ]
    await service.close()
