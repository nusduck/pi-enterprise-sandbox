"""Artifact API — explicit submit; control-plane snapshot download."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from sandbox.models import ArtifactListResponse, ArtifactRegister, ArtifactResponse
from sandbox.security.ownership import require_owned_session, resolve_actor
from sandbox.services.artifact_manager import (
    ArtifactError,
    artifact_content_disposition,
    artifact_manager,
    iter_snapshot_chunks,
)
from sandbox.services.control_plane_storage import FileIdentity
from sandbox.services.execution_context import SandboxExecutionContext

router = APIRouter(prefix="/sessions/{session_id}/artifacts", tags=["artifacts"])


def _require_session(session_id: str, request: Request | None = None):
    return require_owned_session(session_id, request)


def _artifact_http_error(exc: ArtifactError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.as_detail())


def _ownership_fields(session, request: Request, body: ArtifactRegister) -> dict:
    """Resolve formal ownership stamps from **trusted** session/actor only.

    Client body/header org_id/user_id/agent_session_id must NOT override the
    owned session. Spoofing those fields previously wrote formal MySQL rows
    and control-plane snapshots under another tenant's path.
    """
    from sandbox.security.ownership import (
        session_organization_id,
        session_owner_user_id,
    )

    meta = getattr(session, "metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}
    actor = resolve_actor(request) if request is not None else None
    # Prefer JWT/acting actor, then session owner — never client body/headers.
    org = (
        (actor.organization_id if actor else None)
        or session_organization_id(session)
        or str(meta.get("org_id") or meta.get("organization_id") or "")
        or None
    )
    uid = (
        (actor.user_id if actor else None)
        or session_owner_user_id(session)
        or str(meta.get("user_id") or "")
        or None
    )
    # Conversation / agent_session / run: session binding only.
    # Client body/header must not attach formal artifacts to another conversation
    # or run outside the authoritative session (cross-run formal pollution).
    conv = str(meta.get("conversation_id") or "").strip() or None
    agent_sess = (
        str(
            getattr(session, "agent_session_id", None)
            or meta.get("agent_session_id")
            or ""
        ).strip()
        or None
    )
    run_id = (
        str(meta.get("run_id") or meta.get("last_run_id") or "").strip() or None
    )
    if org is not None:
        org = str(org).strip() or None
    if uid is not None:
        uid = str(uid).strip() or None
    return {
        "org_id": org,
        "user_id": uid,
        "conversation_id": conv,
        "agent_session_id": agent_sess,
        "run_id": run_id,
    }


def _session_binding(session) -> dict:
    meta = getattr(session, "metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}
    return {
        "agent_session_id": getattr(session, "agent_session_id", None)
        or meta.get("agent_session_id"),
        "conversation_id": meta.get("conversation_id"),
        "workspace_id": getattr(session, "workspace_id", None)
        or meta.get("workspace_id"),
        "user_id": getattr(session, "user_id", None),
    }


@router.get("", response_model=ArtifactListResponse)
def list_artifacts(session_id: str, request: Request):
    session = _require_session(session_id, request)
    bind = _session_binding(session)
    actor = resolve_actor(request)
    from sandbox.security.ownership import (
        session_organization_id,
        session_owner_user_id,
    )

    # List under trusted actor/session owner only (no client X-Org-Id spoof).
    org = (
        (actor.organization_id if actor else None)
        or session_organization_id(session)
        or None
    )
    uid = (
        (actor.user_id if actor else None)
        or session_owner_user_id(session)
        or bind.get("user_id")
        or None
    )
    artifacts = artifact_manager.list_by_session(
        session_id,
        org_id=org,
        user_id=str(uid) if uid else None,
        agent_session_id=str(bind["agent_session_id"]) if bind.get("agent_session_id") else None,
        conversation_id=str(bind["conversation_id"]) if bind.get("conversation_id") else None,
    )
    return ArtifactListResponse(artifacts=artifacts, total=len(artifacts))


@router.post("/register", response_model=ArtifactResponse, status_code=201)
def register_artifact(session_id: str, body: ArtifactRegister, request: Request):
    session = _require_session(session_id, request)
    context = SandboxExecutionContext.from_session(session)
    own = _ownership_fields(session, request, body)
    bind = _session_binding(session)
    try:
        return artifact_manager.submit(
            session_id=session_id,
            path=body.path,
            name=body.name,
            mime_type=body.mime_type,
            source_execution_id=body.source_execution_id,
            physical_workspace=context.physical_workspace,
            physical_temp=context.physical_temp,
            expected_sha256=body.expected_sha256,
            workspace_id=str(bind.get("workspace_id") or context.workspace_id or ""),
            **own,
        )
    except ArtifactError as exc:
        raise _artifact_http_error(exc) from exc


@router.post("/submit", response_model=ArtifactResponse, status_code=201)
def submit_artifact(session_id: str, body: ArtifactRegister, request: Request):
    session = _require_session(session_id, request)
    context = SandboxExecutionContext.from_session(session)
    own = _ownership_fields(session, request, body)
    bind = _session_binding(session)
    try:
        return artifact_manager.submit(
            session_id=session_id,
            path=body.path,
            name=body.name,
            mime_type=body.mime_type,
            source_execution_id=body.source_execution_id,
            physical_workspace=context.physical_workspace,
            physical_temp=context.physical_temp,
            expected_sha256=body.expected_sha256,
            workspace_id=str(bind.get("workspace_id") or context.workspace_id or ""),
            **own,
        )
    except ArtifactError as exc:
        raise _artifact_http_error(exc) from exc


@router.get("/{artifact_id}/download")
async def download_artifact(session_id: str, artifact_id: str, request: Request):
    """Stream control-plane snapshot (not workspace). Chunks via thread pool."""
    session = _require_session(session_id, request)
    bind = _session_binding(session)
    actor = resolve_actor(request)
    from sandbox.security.ownership import (
        session_organization_id,
        session_owner_user_id,
    )

    # Download under trusted actor/session owner only (no client X-Org-Id spoof).
    org = (
        (actor.organization_id if actor else None)
        or session_organization_id(session)
        or None
    )
    uid = (
        (actor.user_id if actor else None)
        or session_owner_user_id(session)
        or bind.get("user_id")
        or None
    )

    # Pass owned-session bindings when present (strict formal recovery).
    # Offline/local sessions may lack conversation_id — manager allows
    # same-session live cache only in that unbound case (never cross-session).
    agent_sess = bind.get("agent_session_id")
    conv_id = bind.get("conversation_id")

    try:
        art, snap_path, identity = await asyncio.to_thread(
            artifact_manager.resolve_download,
            session_id=session_id,
            artifact_id=artifact_id,
            org_id=org,
            user_id=str(uid) if uid else None,
            agent_session_id=str(agent_sess) if agent_sess else None,
            conversation_id=str(conv_id) if conv_id else None,
        )
    except ArtifactError as exc:
        raise _artifact_http_error(exc) from exc

    disposition = artifact_content_disposition(art.name)
    media = art.mime_type or "application/octet-stream"
    if media.lower() in {"text/html", "application/xhtml+xml", "image/svg+xml"}:
        media = "application/octet-stream"

    async def _agen():
        # Sync iterator in thread-sized chunks so event loop stays free
        it = iter_snapshot_chunks(snap_path, expected=identity)

        def _next():
            try:
                return next(it)
            except StopIteration:
                return None

        while True:
            chunk = await asyncio.to_thread(_next)
            if chunk is None:
                break
            yield chunk

    headers = {
        "Content-Disposition": disposition,
        "X-Content-Type-Options": "nosniff",
        "Content-Length": str(identity.st_size),
    }
    if art.sha256:
        headers["X-Artifact-Sha256"] = art.sha256

    return StreamingResponse(_agen(), media_type=media, headers=headers)
