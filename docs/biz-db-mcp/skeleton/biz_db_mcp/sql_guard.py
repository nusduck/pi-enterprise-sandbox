"""Defense-in-depth SQL guard: only a single read-only SELECT is allowed.

The MySQL account behind this service is already provisioned read-only —
this check must not be the *only* line of defense, but it must also not
rely on database privileges alone. It fails closed on anything it cannot
confidently classify as a single SELECT (or WITH ... SELECT).
"""

from __future__ import annotations

import re

import sqlparse

_FORBIDDEN_KEYWORD_RE = re.compile(
    r"\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE"
    r"|CALL|LOAD_FILE|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b",
    re.IGNORECASE,
)


class SqlGuardError(ValueError):
    """Raised when a SQL string fails the read-only SELECT check."""


def assert_select_only(sql: str) -> None:
    """Raise SqlGuardError unless *sql* is exactly one read-only SELECT."""
    if not sql or not sql.strip():
        raise SqlGuardError("empty SQL statement")

    statements = [
        s for s in sqlparse.parse(sql) if s.token_first(skip_cm=True) is not None
    ]
    if len(statements) != 1:
        raise SqlGuardError("exactly one SQL statement is allowed (no batching)")

    statement = statements[0]
    stmt_type = statement.get_type()
    if stmt_type not in ("SELECT", "UNKNOWN"):
        # sqlparse classifies plain `SELECT ...` as SELECT but a leading
        # `WITH ... SELECT ...` (CTE) as UNKNOWN — both are legitimate.
        raise SqlGuardError(f"only SELECT statements are allowed (got {stmt_type})")

    first_token = statement.token_first(skip_cm=True)
    leading_keyword = (first_token.value or "").strip().upper()
    if leading_keyword not in ("SELECT", "WITH"):
        raise SqlGuardError(
            f"statement must start with SELECT or WITH (got {leading_keyword!r})"
        )

    if _FORBIDDEN_KEYWORD_RE.search(sql):
        raise SqlGuardError("statement contains a forbidden keyword")
