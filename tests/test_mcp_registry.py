"""B5 — MCP discovery / exec / approval / ledger + ToolRegistry (ADR §4.6 / §12.5)."""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.database import Database
from sandbox.repositories import ConversationRepository, ToolExecutionRepository
from sandbox.services.agent_run_manager import AgentRunManager
from sandbox.services.approval_manager import ApprovalManager
from sandbox.services.mcp_manager import (
    MCPManager,
    MCPToolDef,
    normalize_mcp_result,
    seed_builtin_sandbox_mcp_server,
)
from sandbox.services.tool_registry import (
    TOOL_REGISTRY_VERSION,
    ToolCategory,
    ToolRegistry,
    tool_registry,
)


@pytest.fixture()
def db(tmp_path: Path) -> Database:
    path = tmp_path / "mcp.db"
    database = Database(f"sqlite:///{path}")
    database.initialize()
    return database


@pytest.fixture()
def runs(db: Database) -> AgentRunManager:
    return AgentRunManager(
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )


@pytest.fixture()
def approvals() -> ApprovalManager:
    return ApprovalManager(database=None)


@pytest.fixture()
def registry() -> ToolRegistry:
    return ToolRegistry()


@pytest.fixture()
def manager(registry: ToolRegistry, runs: AgentRunManager, approvals: ApprovalManager):
    return MCPManager(registry=registry, runs=runs, approvals=approvals)


# ── ToolRegistry ───────────────────────────────────────────────────────────


def test_tool_registry_categories_and_builtins():
    reg = ToolRegistry()
    cats = set(reg.categories())
    assert cats == {
        "sandbox",
        "process",
        "skill",
        "mcp",
        "artifact",
        "enterprise_http",
    }
    assert reg.version == TOOL_REGISTRY_VERSION
    names = {t.name for t in reg.list_tools()}
    assert "read" in names
    assert "process_start" in names
    assert "submit_artifact" in names
    assert "skill_install" in names
    # Skills optional in allowlist
    al = reg.allowlist(include_skill=False)
    assert "skill_install" not in al
    assert "bash" in al


# ── MCP register / discover / authz ────────────────────────────────────────


def test_register_and_discover(manager: MCPManager):
    async def echo(**kwargs):
        return {"echo": kwargs}

    manager.register_server(
        "demo",
        name="Demo Server",
        transport="local",
        tools=[
            MCPToolDef(
                name="echo",
                description="Echo args",
                input_schema={"type": "object", "properties": {"msg": {"type": "string"}}},
                risk_level="low",
            ),
            MCPToolDef(
                name="danger",
                description="Dangerous",
                risk_level="high",
                requires_approval=True,
            ),
        ],
        handlers={"echo": echo, "danger": echo},
        high_risk_tools=["danger"],
    )
    tools = manager.discover_tools(apply_authz=False)
    names = {t["name"] for t in tools}
    assert "mcp_demo_echo" in names
    assert "mcp_demo_danger" in names
    echo = next(t for t in tools if t["name"] == "mcp_demo_echo")
    assert echo["risk_level"] == "low"
    assert echo["input_schema"]["type"] == "object"
    danger = next(t for t in tools if t["name"] == "mcp_demo_danger")
    assert danger["requires_approval"] is True


def test_allowlist_filters_discovery(manager: MCPManager):
    manager.register_server(
        "al",
        tools=[
            MCPToolDef(name="keep", risk_level="low"),
            MCPToolDef(name="drop", risk_level="low"),
        ],
        allowlist=["keep"],
        handlers={
            "keep": lambda **k: {"ok": True},
            "drop": lambda **k: {"ok": True},
        },
    )
    tools = manager.discover_tools("al", apply_authz=False)
    assert [t["raw_name"] for t in tools] == ["keep"]


def test_unauthorized_user_cannot_see_or_call(manager: MCPManager):
    manager.register_server(
        "private",
        tools=[MCPToolDef(name="secret", risk_level="low")],
        allowed_users=["alice"],
        allowed_orgs=["org_a"],
        handlers={"secret": lambda **k: {"secret": 1}},
    )
    # No actor
    assert manager.discover_tools(user_id=None, organization_id=None) == []
    ok, reason = manager.authorize_tool(
        "mcp_private_secret", user_id="bob", organization_id="org_b"
    )
    assert ok is False
    assert "not authorized" in reason

    # Alice allowed
    tools = manager.discover_tools(user_id="alice", organization_id=None)
    assert len(tools) == 1
    ok, _ = manager.authorize_tool("mcp_private_secret", user_id="alice")
    assert ok is True

    # Org match
    tools = manager.discover_tools(user_id=None, organization_id="org_a")
    assert len(tools) == 1


