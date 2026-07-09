"""Message persistence helpers for agent multi-turn context."""

from __future__ import annotations

from typing import Any


class MessageManager:
    """Normalize and window conversation messages for agent restore."""

    def __init__(self, max_messages: int = 40) -> None:
        self.max_messages = max_messages

    def extract_text(self, msg: dict[str, Any]) -> str:
        content = msg.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for p in content:
                if isinstance(p, str):
                    parts.append(p)
                elif isinstance(p, dict):
                    if p.get("type") == "text" and p.get("text"):
                        parts.append(str(p["text"]))
                    elif p.get("text"):
                        parts.append(str(p["text"]))
            return "\n".join(parts)
        return ""

    def to_persistable(self, messages: list[dict[str, Any]]) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for m in messages:
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            text = self.extract_text(m).strip()
            if not text:
                continue
            out.append({"role": role, "content": text})
        return out[-100:]

    def to_agent_history(
        self, messages: list[dict[str, Any]], *, exclude_last: bool = True
    ) -> list[dict[str, Any]]:
        """Return text-only history for restore (mirrors api-server contract)."""
        src = messages[:-1] if exclude_last and messages else list(messages)
        out: list[dict[str, Any]] = []
        for m in src:
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            text = self.extract_text(m).strip()
            if not text:
                continue
            out.append({"role": role, "content": text})
        if len(out) > self.max_messages:
            return out[-self.max_messages :]
        return out
