"""Tests for Python agent module scaffold."""

from __future__ import annotations

from sandbox.agent.message_manager import MessageManager
from sandbox.agent.skill_manager import SkillManager
from sandbox.agent.tool_registry import ToolRegistry


def test_message_manager_to_agent_history_excludes_last():
    mm = MessageManager(max_messages=10)
    msgs = [
        {"role": "user", "content": "color is teal"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "what color?"},
    ]
    hist = mm.to_agent_history(msgs, exclude_last=True)
    assert len(hist) == 2
    assert hist[0]["content"] == "color is teal"
    assert hist[1]["role"] == "assistant"


def test_message_manager_extract_parts():
    mm = MessageManager()
    text = mm.extract_text({
        "role": "user",
        "content": [{"type": "text", "text": "hello"}, {"type": "text", "text": "world"}],
    })
    assert text == "hello\nworld"


def test_tool_registry_defaults_include_submit_artifact():
    reg = ToolRegistry()
    reg.register_defaults()
    names = reg.list_names()
    assert "submit_artifact" in names
    assert "read" in names
    assert "write" in names


def test_skill_manager_lists_builtin_skills():
    sm = SkillManager()
    skills = sm.list_skills()
    names = {s["name"] for s in skills}
    # repo skills/ is mounted or present depending on env; tolerate empty in CI host
    assert isinstance(skills, list)
    prompt = sm.to_prompt()
    assert isinstance(prompt, str)
    if "document-parser" in names:
        assert "document-parser" in prompt or "Skill:" in prompt