@pytest.mark.asyncio
async def test_invoke_denied_for_unauthorized(manager: MCPManager):
    manager.register_server(
        "x",
        tools=[MCPToolDef(name="t", risk_level="low")],
        allowed_users=["alice"],
        handlers={"t": lambda **k: {"ok": True}},
    )
    result = await manager.invoke(
        "mcp_x_t",
        {},
        user_id="eve",
    )
    assert result["status"] == "denied"
    assert "not authorized" in (result.get("error") or "")


# ── Approval + ledger ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_high_risk_requires_approval(
    manager: MCPManager, runs: AgentRunManager, db: Database
):
    ConversationRepository(db).upsert(
        {
            "id": "conv_mcp",
            "title": "t",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "o1",
        }
    )
    run = runs.start_run(conversation_id="conv_mcp", lease_owner="w1")

    called = {"n": 0}

    async def boom(**kwargs):
        called["n"] += 1
        return {"did": True}

    manager.register_server(
        "risk",
        tools=[MCPToolDef(name="wipe", risk_level="high", requires_approval=True)],
        handlers={"wipe": boom},
        high_risk_tools=["wipe"],
    )
    result = await manager.invoke(
        "mcp_risk_wipe",
        {"target": "all"},
        run_id=run.run_id,
        session_id="sess1",
        conversation_id="conv_mcp",
        user_id="u1",
    )
    assert result["status"] == "pending_approval"
    assert result.get("approval_id")
    assert called["n"] == 0  # not executed yet

    # Ledger waiting
    tools = runs.list_tools_for_run(run.run_id)
    assert len(tools) == 1
    assert tools[0].status == "waiting_approval"
    assert tools[0].tool_name == "mcp_risk_wipe"


@pytest.mark.asyncio
async def test_invoke_success_enters_ledger(
    manager: MCPManager, runs: AgentRunManager, db: Database
):
    ConversationRepository(db).upsert(
        {
            "id": "conv_ok",
            "title": "t",
            "messages": [],
        }
    )
    run = runs.start_run(conversation_id="conv_ok", lease_owner="w1")

    async def add(**kwargs):
        return {"sum": kwargs.get("a", 0) + kwargs.get("b", 0)}

    manager.register_server(
        "math",
        tools=[MCPToolDef(name="add", risk_level="low")],
        handlers={"add": add},
    )
    result = await manager.invoke(
        "mcp_math_add",
        {"a": 2, "b": 3},
        run_id=run.run_id,
        session_id="s1",
        conversation_id="conv_ok",
        tool_call_id="tc_add_1",
        idempotency_key="idem_add_1",
    )
    assert result["status"] == "ok"
    assert result["normalized"] is True
    assert result["content"]["sum"] == 5
    assert result.get("tool_call_id") == "tc_add_1"

    tools = runs.list_tools_for_run(run.run_id)
    assert len(tools) == 1
    assert tools[0].status == "succeeded"
    assert tools[0].tool_name == "mcp_math_add"
    assert tools[0].result_json is not None


@pytest.mark.asyncio
async def test_idempotent_replay_no_double_side_effect(
    manager: MCPManager, runs: AgentRunManager, db: Database
):
    ConversationRepository(db).upsert({"id": "conv_idem", "title": "t", "messages": []})
    run = runs.start_run(conversation_id="conv_idem", lease_owner="w1")
    calls = {"n": 0}

    async def side(**kwargs):
        calls["n"] += 1
        return {"n": calls["n"]}

    manager.register_server(
        "side",
        tools=[MCPToolDef(name="once", risk_level="low")],
        handlers={"once": side},
    )
    r1 = await manager.invoke(
        "mcp_side_once",
        {},
        run_id=run.run_id,
        tool_call_id="tc_once",
        idempotency_key="idem_once",
    )
    r2 = await manager.invoke(
        "mcp_side_once",
        {},
        run_id=run.run_id,
        tool_call_id="tc_once",
        idempotency_key="idem_once",
    )
    assert r1["status"] == "ok"
    assert r2["status"] == "ok"
    assert calls["n"] == 1  # not re-executed
    assert len(runs.list_tools_for_run(run.run_id)) == 1


