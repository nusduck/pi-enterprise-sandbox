"""B5 — multi-attachment binding + structured attachment context (ADR §4.5 / §12.4)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.main import app
from sandbox.paths import get_session_physical_workspace
from sandbox.services.attachment_manager import (
    attachment_manager,
    format_attachment_prompt_block,
    normalize_attachment_context,
)
from sandbox.services.session_manager import session_manager
from tests.conftest import session_create_payload

client = TestClient(app)


def _create_session(caller: str = "att-ctx") -> dict:
    resp = client.post("/sessions", json=session_create_payload(caller))
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_normalize_attachment_context_full_fields():
    raw = {
        "attachment_id": "att_abc",
        "name": "report.xlsx",
        "path": "uploads/att_abc/report.xlsx",
        "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "size": 1024,
        "upload_time": "2026-07-12T00:00:00+00:00",
    }
    n = normalize_attachment_context(raw)
    assert n is not None
    assert n["attachment_id"] == "att_abc"
    assert n["filename"] == "report.xlsx"
    assert n["path"] == "uploads/att_abc/report.xlsx"
    assert n["workspace_path"] == "uploads/att_abc/report.xlsx"
    assert n["mime_type"].startswith("application/")
    assert n["size"] == 1024
    assert n["upload_time"]


def test_normalize_accepts_camel_case():
    n = normalize_attachment_context(
        {
            "attachmentId": "att_1",
            "path": "uploads/att_1/a.txt",
            "mimeType": "text/plain",
            "size": 3,
            "uploadTime": "t",
        }
    )
    assert n["attachment_id"] == "att_1"
    assert n["mime_type"] == "text/plain"
    assert n["upload_time"] == "t"
    assert n["filename"] == "a.txt"


def test_format_attachment_prompt_lists_multi_without_scan():
    attachments = [
        {
            "attachment_id": "att_a",
            "filename": "a.txt",
            "path": "uploads/att_a/a.txt",
            "mime_type": "text/plain",
            "size": 1,
            "upload_time": "t1",
        },
        {
            "attachment_id": "att_b",
            "filename": "b.md",
            "path": "uploads/att_b/b.md",
            "mime_type": "text/markdown",
            "size": 2,
            "upload_time": "t2",
        },
    ]
    block = format_attachment_prompt_block(attachments)
    assert "Current-turn attachments" in block
    assert "uploads/att_a/a.txt" in block
    assert "uploads/att_b/b.md" in block
    assert "Do **not** scan" in block
    assert "attachment_id=`att_a`" in block
    assert "mime=`text/markdown`" in block
    # Empty → no block
    assert format_attachment_prompt_block([]) == ""
    assert format_attachment_prompt_block(None) == ""


def test_upload_returns_upload_time_and_auditable_fields():
    data = _create_session("aud")
    sid = data["session_id"]

    resp = client.post(
        f"/sessions/{sid}/files/upload",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["attachment_id"].startswith("att_")
    assert body["path"].startswith("uploads/")
    assert body["name"] == "notes.txt"
    assert body["mime_type"]
    assert body.get("upload_time")  # B5 audit field
    assert body["size"] == 5

    # Physical file exists at isolated path
    session = session_manager.get(sid)
    physical = Path(get_session_physical_workspace(session))
    assert (physical / body["path"]).is_file()


def test_multi_attachment_binding_distinct_paths():
    """Two same-name files bind to distinct attachment_ids / paths."""
    data = _create_session("multi")
    sid = data["session_id"]
    paths = []
    ids = []
    for i in range(2):
        resp = client.post(
            f"/sessions/{sid}/files/upload",
            files={"file": ("dup.txt", f"content-{i}".encode(), "text/plain")},
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        paths.append(body["path"])
        ids.append(body["attachment_id"])

    assert ids[0] != ids[1]
    assert paths[0] != paths[1]
    assert all(p.startswith("uploads/") for p in paths)

    # Prompt block lists both exactly
    manifests = [
        {
            "attachment_id": ids[0],
            "filename": "dup.txt",
            "path": paths[0],
            "mime_type": "text/plain",
            "size": 9,
            "upload_time": "t0",
        },
        {
            "attachment_id": ids[1],
            "filename": "dup.txt",
            "path": paths[1],
            "mime_type": "text/plain",
            "size": 9,
            "upload_time": "t1",
        },
    ]
    block = format_attachment_prompt_block(manifests)
    assert paths[0] in block and paths[1] in block
    assert ids[0] in block and ids[1] in block


def test_write_bytes_includes_upload_time(tmp_path: Path):
    entry = attachment_manager.write_bytes(
        str(tmp_path),
        b"x",
        filename="x.txt",
        mime_type="text/plain",
    )
    assert entry["upload_time"]
    assert entry["filename"] == "x.txt"
    assert entry["path"].startswith("uploads/")
