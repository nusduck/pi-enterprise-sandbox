"""Tests for SessionManager."""

import pytest

from sandbox.models import SessionStatus
from sandbox.paths import conversation_workspace_id
from sandbox.services.session_manager import SessionManager, public_session_response
from sandbox.services.workspace_manager import WorkspaceWriteConflict, write_lease


class TestSessionManager:
    @pytest.fixture
    def mgr(self):
        write_lease.clear()
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
        assert "_physical_workspace" in session.metadata  # internal only
        assert "workspace_id" in session.metadata

    def test_public_session_strips_physical(self, mgr: SessionManager):
        session = mgr.create(caller_id="pub")
        public = public_session_response(session)
        assert "_physical_workspace" not in public.metadata
        assert public.workspace_id
        assert public.workspace_id == session.metadata["workspace_id"]

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

    def test_workspace_id_generated(self, mgr: SessionManager):
        session = mgr.create()
        assert session.workspace_id
        assert session.workspace_id == session.session_id  # private session workspace

    def test_multiple_sessions_have_unique_ids(self, mgr: SessionManager):
        s1 = mgr.create()
        s2 = mgr.create()
        assert s1.session_id != s2.session_id

    def test_create_with_workspace_path_override_internal(self, mgr: SessionManager):
        override_path = "/custom/workspace/path"
        session = mgr.create(
            caller_id="test-override",
            workspace_path_override=override_path,
        )
        assert session.workspace_id == "path"
        assert session.metadata.get("_physical_workspace") == override_path
        assert session.session_id.startswith("sandbox_")

    def test_create_without_override_generates_path(self, mgr: SessionManager):
        session = mgr.create()
        assert session.workspace_id == session.session_id
        physical = session.metadata.get("_physical_workspace", "")
        assert session.session_id in physical

    def test_two_sessions_different_physical_metadata(self, mgr: SessionManager):
        s1 = mgr.create()
        s2 = mgr.create()
        assert s1.metadata["_physical_workspace"] != s2.metadata["_physical_workspace"]

    def test_conversation_id_binds_shared_workspace(self, mgr: SessionManager):
        conv = "conv-bind-1"
        s1 = mgr.create(caller_id="a", conversation_id=conv)
        assert s1.metadata["workspace_id"] == conversation_workspace_id(conv)
        assert s1.workspace_id == conversation_workspace_id(conv)
        assert s1.metadata["conversation_id"] == conv
        assert conversation_workspace_id(conv) in s1.metadata["_physical_workspace"]
        # Complete first so second can claim write lease
        mgr.update_status(s1.session_id, SessionStatus.COMPLETED)
        s2 = mgr.create(caller_id="b", conversation_id=conv)
        assert s2.metadata["_physical_workspace"] == s1.metadata["_physical_workspace"]

    def test_write_lease_conflict_on_second_writer(self, mgr: SessionManager):
        conv = "lease-conflict-1"
        s1 = mgr.create(caller_id="a", conversation_id=conv)
        assert s1.status == SessionStatus.RUNNING
        with pytest.raises(WorkspaceWriteConflict):
            mgr.create(caller_id="b", conversation_id=conv)
