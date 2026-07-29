"""Push a finished export file into a Sandbox session as a Dataset.

Reuses the existing Sandbox Dataset upload endpoint
(`POST /sessions/{session_id}/datasets`, sandbox/routers/datasets.py) with
the same "service token + acting headers" trust pattern already used by
api-server's Sandbox client (api-server/src/services/sandbox-client.js).

biz-db-mcp is a trusted internal peer, not an end user: it must always set
both acting headers together from an identity it was given by its caller,
never from anything resembling client input (see the README's
"session identity" section for how that identity should reach this
service in a real deployment).
"""

from __future__ import annotations

import uuid
from pathlib import Path

import httpx

from .config import Settings


class SandboxPushError(RuntimeError):
    """Raised when pushing the exported file into Sandbox fails."""


def push_dataset(
    settings: Settings,
    *,
    session_id: str,
    acting_org_id: str,
    acting_user_id: str,
    dataset_name: str,
    file_path: Path,
    conversation_id: str | None = None,
) -> dict:
    url = f"{settings.sandbox_base_url.rstrip('/')}/sessions/{session_id}/datasets"
    headers = {
        settings.sandbox_api_token_header: settings.sandbox_api_token,
        "X-Acting-Organization-Id": acting_org_id,
        "X-Acting-User-Id": acting_user_id,
        # Required by upload_dataset() whenever the formal Dataset plane is
        # authoritative; a fresh key per export call is correct here since
        # each export produces a genuinely new file, not a retry of one.
        "Idempotency-Key": uuid.uuid4().hex,
    }
    if conversation_id:
        headers["X-Conversation-Id"] = conversation_id

    try:
        with file_path.open("rb") as fh:
            files = {"file": (f"{dataset_name}.parquet", fh, "application/octet-stream")}
            resp = httpx.post(url, headers=headers, files=files, timeout=120.0)
    finally:
        file_path.unlink(missing_ok=True)

    if resp.status_code >= 400:
        raise SandboxPushError(
            f"Sandbox dataset upload failed ({resp.status_code}): {resp.text[:500]}"
        )
    return resp.json()
