"""Python-first agent module (P5).

Provides a working OpenAI-tools agent loop against the sandbox REST API
(`AgentRuntime`) plus skill/message/tool helpers. Production browser chat
still defaults to Node api-server; optional SSE path: POST /agent/chat.
"""

from __future__ import annotations

from sandbox.agent.agent_runtime import AgentRuntime, AgentTurnResult
from sandbox.agent.message_manager import MessageManager
from sandbox.agent.skill_manager import SkillManager
from sandbox.agent.tool_registry import ToolRegistry
from sandbox.agent.mcp_manager import MCPManager

__all__ = [
    "AgentRuntime",
    "AgentTurnResult",
    "MessageManager",
    "SkillManager",
    "ToolRegistry",
    "MCPManager",
]
