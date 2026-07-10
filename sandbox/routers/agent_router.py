"""Optional Python agent chat endpoint (SSE) — P5 cutover path.

Enable production browser chat via api-server AGENT_RUNTIME=python
(Node BFF proxies POST /api/chat → this endpoint). Default remains Node.
"""

from __future__ import annotations

import json
import os

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from sandbox.agent.agent_runtime import AgentRuntime
from sandbox.agent.message_manager import MessageManager
from sandbox.services.execution_manager import execution_manager

router = APIRouter(prefix="/agent", tags=["agent"])


class AgentChatBody(BaseModel):
    messages: list[dict] = Field(default_factory=list)
    conversation_id: str | None = None
    sandbox_session_id: str | None = None
    workspace_path: str | None = None


def _inbound_trace_id(request: Request) -> str | None:
    return request.headers.get("x-trace-id") or request.headers.get("X-Trace-Id")


@router.post("/chat")
async def agent_chat(body: AgentChatBody, request: Request):
    """SSE stream compatible with frontend event types."""
    runtime = AgentRuntime(
        model_id=os.environ.get("MODEL_ID"),
        sandbox_base_url=os.environ.get(
            "SANDBOX_INTERNAL_URL",
            os.environ.get("SANDBOX_BASE_URL", "http://127.0.0.1:8081"),
        ),
        api_token=os.environ.get("SANDBOX_API_TOKEN", ""),
        llm_base_url=os.environ.get("LLMIO_BASE_URL", ""),
        llm_api_key=os.environ.get("LLMIO_API_KEY", ""),
    )

    mm = MessageManager()
    last = body.messages[-1] if body.messages else {}
    user_text = mm.extract_text(last).strip() if last else ""
    # Prior turns only — stream_prompt appends the latest user message once.
    prior = body.messages[:-1] if body.messages else []
    inbound_trace = _inbound_trace_id(request)

    async def event_stream():
        session_id = body.sandbox_session_id
        finished_cleanly = False
        assistant_parts: list[str] = []
        try:
            await runtime.create_session(
                conversation_id=body.conversation_id,
                sandbox_session_id=body.sandbox_session_id,
                workspace_path_override=body.workspace_path,
                trace_id=inbound_trace,
            )
            session_id = runtime._session_id or session_id

            if prior:
                await runtime.restore_messages(prior, exclude_last=False)

            if not user_text:
                yield f"data: {json.dumps({'type': 'error', 'message': 'empty message'})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                finished_cleanly = True
                return

            async for ev in runtime.stream_prompt(user_text):
                if await request.is_disconnected():
                    # Policy: interactive agent SSE owns in-flight sandbox work —
                    # cancel the active execution so session locks are not orphaned.
                    sid = getattr(runtime, "_session_id", None) or session_id
                    if sid:
                        try:
                            execution_manager.cancel_active(sid)
                        except Exception:
                            pass
                    break
                if ev.get("type") == "session" and ev.get("session_id"):
                    session_id = ev["session_id"]
                if ev.get("type") == "token" and ev.get("text"):
                    assistant_parts.append(str(ev["text"]))
                yield f"data: {json.dumps(ev, default=str)}\n\n"
            else:
                finished_cleanly = True
                # Persist client history + this assistant turn (Node parity)
                try:
                    await runtime.persist_turn_messages(
                        body.messages or [],
                        "".join(assistant_parts),
                    )
                except Exception:
                    pass
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            finished_cleanly = True
        finally:
            # Parity with Node handleChat: always close the SSE turn.
            sid = getattr(runtime, "_session_id", None) or session_id
            yield f"data: {json.dumps({'type': 'session_closed', 'session_id': sid})}\n\n"
            if not finished_cleanly and sid:
                try:
                    execution_manager.cancel_active(sid)
                except Exception:
                    pass

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
