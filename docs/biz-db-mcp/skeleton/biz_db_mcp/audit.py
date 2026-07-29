"""Structured per-call audit logging.

Logs one JSON line per tool call to stderr so it can be picked up by
whatever log pipeline already collects this service's output — no new
sink to stand up for the skeleton. Never logs the MySQL DSN or Sandbox
API token; SQL text is truncated for readability, not for secrecy.
"""

from __future__ import annotations

import contextlib
import json
import sys
import time
import uuid
from collections.abc import Iterator


@contextlib.contextmanager
def log_call(tool: str, **fields: object) -> Iterator[None]:
    record: dict[str, object] = {
        "call_id": uuid.uuid4().hex,
        "tool": tool,
        **_redact(fields),
    }
    started = time.monotonic()
    try:
        yield
        record["status"] = "ok"
    except Exception as exc:
        record["status"] = "error"
        record["error"] = str(exc)
        raise
    finally:
        record["duration_ms"] = round((time.monotonic() - started) * 1000, 1)
        print(json.dumps(record, default=str), file=sys.stderr, flush=True)


def _redact(fields: dict[str, object]) -> dict[str, object]:
    out = dict(fields)
    sql = out.get("sql")
    if isinstance(sql, str) and len(sql) > 500:
        out["sql"] = sql[:500] + "…(truncated)"
    return out
