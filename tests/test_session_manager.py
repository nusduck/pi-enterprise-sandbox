"""Tests for SessionManager."""

import pytest
from sandbox.models import SessionStatus
from sandbox.services.session_manager import SessionManager


class TestSessionManager:
    @pytest.fixture
    def mgr(self):
        return SessionManager()

    def test_create_session(self, mgr: SessionManager):
        session = mgr.create(caller_id="test-agent")
        assert session.session_id.startswith("sandbox_")
        assert session.status == SessionStatus.RUNNING
        assert session.caller_id == "test-agent"

    def test_create_with_metadata(self, mgr: SessionManager):
        session = mgr.create(
            agent_session_id="pi_abc123",
            user_id="u001",
            caller_id="pi-agent",
            metadata={"env": "staging"},
        )
        assert session.agent_session_id == "pi_abc123"
        assert session.user_id == "u001"
        assert session.metadata["env"] == "staging"
        assert "_physical_workspace" in session.metadata

    def test_get_existing(self, mgr: SessionManager):
        created = mgr.create()
        fetched = mgr.get(created.session_id)
        assert fetched is not None
        assert fetched.session_id == created.session_id

    def test_get_nonexistent(self, mgr: SessionManager):
        assert mgr.get("nonexistent") is None

    def test_delete(self, mgr: SessionManager):
        session = mgr.create()
        assert mgr.delete(session.session_id) is True
        assert mgr.get(session.session_id) is None

    def test_delete_nonexistent(self, mgr: SessionManager):
        assert mgr.delete("nonexistent") is False

    def test_update_status(self, mgr: SessionManager):
        session = mgr.create()
        updated = mgr.update_status(session.session_id, SessionStatus.COMPLETED)
        assert updated is not None
        assert updated.status == SessionStatus.COMPLETED

    def test_list_active(self, mgr: SessionManager):
        mgr.create()
        mgr.create()
        active = mgr.list_active()
        assert len(active) == 2

    def test_count_active(self, mgr: SessionManager):
        mgr.create()
        assert mgr.count_active() == 1

    def test_workspace_path_generated(self, mgr: SessionManager):
        session = mgr.create()
        # Always exposed as /sandbox/workspace (the unified symlink path)
        assert session.workspace_path == "/sandbox/workspace"

    def test_multiple_sessions_have_unique_ids(self, mgr: SessionManager):
        s1 = mgr.create()
        s2 = mgr.create()
        assert s1.session_id != s2.session_id

    def test_create_with_workspace_path_override(self, mgr: SessionManager):
        override_path = "/custom/workspace/path"
        session = mgr.create(
            caller_id="test-override",
            workspace_path_override=override_path,
        )
        # Unified path /sandbox/workspace is exposed; physical path stored in metadata
        assert session.workspace_path == "/sandbox/workspace"
        assert session.metadata.get("_physical_workspace") == override_path
        assert session.session_id.startswith("sandbox_")

    def test_create_without_override_generates_path(self, mgr: SessionManager):
        session = mgr.create()
        assert session.workspace_path == "/sandbox/workspace"
