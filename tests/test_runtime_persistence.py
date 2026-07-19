"""Formal runtime persistence lifecycle and fail-closed process writes."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest

from sandbox.app.persistence.db import MysqlDatabase
from sandbox.services.process_handle_store import FormalProcessDualWriter
from sandbox.services.runtime_persistence import install_formal_runtime_persistence


def _mysql() -> MysqlDatabase:
    return MysqlDatabase(
        "mysql+pymysql://sandbox:test@127.0.0.1:3306/sandbox",
        connect_fn=lambda **_kwargs: object(),
    )


def test_installs_one_prepared_mysql_handle_into_runtime_managers() -> None:
    from sandbox.services.artifact_manager import artifact_manager
    from sandbox.services.audit_logger import audit_logger
    from sandbox.services.dataset_manager import dataset_manager
    from sandbox.services.process_manager import process_manager

    db = _mysql()
    try:
        session_runtime = install_formal_runtime_persistence(
            db, recover_processes=False
        )

        assert session_runtime is not None
        assert session_runtime.db is db
        assert artifact_manager.formal.repo is not None
        assert artifact_manager.formal.repo.db is db
        assert dataset_manager.formal.repo is not None
        assert dataset_manager.formal.repo.db is db
        assert process_manager._formal.repo is not None
        assert process_manager._formal.repo.db is db
        assert process_manager._formal.authoritative is True
        assert audit_logger.repository is not None
        assert audit_logger.repository.db is db
    finally:
        install_formal_runtime_persistence(None)


def test_recovery_failure_rolls_back_all_runtime_manager_slots(monkeypatch) -> None:
    from sandbox.services.artifact_manager import artifact_manager
    from sandbox.services.dataset_manager import dataset_manager
    from sandbox.services.process_manager import process_manager

    db = _mysql()
    monkeypatch.setattr(
        process_manager,
        "recover_formal_orphans",
        lambda: (_ for _ in ()).throw(RuntimeError("recovery failed")),
    )

    with pytest.raises(RuntimeError, match="recovery failed"):
        install_formal_runtime_persistence(db)

    assert artifact_manager.formal.repo is None
    assert dataset_manager.formal.repo is None
    assert process_manager._formal.repo is None
    assert process_manager._formal.authoritative is True
    install_formal_runtime_persistence(None)


def test_authoritative_process_transaction_rolls_back_and_raises() -> None:
    calls: list[str] = []

    class Conn:
        def commit(self) -> None:
            calls.append("commit")

        def rollback(self) -> None:
            calls.append("rollback")

    class Repo:
        def get_by_id(self, *_args: Any, **_kwargs: Any) -> None:
            raise RuntimeError("write failed")

    @contextmanager
    def connection():
        calls.append("open")
        try:
            yield Conn()
        finally:
            calls.append("close")

    writer = FormalProcessDualWriter(
        Repo(),
        conn_factory=connection,
        authoritative=True,
    )
    entry = {
        "process_id": "01K0G2PAV8FPMVC9QHJG7JPN60",
        "org_id": "01K0G2PAV8FPMVC9QHJG7JPN50",
        "user_id": "01K0G2PAV8FPMVC9QHJG7JPN52",
        "sandbox_session_id": "01K0G2PAV8FPMVC9QHJG7JPN53",
        "run_id": "01K0G2PAV8FPMVC9QHJG7JPN4Z",
        "execution_id": "01K0G2PAV8FPMVC9QHJG7JPN61",
        "status": "RUNNING",
    }

    with pytest.raises(RuntimeError, match="write failed"):
        writer.upsert_from_runtime(entry)

    assert calls == ["open", "rollback", "close"]
