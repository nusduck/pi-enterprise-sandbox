"""Sandbox-side reconciliation of the local user-skill cache.

Bubblewrap binds the caller's skill directory into every execution, but the
Agent installs skills from other pods. These tests pin the contract that lets
those two meet through MySQL instead of a shared writable volume: the right
files appear, a warm cache costs nothing, uninstalled skills disappear, and no
failure here can stop code from running.
"""

from __future__ import annotations

import io
import tarfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from sandbox.services.user_skill_materializer import (
    DIGEST_MARKER,
    UserSkillMaterializer,
)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER = "01K0G2PAV8FPMVC9QHJG7JPN51"


def make_bundle(files: dict[str, str]) -> bytes:
    """Gzipped tar shaped like the one the Agent stores."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=f"./{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class FakeConn:
    """Serves the two queries the materializer issues."""

    def __init__(self, rows: dict[str, tuple[str, bytes]], counters: dict[str, int]):
        self.rows = rows
        self.counters = counters
        self._result: list[dict[str, Any]] = []

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        normalized = " ".join(sql.split())
        if "SELECT skill_name, sha256" in normalized:
            self.counters["list"] = self.counters.get("list", 0) + 1
            self._result = [
                {"skill_name": name, "sha256": digest}
                for name, (digest, _) in self.rows.items()
            ]
        elif "SELECT bundle" in normalized:
            self.counters["bundle"] = self.counters.get("bundle", 0) + 1
            entry = self.rows.get(params[2])
            self._result = [{"bundle": entry[1]}] if entry else []
        else:  # pragma: no cover — the materializer issues no other query
            raise AssertionError(f"unexpected query: {normalized}")

    def fetchone(self) -> dict[str, Any] | None:
        return self._result[0] if self._result else None

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self._result)


def make_materializer(rows: dict[str, tuple[str, bytes]], counters=None):
    counters = counters if counters is not None else {}

    @contextmanager
    def factory():
        yield FakeConn(rows, counters)

    m = UserSkillMaterializer()
    m.set_connection_factory(factory)
    return m, counters


def test_materializes_everything_on_a_cold_replica(tmp_path: Path) -> None:
    rows = {
        "alpha": ("a" * 64, make_bundle({"SKILL.md": "alpha\n"})),
        "beta": ("b" * 64, make_bundle({"SKILL.md": "beta\n"})),
    }
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER

    assert m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target) is True

    assert (target / "alpha" / "SKILL.md").read_text() == "alpha\n"
    assert (target / "beta" / "SKILL.md").read_text() == "beta\n"
    assert (target / "alpha" / DIGEST_MARKER).read_text() == "a" * 64


def test_warm_cache_does_not_refetch_bundles(tmp_path: Path) -> None:
    rows = {"alpha": ("a" * 64, make_bundle({"SKILL.md": "alpha\n"}))}
    m, counters = make_materializer(rows)
    target = tmp_path / ORG / USER

    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)
    fetched = counters["bundle"]

    # Freshness window bypasses the query entirely...
    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)
    assert counters["bundle"] == fetched

    # ...and even once it expires, a matching digest skips the extraction.
    m.ensure_current(
        org_id=ORG, user_id=USER, skill_dir=target, freshness_seconds=0
    )
    m.ensure_current(
        org_id=ORG, user_id=USER, skill_dir=target, freshness_seconds=0
    )
    assert counters["bundle"] == fetched


def test_re_extracts_when_the_stored_bundle_changed(tmp_path: Path) -> None:
    rows = {"alpha": ("a" * 64, make_bundle({"SKILL.md": "v1\n"}))}
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER
    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    rows["alpha"] = ("c" * 64, make_bundle({"SKILL.md": "v2\n"}))
    m.ensure_current(
        org_id=ORG, user_id=USER, skill_dir=target, freshness_seconds=0
    )

    assert (target / "alpha" / "SKILL.md").read_text() == "v2\n"


def test_removes_a_skill_the_user_uninstalled(tmp_path: Path) -> None:
    rows = {
        "keep": ("a" * 64, make_bundle({"SKILL.md": "k\n"})),
        "drop": ("b" * 64, make_bundle({"SKILL.md": "d\n"})),
    }
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER
    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    del rows["drop"]
    m.ensure_current(
        org_id=ORG, user_id=USER, skill_dir=target, freshness_seconds=0
    )

    # Otherwise this replica keeps offering a skill that exists nowhere else.
    assert not (target / "drop").exists()
    assert (target / "keep").exists()


def test_database_failure_leaves_previous_contents_bound(tmp_path: Path) -> None:
    @contextmanager
    def failing():
        raise RuntimeError("mysql gone")
        yield  # pragma: no cover

    m = UserSkillMaterializer()
    m.set_connection_factory(failing)
    target = tmp_path / ORG / USER
    target.mkdir(parents=True)
    (target / "stale").mkdir()

    # Reported as not-current, but nothing is destroyed and no exception
    # escapes: an execution with stale skills beats an execution that fails.
    assert m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target) is False
    assert (target / "stale").exists()


def test_one_bad_bundle_does_not_block_the_others(tmp_path: Path) -> None:
    rows = {
        "good": ("a" * 64, make_bundle({"SKILL.md": "g\n"})),
        "broken": ("b" * 64, b"not a tar archive"),
    }
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER

    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    assert (target / "good" / "SKILL.md").read_text() == "g\n"
    assert not (target / "broken").exists()


def test_without_a_database_the_local_tree_is_left_alone(tmp_path: Path) -> None:
    """Single-process development shares one filesystem; nothing to copy."""
    m = UserSkillMaterializer()
    target = tmp_path / ORG / USER
    target.mkdir(parents=True)
    (target / "local-only").mkdir()

    assert m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target) is True
    assert (target / "local-only").exists()


@pytest.mark.parametrize("member", ["../escape.txt", "/abs.txt"])
def test_rejects_bundles_that_escape_the_target(tmp_path: Path, member: str) -> None:
    """The archive arrives via the database and is extracted with service
    privileges, so member paths are treated as untrusted whatever their origin.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"pwned"
        info = tarfile.TarInfo(name=member)
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))

    rows = {"evil": ("e" * 64, buf.getvalue())}
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER

    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    assert not (target / "evil").exists()
    assert not (tmp_path / "escape.txt").exists()


def test_rejects_symlinks_in_a_bundle(tmp_path: Path) -> None:
    """A symlink could point outside the read-only bind once inside bwrap."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo(name="./link")
        info.type = tarfile.SYMTYPE
        info.linkname = "/etc/passwd"
        tar.addfile(info)

    rows = {"linky": ("l" * 64, buf.getvalue())}
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER

    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    assert not (target / "linky").exists()


def test_refuses_a_skill_name_that_would_traverse(tmp_path: Path) -> None:
    rows = {"../evil": ("e" * 64, make_bundle({"SKILL.md": "x\n"}))}
    m, _ = make_materializer(rows)
    target = tmp_path / ORG / USER

    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    assert not (tmp_path / ORG / "evil").exists()


def test_clearing_the_factory_drops_cached_freshness(tmp_path: Path) -> None:
    rows = {"alpha": ("a" * 64, make_bundle({"SKILL.md": "a\n"}))}
    m, counters = make_materializer(rows)
    target = tmp_path / ORG / USER
    m.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)

    m.set_connection_factory(None)

    assert m.installed is False
    # A reinstalled factory must re-check rather than trust a stale window.
    m2, counters2 = make_materializer(rows)
    m2.ensure_current(org_id=ORG, user_id=USER, skill_dir=target)
    assert counters2["list"] == 1
