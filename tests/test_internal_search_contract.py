"""Contract + runtime tests for the read-only workspace search plane."""

import json

import pytest

from sandbox.app.domain.internal_search_contract import (
    InternalSearchContractError,
    parse_and_bind_internal_search,
)
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
)

IDS = {
    "orgId": "01K0G2PAV8FPMVC9QHJG7JPN4Z",
    "userId": "01K0G2PAV8FPMVC9QHJG7JPN50",
    "conversationId": "01K0G2PAV8FPMVC9QHJG7JPN51",
    "agentSessionId": "01K0G2PAV8FPMVC9QHJG7JPN52",
    "runId": "01K0G2PAV8FPMVC9QHJG7JPN5H",
    "sandboxSessionId": "01K0G2PAV8FPMVC9QHJG7JPN5F",
    "traceId": "b" * 32,
    "executionFenceToken": 7,
}

DEFAULT_ARGS = {
    "ls": {"path": ".", "depth": 1, "includeHidden": False},
    "find": {
        "path": ".",
        "pattern": "*.py",
        "type": None,
        "maxDepth": 20,
        "limit": 200,
    },
    "grep": {
        "path": ".",
        "query": "needle",
        "glob": None,
        "regex": False,
        "caseSensitive": True,
        "context": 0,
        "limit": 100,
        "outputMode": "content",
    },
}


def make(tool="ls", args=None):
    args = args if args is not None else dict(DEFAULT_ARGS[tool])
    h = compute_tool_request_hash_v1(tool_name=tool, args=args)
    body = {
        **args,
        "identity": IDS,
        "toolExecutionId": "01K0G2PAV8FPMVC9QHJG7PJN70",
        "toolCallId": "call-1",
        "requestHash": h["requestHash"],
        "requestHashVersion": 1,
    }
    claims = {
        "scope": [f"sandbox.files.{tool}"],
        "tool_name": tool,
        "org_id": IDS["orgId"],
        "user_id": IDS["userId"],
        "conversation_id": IDS["conversationId"],
        "agent_session_id": IDS["agentSessionId"],
        "run_id": IDS["runId"],
        "sandbox_session_id": IDS["sandboxSessionId"],
        "trace_id": IDS["traceId"],
        "execution_fence_token": 7,
        "tool_execution_id": body["toolExecutionId"],
        "tool_call_id": "call-1",
        "request_hash": h["requestHash"],
        "request_hash_version": 1,
    }
    return body, claims


def parse(tool, body, claims):
    return parse_and_bind_internal_search(
        json.dumps(body, separators=(",", ":")).encode(), claims, tool_name=tool
    )


@pytest.mark.parametrize("tool", ["ls", "find", "grep"])
def test_binds_identity_and_hash_for_every_search_tool(tool):
    body, claims = make(tool)
    out = parse(tool, body, claims)
    assert out.tool_name == tool
    assert out.args == DEFAULT_ARGS[tool]
    assert out.org_id == IDS["orgId"]
    assert out.execution_fence_token == 7


@pytest.mark.parametrize("tool", ["ls", "find", "grep"])
def test_rejects_hash_mismatch(tool):
    body, claims = make(tool)
    body["path"] = "src"
    with pytest.raises(InternalSearchContractError, match="requestHash mismatch"):
        parse(tool, body, claims)


@pytest.mark.parametrize(
    "tool,other",
    [("ls", "find"), ("find", "grep"), ("grep", "ls")],
)
def test_scope_is_bound_to_exactly_one_tool(tool, other):
    body, claims = make(tool)
    claims["scope"] = [f"sandbox.files.{other}"]
    with pytest.raises(InternalSearchContractError, match="scope/tool mismatch"):
        parse(tool, body, claims)


def test_rejects_read_scope_reuse():
    # A files.read claim must not be replayed against a search route.
    body, claims = make("ls")
    claims["scope"] = ["sandbox.files.read"]
    with pytest.raises(InternalSearchContractError, match="scope/tool mismatch"):
        parse("ls", body, claims)


@pytest.mark.parametrize("tool", ["ls", "find", "grep"])
def test_rejects_extra_body_keys(tool):
    body, claims = make(tool)
    body["extra"] = 1
    with pytest.raises(InternalSearchContractError, match="body keys"):
        parse(tool, body, claims)


@pytest.mark.parametrize("tool", ["ls", "find", "grep"])
def test_rejects_identity_field_swap(tool):
    body, claims = make(tool)
    body["identity"] = {**IDS, "orgId": "01K0G2PAV8FPMVC9QHJG7JPN51"}
    with pytest.raises(InternalSearchContractError):
        parse(tool, body, claims)


def test_ls_depth_is_clamped_by_contract():
    args = {"path": ".", "depth": 6, "includeHidden": False}
    body, claims = make("ls", args)
    with pytest.raises(InternalSearchContractError, match="depth invalid"):
        parse("ls", body, claims)


