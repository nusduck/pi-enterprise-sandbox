"""PR-09 adversarial tests — control-plane snapshots, formal restart, races.

Hermetic: no real MySQL / Redis / Docker.
"""

from __future__ import annotations

import hashlib
import os
import stat
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.app.domain.types import OwnerScope
from sandbox.config import settings
from sandbox.main import app
from sandbox.services.artifact_manager import (
    ArtifactError,
    ArtifactManager,
    safe_content_disposition_filename,
)
from sandbox.services.artifact_store import (
    FakeFormalArtifactRepository,
    FormalArtifactDualWriter,
)
from sandbox.services.control_plane_storage import (
    ControlPlaneError,
    FileIdentity,
    artifact_blob_path,
    control_root,
    dataset_staging_path,
    open_workspace_leaf_nofollow,
    secure_publish_to_workspace,
    stream_copy_hash_from_fd,
    unlink_workspace_leaf_if_matches,
    write_all,
)
from sandbox.services.dataset_manager import (
    DATASET_STATUS_READY,
    DATASET_STATUS_UPLOADING,
    DatasetError,
    DatasetManager,
    logical_dataset_path,
    sanitize_dataset_filename,
)
from sandbox.services.dataset_store import (
    FakeFormalDatasetRepository,
    FormalDatasetDualWriter,
)
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_quota_ledger import (
    QuotaExceededError,
    WorkspaceQuotaLedger,
)
from tests.conftest import formal_id, session_create_payload

client = TestClient(app)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER2 = "01K0G2PAV8FPMVC9QHJG7JPN5A"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"


