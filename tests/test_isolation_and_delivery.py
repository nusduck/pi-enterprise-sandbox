"""Workspace isolation, skill R/O, and artifact-only delivery acceptance tests."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from sandbox.main import app
from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH, get_session_physical_workspace
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager


client = TestClient(app)


def _create_session(caller: str = "test") -> dict:
    resp = client.post("/sessions", json={"caller_id": caller})
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["workspace_path"] == AGENT_WORKSPACE_PATH
    return data


def test_new_session_workspace_is_empty():
    data = _create_session()
    sid = data["session_id"]
    physical = Path(data["metadata"]["_physical_workspace"])
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
    from sandbox.config import settings

    skill_root = Path(settings.skills_path)
    skill_root.mkdir(parents=True, exist_ok=True)
    demo = skill_root / "demo-skill"
    demo.mkdir(exist_ok=True)
    (demo / "SKILL.md").write_text("# Demo\n", encoding="utf-8")

    data = _create_session()
    physical = Path(data["metadata"]["_physical_workspace"])
    # Workspace must not contain skills seed
    assert "skills" not in {p.name for p in physical.iterdir()} if physical.exists() else True
    assert skill_root.is_dir()
    assert (demo / "SKILL.md").is_file()
    # Skills live outside the workspace tree
    assert not str(skill_root.resolve()).startswith(str(physical.resolve()) + "/")
    assert skill_root.resolve() != physical.resolve()
    # Agent-visible constants
    assert AGENT_SKILL_PATH == "/home/sandbox/skill"
    assert AGENT_WORKSPACE_PATH == "/home/sandbox/workspace"


def test_file_api_write_outside_workspace_fails():
    """Writing via the file API to a path outside the workspace must fail."""
    data = _create_session()
    sid = data["session_id"]

    for bad_path in ("../outside.txt", "../../etc/passwd", "/etc/passwd"):
        resp = client.post(
            f"/sessions/{sid}/files/write",
            json={"path": bad_path, "content": "should-not-write"},
        )
        # PermissionError surfaces as 500 unless router maps it; accept 403/400/500
        # as long as write did not succeed and content is not created in-workspace
        assert resp.status_code != 201, f"escape path accepted: {bad_path}"
        assert resp.status_code in (400, 403, 500)

    # Confirm nothing escaped into the physical parent
    physical = Path(data["metadata"]["_physical_workspace"])
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


def test_empty_init_conversation_workspace():
    ws = workspace_manager.init_conversation_workspace("test-conv-empty")
    assert ws.is_dir()
    assert list(ws.iterdir()) == []
    workspace_manager.remove_conversation_workspace("test-conv-empty")
