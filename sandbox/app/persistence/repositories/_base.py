"""Shared repository helpers."""

from __future__ import annotations

from typing import Any, Protocol, Sequence


class SupportsExecute(Protocol):
    def execute(
        self,
        sql: str,
        params: Sequence[Any] | None = None,
    ) -> Any: ...

    def fetchone(self) -> dict[str, Any] | None: ...

    def fetchall(self) -> list[dict[str, Any]]: ...

    @property
    def rowcount(self) -> int: ...


class DatabaseLike(Protocol):
    def connection(self) -> Any: ...

    def transaction(self) -> Any: ...


def require_db(db: Any, name: str) -> Any:
    if db is None:
        raise ValueError(f"{name} requires a MysqlDatabase (or compatible) executor")
    return db
