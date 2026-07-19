"""Strict Agent -> Sandbox contract for owner-scoped artifact downloads."""

from __future__ import annotations

import hashlib
import hmac
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sandbox.app.domain.files_read_contract import _decode_strict_json_object
from sandbox.security.path_validation import validate_formal_id

ARTIFACT_DOWNLOAD_SCOPE = "sandbox.artifacts.download"
ARTIFACT_DOWNLOAD_TOOL = "artifact.download"

_ROOT_KEYS = frozenset({"artifactId", "identity"})
_IDENTITY_KEYS = frozenset(
    {
        "orgId",
        "userId",
        "conversationId",
        "agentSessionId",
        "runId",
        "sandboxSessionId",
        "traceId",
        "executionFenceToken",
    }
)
_TRACE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class InternalArtifactDownloadContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _fail(code: str, message: str) -> None:
    raise InternalArtifactDownloadContractError(code, message)


def _formal_id(value: Any, field: str) -> str:
    try:
        return validate_formal_id(value, field)
    except (TypeError, ValueError):
        _fail("ARTIFACT_DOWNLOAD_FIELD_INVALID", f"{field} must be a formal ULID")
    raise AssertionError("unreachable")


def _claim_matches(value: str, claims: Mapping[str, Any], claim: str) -> None:
    actual = claims.get(claim)
    if type(actual) is not str or not hmac.compare_digest(value, actual):
        _fail("ARTIFACT_DOWNLOAD_CLAIM_MISMATCH", f"{claim} mismatch")


@dataclass(frozen=True, slots=True)
class InternalArtifactDownloadCommand:
    artifact_id: str
    org_id: str
    user_id: str
    conversation_id: str
    agent_session_id: str
    run_id: str
    sandbox_session_id: str
    trace_id: str
    execution_fence_token: int


def parse_and_bind_internal_artifact_download(
    raw_body: bytes,
    claims: Mapping[str, Any],
) -> InternalArtifactDownloadCommand:
    if (
        not isinstance(claims, Mapping)
        or claims.get("scope") != [ARTIFACT_DOWNLOAD_SCOPE]
        or claims.get("tool_name") != ARTIFACT_DOWNLOAD_TOOL
    ):
        _fail("ARTIFACT_DOWNLOAD_CLAIM_MISMATCH", "scope or tool mismatch")

    try:
        root = _decode_strict_json_object(raw_body)
    except Exception:
        _fail("ARTIFACT_DOWNLOAD_JSON_INVALID", "body is not a strict JSON object")
    if frozenset(root) != _ROOT_KEYS:
        _fail("ARTIFACT_DOWNLOAD_SCHEMA_INVALID", "body keys invalid")

    identity = root.get("identity")
    if type(identity) is not dict or frozenset(identity) != _IDENTITY_KEYS:
        _fail("ARTIFACT_DOWNLOAD_SCHEMA_INVALID", "identity keys invalid")

    ids: dict[str, str] = {}
    claim_names = {
        "orgId": "org_id",
        "userId": "user_id",
        "conversationId": "conversation_id",
        "agentSessionId": "agent_session_id",
        "runId": "run_id",
        "sandboxSessionId": "sandbox_session_id",
    }
    for field, claim_name in claim_names.items():
        value = _formal_id(identity[field], f"identity.{field}")
        _claim_matches(value, claims, claim_name)
        ids[field] = value

    artifact_id = _formal_id(root["artifactId"], "artifactId")
    trace_id = identity["traceId"]
    if type(trace_id) is not str or _TRACE_ID_RE.fullmatch(trace_id) is None:
        _fail("ARTIFACT_DOWNLOAD_FIELD_INVALID", "traceId invalid")
    _claim_matches(trace_id, claims, "trace_id")

    fence = identity["executionFenceToken"]
    if (
        type(fence) is not int
        or fence <= 0
        or fence > 9_007_199_254_740_991
        or claims.get("execution_fence_token") != fence
    ):
        _fail("ARTIFACT_DOWNLOAD_CLAIM_MISMATCH", "execution fence mismatch")

    operation_id = f"{artifact_id}:{ARTIFACT_DOWNLOAD_TOOL}"
    _claim_matches(operation_id, claims, "tool_execution_id")
    _claim_matches(operation_id, claims, "tool_call_id")
    request_hash = hashlib.sha256(raw_body).hexdigest()
    if (
        claims.get("request_hash_version") != 1
        or claims.get("request_hash") != request_hash
    ):
        _fail("ARTIFACT_DOWNLOAD_HASH_INVALID", "request hash mismatch")

    return InternalArtifactDownloadCommand(
        artifact_id=artifact_id,
        org_id=ids["orgId"],
        user_id=ids["userId"],
        conversation_id=ids["conversationId"],
        agent_session_id=ids["agentSessionId"],
        run_id=ids["runId"],
        sandbox_session_id=ids["sandboxSessionId"],
        trace_id=trace_id,
        execution_fence_token=fence,
    )


__all__ = [
    "ARTIFACT_DOWNLOAD_SCOPE",
    "ARTIFACT_DOWNLOAD_TOOL",
    "InternalArtifactDownloadCommand",
    "InternalArtifactDownloadContractError",
    "parse_and_bind_internal_artifact_download",
]
