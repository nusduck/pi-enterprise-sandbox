"""Formal artifact UNIQUE uses full-path hash (InnoDB 3072-byte safe)."""

from __future__ import annotations

import hashlib

import pytest

from sandbox.app.domain.types import OwnerScope
from sandbox.app.persistence.errors import ConflictError
from sandbox.app.persistence.repositories.artifact_repository import (
    relative_path_sha256_hex,
)
from sandbox.services.artifact_store import FakeFormalArtifactRepository


def test_relative_path_sha256_hex_is_full_path_digest():
    p = "a" * 900 + "/file.bin"
    h = relative_path_sha256_hex(p)
    assert len(h) == 64
    assert h == hashlib.sha256(p.encode("utf-8")).hexdigest().lower()
    # Distinct long paths that share a long prefix must not share identity.
    p2 = "a" * 900 + "/file2.bin"
    assert relative_path_sha256_hex(p2) != h


def test_uk_artifact_file_index_byte_budget():
    """Static oracle: hashed unique fits; raw path unique does not."""
    run_id_utf8mb4 = 26 * 4
    path_hash_ascii = 64
    sha_ascii = 64
    assert run_id_utf8mb4 + path_hash_ascii + sha_ascii <= 3072
    legacy = run_id_utf8mb4 + 1024 * 4 + 64 * 4
    assert legacy > 3072


def test_fake_repo_exact_path_lookup_and_idempotent():
    repo = FakeFormalArtifactRepository()
    scope = OwnerScope(org_id="o1", user_id="u1")
    entry = {
        "artifact_id": "A1" + "0" * 24,
        "org_id": "o1",
        "user_id": "u1",
        "conversation_id": "c1" + "0" * 24,
        "agent_session_id": "s1" + "0" * 24,
        "run_id": "r1" + "0" * 24,
        "relative_path": "deep/" + ("x" * 800) + "/out.pdf",
        "display_name": "out.pdf",
        "mime_type": "application/pdf",
        "size_bytes": 12,
        "sha256": "ab" * 32,
        "status": "ready",
    }
    # Normalize ULID-ish ids for fake (assert may not apply in fake)
    for k in (
        "artifact_id",
        "conversation_id",
        "agent_session_id",
        "run_id",
    ):
        entry[k] = (entry[k][:26]).ljust(26, "0")
    created = repo.create(None, entry)
    again = repo.get_by_run_path_hash(
        None,
        scope,
        run_id=entry["run_id"],
        relative_path=entry["relative_path"],
        sha256=entry["sha256"],
    )
    assert again is not None
    assert again.artifact_id == created.artifact_id
    # Different full path (same prefix length) is a different identity.
    miss = repo.get_by_run_path_hash(
        None,
        scope,
        run_id=entry["run_id"],
        relative_path=entry["relative_path"] + ".bak",
        sha256=entry["sha256"],
    )
    assert miss is None


def test_fake_repo_path_hash_collision_fail_closed():
    """If unique key hits but stored path differs, fail closed."""
    repo = FakeFormalArtifactRepository()
    scope = OwnerScope(org_id="o1", user_id="u1")
    path_a = "path-a"
    path_b = "path-b"
    # Force collision by poisoning unique map (simulated theoretical SHA collision).
    row = {
        "artifact_id": "A1" + "0" * 24,
        "org_id": "o1",
        "user_id": "u1",
        "conversation_id": "c1" + "0" * 24,
        "agent_session_id": "s1" + "0" * 24,
        "run_id": "r1" + "0" * 24,
        "relative_path": path_a,
        "relative_path_hash": relative_path_sha256_hex(path_b),  # wrong hash for path_a
        "display_name": "a",
        "mime_type": None,
        "size_bytes": 1,
        "sha256": "cd" * 32,
        "status": "ready",
        "created_at": "2026-07-18 00:00:00.000",
    }
    for k in ("artifact_id", "conversation_id", "agent_session_id", "run_id"):
        row[k] = (row[k][:26]).ljust(26, "0")
    with repo._lock:  # noqa: SLF001
        repo.rows[row["artifact_id"]] = row
        # Unique as if path_b hashed into this slot
        repo._unique[
            (row["run_id"], relative_path_sha256_hex(path_b), row["sha256"])
        ] = row["artifact_id"]

    with pytest.raises(ConflictError, match="path hash collision"):
        repo.get_by_run_path_hash(
            None,
            scope,
            run_id=row["run_id"],
            relative_path=path_b,
            sha256=row["sha256"],
        )