@pytest.mark.asyncio
async def test_skip_approval_executes_high_risk(manager: MCPManager):
    async def go(**kwargs):
        return {"ran": True}

    manager.register_server(
        "hr",
        tools=[MCPToolDef(name="x", risk_level="high", requires_approval=True)],
        handlers={"x": go},
        high_risk_tools=["x"],
    )
    result = await manager.invoke("mcp_hr_x", {}, skip_approval=True)
    assert result["status"] == "ok"
    assert result["content"]["ran"] is True


@pytest.mark.asyncio
async def test_timeout_and_retry(manager: MCPManager):
    attempts = {"n": 0}

    async def flaky(**kwargs):
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise RuntimeError("transient")
        return {"ok": True}

    manager.register_server(
        "flaky",
        tools=[MCPToolDef(name="f", risk_level="low")],
        handlers={"f": flaky},
        max_retries=2,
        timeout_seconds=5,
    )
    result = await manager.invoke("mcp_flaky_f", {}, skip_approval=True)
    assert result["status"] == "ok"
    assert attempts["n"] == 2


def test_normalize_mcp_result_envelope():
    env = normalize_mcp_result(
        {"result": 1},
        tool_name="mcp_x_t",
        server_id="x",
        duration_ms=1.5,
    )
    assert env["normalized"] is True
    assert env["status"] == "ok"
    assert env["server_id"] == "x"


def test_seed_builtin_sandbox_server(manager: MCPManager):
    rec = seed_builtin_sandbox_mcp_server(manager)
    assert rec.server_id == "sandbox"
    tools = manager.discover_tools(apply_authz=False)
    names = {t["name"] for t in tools}
    assert any(n.startswith("mcp_sandbox_") for n in names)
    # High-risk tools flagged (write/command/python require approval)
    high = [t for t in tools if t["requires_approval"]]
    assert len(high) >= 1
    high_names = {t["name"] for t in high}
    assert any(
        "write_file" in n or "run_command" in n or "run_python" in n for n in high_names
    )


def test_module_registry_has_mcp_after_seed():
    # Import side-effect may seed sandbox server via router; ensure category works
    assert ToolCategory.MCP.value == "mcp"
    tree = tool_registry.list_by_category()
    assert "sandbox" in tree
    assert "mcp" in tree


# ── HTTP surface (TestClient) ──────────────────────────────────────────────


def test_mcp_http_registry_discover_register_invoke():
    from fastapi.testclient import TestClient

    from sandbox.main import app

    c = TestClient(app)

    # Unified registry
    r = c.get("/mcp/registry")
    assert r.status_code == 200
    body = r.json()
    assert "version" in body
    assert "sandbox" in body["tools"]
    assert "mcp" in body["tools"]

    # Register a local test server via API (no custom handlers — use built-in)
    r = c.post(
        "/mcp/servers",
        json={
            "server_id": "http_demo",
            "name": "HTTP Demo",
            "transport": "local",
            "tools": [
                {
                    "name": "ping",
                    "description": "ping",
                    "risk_level": "low",
                    "input_schema": {"type": "object"},
                }
            ],
            "allowed_users": ["alice"],
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["server_id"] == "http_demo"

    # Discover without actor → empty for restricted server (sandbox still open)
    r = c.get("/mcp/discover")
    assert r.status_code == 200
    names = {t["name"] for t in r.json()["tools"]}
    assert "mcp_http_demo_ping" not in names

    # Discover as alice
    r = c.get("/mcp/discover", params={"user_id": "alice"})
    names = {t["name"] for t in r.json()["tools"]}
    assert "mcp_http_demo_ping" in names

    # Unauthorized invoke
    r = c.post(
        "/mcp/invoke",
        json={"tool_name": "mcp_http_demo_ping", "arguments": {}, "user_id": "eve"},
    )
    assert r.status_code == 403

    # Cleanup
    r = c.delete("/mcp/servers/http_demo")
    assert r.status_code == 200
