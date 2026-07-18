"""Tests for SessionManager — AgentSession 1:1 Workspace ownership (PR-07A)."""

from __future__ import annotations

import pytest

from sandbox.models import SessionStatus
from sandbox.services.session_manager import (
    SessionManager,
    WorkspaceBindingConflict,
    WorkspaceBindingRequired,
    public_session_response,
)

# Crockford Base32 ULIDs (formal CHAR(26) ids).
AGENT_A = "01JTESTAGENT0000000000000A"  # 26
AGENT_B = "01JTESTAGENT0000000000000B"
WSP_A = "01JTESTWRKSP0000000000000A"
WSP_B = "01JTESTWRKSP0000000000000B"
SBX_A = "01JTESTSANDBX000000000000A"


class TestSessionManager:
    @pytest.fixture
    def mgr(self):
        return SessionManager()

    def test_create_requires_agent_and_workspace(self, mgr: SessionManager):
        with pytest.raises(WorkspaceBindingRequired):
            mgr.create(caller_id="test-agent")
        with pytest.raises(WorkspaceBindingRequired):
            mgr.create(agent_session_id=AGENT_A, caller_id="x")
        with pytest.raises(WorkspaceBindingRequired):
            mgr.create(workspace_id=WSP_A, caller_id="x")

    def test_create_session(self, mgr: SessionManager):
        session = mgr.create(
            agent_session_id=AGENT_A,
            workspace_id=WSP_A,
            caller_id="test-agent",
        )
        assert session.session_id.startswith("sandbox_")
        assert session.status == SessionStatus.RUNNING
        assert session.caller_id == "test-agent"
        assert session.agent_session_id == AGENT_A
        assert session.workspace_id == WSP_A

    def test_create_with_metadata(self, mgr: SessionManager):
        session = mgr.create(
            agent_session_id=AGENT_A,
            workspace_id=WSP_A,
            user_id="u001",
            caller_id="pi-agent",
            metadata={"env": "staging"},
        )
        assert session.agent_session_id == AGENT_A
        assert session.user_id == "u001"
        assert session.metadata["env"] == "staging"
        assert "_physical_workspace" in session.metadata  # internal only
        assert session.metadata["workspace_id"] == WSP_A

    def test_public_session_strips_physical(self, mgr: SessionManager):
        session = mgr.create(
            agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="pub"
        )
        public = public_session_response(session)
        assert "_physical_workspace" not in public.metadata
        assert public.workspace_id == WSP_A

    def test_get_existing(self, mgr: SessionManager):
        created = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        fetched = mgr.get(created.session_id)
        assert fetched is not None
        assert fetched.session_id == created.session_id

    def test_get_nonexistent(self, mgr: SessionManager):
        assert mgr.get("nonexistent") is None

    def test_delete(self, mgr: SessionManager):
        session = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        assert mgr.delete(session.session_id) is True
        assert mgr.get(session.session_id) is None

    def test_delete_nonexistent(self, mgr: SessionManager):
        assert mgr.delete("nonexistent") is False

    def test_update_status(self, mgr: SessionManager):
        session = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        updated = mgr.update_status(session.session_id, SessionStatus.COMPLETED)
        assert updated is not None
        assert updated.status == SessionStatus.COMPLETED

    def test_list_active(self, mgr: SessionManager):
        mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        mgr.create(agent_session_id=AGENT_B, workspace_id=WSP_B)
        active = mgr.list_active()
        assert len(active) == 2

    def test_count_active(self, mgr: SessionManager):
        mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        assert mgr.count_active() == 1

    def test_workspace_id_from_binding(self, mgr: SessionManager):
        session = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        assert session.workspace_id == WSP_A
        assert session.workspace_id != session.session_id

    def test_multiple_sessions_have_unique_ids(self, mgr: SessionManager):
        s1 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        s2 = mgr.create(agent_session_id=AGENT_B, workspace_id=WSP_B)
        assert s1.session_id != s2.session_id

    def test_create_with_workspace_path_override_internal(self, mgr: SessionManager):
        override_path = "/custom/workspace/path"
        session = mgr.create(
            agent_session_id=AGENT_A,
            workspace_id=WSP_A,
            caller_id="test-override",
            workspace_path_override=override_path,
        )
        assert session.workspace_id == WSP_A
        assert session.metadata.get("_physical_workspace") == override_path

    def test_two_sessions_different_physical_metadata(self, mgr: SessionManager):
        s1 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        s2 = mgr.create(agent_session_id=AGENT_B, workspace_id=WSP_B)
        assert s1.metadata["_physical_workspace"] != s2.metadata["_physical_workspace"]

    def test_same_conversation_different_agent_sessions_different_workspaces(
        self, mgr: SessionManager
    ):
        """Same conversation_id must not force shared workspace."""
        conv = "shared-conversation-1"
        s1 = mgr.create(
            agent_session_id=AGENT_A,
            workspace_id=WSP_A,
            conversation_id=conv,
            caller_id="a",
        )
        s2 = mgr.create(
            agent_session_id=AGENT_B,
            workspace_id=WSP_B,
            conversation_id=conv,
            caller_id="b",
        )
        assert s1.workspace_id != s2.workspace_id
        assert s1.metadata["_physical_workspace"] != s2.metadata["_physical_workspace"]
        assert s1.metadata.get("conversation_id") == conv
        assert s2.metadata.get("conversation_id") == conv

    def test_same_agent_session_rebind_same_workspace(self, mgr: SessionManager):
        s1 = mgr.create(
            agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a"
        )
        # Multi-turn: create again with same binding reuses RUNNING session.
        s2 = mgr.create(
            agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a"
        )
        assert s2.session_id == s1.session_id
        assert s2.workspace_id == s1.workspace_id

        # After COMPLETED, rebind reactivates same session + workspace.
        mgr.update_status(s1.session_id, SessionStatus.COMPLETED)
        s3 = mgr.create(
            agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a"
        )
        assert s3.session_id == s1.session_id
        assert s3.workspace_id == WSP_A
        assert s3.status == SessionStatus.RUNNING

    def test_rebind_renews_ttl_running_and_terminal_memory(self, mgr: SessionManager):
        """RUNNING with past ttl / COMPLETED / EXPIRED rebind renews TTL (memory)."""
        from datetime import datetime, timedelta, timezone

        s1 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a")
        past = datetime.now(timezone.utc) - timedelta(hours=2)
        # Past TTL while still RUNNING — must not expire after rebind.
        mgr._sessions[s1.session_id]["ttl_until"] = past
        s2 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a")
        assert s2.session_id == s1.session_id
        assert s2.status == SessionStatus.RUNNING
        assert mgr._sessions[s1.session_id]["ttl_until"] > datetime.now(timezone.utc)
        assert mgr.cleanup_expired() == 0
        assert mgr.get(s1.session_id).status == SessionStatus.RUNNING

        mgr.update_status(s1.session_id, SessionStatus.COMPLETED)
        s3 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a")
        assert s3.status == SessionStatus.RUNNING
        assert mgr._sessions[s1.session_id]["ttl_until"] > datetime.now(timezone.utc)
        assert mgr.cleanup_expired() == 0

        mgr.update_status(s1.session_id, SessionStatus.EXPIRED)
        s4 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a")
        assert s4.status == SessionStatus.RUNNING
        assert mgr.cleanup_expired() == 0
        assert mgr.get(s1.session_id).status == SessionStatus.RUNNING

    def test_update_status_does_not_renew_ttl(self, mgr: SessionManager):
        from datetime import datetime, timedelta, timezone

        s1 = mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        past = datetime.now(timezone.utc) - timedelta(hours=1)
        mgr._sessions[s1.session_id]["ttl_until"] = past
        mgr.update_status(s1.session_id, SessionStatus.COMPLETED)
        # update_status must not extend TTL
        assert mgr._sessions[s1.session_id]["ttl_until"] == past

    def test_forged_workspace_mismatch_rejected(self, mgr: SessionManager):
        mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_A)
        with pytest.raises(WorkspaceBindingConflict):
            mgr.create(agent_session_id=AGENT_A, workspace_id=WSP_B)
        with pytest.raises(WorkspaceBindingConflict):
            mgr.create(agent_session_id=AGENT_B, workspace_id=WSP_A)

    def test_invalid_formal_ids_rejected(self, mgr: SessionManager):
        with pytest.raises(WorkspaceBindingRequired):
            mgr.create(agent_session_id="not-a-ulid", workspace_id=WSP_A)
        with pytest.raises(WorkspaceBindingRequired):
            mgr.create(agent_session_id=AGENT_A, workspace_id="../escape")

    def test_conversation_id_never_derives_workspace(self, mgr: SessionManager):
        s = mgr.create(
            agent_session_id=AGENT_A,
            workspace_id=WSP_A,
            conversation_id="any-conversation",
        )
        assert s.workspace_id == WSP_A
        assert "conv_any-conversation" not in (s.metadata.get("_physical_workspace") or "")
        assert s.metadata.get("workspace_id") == WSP_A

    def test_preallocated_sandbox_session_id(self, mgr: SessionManager):
        s = mgr.create(
            agent_session_id=AGENT_A,
            workspace_id=WSP_A,
            sandbox_session_id=SBX_A,
        )
        assert s.session_id == SBX_A