def test_bool_field_rejects_integer_one():
    # bool is an int subclass in Python; 1 must not pass as True.
    args = {"path": ".", "depth": 1, "includeHidden": 1}
    body, claims = make("ls", args)
    with pytest.raises(InternalSearchContractError, match="includeHidden invalid"):
        parse("ls", body, claims)


def test_find_rejects_unknown_type_filter():
    args = {**DEFAULT_ARGS["find"], "type": "socket"}
    body, claims = make("find", args)
    with pytest.raises(InternalSearchContractError, match="type invalid"):
        parse("find", body, claims)


def test_grep_rejects_limit_above_ceiling():
    args = {**DEFAULT_ARGS["grep"], "limit": 501}
    body, claims = make("grep", args)
    with pytest.raises(InternalSearchContractError, match="limit invalid"):
        parse("grep", body, claims)


def test_grep_rejects_null_byte_in_query():
    args = {**DEFAULT_ARGS["grep"], "query": "a\x00b"}
    body, claims = make("grep", args)
    with pytest.raises(InternalSearchContractError, match="query invalid"):
        parse("grep", body, claims)


def test_rejects_unsupported_tool_name():
    body, claims = make("ls")
    with pytest.raises(InternalSearchContractError, match="unsupported search tool"):
        parse("stat", body, claims)


# ── runtime ────────────────────────────────────────────────────────────────


class _FakeSearchService:
    def __init__(self, result=None, raises=None):
        self.result = result
        self.raises = raises
        self.calls = []

    def _respond(self, name, kwargs):
        self.calls.append((name, kwargs))
        if self.raises is not None:
            raise self.raises
        return self.result

    def ls(self, workspace_path, **kwargs):
        return self._respond("ls", {"workspace_path": workspace_path, **kwargs})

    def find(self, workspace_path, **kwargs):
        return self._respond("find", {"workspace_path": workspace_path, **kwargs})

    def grep(self, workspace_path, **kwargs):
        return self._respond("grep", {"workspace_path": workspace_path, **kwargs})


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def model_dump(self, mode="json"):
        return dict(self._payload)


def _runtime(service):
    from sandbox.services.formal_search_runtime import FormalSearchRuntime
    from sandbox.services.internal_execution_supervisor import (
        InternalExecutionSupervisor,
    )

    return FormalSearchRuntime(
        claim_validator=object(),
        supervisor=InternalExecutionSupervisor(),
        id_factory=lambda: "01K0G2PAV8FPMVC9QHJG7PJN72",
        search_service=service,
    )


def test_runtime_projects_service_payload_and_tags_the_tool(tmp_path, monkeypatch):
    from sandbox.services import formal_search_runtime as mod

    monkeypatch.setattr(
        mod.workspace_manager, "init_workspace", lambda wid: tmp_path / "ws"
    )
    monkeypatch.setattr(mod.workspace_manager, "init_temp", lambda wid: tmp_path / "tmp")
    service = _FakeSearchService(_Response({"items": [], "truncated": False}))
    body, claims = make("find")
    command = parse("find", body, claims)

    result, status, error_code = _runtime(service)._run_sync(command, "ws-1")

    assert status == SANDBOX_EXECUTION_STATUS_SUCCESS
    assert error_code is None
    assert result["tool"] == "find"
    assert result["truncated"] is False
    name, kwargs = service.calls[0]
    assert name == "find"
    assert kwargs["pattern"] == "*.py"
    assert kwargs["limit"] == 200


def test_runtime_maps_escape_attempt_to_path_invalid(tmp_path, monkeypatch):
    from sandbox.services import formal_search_runtime as mod

    monkeypatch.setattr(
        mod.workspace_manager, "init_workspace", lambda wid: tmp_path / "ws"
    )
    monkeypatch.setattr(mod.workspace_manager, "init_temp", lambda wid: tmp_path / "tmp")
    service = _FakeSearchService(raises=PermissionError("outside root /var/secret"))
    body, claims = make("ls")
    command = parse("ls", body, claims)

    result, status, error_code = _runtime(service)._run_sync(command, "ws-1")

    assert status == SANDBOX_EXECUTION_STATUS_FAILED
    assert error_code == "PATH_INVALID"
    assert result["_httpStatus"] == 400
    # The physical root must not leak back to the model.
    assert "/var/secret" not in json.dumps(result)


def test_runtime_never_reports_outcome_unknown_for_read_only_failure(
    tmp_path, monkeypatch
):
    from sandbox.services import formal_search_runtime as mod

    monkeypatch.setattr(
        mod.workspace_manager, "init_workspace", lambda wid: tmp_path / "ws"
    )
    monkeypatch.setattr(mod.workspace_manager, "init_temp", lambda wid: tmp_path / "tmp")
    service = _FakeSearchService(raises=ValueError("bad glob"))
    body, claims = make("grep")
    command = parse("grep", body, claims)

    result, status, error_code = _runtime(service)._run_sync(command, "ws-1")

    assert status == SANDBOX_EXECUTION_STATUS_FAILED
    assert error_code == "SEARCH_ARGUMENT_INVALID"
    assert "unknown" not in json.dumps(result).lower()
