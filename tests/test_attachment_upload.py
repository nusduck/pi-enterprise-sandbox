"""Attachment upload: path isolation, whitelist, size limits, idempotency."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.main import app
from sandbox.services.attachment_manager import (
    AttachmentError,
    attachment_manager,
    extension_of,
    is_allowed_extension,
    sanitize_filename,
)

client = TestClient(app)


def _create_session(caller: str = "att-test") -> dict:
    resp = client.post("/sessions", json={"caller_id": caller})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_extension_whitelist_allows_common_types():
    for name in (
        "a.txt", "b.PDF", "c.Tar.Gz", "note.md", "x.py", "img.PNG",
        "sheet.xlsx", "pack.zip", "archive.tgz",
    ):
        assert is_allowed_extension(name), name


def test_extension_whitelist_denies_risky_types():
    for name in ("malware.exe", "a.rar", "b.7z", "c.bin", "noext"):
        assert not is_allowed_extension(name), name


def test_extension_of_compound():
    assert extension_of("foo.TAR.GZ") == ".tar.gz"
    assert extension_of("x.tgz") == ".tgz"


def test_sanitize_filename_strips_path():
    assert sanitize_filename("../../etc/passwd.txt") == "passwd.txt"
    assert sanitize_filename("") == "upload"


def test_upload_isolated_path_not_bare_filename():
    data = _create_session("iso")
    sid = data["session_id"]
    physical = Path(data["metadata"]["_physical_workspace"])

    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("report.txt", b"hello attachment", "text/plain")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["attachment_id"]
    assert body["path"].startswith("uploads/")
    assert body["path"].endswith("/report.txt")
    assert body["name"] == "report.txt"
    assert body["size"] == len(b"hello attachment")
    # Bare filename must NOT exist at workspace root
    assert not (physical / "report.txt").exists()
    assert (physical / body["path"]).is_file()
    assert (physical / body["path"]).read_bytes() == b"hello attachment"


def test_same_display_name_different_attachment_ids_no_overwrite():
    data = _create_session("same-name")
    sid = data["session_id"]
    physical = Path(data["metadata"]["_physical_workspace"])

    r1 = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("dup.txt", b"first", "text/plain")},
    )
    r2 = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("dup.txt", b"second-version", "text/plain")},
    )
    assert r1.status_code == 201 and r2.status_code == 201
    b1, b2 = r1.json(), r2.json()
    assert b1["attachment_id"] != b2["attachment_id"]
    assert b1["path"] != b2["path"]
    assert (physical / b1["path"]).read_bytes() == b"first"
    assert (physical / b2["path"]).read_bytes() == b"second-version"


def test_idempotent_upload_same_key():
    data = _create_session("idem")
    sid = data["session_id"]
    physical = Path(data["metadata"]["_physical_workspace"])
    headers = {"Idempotency-Key": "idem-key-fixed-001"}

    r1 = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("once.txt", b"only-once", "text/plain")},
        headers=headers,
    )
    r2 = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("once.txt", b"different-body-ignored", "text/plain")},
        headers=headers,
    )
    assert r1.status_code == 201 and r2.status_code == 201
    b1, b2 = r1.json(), r2.json()
    assert b1["attachment_id"] == b2["attachment_id"]
    assert b1["path"] == b2["path"]
    assert b1["size"] == b2["size"] == len(b"only-once")
    # Only one file under uploads for this attachment
    assert (physical / b1["path"]).read_bytes() == b"only-once"


def test_upload_type_denied():
    data = _create_session("deny")
    sid = data["session_id"]
    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("evil.exe", b"MZ....", "application/octet-stream")},
    )
    assert resp.status_code == 400
    detail = resp.json()["detail"]
    assert detail["code"] == "attachment_type_denied"


def test_upload_too_large_returns_413(monkeypatch):
    monkeypatch.setattr(settings, "max_file_size_mb", 0)  # 0 MB → any byte over
    # 0 MB means max_bytes = 0, so first chunk fails
    data = _create_session("big")
    sid = data["session_id"]
    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("big.txt", b"x", "text/plain")},
    )
    assert resp.status_code == 413, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "attachment_too_large"


def test_upload_quota_exceeded_413(monkeypatch):
    monkeypatch.setattr(settings, "workspace_quota_mb", 0)
    data = _create_session("quota")
    sid = data["session_id"]
    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("q.txt", b"hello", "text/plain")},
    )
    # quota 0: after writing temp under workspace, commit detects over-quota
    assert resp.status_code == 413, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "workspace_quota_exceeded"


def test_archive_not_auto_extracted():
    data = _create_session("zip")
    sid = data["session_id"]
    physical = Path(data["metadata"]["_physical_workspace"])
    # Minimal zip local file header prefix (not a valid full zip — stored as bytes)
    payload = b"PK\x03\x04fake-zip-bytes"
    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("pack.zip", payload, "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["path"].endswith("/pack.zip")
    on_disk = physical / body["path"]
    assert on_disk.is_file()
    assert on_disk.read_bytes() == payload
    # No sibling extracted tree
    parent = on_disk.parent
    names = {p.name for p in parent.iterdir()}
    assert "pack.zip" in names
    # only meta + zip expected (and maybe temp none)
    assert not any(n.endswith(".extracted") for n in names)


def test_attachment_manager_write_bytes_unit(tmp_path):
    ws = str(tmp_path)
    entry = attachment_manager.write_bytes(
        ws, b"unit", filename="n.md", idempotency_key="k1",
    )
    assert entry["path"].startswith("uploads/")
    again = attachment_manager.write_bytes(
        ws, b"other", filename="n.md", idempotency_key="k1",
    )
    assert again["attachment_id"] == entry["attachment_id"]
    with pytest.raises(AttachmentError) as ei:
        attachment_manager.write_bytes(ws, b"x", filename="bad.exe")
    assert ei.value.code == "attachment_type_denied"
