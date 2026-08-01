from __future__ import annotations

import hashlib
from types import SimpleNamespace

from sandbox.routers import datasets as dataset_routes


def test_dataset_content_resolves_registered_id_not_browser_path(
    monkeypatch,
    tmp_path,
) -> None:
    payload = b"\x89PNG\r\n\x1a\n"
    relative_path = "datasets/dataset-1/image.png"
    target = tmp_path / relative_path
    target.parent.mkdir(parents=True)
    target.write_bytes(payload)
    digest = hashlib.sha256(payload).hexdigest()
    session = SimpleNamespace(
        session_id="session-1",
        user_id="user-1",
        org_id="org-1",
        metadata={
            "workspace_id": "workspace-1",
            "_physical_workspace": str(tmp_path),
            "_physical_temp": str(tmp_path / "temp"),
        },
    )
    entry = SimpleNamespace(
        status="ready",
        stored_relative_path=relative_path,
        original_filename="image.png",
        mime_type="image/png",
        sha256=digest,
    )
    monkeypatch.setattr(dataset_routes, "_require_session", lambda *_: session)
    monkeypatch.setattr(
        dataset_routes,
        "_ownership_from_request",
        lambda *_args, **_kwargs: ("org-1", "user-1", "conv-1", "agent-1"),
    )
    monkeypatch.setattr(dataset_routes.dataset_manager, "get", lambda *_args, **_kwargs: entry)

    response = dataset_routes.get_dataset_content(
        "session-1",
        "dataset-1",
        object(),
    )

    assert str(response.path) == str(target)
    assert response.media_type == "image/png"
    assert response.headers["x-dataset-sha256"] == digest
    assert response.headers["x-content-type-options"] == "nosniff"
