"""Formal SandboxSession provisioning invariants."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest

from sandbox.app.domain.types import SandboxSessionRecord
from sandbox.services.formal_session_runtime import (
    FormalSessionRuntime,
    SessionProvisioningError,
    parse_session_ensure_body,
)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER = "01K0G2PAV8FPMVC9QHJG7JPN52"
USER_2 = "01K0G2PAV8FPMVC9QHJG7JPN5A"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN53"
SANDBOX_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN54"
WORKSPACE = "01K0G2PAV8FPMVC9QHJG7JPN55"


def _claims() -> dict[str, str]:
    return {
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT_SESSION,
        "sandbox_session_id": SANDBOX_SESSION,
    }


class Conn:
    def __init__(self, *, parent_exists: bool = True) -> None:
        self.parent_exists = parent_exists
        self.commits = 0
        self.rollbacks = 0
        self.executions: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any = None) -> None:
        self.executions.append((sql, params))

    def fetchone(self) -> dict[str, str] | None:
        return {"agent_session_id": AGENT_SESSION} if self.parent_exists else None

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class Db:
    def __init__(self, conn: Conn) -> None:
        self.conn = conn

    @contextmanager
    def connection(self):
        yield self.conn


class Repo:
    def __init__(self) -> None:
        self.record: SandboxSessionRecord | None = None
        self.creates = 0

    def get_by_id(self, *_args: Any) -> SandboxSessionRecord | None:
        return self.record

    def get_by_agent_session_id(self, *_args: Any) -> SandboxSessionRecord | None:
        return self.record

    def get_by_workspace_id(self, *_args: Any) -> SandboxSessionRecord | None:
        return self.record

    def create(self, _conn: Any, payload: dict[str, Any]) -> SandboxSessionRecord:
        self.creates += 1
        self.record = SandboxSessionRecord(
            sandbox_session_id=payload["sandbox_session_id"],
            org_id=payload["org_id"],
            user_id=payload["user_id"],
            agent_session_id=payload["agent_session_id"],
            workspace_id=payload["workspace_id"],
            status=payload["status"],
            created_at="2026-07-18T00:00:00Z",
            updated_at="2026-07-18T00:00:00Z",
        )
        return self.record


class OwnerRepo(Repo):
    def get_by_id(
        self, _conn: Any, _session_id: str, scope: Any
    ) -> SandboxSessionRecord | None:
        if self.record is None:
            return None
        if scope.org_id != self.record.org_id or scope.user_id != self.record.user_id:
            return None
        return self.record


def test_ensure_is_idempotent_and_initializes_workspace(monkeypatch) -> None:
    conn = Conn()
    repo = Repo()
    runtime = FormalSessionRuntime(db=Db(conn), repository=repo)  # type: ignore[arg-type]
    initialized: list[str] = []
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        initialized.append,
    )

    first = runtime.ensure(claims=_claims(), workspace_id=WORKSPACE)
    second = runtime.ensure(claims=_claims(), workspace_id=WORKSPACE)

    assert first == second
    assert repo.creates == 1
    assert conn.commits == 2
    assert initialized == [WORKSPACE, WORKSPACE]
    assert "execution_fence_token" not in conn.executions[0][0]


def test_run_bound_ensure_requires_the_claimed_execution_fence(monkeypatch) -> None:
    conn = Conn()
    runtime = FormalSessionRuntime(db=Db(conn), repository=Repo())  # type: ignore[arg-type]
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        lambda _workspace_id: None,
    )
    runtime.ensure(
        claims={**_claims(), "execution_fence_token": 7},
        workspace_id=WORKSPACE,
    )
    sql, params = conn.executions[0]
    assert "execution_fence_token = %s" in sql
    assert params[-1] == 7


def test_parent_binding_mismatch_never_creates(monkeypatch) -> None:
    repo = Repo()
    runtime = FormalSessionRuntime(
        db=Db(Conn(parent_exists=False)), repository=repo  # type: ignore[arg-type]
    )
    initialized: list[str] = []
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        initialized.append,
    )

    with pytest.raises(SessionProvisioningError) as exc:
        runtime.ensure(claims=_claims(), workspace_id=WORKSPACE)

    assert exc.value.code == "SESSION_PARENT_MISMATCH"
    assert repo.creates == 0
    assert initialized == []


def test_resolve_owned_builds_public_session_from_both_formal_bindings() -> None:
    class ResolveConn(Conn):
        def fetchone(self) -> dict[str, str] | None:
            return {
                "conversation_id": CONV,
                "last_run_id": "01K0G2PAV8FPMVC9QHJG7JPN5B",
            }

    conn = ResolveConn()
    repo = OwnerRepo()
    repo.record = SandboxSessionRecord(
        sandbox_session_id=SANDBOX_SESSION,
        org_id=ORG,
        user_id=USER,
        agent_session_id=AGENT_SESSION,
        workspace_id=WORKSPACE,
        status="ACTIVE",
        created_at="2026-07-18T00:00:00Z",
        updated_at="2026-07-18T00:00:00Z",
    )
    runtime = FormalSessionRuntime(db=Db(conn), repository=repo)  # type: ignore[arg-type]

    session = runtime.resolve_owned(SANDBOX_SESSION, org_id=ORG, user_id=USER)

    assert session is not None
    assert session.session_id == SANDBOX_SESSION
    assert session.workspace_id == WORKSPACE
    assert session.metadata["conversation_id"] == CONV
    assert session.metadata["organization_id"] == ORG
    sql, params = conn.executions[-1]
    assert "sandbox_session_id = %s" in sql
    assert params == (AGENT_SESSION, ORG, USER, SANDBOX_SESSION, WORKSPACE)


def test_resolve_owned_hides_cross_tenant_session() -> None:
    repo = OwnerRepo()
    repo.record = SandboxSessionRecord(
        sandbox_session_id=SANDBOX_SESSION,
        org_id=ORG,
        user_id=USER,
        agent_session_id=AGENT_SESSION,
        workspace_id=WORKSPACE,
        status="ACTIVE",
        created_at="2026-07-18T00:00:00Z",
        updated_at="2026-07-18T00:00:00Z",
    )
    conn = Conn()
    runtime = FormalSessionRuntime(db=Db(conn), repository=repo)  # type: ignore[arg-type]

    assert runtime.resolve_owned(SANDBOX_SESSION, org_id=ORG, user_id=USER_2) is None
    assert conn.executions == []


@pytest.mark.parametrize(
    "raw",
    [
        b'{}',
        b'{"workspaceId":"x","extra":1}',
        (
            b'{"workspaceId":"01K0G2PAV8FPMVC9QHJG7JPN55",'
            b'"workspaceId":"01K0G2PAV8FPMVC9QHJG7JPN55"}'
        ),
    ],
)
def test_body_parser_rejects_non_exact_objects(raw: bytes) -> None:
    with pytest.raises(SessionProvisioningError) as exc:
        parse_session_ensure_body(raw)
    assert exc.value.code == "SESSION_BODY_INVALID"
