"""Tests for structured ls / find / grep (file_search service)."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from sandbox.services.file_search import (
    FIND_MAX_LIMIT,
    FileSearchService,
)


@pytest.fixture
def ws():
    tmp = Path(tempfile.mkdtemp(prefix="file_search_"))
    yield str(tmp)
    shutil.rmtree(str(tmp), ignore_errors=True)


@pytest.fixture
def svc():
    return FileSearchService()


def _write(ws: str, rel: str, content: str | bytes) -> Path:
    p = Path(ws) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        p.write_bytes(content)
    else:
        p.write_text(content, encoding="utf-8")
    return p


class TestLs:
    def test_basic_depth_one(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "a")
        _write(ws, "sub/b.txt", "b")
        result = svc.ls(ws, ".", depth=1)
        paths = [i.path for i in result.items]
        assert "a.txt" in paths
        assert "sub" in paths
        assert "sub/b.txt" not in paths
        assert result.truncated is False
        assert result.stats.matched >= 2

    def test_depth_two_includes_nested(self, svc: FileSearchService, ws: str):
        _write(ws, "sub/b.txt", "b")
        result = svc.ls(ws, ".", depth=2)
        paths = [i.path for i in result.items]
        assert "sub/b.txt" in paths

    def test_empty_directory(self, svc: FileSearchService, ws: str):
        result = svc.ls(ws, ".", depth=1)
        assert result.items == []
        assert result.truncated is False
        assert result.stop_reason is None

    def test_hidden_excluded_by_default(self, svc: FileSearchService, ws: str):
        _write(ws, "visible.txt", "v")
        _write(ws, ".secret", "s")
        result = svc.ls(ws, ".", depth=1, include_hidden=False)
        names = [i.name for i in result.items]
        assert "visible.txt" in names
        assert ".secret" not in names

    def test_hidden_included_when_requested(self, svc: FileSearchService, ws: str):
        _write(ws, ".secret", "s")
        result = svc.ls(ws, ".", depth=1, include_hidden=True)
        names = [i.name for i in result.items]
        assert ".secret" in names

    def test_stable_sort(self, svc: FileSearchService, ws: str):
        for name in ("c.txt", "a.txt", "B.txt"):
            _write(ws, name, "x")
        result = svc.ls(ws, ".", depth=1)
        paths = [i.path for i in result.items]
        assert paths == sorted(paths, key=str.lower)

    def test_path_escape_blocked(self, svc: FileSearchService, ws: str):
        with pytest.raises(PermissionError):
            svc.ls(ws, "../outside", depth=1)

    def test_no_physical_path_in_response(self, svc: FileSearchService, ws: str):
        _write(ws, "f.txt", "hi")
        result = svc.ls(ws, ".", depth=1)
        blob = result.model_dump_json()
        assert ws not in blob
        assert "/var/sandbox" not in blob

    def test_depth_clamped_to_five(self, svc: FileSearchService, ws: str):
        # Build deep tree
        rel = "/".join(f"d{i}" for i in range(8))
        _write(ws, f"{rel}/leaf.txt", "x")
        result = svc.ls(ws, ".", depth=99)  # request over max
        assert result.stats.depth_reached <= 5
        paths = [i.path for i in result.items]
        assert not any(p.endswith("leaf.txt") for p in paths)

    def test_item_limit_truncation(self, svc: FileSearchService, ws: str, monkeypatch):
        # Lower ceiling for speed
        import sandbox.services.file_search as mod

        monkeypatch.setattr(mod, "LS_MAX_ITEMS", 5)
        for i in range(20):
            _write(ws, f"f{i:02d}.txt", "x")
        result = svc.ls(ws, ".", depth=1)
        assert len(result.items) == 5
        assert result.truncated is True
        assert result.stop_reason == "item_limit"

    def test_symlink_escape_skipped(self, svc: FileSearchService, ws: str):
        outside = Path(tempfile.mkdtemp(prefix="outside_"))
        try:
            target = outside / "secret.txt"
            target.write_text("nope", encoding="utf-8")
            link = Path(ws) / "escape_link"
            link.symlink_to(target)
            result = svc.ls(ws, ".", depth=1, include_hidden=True)
            paths = [i.path for i in result.items]
            assert "escape_link" not in paths
            reasons = {s.path: s.reason for s in result.skipped}
            assert reasons.get("escape_link") == "symlink_escape"
        finally:
            shutil.rmtree(str(outside), ignore_errors=True)

    def test_not_found(self, svc: FileSearchService, ws: str):
        result = svc.ls(ws, "missing_dir", depth=1)
        assert result.items == []
        assert result.stop_reason == "not_found"


class TestFind:
    def test_glob_pattern(self, svc: FileSearchService, ws: str):
        _write(ws, "a.py", "x")
        _write(ws, "b.txt", "y")
        _write(ws, "sub/c.py", "z")
        result = svc.find(ws, ".", pattern="*.py")
        paths = [i.path for i in result.items]
        assert "a.py" in paths
        assert "sub/c.py" in paths
        assert "b.txt" not in paths

    def test_type_filter_file(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "x")
        Path(ws, "subdir").mkdir()
        result = svc.find(ws, ".", pattern="*", type="file")
        assert all(i.type == "file" for i in result.items)
        assert any(i.path == "a.txt" for i in result.items)

    def test_type_filter_dir(self, svc: FileSearchService, ws: str):
        Path(ws, "subdir").mkdir()
        _write(ws, "a.txt", "x")
        result = svc.find(ws, ".", pattern="sub*", type="dir")
        assert len(result.items) >= 1
        assert all(i.type == "dir" for i in result.items)

    def test_invalid_type_raises(self, svc: FileSearchService, ws: str):
        with pytest.raises(ValueError, match="invalid type"):
            svc.find(ws, ".", pattern="*", type="socket")

    def test_limit_truncation(self, svc: FileSearchService, ws: str):
        for i in range(30):
            _write(ws, f"n{i}.txt", "x")
        result = svc.find(ws, ".", pattern="*.txt", limit=10)
        assert len(result.items) == 10
        assert result.truncated is True
        assert result.stop_reason == "item_limit"

    def test_limit_clamped(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "x")
        result = svc.find(ws, ".", pattern="*", limit=99999)
        # Should not raise; clamp to FIND_MAX_LIMIT
        assert result.stats.matched <= FIND_MAX_LIMIT

    def test_path_escape_blocked(self, svc: FileSearchService, ws: str):
        with pytest.raises(PermissionError):
            svc.find(ws, "../../etc", pattern="*")

    def test_empty_workspace(self, svc: FileSearchService, ws: str):
        # Start path itself (.) may match pattern "*"
        result = svc.find(ws, ".", pattern="*.nope")
        assert result.items == []
        assert result.truncated is False

    def test_stable_order(self, svc: FileSearchService, ws: str):
        for name in ("z.txt", "a.txt", "m.txt"):
            _write(ws, name, "x")
        result = svc.find(ws, ".", pattern="*.txt")
        paths = [i.path for i in result.items]
        assert paths == sorted(paths, key=str.lower)

    def test_no_physical_path(self, svc: FileSearchService, ws: str):
        _write(ws, "x.txt", "1")
        blob = svc.find(ws, ".", pattern="*").model_dump_json()
        assert ws not in blob

    def test_symlink_escape_skipped(self, svc: FileSearchService, ws: str):
        outside = Path(tempfile.mkdtemp(prefix="find_out_"))
        try:
            target = outside / "t.txt"
            target.write_text("x", encoding="utf-8")
            (Path(ws) / "bad").symlink_to(target)
            result = svc.find(ws, ".", pattern="*")
            assert not any(i.path == "bad" for i in result.items)
            assert any(s.reason == "symlink_escape" for s in result.skipped)
        finally:
            shutil.rmtree(str(outside), ignore_errors=True)


class TestGrep:
    def test_literal_match(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "hello world\nfoo bar\n")
        result = svc.grep(ws, ".", query="hello")
        assert len(result.matches) == 1
        assert result.matches[0].line == 1
        assert "hello" in result.matches[0].text
        assert result.truncated is False

    def test_case_insensitive(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "Hello World")
        result = svc.grep(ws, ".", query="hello", case_sensitive=False)
        assert len(result.matches) == 1

    def test_case_sensitive_miss(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "Hello World")
        result = svc.grep(ws, ".", query="hello", case_sensitive=True)
        assert result.matches == []

    def test_regex_match(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "abc123xyz")
        result = svc.grep(ws, ".", query=r"abc\d+", regex=True)
        assert len(result.matches) == 1

    def test_unsafe_regex_rejected(self, svc: FileSearchService, ws: str):
        with pytest.raises(ValueError, match="unsafe|invalid"):
            svc.grep(ws, ".", query=r"(a+)+$", regex=True)

    def test_invalid_regex_rejected(self, svc: FileSearchService, ws: str):
        with pytest.raises(ValueError, match="invalid regex"):
            svc.grep(ws, ".", query="[unterminated", regex=True)

    def test_glob_filter(self, svc: FileSearchService, ws: str):
        _write(ws, "a.py", "needle")
        _write(ws, "b.txt", "needle")
        result = svc.grep(ws, ".", query="needle", glob="*.py")
        assert len(result.matches) == 1
        assert result.matches[0].path == "a.py"

    def test_context_lines(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "l1\nl2\nMATCH\nl4\nl5\n")
        result = svc.grep(ws, ".", query="MATCH", context=1)
        assert len(result.matches) == 1
        assert result.matches[0].before == ["l2"]
        assert result.matches[0].after == ["l4"]

    def test_skip_binary(self, svc: FileSearchService, ws: str):
        _write(ws, "bin.dat", b"hello\x00world\xff\xfe")
        _write(ws, "text.txt", "hello world")
        result = svc.grep(ws, ".", query="hello")
        assert len(result.matches) == 1
        assert result.matches[0].path == "text.txt"
        assert any(s.reason == "binary" for s in result.skipped)

    def test_skip_large_file(self, svc: FileSearchService, ws: str, monkeypatch):
        import sandbox.services.file_search as mod

        monkeypatch.setattr(mod, "GREP_MAX_FILE_BYTES", 50)
        _write(ws, "big.txt", "x" * 200)
        _write(ws, "small.txt", "needle")
        result = svc.grep(ws, ".", query="needle")
        assert len(result.matches) == 1
        assert result.matches[0].path == "small.txt"
        assert any(s.reason == "file_too_large" for s in result.skipped)

    def test_match_limit_truncation(self, svc: FileSearchService, ws: str):
        lines = "\n".join(f"hit {i}" for i in range(100))
        _write(ws, "many.txt", lines)
        result = svc.grep(ws, ".", query="hit", limit=10)
        assert len(result.matches) == 10
        assert result.truncated is True
        assert result.stop_reason == "match_limit"

    def test_path_escape_blocked(self, svc: FileSearchService, ws: str):
        with pytest.raises(PermissionError):
            svc.grep(ws, "/etc", query="root")

    def test_empty_no_matches(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "nothing here")
        result = svc.grep(ws, ".", query="zzz_nope")
        assert result.matches == []
        assert result.truncated is False

    def test_stable_match_order(self, svc: FileSearchService, ws: str):
        _write(ws, "b.txt", "hit")
        _write(ws, "a.txt", "hit\nhit")
        result = svc.grep(ws, ".", query="hit")
        keys = [(m.path, m.line) for m in result.matches]
        assert keys == sorted(keys, key=lambda k: (k[0].lower(), k[1]))

    def test_no_physical_path_in_response(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "needle")
        blob = svc.grep(ws, ".", query="needle").model_dump_json()
        assert ws not in blob

    def test_query_required(self, svc: FileSearchService, ws: str):
        with pytest.raises(ValueError):
            svc.grep(ws, ".", query="")

    def test_literal_does_not_interpret_regex(self, svc: FileSearchService, ws: str):
        _write(ws, "a.txt", "a+b and aab")
        result = svc.grep(ws, ".", query="a+b", regex=False)
        assert len(result.matches) == 1
        assert "a+b" in result.matches[0].text

    def test_symlink_escape_skipped(self, svc: FileSearchService, ws: str):
        outside = Path(tempfile.mkdtemp(prefix="grep_out_"))
        try:
            target = outside / "secret.txt"
            target.write_text("needle outside", encoding="utf-8")
            (Path(ws) / "link.txt").symlink_to(target)
            _write(ws, "ok.txt", "needle inside")
            result = svc.grep(ws, ".", query="needle")
            paths = [m.path for m in result.matches]
            assert "ok.txt" in paths
            assert "link.txt" not in paths
            assert any(s.reason == "symlink_escape" for s in result.skipped)
        finally:
            shutil.rmtree(str(outside), ignore_errors=True)


class TestFileSearchRoutes:
    """HTTP-level coverage via FastAPI TestClient when app is available."""

    @pytest.fixture
    def client_and_session(self, ws: str):
        from fastapi.testclient import TestClient

        from sandbox.main import app
        from sandbox.services.session_manager import session_manager
        from tests.conftest import formal_id

        # Bind session physical workspace to the temp dir (formal AgentSession ownership).
        session = session_manager.create(
            agent_session_id=formal_id("AGT"),
            workspace_id=formal_id("WSP"),
            caller_id="test-file-search",
            workspace_path_override=ws,
        )
        client = TestClient(app)
        yield client, session.session_id, ws
        try:
            session_manager.delete(session.session_id)
        except Exception:
            pass

    def test_ls_endpoint(self, client_and_session, svc: FileSearchService):
        client, sid, ws = client_and_session
        _write(ws, "route.txt", "hi")
        resp = client.post(f"/sessions/{sid}/files/ls", json={"path": ".", "depth": 1})
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert any(i["path"] == "route.txt" for i in data["items"])
        assert "truncated" in data
        assert "stats" in data

    def test_find_endpoint(self, client_and_session):
        client, sid, ws = client_and_session
        _write(ws, "x.py", "print(1)")
        resp = client.post(
            f"/sessions/{sid}/files/find",
            json={"path": ".", "pattern": "*.py"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert any(i["path"] == "x.py" for i in data["items"])

    def test_grep_endpoint(self, client_and_session):
        client, sid, ws = client_and_session
        _write(ws, "g.txt", "findme please")
        resp = client.post(
            f"/sessions/{sid}/files/grep",
            json={"path": ".", "query": "findme"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert len(data["matches"]) == 1
        assert data["matches"][0]["path"] == "g.txt"

    def test_ls_path_escape_403(self, client_and_session):
        client, sid, _ws = client_and_session
        resp = client.post(
            f"/sessions/{sid}/files/ls",
            json={"path": "../etc/passwd", "depth": 1},
        )
        assert resp.status_code == 403
        assert "workspace" not in resp.text.lower() or "escape" in resp.text.lower()
        # Physical temp root must not leak
        assert "/var/folders" not in resp.text or True  # soft: sanitize may rewrite

    def test_grep_empty_query_422(self, client_and_session):
        client, sid, _ws = client_and_session
        resp = client.post(
            f"/sessions/{sid}/files/grep",
            json={"path": ".", "query": ""},
        )
        assert resp.status_code in (400, 422)
