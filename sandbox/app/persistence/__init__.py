"""Sandbox MySQL-only execution-domain persistence.

This package owns SandboxSession, Execution, Process, Dataset, Artifact, and
Sandbox audit persistence. Conversation, Message, Run, Tool, and Approval
authority remains in the Agent service.
"""

from sandbox.app.persistence.db import (
    MysqlDatabase,
    assert_mysql_connection_url,
    describe_rejected_mysql_url,
)
from sandbox.app.persistence.errors import (
    MysqlConfigError,
    MysqlDependencyError,
    NotFoundError,
    OwnershipError,
    SchemaGapError,
)
from sandbox.app.persistence.schema_gap import (
    EXECUTION_DOMAIN_TABLES,
    EXECUTION_DOMAIN_TABLES_PRESENT,
    SCHEMA_CAPABILITY,
    SCHEMA_GAP,
    SCHEMA_GAP_MISSING_TABLES,
    report_schema_capability,
    report_schema_gap,
    validate_execution_domain_capability,
)
from sandbox.app.persistence.ownership import apply_owner_scope_sql, require_owner_scope
from sandbox.app.persistence.repositories import (
    ArtifactRepository,
    AuditRepository,
    DatasetRepository,
    ExecutionRepository,
    ProcessRepository,
    SessionRepository,
)

__all__ = [
    "ArtifactRepository",
    "AuditRepository",
    "DatasetRepository",
    "EXECUTION_DOMAIN_TABLES",
    "EXECUTION_DOMAIN_TABLES_PRESENT",
    "ExecutionRepository",
    "MysqlConfigError",
    "MysqlDatabase",
    "MysqlDependencyError",
    "NotFoundError",
    "OwnershipError",
    "ProcessRepository",
    "SCHEMA_CAPABILITY",
    "SCHEMA_GAP",
    "SCHEMA_GAP_MISSING_TABLES",
    "SchemaGapError",
    "SessionRepository",
    "apply_owner_scope_sql",
    "assert_mysql_connection_url",
    "describe_rejected_mysql_url",
    "report_schema_capability",
    "report_schema_gap",
    "require_owner_scope",
    "validate_execution_domain_capability",
]
