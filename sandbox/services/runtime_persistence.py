"""Lifecycle installation for Sandbox formal MySQL repositories.

All repositories share the already prepared and pinged ``MysqlDatabase``
owned by ``InternalPlaneResources``. Managers never parse a DSN or create an
independent database handle at module import time.
"""

from __future__ import annotations

from typing import Any


def install_formal_runtime_persistence(
    db: Any | None,
    *,
    recover_processes: bool = True,
) -> Any | None:
    """Install/clear formal manager slots and return session runtime."""
    from sandbox.services.artifact_manager import artifact_manager
    from sandbox.services.audit_logger import audit_logger
    from sandbox.services.dataset_manager import dataset_manager
    from sandbox.services.process_manager import process_manager

    if db is None:
        from sandbox.config import is_mysql_database_url, settings

        formal_required = is_mysql_database_url(settings.database_url)
        artifact_manager.set_formal_repository(
            None, authoritative=formal_required
        )
        dataset_manager.set_formal_repository(
            None, authoritative=formal_required
        )
        process_manager.set_formal_repository(
            None, authoritative=formal_required
        )
        audit_logger.reset_for_config(authoritative=formal_required)
        return None

    # Internal-plane lifecycle tests may inject protocol fakes that only
    # implement ping/probe. They validate resource state, but they are not a
    # complete runtime database and must not mutate process-global managers.
    from sandbox.app.persistence.db import MysqlDatabase

    if not isinstance(db, MysqlDatabase):
        return None

    from sandbox.app.persistence.repositories.artifact_repository import (
        ArtifactRepository,
    )
    from sandbox.app.persistence.repositories.audit_repository import AuditRepository
    from sandbox.app.persistence.repositories.dataset_repository import (
        DatasetRepository,
    )
    from sandbox.app.persistence.repositories.process_repository import (
        ProcessRepository,
    )
    from sandbox.app.persistence.repositories.session_repository import (
        SessionRepository,
    )
    from sandbox.services.formal_session_runtime import FormalSessionRuntime

    connection = getattr(db, "connection", None)
    if connection is not None and not callable(connection):
        raise TypeError("formal MySQL connection factory must be callable")
    try:
        artifact_manager.set_formal_repository(
            ArtifactRepository(db),
            conn_factory=connection,
            authoritative=True,
        )
        dataset_manager.set_formal_repository(
            DatasetRepository(db),
            conn_factory=connection,
            authoritative=True,
        )
        process_manager.set_formal_repository(
            ProcessRepository(db),
            conn_factory=connection,
            authoritative=True,
        )
        audit_logger.set_formal_repository(
            AuditRepository(db),
            conn_factory=connection,
            authoritative=True,
        )
        if recover_processes:
            process_manager.recover_formal_orphans()
    except Exception:
        artifact_manager.set_formal_repository(None, authoritative=True)
        dataset_manager.set_formal_repository(None, authoritative=True)
        process_manager.set_formal_repository(None, authoritative=True)
        audit_logger.set_formal_repository(None, authoritative=True)
        raise
    return FormalSessionRuntime(db=db, repository=SessionRepository(db))


__all__ = ["install_formal_runtime_persistence"]
