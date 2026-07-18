"""Workspace isolation, skill R/O, and artifact-only delivery acceptance tests.

PR-07A: sessions require formal agent_session_id + workspace_id bindings.
HTTP tests set auth_enabled hermetically (do not rely on host env).
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.main import app
from sandbox.paths import AGENT_SKILL_PATH, get_session_physical_workspace
from sandbox.services.session_manager import session_manager


client = TestClient(app)

def _formal_id(prefix: str = "01JTEST") -> str:
    """Return a unique 26-char Crockford formal id (no cross-suite collisions)."""
    from tests.conftest import formal_id

    _ = prefix
    return formal_id()


@pytest.fixture(autouse=True)
def _hermetic_auth(monkeypatch):
    """HTTP suite must not silently depend on host SANDBOX_AUTH_ENABLED."""
    monkeypatch.setattr(settings, "auth_enabled", False)


def _create_session(caller: str = "test", **extra) -> dict:
    body = {
        "caller_id": caller,
        "agent_session_id": extra.pop("agent_session_id", _formal_id("01JAGT")),
        "workspace_id": extra.pop("workspace_id", _formal_id("01JWSP")),
        **extra,
    }
    resp = client.post("/sessions", json=body)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data.get("workspace_id")
    assert "workspace_path" not in data or data.get("workspace_path") in (None, "")
    assert "_physical_workspace" not in (data.get("metadata") or {})
    return data


def _physical_for(session_id: str) -> Path:
    session = session_manager.get(session_id)
    assert session is not None
    return Path(get_session_physical_workspace(session))


def test_new_session_workspace_is_empty():
    data = _create_session()
    sid = data["session_id"]
    physical = _physical_for(sid)
    assert physical.is_dir()
    assert list(physical.iterdir()) == []

    listed = client.get(f"/sessions/{sid}/files", params={"path": "."})
    assert listed.status_code == 200
    assert listed.json()["total"] == 0


def test_two_sessions_cannot_see_each_others_files():
    a = _create_session("a")
    b = _create_session("b")
    sa, sb = a["session_id"], b["session_id"]

    wa = client.post(
        f"/sessions/{sa}/files/write",
        json={"path": "a.txt", "content": "from-A"},
    )
    wb = client.post(
        f"/sessions/{sb}/files/write",
        json={"path": "b.txt", "content": "from-B"},
    )
    assert wa.status_code == 201
    assert wb.status_code == 201

    list_a = client.get(f"/sessions/{sa}/files", params={"path": "."}).json()
    list_b = client.get(f"/sessions/{sb}/files", params={"path": "."}).json()
    names_a = {f["name"] for f in list_a["files"]}
    names_b = {f["name"] for f in list_b["files"]}
    assert "a.txt" in names_a and "b.txt" not in names_a
    assert "b.txt" in names_b and "a.txt" not in names_b

    # Cross-read via session B must not return A's content through B's path
    cross = client.get(f"/sessions/{sb}/files/read", params={"path": "a.txt"})
    assert cross.status_code == 200
    assert cross.json().get("content", "") == ""


def test_concurrent_sessions_isolated_writes():
    def worker(i: int) -> tuple[str, str]:
        data = _create_session(f"worker-{i}")
        sid = data["session_id"]
        client.post(
            f"/sessions/{sid}/files/write",
            json={"path": "me.txt", "content": f"worker-{i}"},
        )
        content = client.get(f"/sessions/{sid}/files/read", params={"path": "me.txt"}).json()
        return sid, content.get("content", "")

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(worker, range(4)))

    for i, (_sid, content) in enumerate(results):
        assert content == f"worker-{i}"


def test_skill_path_readable_workspace_not_skill(tmp_path, monkeypatch):
    """Skills root is separate from session workspace."""
    skill_root = Path(settings.skills_path)
    skill_root.mkdir(parents=True, exist_ok=True)
    demo = skill_root / "demo-skill"
    demo.mkdir(exist_ok=True)
    (demo / "SKILL.md").write_text("# Demo\n", encoding="utf-8")

    data = _create_session()
    physical = _physical_for(data["session_id"])
    assert "skills" not in {p.name for p in physical.iterdir()} if physical.exists() else True
    assert skill_root.is_dir()
    assert (demo / "SKILL.md").is_file()
    assert not str(skill_root.resolve()).startswith(str(physical.resolve()) + "/")
    assert skill_root.resolve() != physical.resolve()
    assert AGENT_SKILL_PATH == "/home/sandbox/skill"


def test_file_api_write_outside_workspace_fails():
    """Writing via the file API to a path outside the workspace must fail."""
    data = _create_session()
    sid = data["session_id"]

    for bad_path in ("../outside.txt", "../../etc/passwd", "/etc/passwd"):
        resp = client.post(
            f"/sessions/{sid}/files/write",
            json={"path": bad_path, "content": "should-not-write"},
        )
        assert resp.status_code != 201, f"escape path accepted: {bad_path}"
        assert resp.status_code in (400, 403, 500)

    physical = _physical_for(sid)
    assert not (physical.parent / "outside.txt").exists()


def test_write_does_not_register_artifact_submit_does():
    """P7: write alone → no artifact; submit → artifact row."""
    data = _create_session()
    sid = data["session_id"]

    w = client.post(
        f"/sessions/{sid}/files/write",
        json={"path": "out.txt", "content": "hello deliverable"},
    )
    assert w.status_code == 201

    before = client.get(f"/sessions/{sid}/artifacts")
    assert before.status_code == 200
    assert before.json()["total"] == 0

    sub = client.post(
        f"/sessions/{sid}/artifacts/submit",
        json={"name": "out.txt", "path": "out.txt", "mime_type": "text/plain"},
    )
    assert sub.status_code == 201, sub.text
    art = sub.json()
    assert art["artifact_id"].startswith("art_")
    assert art["path"] == "out.txt"

    after = client.get(f"/sessions/{sid}/artifacts")
    assert after.json()["total"] == 1

    dl = client.get(f"/sessions/{sid}/artifacts/{art['artifact_id']}/download")
    assert dl.status_code == 200
    assert b"hello deliverable" in dl.content


def test_physical_workspaces_differ_per_session():
    a = _create_session("pa")
    b = _create_session("pb")
    sa = session_manager.get(a["session_id"])
    sb = session_manager.get(b["session_id"])
    pa = get_session_physical_workspace(sa)
    pb = get_session_physical_workspace(sb)
    assert pa != pb
    assert Path(pa).is_dir() and Path(pb).is_dir()


def test_empty_init_workspace_by_formal_id():
    wid = _formal_id("01JWSP")
    ws = workspace_manager_init(wid)
    assert ws.is_dir()
    assert list(ws.iterdir()) == []
    from sandbox.services.workspace_manager import workspace_manager

    workspace_manager.remove_workspace(wid)


def workspace_manager_init(wid: str) -> Path:
    from sandbox.services.workspace_manager import workspace_manager

    return workspace_manager.init_workspace(wid)


def test_conversation_id_traversal_rejected():
    """Client conversation IDs with traversal must not create dirs outside root."""
    root = Path(settings.workspaces_path).resolve()
    for bad_id in ("../escape", "a/b", "../../tmp", "has space"):
        resp = client.post("/conversations", json={"id": bad_id, "title": "evil"})
        assert resp.status_code == 400, f"accepted bad id {bad_id!r}: {resp.status_code}"
        assert not (root.parent / "escape").exists()


def test_conversation_api_does_not_own_workspace():
    """Conversation create does not invent workspace_id or physical trees."""
    before = set(Path(settings.workspaces_path).iterdir()) if Path(settings.workspaces_path).exists() else set()
    resp = client.post("/conversations", json={"title": "no-ws-own"})
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data.get("workspace_id") in (None, "")
    assert "workspace_path" not in data or data.get("workspace_path") in (None, "")
    physical_root = str(Path(settings.workspaces_path).resolve())
    dumped = str(data)
    assert physical_root not in dumped
    assert "/var/sandbox/workspaces" not in dumped

    # No new workspace directory created by conversation create.
    after = set(Path(settings.workspaces_path).iterdir()) if Path(settings.workspaces_path).exists() else set()
    assert after == before

    ws = client.get(f"/conversations/{data['id']}/workspace")
    assert ws.status_code == 200
    body = ws.json()
    assert body.get("workspace_id") in (None, "")


def test_same_conversation_different_agent_sessions_isolated():
    """Same conversation + different AgentSession => different workspaces."""
    conv = client.post("/conversations", json={"title": "shared-conv"}).json()
    agent_a, wsp_a = _formal_id("01JAGT"), _formal_id("01JWSP")
    agent_b, wsp_b = _formal_id("01JAGT"), _formal_id("01JWSP")
    s1 = client.post(
        "/sessions",
        json={
            "caller_id": "a",
            "conversation_id": conv["id"],
            "agent_session_id": agent_a,
            "workspace_id": wsp_a,
        },
    )
    s2 = client.post(
        "/sessions",
        json={
            "caller_id": "b",
            "conversation_id": conv["id"],
            "agent_session_id": agent_b,
            "workspace_id": wsp_b,
        },
    )
    assert s1.status_code == 201, s1.text
    assert s2.status_code == 201, s2.text
    d1, d2 = s1.json(), s2.json()
    assert d1["workspace_id"] != d2["workspace_id"]
    assert d1["agent_session_id"] != d2["agent_session_id"]
    assert _physical_for(d1["session_id"]) != _physical_for(d2["session_id"])

    client.post(
        f"/sessions/{d1['session_id']}/files/write",
        json={"path": "a-only.txt", "content": "A"},
    )
    client.post(
        f"/sessions/{d2['session_id']}/files/write",
        json={"path": "b-only.txt", "content": "B"},
    )
    list_a = client.get(f"/sessions/{d1['session_id']}/files", params={"path": "."}).json()
    list_b = client.get(f"/sessions/{d2['session_id']}/files", params={"path": "."}).json()
    names_a = {f["name"] for f in list_a["files"]}
    names_b = {f["name"] for f in list_b["files"]}
    assert "a-only.txt" in names_a and "b-only.txt" not in names_a
    assert "b-only.txt" in names_b and "a-only.txt" not in names_b


def test_forged_workspace_mismatch_http_409():
    """Second AgentSession claiming another session's workspace → 409."""
    agent_a, wsp = _formal_id("01JAGT"), _formal_id("01JWSP")
    agent_b = _formal_id("01JAGT")
    first = client.post(
        "/sessions",
        json={
            "caller_id": "writer-1",
            "agent_session_id": agent_a,
            "workspace_id": wsp,
        },
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/sessions",
        json={
            "caller_id": "writer-2",
            "agent_session_id": agent_b,
            "workspace_id": wsp,
        },
    )
    assert second.status_code == 409, second.text
    detail = second.json().get("detail", "")
    assert "workspace" in detail.lower() or "bound" in detail.lower() or "conflict" in detail.lower()
    # No physical path leakage
    assert str(settings.workspaces_path) not in detail
    assert "/var/sandbox" not in detail


