"""Explicit MySQL persistence errors — no silent SQLite/memory fallback."""

from __future__ import annotations


class MysqlConfigError(Exception):
    """Invalid or unsupported database URL / configuration."""

    code = "MYSQL_CONFIG_ERROR"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.name = "MysqlConfigError"


class MysqlDependencyError(Exception):
    """Required driver package is not installed."""

    code = "MYSQL_DEPENDENCY_ERROR"

    def __init__(self, message: str, *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.name = "MysqlDependencyError"
        self.__cause__ = cause


class OwnershipError(Exception):
    """Missing or invalid owner scope for a multi-tenant query."""

    code = "OWNERSHIP_DENIED"

    def __init__(
        self,
        message: str,
        *,
        resource: str | None = None,
        id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.name = "OwnershipError"
        self.resource = resource
        self.id = id


class NotFoundError(Exception):
    """Owned row not found (or not visible under owner scope)."""

    code = "NOT_FOUND"

    def __init__(
        self,
        message: str,
        *,
        resource: str | None = None,
        id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.name = "NotFoundError"
        self.resource = resource
        self.id = id


class ConflictError(Exception):
    """State/identity conflict under the same owner scope (not foreign-owner)."""

    code = "CONFLICT"

    def __init__(
        self,
        message: str,
        *,
        resource: str | None = None,
        id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.name = "ConflictError"
        self.resource = resource
        self.id = id


class IdempotencyKeyReuseError(ConflictError):
    """Same run+toolCall reused with a different claim identity/hash/version.

    Distinct from generic same-owner binding/status conflicts.
    """

    code = "IDEMPOTENCY_KEY_REUSE"

    def __init__(
        self,
        message: str,
        *,
        resource: str | None = None,
        id: str | None = None,
    ) -> None:
        super().__init__(message, resource=resource, id=id)
        self.name = "IdempotencyKeyReuseError"


class SchemaGapError(Exception):
    """Operation targets a table absent from the Agent MySQL migration."""

    code = "SCHEMA_GAP"

    def __init__(
        self,
        message: str,
        *,
        table: str | None = None,
    ) -> None:
        super().__init__(message)
        self.name = "SchemaGapError"
        self.table = table
