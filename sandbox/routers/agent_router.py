"""Optional Python agent chat endpoint (SSE) — P5 cutover path.

Enable via calling POST /agent/chat. Does not replace Node api-server by default.
"""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from sandbox.agent.agent_runtime import AgentRuntime
from sandbox.agent.message_manager import MessageManager

router = APIRouter(prefix="/agent", tags=["agent"])


class AgentChatBody(BaseModel):
    messages: list[dict] = Field(default_factory=list)
    conversation_id: str | None = None
    sandbox_session_id: str | None = None
    workspace_path: str | None = None


@router.post("/chat")
async def agent_chat(body: AgentChatBody, request: Request):
    """SSE stream compatible with frontend event types."""
    runtime = AgentRuntime(
        model_id=os.environ.get("MODEL_ID"),
        sandbox_base_url=os.environ.get("SANDBOX_INTERNAL_URL", "http://127.0.0.1:8081"),
        api_token=os.environ.get("SANDBOX_API_TOKEN", ""),
        llm_base_url=os.environ.get("LLMIO_BASE_URL", ""),
        llm_api_key=os.environ.get("LLMIO_API_KEY", ""),
    )

    mm = MessageManager()
    last = body.messages[-1] if body.messages else {}
    user_text = mm.extract_text(last).strip() if last else ""
    prior = body.messages[:-1] if body.messages else []

    async def event_stream():
        try:
            await runtime.create_session(
                conversation_id=body.conversation_id,
                sandbox_session_id=body.sandbox_session_id,
                workspace_path_override=body.workspace_path,
            )
            if prior:
                await runtime.restore_messages(prior + [last] if last else prior)
            if not user_text:
                yield f"data: {json.dumps({'type': 'error', 'message': 'empty message'})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return
            # restore_messages with exclude last then prompt user_text
            await runtime.restore_messages(body.messages)
            # remove last from transcript so prompt adds it once
            if runtime._messages and runtime._messages[-1].get("role") == "user":
                runtime._messages.pop()
            async for ev in runtime.stream_prompt(user_text):
                if await request.is_disconnected():
                    break
                yield f"data: {json.dumps(ev, default=str)}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
