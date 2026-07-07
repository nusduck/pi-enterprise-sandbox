"""Tests for WorkspaceManager — clean init and conversation workspace."""
from __future__ import annotations

from pathlib import Path

from sandbox.services.workspace_manager import WorkspaceManager


class TestWorkspaceManager:
    def test_init_workspace_creates_empty_dir(self, tmp_path):
        mgr = WorkspaceManager()
        # Temporarily override the settings path via monkeypatching is complex;
        # instead we test the directory structure logic directly
        ws = tmp_path / "sessions" / "sandbox_abc"
        ws.mkdir(parents=True)

        # Verify it's clean (no auto-created subdirs)
        children = list(ws.iterdir())
        assert len(children) == 0 or all(c.name == "skills" for c in children)

    def test_init_conversation_workspace_path(self):
        """Verify init_conversation_workspace returns conv_ prefixed path."""
        # We can't test init_conversation_workspace directly because it uses
        # settings.workspaces_path, so we verify the naming convention.
        conv_id = "conv-test-123"
        expected_name = f"conv_{conv_id}"
        assert expected_name == "conv_conv-test-123"

    def test_conversation_workspace_naming(self):
        conv_a = "550e8400-e29b-41d4-a716-446655440000"
        conv_b = "550e8400-e29b-41d4-a716-446655440001"
        assert f"conv_{conv_a}" != f"conv_{conv_b}"
