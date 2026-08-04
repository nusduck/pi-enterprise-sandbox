"""Bridge client maps Sandbox MCP control-plane failures to actionable messages."""

from __future__ import annotations

import json

import httpx
import pytest

from sandbox.mcp.sandbox_client import SandboxBridgeClient, SandboxBridgeError, _safe_bridge_error
from sandbox.mcp.settings import McpSettings


def _response(status: int, body: object) -> httpx.Response:
    return httpx.Response(
        status,
        content=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        request=httpx.Request("POST", "http://sandbox.test/internal/mcp/v1/artifacts/submit"),
    )


def test_safe_bridge_error_file_not_found_mentions_context_id():
    err = _safe_bridge_error(
        _response(404, {"detail": {"code": "FILE_NOT_FOUND", "message": "file not found"}})
    )
    assert isinstance(err, SandboxBridgeError)
    assert err.code == "FILE_NOT_FOUND"
    assert "context_id" in str(err)
    assert "source_path" in str(err)


def test_safe_bridge_error_too_large():
    err = _safe_bridge_error(
        _response(413, {"detail": {"code": "TOO_LARGE", "message": "file exceeds max size"}})
    )
    assert err.code == "TOO_LARGE"
    assert "max size" in str(err)


def test_safe_bridge_error_does_not_forward_unknown_detail_text():
    err = _safe_bridge_error(
        _response(
            500,
            {"detail": {"code": "OPEN_FAILED", "message": "/var/sandbox/secret/path"}},
        )
    )
    assert err.code == "OPEN_FAILED"
    assert "/var/sandbox" not in str(err)
    assert str(err) == "Sandbox rejected the request"


def test_safe_bridge_error_503():
    err = _safe_bridge_error(_response(503, {"detail": "down"}))
    assert err.code == "UNAVAILABLE"
    assert "temporarily unavailable" in str(err)


@pytest.mark.asyncio
async def test_client_post_raises_mapped_file_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return _response(404, {"detail": {"code": "FILE_NOT_FOUND", "message": "file not found"}})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://sandbox.test"
    ) as client:
        bridge = SandboxBridgeClient(
            McpSettings(
                token="t",
                internal_token="inner",
                download_secret="secret",
                redis_url="redis://unit",
            ),
            client=client,
        )
        with pytest.raises(SandboxBridgeError, match="context_id"):
            await bridge.post(
                "/internal/mcp/v1/artifacts/submit",
                {
                    "sandbox_session_id": "S" + "0" * 25,
                    "workspace_id": "W" + "0" * 25,
                    "artifact_id": "A" + "0" * 25,
                    "source_path": "missing.csv",
                },
            )
