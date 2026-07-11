"""Workspace isolation, skill R/O, and artifact-only delivery acceptance tests."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from sandbox.main import app
from sandbox.paths import AGENT_SKILL_PATH, get_session_physical_workspace
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager


client = TestClient(app)


def _create_session(caller: str = "test") -> dict:
    resp = client.post("/sessions", json={"caller_id": caller})
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
    from sandbox.config import settings

    skill_root = Path(settings.skills_path)
    skill_root.mkdir(parents=True, exist_ok=True)
    demo = skill_root / "demo-skill"
    demo.mkdir(exist_ok=True)
    (demo / "SKILL.md").write_text("# Demo\n", encoding="utf-8")

    data = _create_session()
    physical = _physical_for(data["session_id"])
    # Workspace must not contain skills seed
    assert "skills" not in {p.name for p in physical.iterdir()} if physical.exists() else True
    assert skill_root.is_dir()
    assert (demo / "SKILL.md").is_file()
    # Skills live outside the workspace tree
    assert not str(skill_root.resolve()).startswith(str(physical.resolve()) + "/")
    assert skill_root.resolve() != physical.resolve()
    # Skill constant remains (skills are not the session workspace contract)
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
        # PermissionError surfaces as 500 unless router maps it; accept 403/400/500
        # as long as write did not succeed and content is not created in-workspace
        assert resp.status_code != 201, f"escape path accepted: {bad_path}"
        assert resp.status_code in (400, 403, 500)

    # Confirm nothing escaped into the physical parent
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


def test_empty_init_conversation_workspace():
    ws = workspace_manager.init_conversation_workspace("test-conv-empty")
    assert ws.is_dir()
    assert list(ws.iterdir()) == []
    workspace_manager.remove_conversation_workspace("test-conv-empty")


def test_conversation_id_traversal_rejected():
    """Client conversation IDs with traversal must not create dirs outside root."""
    from sandbox.config import settings

    root = Path(settings.workspaces_path).resolve()
    for bad_id in ("../escape", "a/b", "../../tmp", "has space"):
        resp = client.post("/conversations", json={"id": bad_id, "title": "evil"})
        assert resp.status_code == 400, f"accepted bad id {bad_id!r}: {resp.status_code}"
        # No directory created outside workspaces root
        assert not (root.parent / "escape").exists()


def test_conversation_api_returns_workspace_id_only():
    """ConversationResponse exposes opaque workspace_id, never host paths."""
    from sandbox.config import settings

    resp = client.post("/conversations", json={"title": "logical-ws"})
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["workspace_id"].startswith("conv_")
    assert "workspace_path" not in data or data.get("workspace_path") in (None, "")
    physical_root = str(Path(settings.workspaces_path).resolve())
    dumped = str(data)
    assert physical_root not in dumped
    assert "/var/sandbox/workspaces" not in dumped
    assert "/home/sandbox/workspace" not in dumped

    ws = client.get(f"/conversations/{data['id']}/workspace")
    assert ws.status_code == 200
    body = ws.json()
    assert body["workspace_id"].startswith("conv_")
    assert "workspace_path" not in body


def test_two_conversations_isolated_concurrently():
    """Concurrent conversations must not share files or physical roots."""
    c1 = client.post("/conversations", json={"title": "iso-a"}).json()
    c2 = client.post("/conversations", json={"title": "iso-b"}).json()
    s1 = client.post(
        "/sessions",
        json={"caller_id": "a", "conversation_id": c1["id"]},
    )
    s2 = client.post(
        "/sessions",
        json={"caller_id": "b", "conversation_id": c2["id"]},
    )
    assert s1.status_code == 201, s1.text
    assert s2.status_code == 201, s2.text
    d1, d2 = s1.json(), s2.json()
    assert d1["workspace_id"] != d2["workspace_id"]
    assert "_physical_workspace" not in (d1.get("metadata") or {})
    assert "_physical_workspace" not in (d2.get("metadata") or {})
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


def test_write_lease_conflict_http_409():
    """Second concurrent session on the same conversation workspace → 409."""
    conv = client.post("/conversations", json={"title": "lease"}).json()
    first = client.post(
        "/sessions",
        json={"caller_id": "writer-1", "conversation_id": conv["id"]},
    )
    assert first.status_code == 201, first.text
    second = client.post(
        "/sessions",
        json={"caller_id": "writer-2", "conversation_id": conv["id"]},
    )
    assert second.status_code == 409, second.text
    detail = second.json().get("detail", "")
    assert "lease" in detail.lower() or "conflict" in detail.lower()


def test_session_rebind_sees_same_conversation_files():
    """After first session ends, a new session rebinds and sees prior files."""
    conv = client.post("/conversations", json={"title": "rebind"}).json()
    s1 = client.post(
        "/sessions",
        json={"caller_id": "t1", "conversation_id": conv["id"]},
    ).json()
    sid1 = s1["session_id"]
    w = client.post(
        f"/sessions/{sid1}/files/write",
        json={"path": "keep.txt", "content": "persisted"},
    )
    assert w.status_code == 201

    # End first session (releases write lease; keeps conversation workspace)
    deleted = client.delete(f"/sessions/{sid1}")
    assert deleted.status_code == 204

    s2 = client.post(
        "/sessions",
        json={"caller_id": "t2", "conversation_id": conv["id"]},
    )
    assert s2.status_code == 201, s2.text
    sid2 = s2.json()["session_id"]
    read = client.get(f"/sessions/{sid2}/files/read", params={"path": "keep.txt"})
    assert read.status_code == 200
    assert read.json().get("content") == "persisted"


def test_path_escape_error_detail_has_no_physical_root():
    """File API escape errors must not include host workspace roots."""
    from sandbox.config import settings

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
        json={"name": "gone.txt", "path": "no-such-file.txt", "mime_type": "text/plain"},
    )
    assert missing.status_code in (400, 404)

    # Directory is not a regular file
    (physical / "subdir").mkdir()
    is_dir = client.post(
        f"/sessions/{sid}/artifacts/submit",
        json={"name": "subdir", "path": "subdir", "mime_type": "text/plain"},
    )
    assert is_dir.status_code in (400, 403)

    # Path traversal
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
        json={"name": "a-only.txt", "path": "a-only.txt", "mime_type": "text/plain"},
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

    Attachments use isolated paths uploads/{id}/{name}; .dat is not on the
    whitelist, so we use .bin-equivalent via .txt for whitelist + binary body.
    """
    data = _create_session("bin")
    sid = data["session_id"]
    payload = b"hello\x00world\xff\xfe binary"

    # .zip is whitelisted and stored as opaque bytes (no extract)
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
