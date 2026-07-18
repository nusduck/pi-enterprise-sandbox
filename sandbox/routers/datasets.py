"""Dataset API — streaming upload into session workspace (PR-09 / plan §17).

Never buffers the full body in memory. Logical path:
  datasets/{dataset_id}/{safe_filename}
"""

from __future__ import annotations

from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile

from sandbox.models import DatasetListResponse, DatasetResponse
from sandbox.security.ownership import require_owned_session, resolve_actor
from sandbox.services.dataset_manager import DatasetError, dataset_manager
from sandbox.services.execution_context import SandboxExecutionContext

router = APIRouter(prefix="/sessions/{session_id}/datasets", tags=["datasets"])

_CHUNK_SIZE = 64 * 1024


def _require_session(session_id: str, request: Request | None = None):
    return require_owned_session(session_id, request)


def _session_context(
    session_id: str, request: Request | None = None
) -> SandboxExecutionContext:
    session = _require_session(session_id, request)
    return SandboxExecutionContext.from_session(session)


def _ownership_from_request(
    session,
    request: Request,
    *,
    org_id: str | None = None,
    user_id: str | None = None,
    conversation_id: str | None = None,
) -> tuple[str, str, str, str]:
    """Resolve org/user/conversation/agent_session for formal dataset row.

    Tenant principals come from authenticated actor or session owner only.
    Client ``X-Org-Id`` / ``X-User-Id`` cannot stamp formal rows under
    another tenant. Optional header args are ignored for org/user (kept for
    call-site compatibility).
    """
    del org_id, user_id  # never trust client-supplied tenant principals
    from sandbox.security.ownership import (
        session_organization_id,
        session_owner_user_id,
    )

    meta = getattr(session, "metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}
    actor = resolve_actor(request) if request is not None else None

    org = (
        (actor.organization_id if actor else "")
        or (session_organization_id(session) or "")
        or str(meta.get("org_id") or meta.get("organization_id") or "")
    ).strip()
    uid = (
        (actor.user_id if actor else "")
        or (session_owner_user_id(session) or "")
        or str(meta.get("user_id") or "")
    ).strip()
    # Conversation + agent_session: authoritative session binding only.
    # Client conversation_id header/body must not re-bind formal datasets.
    del conversation_id  # ignore client-supplied conversation principal
    conv = str(meta.get("conversation_id") or "").strip()
    agent_sess = str(
        getattr(session, "agent_session_id", None) or meta.get("agent_session_id") or ""
    ).strip()

    if not (org and uid and conv and agent_sess):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "dataset_ownership_required",
                "message": (
                    "org_id, user_id, conversation_id, and agent_session_id "
                    "are required (session binding / authenticated actor)"
                ),
            },
        )
    return org, uid, conv, agent_sess


def _entry_to_response(entry) -> DatasetResponse:
    pub = entry.to_public()
    return DatasetResponse(**pub)


def _dataset_http_error(exc: DatasetError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.as_detail())


@router.get("", response_model=DatasetListResponse)
def list_datasets(session_id: str, request: Request, ready_only: bool = False):
    session = _require_session(session_id, request)
    actor = resolve_actor(request)
    org = actor.organization_id if actor else None
    uid = actor.user_id if actor else getattr(session, "user_id", None)
    rows = dataset_manager.list_for_session(
        session_id,
        org_id=org,
        user_id=uid,
        ready_only=ready_only,
    )
    datasets = [_entry_to_response(e) for e in rows]
    return DatasetListResponse(datasets=datasets, total=len(datasets))


@router.get("/{dataset_id}", response_model=DatasetResponse)
def get_dataset(session_id: str, dataset_id: str, request: Request):
    session = _require_session(session_id, request)
    actor = resolve_actor(request)
    org = actor.organization_id if actor else None
    uid = actor.user_id if actor else getattr(session, "user_id", None)
    entry = dataset_manager.get(
        dataset_id,
        org_id=org,
        user_id=uid,
        sandbox_session_id=session_id,
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return _entry_to_response(entry)


@router.post("", status_code=201, response_model=DatasetResponse)
async def upload_dataset(
    session_id: str,
    request: Request,
    file: UploadFile = File(...),
    org_id: str | None = Header(default=None, alias="X-Org-Id"),
    user_id: str | None = Header(default=None, alias="X-User-Id"),
    conversation_id: str | None = Header(default=None, alias="X-Conversation-Id"),
    content_length: str | None = Header(default=None, alias="Content-Length"),
):
    """Stream multipart file into ``datasets/{id}/{safe_name}``.

    - No full-body heap buffer (64 KiB chunks)
    - UPLOADING temp → atomic READY
    - Incremental SHA-256 + size
    - Concurrent quota reservation (no TOCTOU oversell)
    - Disconnect / error aborts temp + incomplete metadata (never READY)
    """
    session = _require_session(session_id, request)
    context = SandboxExecutionContext.from_session(session)
    org, uid, conv, agent_sess = _ownership_from_request(
        session,
        request,
        org_id=org_id,
        user_id=user_id,
        conversation_id=conversation_id,
    )

    filename = file.filename or "dataset"
    declared: int | None = None
    if content_length:
        try:
            declared = int(content_length)
        except ValueError:
            declared = None

    entry = None
    try:
        entry = dataset_manager.begin_upload(
            workspace_path=str(context.physical_workspace),
            workspace_key=context.workspace_id or session_id,
            sandbox_session_id=session_id,
            org_id=org,
            user_id=uid,
            conversation_id=conv,
            agent_session_id=agent_sess,
            original_filename=filename,
            mime_type=file.content_type,
            declared_size=declared,
        )
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            dataset_manager.write_chunk(entry.dataset_id, chunk)
        finished = dataset_manager.finish_upload(entry.dataset_id)
        return _entry_to_response(finished)
    except DatasetError as exc:
        if entry is not None:
            dataset_manager.abort_upload(entry.dataset_id, reason=exc.code)
        raise _dataset_http_error(exc) from exc
    except HTTPException:
        if entry is not None:
            dataset_manager.abort_upload(entry.dataset_id, reason="http_error")
        raise
    except Exception:
        if entry is not None:
            dataset_manager.abort_upload(entry.dataset_id, reason="internal_error")
        raise
    finally:
        try:
            await file.close()
        except Exception:
            pass


@router.post("/{dataset_id}/abort", status_code=204)
def abort_dataset(session_id: str, dataset_id: str, request: Request):
    """Cancel an in-flight upload; cleans temp and incomplete metadata."""
    from fastapi.responses import Response

    _require_session(session_id, request)
    entry = dataset_manager.get(dataset_id, sandbox_session_id=session_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    dataset_manager.abort_upload(dataset_id, reason="client_abort")
    return Response(status_code=204)