def test_same_agent_session_rebind_same_workspace_files():
    """Same AgentSession rebind reuses workspace files across COMPLETED→RUNNING."""
    agent, wsp = _formal_id("01JAGT"), _formal_id("01JWSP")
    s1 = client.post(
        "/sessions",
        json={
            "caller_id": "t1",
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    ).json()
    sid1 = s1["session_id"]
    w = client.post(
        f"/sessions/{sid1}/files/write",
        json={"path": "keep.txt", "content": "persisted"},
    )
    assert w.status_code == 201

    # Mark COMPLETED without deleting (AgentSession still owns workspace identity).
    from sandbox.models import SessionStatus

    session_manager.update_status(sid1, SessionStatus.COMPLETED)

    s2 = client.post(
        "/sessions",
        json={
            "caller_id": "t2",
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    )
    assert s2.status_code == 201, s2.text
    body = s2.json()
    assert body["session_id"] == sid1
    assert body["workspace_id"] == wsp
    read = client.get(f"/sessions/{sid1}/files/read", params={"path": "keep.txt"})
    assert read.status_code == 200
    assert read.json().get("content") == "persisted"


def test_conversation_delete_does_not_close_linked_session(monkeypatch):
    """Conversation delete must not cancel/close/delete linked SandboxSession or workspace."""
    from unittest.mock import MagicMock

    from sandbox.services.execution_manager import execution_manager
    from sandbox.services.process_manager import process_manager
    from sandbox.services.workspace_manager import workspace_manager

    agent, wsp = _formal_id("01JAGT"), _formal_id("01JWSP")
    conv = client.post("/conversations", json={"title": "linked-active"}).json()
    session = client.post(
        "/sessions",
        json={
            "caller_id": "linked-1",
            "conversation_id": conv["id"],
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    ).json()
    sid = session["session_id"]
    # Bind conversation row to the live session (as Agent would).
    patch = client.patch(
        f"/conversations/{conv['id']}",
        json={"sandbox_session_id": sid, "workspace_id": wsp},
    )
    assert patch.status_code == 200, patch.text
    written = client.post(
        f"/sessions/{sid}/files/write",
        json={"path": "keep-me.txt", "content": "still-here"},
    )
    assert written.status_code == 201, written.text
    temp_written = client.post(
        f"/sessions/{sid}/files/write",
        json={"path": "/tmp/cache.json", "content": "temp-still-here"},
    )
    assert temp_written.status_code == 201, temp_written.text

    cancel_ws = MagicMock()
    cancel_proc = MagicMock()
    remove_ws = MagicMock()
    monkeypatch.setattr(execution_manager, "cancel_active_workspace", cancel_ws)
    monkeypatch.setattr(process_manager, "cancel_for_workspace", cancel_proc)
    monkeypatch.setattr(workspace_manager, "remove_workspace", remove_ws)

    del_resp = client.delete(f"/conversations/{conv['id']}")
    assert del_resp.status_code == 204, del_resp.text
    cancel_ws.assert_not_called()
    cancel_proc.assert_not_called()
    remove_ws.assert_not_called()

    # Conversation gone; session + workspace + files remain.
    assert client.get(f"/conversations/{conv['id']}").status_code == 404
    live = session_manager.get(sid)
    assert live is not None
    assert str(getattr(live.status, "value", live.status)) == "RUNNING"
    assert live.workspace_id == wsp
    physical = settings.workspaces_path / wsp
    temp = settings.temp_path / f"tmp_{wsp}"
    assert physical.exists()
    assert temp.exists()
    assert (physical / "keep-me.txt").read_text(encoding="utf-8") == "still-here"
    read = client.get(f"/sessions/{sid}/files/read", params={"path": "keep-me.txt"})
    assert read.status_code == 200
    assert read.json().get("content") == "still-here"
    temp_read = client.get(
        f"/sessions/{sid}/files/read", params={"path": "/tmp/cache.json"}
    )
    assert temp_read.status_code == 200
    assert temp_read.json().get("content") == "temp-still-here"


def test_session_close_removes_workspace_not_conversation():
    """Session delete owns workspace cleanup; conversation delete does not invent trees."""
    agent, wsp = _formal_id("01JAGT"), _formal_id("01JWSP")
    conv = client.post("/conversations", json={"title": "tmp-close"}).json()
    session = client.post(
        "/sessions",
        json={
            "caller_id": "tmp-1",
            "conversation_id": conv["id"],
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    ).json()
    session_id = session["session_id"]
    written = client.post(
        f"/sessions/{session_id}/files/write",
        json={"path": "/tmp/cache/state.json", "content": "persisted-temp"},
    )
    assert written.status_code == 201, written.text

    workspace = settings.workspaces_path / wsp
    temp = settings.temp_path / f"tmp_{wsp}"
    assert workspace.exists() and temp.exists()

    assert client.delete(f"/sessions/{session_id}").status_code == 204
    assert not workspace.exists()
    assert not temp.exists()

    # Conversation delete is orthogonal and does not recreate/remove workspace trees.
    assert client.delete(f"/conversations/{conv['id']}").status_code == 204


def test_create_session_without_binding_fails_closed():
    resp = client.post("/sessions", json={"caller_id": "no-bind"})
    assert resp.status_code == 400
    assert "agent_session_id" in resp.json().get("detail", "").lower() or "required" in resp.json().get("detail", "").lower()


def test_path_escape_error_detail_has_no_physical_root():
    """File API escape errors must not include host workspace roots."""
    data = _create_session("leak-check")
    sid = data["session_id"]
    physical = str(_physical_for(sid))
    resp = client.post(
        f"/sessions/{sid}/files/write",
        json={"path": "../outside.txt", "content": "nope"},
    )
    assert resp.status_code in (400, 403, 500)
    body = resp.text
    assert physical not in body
    assert str(settings.workspaces_path) not in body
    assert "/var/sandbox/workspaces" not in body


def test_artifact_submit_rejects_traversal_missing_dir_and_symlink():
    data = _create_session()
    sid = data["session_id"]
    physical = _physical_for(sid)

    # Missing file
    missing = client.post(
        f"/sessions/{sid}/artifacts/submit",
        json={
            "name": "gone.txt",
            "path": "no-such-file.txt",
            "mime_type": "text/plain",
        },
    )
    assert missing.status_code in (400, 404)

    # Directory is not a regular file
    (physical / "subdir").mkdir()
    is_dir = client.post(
        f"/sessions/{sid}/artifacts/submit",
        json={"name": "subdir", "path": "subdir", "mime_type": "text/plain"},
    )
    assert is_dir.status_code in (400, 403)

    # Path traversal / absolute path
    for bad in ("../outside.txt", "/etc/passwd"):
        trav = client.post(
            f"/sessions/{sid}/artifacts/submit",
            json={"name": "x", "path": bad, "mime_type": "text/plain"},
        )
        assert trav.status_code in (400, 403), f"accepted {bad}"

    # Symlink pointing outside workspace
    outside = physical.parent / "outside_secret.txt"
    outside.write_text("secret-data", encoding="utf-8")
    link = physical / "evil_link"
    link.symlink_to(outside)
    symlink = client.post(
        f"/sessions/{sid}/artifacts/submit",
        json={"name": "evil", "path": "evil_link", "mime_type": "text/plain"},
    )
    assert symlink.status_code in (400, 403)
    outside.unlink(missing_ok=True)


def test_artifact_cross_session_download_denied():
    """Session B cannot download Session A's artifact by ID."""
    a = _create_session("art-a")
    b = _create_session("art-b")
    sa, sb = a["session_id"], b["session_id"]

    client.post(
        f"/sessions/{sa}/files/write",
        json={"path": "a-only.txt", "content": "private-A"},
    )
    sub = client.post(
        f"/sessions/{sa}/artifacts/submit",
        json={
            "name": "a-only.txt",
            "path": "a-only.txt",
            "mime_type": "text/plain",
        },
    )
    assert sub.status_code == 201, sub.text
    art_id = sub.json()["artifact_id"]

    # Owner can download
    own = client.get(f"/sessions/{sa}/artifacts/{art_id}/download")
    assert own.status_code == 200
    assert b"private-A" in own.content

    # Other session must not obtain the bytes
    cross = client.get(f"/sessions/{sb}/artifacts/{art_id}/download")
    assert cross.status_code in (403, 404)
    assert b"private-A" not in cross.content


def test_binary_upload_roundtrip_invalid_utf8():
    """Upload must preserve exact bytes including NUL and invalid UTF-8.

    Attachments use isolated paths uploads/{id}/{name}; .zip is whitelisted
    and stored as opaque bytes.
    """
    data = _create_session("bin")
    sid = data["session_id"]
    payload = b"hello\x00world\xff\xfe binary"

    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("bin.zip", payload, "application/octet-stream")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    rel = body["path"]
    assert rel.startswith("uploads/")
    assert body.get("attachment_id")

    physical = _physical_for(sid)
    assert (physical / rel).read_bytes() == payload

    dl = client.get(f"/sessions/{sid}/files/download", params={"path": rel})
    assert dl.status_code == 200
    assert dl.content == payload


def test_agent_session_rebind_preserves_temp_until_session_close():
    """Same AgentSession + workspace: /tmp survives COMPLETED→rebind; Session close cleans both.

    Conversation delete is not involved (Workspace lifecycle follows Session).
    """
    from sandbox.models import SessionStatus

    agent, wsp = _formal_id(), _formal_id()
    s1 = client.post(
        "/sessions",
        json={
            "caller_id": "tmp-rebind-1",
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    )
    assert s1.status_code == 201, s1.text
    sid = s1.json()["session_id"]
    written = client.post(
        f"/sessions/{sid}/files/write",
        json={"path": "/tmp/cache/state.json", "content": "persisted-temp"},
    )
    assert written.status_code == 201, written.text
    assert written.json()["path"] == "/tmp/cache/state.json"

    session_manager.update_status(sid, SessionStatus.COMPLETED)
    rebound = client.post(
        "/sessions",
        json={
            "caller_id": "tmp-rebind-2",
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    )
    assert rebound.status_code == 201, rebound.text
    assert rebound.json()["session_id"] == sid
    assert rebound.json()["workspace_id"] == wsp

    read = client.get(
        f"/sessions/{sid}/files/read",
        params={"path": "/tmp/cache/state.json"},
    )
    assert read.status_code == 200
    assert read.json().get("content") == "persisted-temp"

    workspace = settings.workspaces_path / wsp
    temp = settings.temp_path / f"tmp_{wsp}"
    assert workspace.exists() and temp.exists()

    # Explicit Session close owns cleanup of both trees.
    assert client.delete(f"/sessions/{sid}").status_code == 204
    assert not workspace.exists()
    assert not temp.exists()