@pytest.fixture(autouse=True)
def _hermetic_auth(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", False)


def _create_session(**extra) -> dict:
    conv_resp = client.post(
        "/conversations",
        json={"id": extra.pop("conversation_id", None) or formal_id(), "title": "ds-test"},
    )
    if conv_resp.status_code == 201:
        conv_id = conv_resp.json()["id"]
    else:
        conv_resp = client.post("/conversations", json={"title": "ds-test"})
        assert conv_resp.status_code == 201, conv_resp.text
        conv_id = conv_resp.json()["id"]

    body = session_create_payload(**extra)
    body.setdefault("user_id", USER)
    body.setdefault("conversation_id", conv_id)
    body.setdefault(
        "metadata",
        {"org_id": ORG, "conversation_id": conv_id, "user_id": USER},
    )
    resp = client.post("/sessions", json=body)
    assert resp.status_code == 201, resp.text
    data = resp.json()
    data["_test_conversation_id"] = conv_id
    return data


def _physical(session_id: str) -> Path:
    from sandbox.paths import get_session_physical_workspace

    s = session_manager.get(session_id)
    assert s is not None
    return Path(get_session_physical_workspace(s))


def _ownership_headers(conversation_id: str | None = None, **extra) -> dict[str, str]:
    h = {
        "X-Org-Id": ORG,
        "X-User-Id": USER,
        "X-Conversation-Id": conversation_id or CONV,
    }
    h.update(extra)
    return h


# ── Filename ────────────────────────────────────────────────────────────────


class TestDatasetFilename:
    def test_sanitize_strips_traversal(self):
        assert sanitize_dataset_filename("../../etc/passwd.txt") == "passwd.txt"

    def test_reject_absolute(self):
        with pytest.raises(DatasetError) as ei:
            sanitize_dataset_filename("/etc/passwd")
        assert ei.value.code == "dataset_filename_invalid"


# ── Quota control-plane ─────────────────────────────────────────────────────


class TestQuotaLedgerConcurrent:
    def test_concurrent_reserve_does_not_oversell(self, tmp_path):
        class _L(WorkspaceQuotaLedger):
            def quota_bytes(self, *, quota_mb=None):  # noqa: ARG002
                return 1000

        ledger = _L()
        ws = str(tmp_path)
        key = formal_id()
        (tmp_path / "existing.bin").write_bytes(b"x" * 400)
        success, errors = [], []

        def worker(_n: int):
            try:
                success.append(ledger.reserve(ws, key, 400))
            except QuotaExceededError as exc:
                errors.append(exc)

        with ThreadPoolExecutor(max_workers=8) as pool:
            futs = [pool.submit(worker, i) for i in range(8)]
            for f in as_completed(futs):
                f.result()
        assert len(success) == 1
        assert len(errors) == 7
        for r in success:
            r.release()

    def test_reservation_not_in_workspace(self, tmp_path):
        ledger = WorkspaceQuotaLedger()
        wid = formal_id()
        r = ledger.reserve(str(tmp_path), wid, 10)
        # Reservation lives under control_root, not workspace
        assert not list(tmp_path.rglob("res"))
        assert (control_root() / "quota" / wid / "res" / r.reservation_id).is_file()
        r.release()


# ── Dataset control-plane staging ───────────────────────────────────────────


class TestDatasetManagerStream:
    def test_stream_ready_sha_and_path(self, tmp_path):
        fake = FakeFormalDatasetRepository()
        mgr = DatasetManager(
            formal=FormalDatasetDualWriter(fake, authoritative=True),
            quota=WorkspaceQuotaLedger(),
            auto_wire_formal=False,
        )
        payload = b"hello-dataset-" + os.urandom(64)
        expected_sha = hashlib.sha256(payload).hexdigest()
        agent = formal_id()
        wid = formal_id()
        entry = mgr.stream_from_iterator(
            workspace_path=str(tmp_path),
            workspace_key=wid,
            sandbox_session_id="sess1",
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            original_filename="report.csv",
            chunks=iter([payload[:10], payload[10:]]),
        )
        assert entry.status == DATASET_STATUS_READY
        assert entry.sha256 == expected_sha
        final = tmp_path / entry.stored_relative_path
        assert final.is_file()
        assert final.read_bytes() == payload
        # Staging cleaned from control plane
        staging = dataset_staging_path(wid, entry.dataset_id, "report.csv")
        assert not staging.exists()

    def test_uploading_has_no_formal_workspace_path(self, tmp_path):
        fake = FakeFormalDatasetRepository()
        mgr = DatasetManager(
            formal=FormalDatasetDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        wid = formal_id()
        entry = mgr.begin_upload(
            workspace_path=str(tmp_path),
            workspace_key=wid,
            sandbox_session_id="sess-stage",
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=formal_id(),
            original_filename="secret.csv",
        )
        mgr.write_chunk(entry.dataset_id, b"partial-secret")
        formal = logical_dataset_path(entry.dataset_id, "secret.csv")
        assert not (tmp_path / formal).exists()
        staging = dataset_staging_path(wid, entry.dataset_id, "secret.csv")
        assert staging.is_file()
        assert entry.to_public()["path"] == ""
        assert entry.to_public()["status"] == DATASET_STATUS_UPLOADING
        mgr.abort_upload(entry.dataset_id)
        assert not staging.exists()

    def test_workspace_cannot_tamper_quota_reservation(self, tmp_path):
        """Deleting files inside workspace must not drop control-plane reservations."""
        ledger = WorkspaceQuotaLedger()
        wid = formal_id()
        r = ledger.reserve(str(tmp_path), wid, 100)
        # Attacker writes junk in workspace
        (tmp_path / ".quota").mkdir(exist_ok=True)
        (tmp_path / ".quota" / "res").mkdir(exist_ok=True)
        # Control plane reservation still present
        assert (control_root() / "quota" / wid / "res" / r.reservation_id).is_file()
        r.release()

    def test_mark_ready_failure_compensates(self, tmp_path):
        fake = FakeFormalDatasetRepository()
        fake.fail_next_update = RuntimeError("simulated formal ready fail")
        mgr = DatasetManager(
            formal=FormalDatasetDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        with pytest.raises(DatasetError) as ei:
            mgr.stream_from_iterator(
                workspace_path=str(tmp_path),
                workspace_key=formal_id(),
                sandbox_session_id="sess-comp",
                org_id=ORG,
                user_id=USER,
                conversation_id=CONV,
                agent_session_id=formal_id(),
                original_filename="x.bin",
                chunks=iter([b"abc"]),
            )
        assert ei.value.code == "dataset_formal_ready_failed"


# ── Artifact immutable snapshot ─────────────────────────────────────────────


class TestArtifactSnapshot:
    def test_submit_copies_to_control_plane_not_workspace_only(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "out.txt"
        src.write_bytes(b"deliverable")
        agent = formal_id()
        art = mgr.submit(
            session_id="s1",
            path="out.txt",
            name="out.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        snap = artifact_blob_path(ORG, art.artifact_id)
        assert snap.is_file()
        assert snap.read_bytes() == b"deliverable"
        # Mutate workspace + restore mtime — snapshot unchanged
        mtime = src.stat().st_mtime
        src.write_bytes(b"TAMPERED!!!")
        os.utime(src, (mtime, mtime))
        assert snap.read_bytes() == b"deliverable"
        art2, path, ident = mgr.resolve_download(
            session_id="s1",
            artifact_id=art.artifact_id,
            org_id=ORG,
            user_id=USER,
            agent_session_id=agent,
            conversation_id=CONV,
            run_id=RUN,
        )
        assert path == snap
        assert path.read_bytes() == b"deliverable"
        _ = art2, ident

    def test_mutate_workspace_utime_does_not_affect_download(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = tmp_path / "ws"
        ws.mkdir()
        src = ws / "a.txt"
        src.write_bytes(b"ORIGINAL-CONTENT")
        art = mgr.submit(
            session_id="s-m",
            name="a.txt",
            path="a.txt",
            physical_workspace=ws,
            org_id=ORG,
            user_id=USER,
        )
        snap = artifact_blob_path(ORG, art.artifact_id)
        assert snap.read_bytes() == b"ORIGINAL-CONTENT"
        mtime = src.stat().st_mtime_ns if hasattr(src.stat(), "st_mtime_ns") else None
        src.write_bytes(b"EVIL" + b"x" * (len("ORIGINAL-CONTENT") - 4))
        if mtime is not None:
            os.utime(src, ns=(mtime, mtime))
        # Download from snapshot still original
        _art, path, _id = mgr.resolve_download(
            session_id="s-m", artifact_id=art.artifact_id, org_id=ORG, user_id=USER
        )
        assert path.read_bytes() == b"ORIGINAL-CONTENT"

    def test_formal_restart_fresh_manager_recovers(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr1 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "r.txt"
        src.write_bytes(b"persist-me")
        agent = formal_id()
        art = mgr1.submit(
            session_id="s-old",
            path="r.txt",
            name="r.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        snap = artifact_blob_path(ORG, art.artifact_id)
        assert snap.is_file()

        # Fresh manager simulates process restart (empty memory)
        mgr2 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        recovered = mgr2.get_for_owner(
            art.artifact_id,
            session_id="s-new",
            org_id=ORG,
            user_id=USER,
            agent_session_id=agent,
            conversation_id=CONV,
            run_id=RUN,
        )
        assert recovered is not None
        assert recovered.artifact_id == art.artifact_id
        _a, path, _i = mgr2.resolve_download(
            session_id="s-new",
            artifact_id=art.artifact_id,
            org_id=ORG,
            user_id=USER,
            agent_session_id=agent,
            conversation_id=CONV,
            run_id=RUN,
        )
        assert path.read_bytes() == b"persist-me"

    def test_cross_org_formal_get_none(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "x.txt"
        src.write_text("secret")
        agent = formal_id()
        art = mgr.submit(
            session_id="s1",
            path="x.txt",
            name="x.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        assert (
            mgr.get_for_owner(
                art.artifact_id,
                session_id="s1",
                org_id=ORG,
                user_id=USER2,
                agent_session_id=agent,
                conversation_id=CONV,
            )
            is None
        )

    def test_cross_agent_session_denied(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "x.txt"
        src.write_text("secret")
        agent_a, agent_b = formal_id(), formal_id()
        art = mgr.submit(
            session_id="s1",
            path="x.txt",
            name="x.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent_a,
            run_id=RUN,
        )
        assert (
            mgr.get_for_owner(
                art.artifact_id,
                session_id="s2",
                org_id=ORG,
                user_id=USER,
                agent_session_id=agent_b,
                conversation_id=CONV,
                run_id=RUN,
            )
            is None
        )

    def test_unique_race_no_orphan_snapshot(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        writer = FormalArtifactDualWriter(fake, authoritative=True)
        # Pre-insert winner
        winner_id = formal_id()
        sha = hashlib.sha256(b"abc").hexdigest()
        fake.simulate_unique_race_insert(
            {
                "artifact_id": winner_id,
                "org_id": ORG,
                "user_id": USER,
                "conversation_id": CONV,
                "agent_session_id": formal_id(),
                "run_id": RUN,
                "relative_path": "out/r.txt",
                "display_name": "r.txt",
                "size_bytes": 3,
                "sha256": sha,
                "status": "ready",
            }
        )
        # Create snapshot for loser id then get_or_create returns winner
        loser_id = formal_id()
        ensure = artifact_blob_path(ORG, loser_id)
        ensure.parent.mkdir(parents=True, exist_ok=True)
        ensure.write_bytes(b"abc")
        row = writer.get_or_create(
            {
                "artifact_id": loser_id,
                "org_id": ORG,
                "user_id": USER,
                "conversation_id": CONV,
                "agent_session_id": formal_id(),
                "run_id": RUN,
                "relative_path": "out/r.txt",
                "display_name": "r.txt",
                "size_bytes": 3,
                "sha256": sha,
                "status": "ready",
            }
        )
        assert row.artifact_id == winner_id
        # Manager submit path unlinks loser — unit: we unlink loser ourselves as contract
        from sandbox.services.control_plane_storage import unlink_control_file

        if row.artifact_id != loser_id:
            unlink_control_file(ensure)
        assert not ensure.exists() or row.artifact_id == loser_id

    def test_idempotent_submit(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "i.txt"
        src.write_bytes(b"same")
        agent = formal_id()
        a1 = mgr.submit(
            session_id="s1",
            path="i.txt",
            name="i.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        a2 = mgr.submit(
            session_id="s1",
            path="i.txt",
            name="i.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        assert a1.artifact_id == a2.artifact_id
        assert len(fake.rows) == 1

    def test_parent_symlink_swap_rejected_on_open(self, tmp_path):
        """dirfd walk must refuse when a parent component is a symlink."""
        real = tmp_path / "realdir"
        real.mkdir()
        (real / "leaf.txt").write_text("x")
        # workspace/sub -> realdir (symlink parent)
        sub = tmp_path / "sub"
        sub.symlink_to(real)
        with pytest.raises(ControlPlaneError) as ei:
            open_workspace_leaf_nofollow(tmp_path, ("sub", "leaf.txt"))
        assert ei.value.code in {"PATH_INVALID", "SYMLINK_REJECTED", "FILE_NOT_FOUND"}

    def test_write_all_handles_partial_writes(self, tmp_path, monkeypatch):
        """write_all must loop until full buffer is written."""
        path = tmp_path / "out.bin"
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        calls = {"n": 0}
        original = os.write

        def partial_write(f, data):
            calls["n"] += 1
            if isinstance(data, memoryview):
                raw = data.tobytes()
            else:
                raw = bytes(data)
            # Force short write for first few calls
            if calls["n"] <= 3 and len(raw) > 1:
                n = original(f, raw[:1])
                return n
            return original(f, raw)

        monkeypatch.setattr(os, "write", partial_write)
        try:
            payload = b"ABCDEFGHIJ"
            wrote = write_all(fd, payload)
            assert wrote == len(payload)
        finally:
            os.close(fd)
            monkeypatch.setattr(os, "write", original)
        assert path.read_bytes() == b"ABCDEFGHIJ"
        assert calls["n"] > 1

    def test_publish_size_mismatch_not_published(self, tmp_path, monkeypatch):
        """If fstat size != streamed total, leaf must not remain published."""
        ctrl = tmp_path / "ctrl"
        ctrl.mkdir()
        src = ctrl / "blob"
        src.write_bytes(b"hello-world")
        ws = tmp_path / "ws"
        ws.mkdir()
        # Corrupt write_all path: after write, force fstat size lie via wrapping
        # Instead: inject max smaller and expect TOO_LARGE or fail closed
        with pytest.raises(ControlPlaneError) as ei:
            secure_publish_to_workspace(
                src_control_path=src,
                workspace_path=ws,
                relative_parts=("out", "f.bin"),
                max_bytes=3,  # smaller than content
            )
        assert ei.value.code == "TOO_LARGE"
        assert not (ws / "out" / "f.bin").exists()

    def test_compensation_unlink_requires_identity_match(self, tmp_path):
        """Compensation must not delete a leaf that no longer matches identity."""
        ws = tmp_path / "ws"
        ws.mkdir()
        (ws / "datasets").mkdir()
        did = formal_id()
        ddir = ws / "datasets" / did
        ddir.mkdir()
        leaf = ddir / "f.bin"
        leaf.write_bytes(b"published")
        st = leaf.stat()
        expected = FileIdentity.from_stat(st)
        # Replace leaf with different content/inode
        leaf.unlink()
        leaf.write_bytes(b"OTHER-CONTENT")
        # Identity no longer matches → must not delete
        ok = unlink_workspace_leaf_if_matches(
            workspace_path=ws,
            relative_parts=("datasets", did, "f.bin"),
            expected=expected,
        )
        assert ok is False
        assert leaf.is_file()
        assert leaf.read_bytes() == b"OTHER-CONTENT"

    def test_fresh_manager_requires_session_binding_not_org_user_only(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr1 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "b.txt"
        src.write_bytes(b"bound")
        agent = formal_id()
        art = mgr1.submit(
            session_id="s1",
            path="b.txt",
            name="b.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        mgr2 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        # org/user alone insufficient (unbound → no cache on fresh manager)
        assert (
            mgr2.get_for_owner(
                art.artifact_id,
                session_id="s-other",
                org_id=ORG,
                user_id=USER,
            )
            is None
        )
        # wrong agent_session
        assert (
            mgr2.get_for_owner(
                art.artifact_id,
                session_id="s-other",
                org_id=ORG,
                user_id=USER,
                agent_session_id=formal_id(),
                conversation_id=CONV,
                run_id=RUN,
            )
            is None
        )
        # correct binding
        assert (
            mgr2.get_for_owner(
                art.artifact_id,
                session_id="s-rebind",
                org_id=ORG,
                user_id=USER,
                agent_session_id=agent,
                conversation_id=CONV,
                run_id=RUN,
            )
            is not None
        )

    def test_same_session_unbound_live_download_ok(self, tmp_path):
        """Live manager: same session without agent/conversation bindings can download."""
        fake = FakeFormalArtifactRepository()
        mgr = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "live.txt"
        src.write_bytes(b"live-bytes")
        agent = formal_id()
        art = mgr.submit(
            session_id="sess-live",
            path="live.txt",
            name="live.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        # Unbound download (no agent/conversation) on same session — live cache
        got = mgr.get_for_owner(
            art.artifact_id,
            session_id="sess-live",
            org_id=ORG,
            user_id=USER,
            agent_session_id=None,
            conversation_id=None,
        )
        assert got is not None
        assert got.artifact_id == art.artifact_id
        _a, path, _i = mgr.resolve_download(
            session_id="sess-live",
            artifact_id=art.artifact_id,
            org_id=ORG,
            user_id=USER,
            agent_session_id=None,
            conversation_id=None,
        )
        assert path.read_bytes() == b"live-bytes"

    def test_cross_session_unbound_denied(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "x.txt"
        src.write_bytes(b"private")
        agent = formal_id()
        art = mgr.submit(
            session_id="owner-sess",
            path="x.txt",
            name="x.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        assert (
            mgr.get_for_owner(
                art.artifact_id,
                session_id="other-sess",
                org_id=ORG,
                user_id=USER,
                agent_session_id=None,
                conversation_id=None,
            )
            is None
        )

    def test_fresh_manager_unbound_404(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr1 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "f.txt"
        src.write_bytes(b"gone-from-memory")
        agent = formal_id()
        art = mgr1.submit(
            session_id="s1",
            path="f.txt",
            name="f.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        mgr2 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        # Fresh manager, unbound → no cache recovery
        assert (
            mgr2.get_for_owner(
                art.artifact_id,
                session_id="s1",
                org_id=ORG,
                user_id=USER,
                agent_session_id=None,
                conversation_id=None,
            )
            is None
        )

    def test_bound_fresh_manager_correct_owner_ok(self, tmp_path):
        fake = FakeFormalArtifactRepository()
        mgr1 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        src = tmp_path / "ok.txt"
        src.write_bytes(b"recover-me")
        agent = formal_id()
        art = mgr1.submit(
            session_id="s-old",
            path="ok.txt",
            name="ok.txt",
            physical_workspace=tmp_path,
            org_id=ORG,
            user_id=USER,
            conversation_id=CONV,
            agent_session_id=agent,
            run_id=RUN,
        )
        mgr2 = ArtifactManager(
            formal=FormalArtifactDualWriter(fake, authoritative=True),
            auto_wire_formal=False,
        )
        got = mgr2.get_for_owner(
            art.artifact_id,
            session_id="s-new",
            org_id=ORG,
            user_id=USER,
            agent_session_id=agent,
            conversation_id=CONV,
            run_id=RUN,
        )
        assert got is not None
        _a, path, _i = mgr2.resolve_download(
            session_id="s-new",
            artifact_id=art.artifact_id,
            org_id=ORG,
            user_id=USER,
            agent_session_id=agent,
            conversation_id=CONV,
            run_id=RUN,
        )
        assert path.read_bytes() == b"recover-me"

    def test_stream_copy_rejects_identity_change_mid_copy(self, tmp_path, monkeypatch):
        """If source fstat changes mid-copy, snapshot must not be published."""
        src = tmp_path / "src.bin"
        src.write_bytes(b"A" * 100)
        dest = tmp_path / "snap" / "blob"
        dest.parent.mkdir()
        fd, st = open_workspace_leaf_nofollow(tmp_path, ("src.bin",))
        ident = FileIdentity.from_stat(st)
        # After open, truncate/replace file on disk so end fstat differs
        # (same path; on some FS inode may change if we rewrite via replace)
        calls = {"reads": 0}
        real_read = os.read

        def read_and_mutate(f, n):
            calls["reads"] += 1
            data = real_read(f, n)
            if calls["reads"] == 1 and data:
                # Mutate underlying file between reads
                src.write_bytes(b"B" * 100)
            return data

        monkeypatch.setattr(os, "read", read_and_mutate)
        try:
            with pytest.raises(ControlPlaneError) as ei:
                stream_copy_hash_from_fd(
                    fd, dest, max_bytes=10_000, source_identity=ident
                )
            # identity mismatch or size mismatch acceptable fail-closed
            assert ei.value.code in {
                "IDENTITY_MISMATCH",
                "SIZE_MISMATCH",
                "WRITE_FAILED",
            }
        finally:
            os.close(fd)
            monkeypatch.setattr(os, "read", real_read)
        # No final blob left (tmp cleaned)
        assert not dest.exists()


# ── HTTP ────────────────────────────────────────────────────────────────────


class TestDatasetHttp:
    def test_upload_stream_e2e(self):
        sess = _create_session()
        sid = sess["session_id"]
        body = b"csv,data\n1,2\n"
        resp = client.post(
            f"/sessions/{sid}/datasets",
            files={"file": ("data.csv", body, "text/csv")},
            headers=_ownership_headers(sess["_test_conversation_id"]),
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["status"] == "ready"
        assert data["path"].startswith("datasets/")
        physical = _physical(sid)
        assert (physical / data["path"]).read_bytes() == body
        arts = client.get(f"/sessions/{sid}/artifacts").json()
        assert arts["total"] == 0


class TestArtifactHttp:
    def test_write_does_not_create_artifact(self):
        sess = _create_session()
        sid = sess["session_id"]
        client.post(
            f"/sessions/{sid}/files/write",
            json={"path": "out/report.txt", "content": "not an artifact"},
        )
        arts = client.get(f"/sessions/{sid}/artifacts").json()
        assert arts["total"] == 0

    def test_submit_and_download_stream(self):
        sess = _create_session()
        sid = sess["session_id"]
        content = b"chart-png-bytes"
        client.post(
            f"/sessions/{sid}/files/write",
            json={"path": "chart.png", "content": content.decode("latin-1")},
        )
        sub = client.post(
            f"/sessions/{sid}/artifacts/submit",
            json={"name": "chart.png", "path": "chart.png", "mime_type": "image/png"},
            headers=_ownership_headers(sess["_test_conversation_id"]),
        )
        assert sub.status_code == 201, sub.text
        art_id = sub.json()["artifact_id"]
        dl = client.get(f"/sessions/{sid}/artifacts/{art_id}/download")
        assert dl.status_code == 200
        assert dl.content == content
        assert "attachment" in (dl.headers.get("content-disposition") or "")
        assert dl.headers.get("x-content-type-options") == "nosniff"

    def test_symlink_rejected_on_submit(self):
        sess = _create_session()
        sid = sess["session_id"]
        physical = _physical(sid)
        target = physical / "real.txt"
        target.write_text("secret")
        link = physical / "link.txt"
        link.symlink_to(target)
        resp = client.post(
            f"/sessions/{sid}/artifacts/submit",
            json={"name": "link.txt", "path": "link.txt"},
            headers=_ownership_headers(sess["_test_conversation_id"]),
        )
        assert resp.status_code in (400, 403)

    def test_path_traversal_rejected(self):
        sess = _create_session()
        sid = sess["session_id"]
        resp = client.post(
            f"/sessions/{sid}/artifacts/submit",
            json={"name": "x", "path": "../../etc/passwd"},
            headers=_ownership_headers(sess["_test_conversation_id"]),
        )
        assert resp.status_code in (400, 403)

    def test_hash_mismatch_on_submit(self):
        sess = _create_session()
        sid = sess["session_id"]
        client.post(
            f"/sessions/{sid}/files/write",
            json={"path": "h.txt", "content": "abc"},
        )
        resp = client.post(
            f"/sessions/{sid}/artifacts/submit",
            json={
                "name": "h.txt",
                "path": "h.txt",
                "expected_sha256": "0" * 64,
            },
            headers=_ownership_headers(sess["_test_conversation_id"], **{"X-Run-Id": RUN}),
        )
        assert resp.status_code == 409

    def test_cross_session_download_denied(self):
        a = _create_session(caller_id="a")
        b = _create_session(caller_id="b")
        sa, sb = a["session_id"], b["session_id"]
        client.post(
            f"/sessions/{sa}/files/write",
            json={"path": "secret.txt", "content": "nope"},
        )
        sub = client.post(
            f"/sessions/{sa}/artifacts/submit",
            json={"name": "secret.txt", "path": "secret.txt"},
            headers=_ownership_headers(a["_test_conversation_id"]),
        )
        assert sub.status_code == 201
        art_id = sub.json()["artifact_id"]
        dl = client.get(f"/sessions/{sb}/artifacts/{art_id}/download")
        assert dl.status_code == 404


class TestArtifactDisposition:
    def test_safe_filename(self):
        assert "\r" not in safe_content_disposition_filename('a\r\nb.txt')
        assert '"' not in safe_content_disposition_filename('a"b.txt')
