"""Child process workspace/temp quota **monitoring** (process/bash/python).

API file/dataset paths use the control-plane ledger. Managed children write
directly into the workspace bind and can flood disk with many files under
only ``RLIMIT_FSIZE``.

This module provides **defense-in-depth monitoring**, not a hard multi-tenant
disk isolation boundary:

  - Bounded tree measurement (entry/inode cap + fail-closed on errors).
  - Admit check + interval sampler that kill/fail the child on over-quota
    *or* measurement failure.
  - Production must **not** claim a positive workspace/temp quota unless the
    operator also asserts an external hard backend (volume/project quota)
    via ``workspace_quota_hard_backend_asserted`` (see ``validate_production_settings``).

Hard byte totals require OS project/XFS/volume quotas outside this process.
"""

from __future__ import annotations

import logging
import os
import stat as statmod
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sandbox.config import settings

logger = logging.getLogger("sandbox.child_workspace_quota")

_DEFAULT_SAMPLE_INTERVAL_S = 2.0
_MIN_SAMPLE_INTERVAL_S = 0.5
_DEFAULT_MAX_ENTRIES = 100_000

CODE_QUOTA_EXCEEDED = "workspace_quota_exceeded"
CODE_INODE_LIMIT = "workspace_inode_limit_exceeded"
CODE_ENFORCEMENT_FAILED = "workspace_quota_enforcement_failed"


class ChildQuotaMeasureError(Exception):
    """Fail-closed measurement / enforcement outcome."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True, slots=True)
class BoundedTreeMeasure:
    size_bytes: int
    entries: int


@dataclass(frozen=True, slots=True)
class QuotaUsage:
    workspace_bytes: int
    temp_bytes: int
    reserved_bytes: int
    quota_bytes: int
    temp_quota_bytes: int
    workspace_entries: int = 0
    temp_entries: int = 0

    @property
    def workspace_over(self) -> bool:
        return (
            self.quota_bytes > 0
            and self.workspace_bytes + self.reserved_bytes > self.quota_bytes
        )

    @property
    def temp_over(self) -> bool:
        return self.temp_quota_bytes > 0 and self.temp_bytes > self.temp_quota_bytes


@dataclass(frozen=True, slots=True)
class ChildQuotaDecision:
    """Admit / sample decision. ``allow=False`` must kill/fail the child."""

    allow: bool
    code: str | None = None
    message: str = ""
    usage: QuotaUsage | None = None


def _quota_bytes(mb: int) -> int:
    return max(0, int(mb)) * 1024 * 1024


def _max_entries() -> int:
    return max(
        1,
        int(
            getattr(
                settings,
                "workspace_child_quota_max_entries",
                _DEFAULT_MAX_ENTRIES,
            )
            or _DEFAULT_MAX_ENTRIES
        ),
    )


def measure_tree_bounded(
    root: str | Path,
    *,
    max_entries: int | None = None,
) -> BoundedTreeMeasure:
    """Bounded recursive size + entry count (fail-closed).

    - Counts **every** directory entry (files, dirs, symlinks) toward
      ``max_entries`` so zero-byte inode floods trip the limit.
    - Never follows symlinks for descent (``follow_symlinks=False``).
    - Regular-file sizes via ``lstat`` only (symlink size is not target size).
    - Any OSError / unexpected error → ``workspace_quota_enforcement_failed``.
    - Entry cap hit → ``workspace_inode_limit_exceeded`` (no further scan).
    """
    limit = max_entries if max_entries is not None else _max_entries()
    if limit < 1:
        raise ChildQuotaMeasureError(
            CODE_ENFORCEMENT_FAILED,
            "invalid workspace_child_quota_max_entries",
        )

    root_path = Path(root)
    try:
        if not root_path.exists():
            return BoundedTreeMeasure(size_bytes=0, entries=0)
    except OSError as exc:
        raise ChildQuotaMeasureError(
            CODE_ENFORCEMENT_FAILED,
            f"workspace root inaccessible: {exc}",
        ) from exc

    total = 0
    entries = 0
    # Iterative stack of directory paths (never follow symlinks into dirs).
    stack: list[Path] = [root_path]
    try:
        while stack:
            current = stack.pop()
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        entries += 1
                        if entries > limit:
                            raise ChildQuotaMeasureError(
                                CODE_INODE_LIMIT,
                                (
                                    f"workspace tree entry limit exceeded "
                                    f"({limit} entries); refusing unbounded scan"
                                ),
                            )
                        try:
                            st = entry.stat(follow_symlinks=False)
                        except OSError as exc:
                            raise ChildQuotaMeasureError(
                                CODE_ENFORCEMENT_FAILED,
                                f"stat failed during quota measure: {exc}",
                            ) from exc
                        if statmod.S_ISLNK(st.st_mode):
                            # Counted as entry; do not follow.
                            continue
                        if statmod.S_ISREG(st.st_mode):
                            total += int(st.st_size)
                        elif statmod.S_ISDIR(st.st_mode):
                            stack.append(Path(entry.path))
                        # Other special files: entry counted, no size add.
            except ChildQuotaMeasureError:
                raise
            except OSError as exc:
                raise ChildQuotaMeasureError(
                    CODE_ENFORCEMENT_FAILED,
                    f"scandir failed during quota measure: {exc}",
                ) from exc
    except ChildQuotaMeasureError:
        raise
    except Exception as exc:
        raise ChildQuotaMeasureError(
            CODE_ENFORCEMENT_FAILED,
            f"quota measure failed: {exc}",
        ) from exc

    return BoundedTreeMeasure(size_bytes=total, entries=entries)


def measure_child_quota_usage(
    workspace_path: str | Path,
    temp_path: str | Path | None,
    *,
    workspace_id: str | None = None,
    reserved_bytes: int | None = None,
    max_entries: int | None = None,
) -> QuotaUsage:
    """Measure usage with bounded walks. Raises ``ChildQuotaMeasureError``."""
    limit = max_entries if max_entries is not None else _max_entries()
    # Split budget across workspace + temp so flood of either is capped.
    half = max(1, limit // 2) if temp_path else limit

    ws = measure_tree_bounded(workspace_path, max_entries=half if temp_path else limit)
    if temp_path:
        # Remaining budget for temp (at least 1).
        remaining = max(1, limit - ws.entries)
        tmp = measure_tree_bounded(temp_path, max_entries=remaining)
    else:
        tmp = BoundedTreeMeasure(size_bytes=0, entries=0)

    reserved = 0 if reserved_bytes is None else max(0, int(reserved_bytes))
    if reserved_bytes is None and workspace_id:
        try:
            from sandbox.services.workspace_quota_ledger import _sum_disk_reservations

            reserved = _sum_disk_reservations(workspace_id)
        except Exception as exc:
            raise ChildQuotaMeasureError(
                CODE_ENFORCEMENT_FAILED,
                f"reservation sum failed: {exc}",
            ) from exc

    return QuotaUsage(
        workspace_bytes=ws.size_bytes,
        temp_bytes=tmp.size_bytes,
        reserved_bytes=reserved,
        quota_bytes=_quota_bytes(settings.workspace_quota_mb),
        temp_quota_bytes=_quota_bytes(settings.temp_quota_mb),
        workspace_entries=ws.entries,
        temp_entries=tmp.entries,
    )


def evaluate_child_quota(
    workspace_path: str | Path,
    temp_path: str | Path | None,
    *,
    workspace_id: str | None = None,
) -> ChildQuotaDecision:
    """Single decision for admit or sample. Fail-closed on measure errors."""
    if not settings.workspace_child_quota_enforcement:
        return ChildQuotaDecision(allow=True, message="monitoring disabled")
    if settings.workspace_quota_mb <= 0 and settings.temp_quota_mb <= 0:
        return ChildQuotaDecision(allow=True, message="no positive quota configured")
    try:
        usage = measure_child_quota_usage(
            workspace_path, temp_path, workspace_id=workspace_id
        )
    except ChildQuotaMeasureError as exc:
        return ChildQuotaDecision(
            allow=False,
            code=exc.code,
            message=exc.message,
        )
    except Exception as exc:
        return ChildQuotaDecision(
            allow=False,
            code=CODE_ENFORCEMENT_FAILED,
            message=f"quota measure failed: {exc}",
        )
    if usage.workspace_over or usage.temp_over:
        return ChildQuotaDecision(
            allow=False,
            code=CODE_QUOTA_EXCEEDED,
            message=format_quota_exceeded_message(usage),
            usage=usage,
        )
    return ChildQuotaDecision(allow=True, usage=usage)


def assert_child_quota_admit(
    workspace_path: str | Path,
    temp_path: str | Path | None,
    *,
    workspace_id: str | None = None,
) -> ChildQuotaDecision:
    """Admit gate. ``allow=False`` means refuse start (with stable code)."""
    return evaluate_child_quota(
        workspace_path, temp_path, workspace_id=workspace_id
    )


class ChildWorkspaceQuotaWatch:
    """Background **monitor** sampler (not a hard disk quota).

    Calls *on_violation* at most once with a ``ChildQuotaDecision`` when
    over quota **or** measurement fails fail-closed.
    """

    def __init__(
        self,
        *,
        workspace_path: str | Path,
        temp_path: str | Path | None,
        workspace_id: str | None,
        on_violation: Callable[[ChildQuotaDecision], None] | None = None,
        on_exceed: Callable[[Any], None] | None = None,
        sample_interval_s: float | None = None,
    ) -> None:
        self._workspace_path = str(workspace_path)
        self._temp_path = str(temp_path) if temp_path else None
        self._workspace_id = (workspace_id or "").strip() or None
        # Prefer on_violation; on_exceed kept for brief compatibility (usage only).
        self._on_violation = on_violation
        self._on_exceed = on_exceed
        interval = (
            float(sample_interval_s)
            if sample_interval_s is not None
            else float(
                getattr(
                    settings,
                    "workspace_child_quota_sample_interval_s",
                    _DEFAULT_SAMPLE_INTERVAL_S,
                )
            )
        )
        self._interval = max(_MIN_SAMPLE_INTERVAL_S, interval)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tripped = False
        self._last_decision: ChildQuotaDecision | None = None
        self._lock = threading.Lock()

    @property
    def exceeded(self) -> bool:
        """True if monitor tripped (over-quota **or** enforcement failure)."""
        with self._lock:
            return self._tripped

    @property
    def last_decision(self) -> ChildQuotaDecision | None:
        with self._lock:
            return self._last_decision

    def start(self) -> None:
        if not settings.workspace_child_quota_enforcement:
            return
        if settings.workspace_quota_mb <= 0 and settings.temp_quota_mb <= 0:
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="child-workspace-quota-monitor",
            daemon=True,
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        t = self._thread
        if t is not None and t.is_alive():
            t.join(timeout=timeout)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            decision = evaluate_child_quota(
                self._workspace_path,
                self._temp_path,
                workspace_id=self._workspace_id,
            )
            if decision.allow:
                continue
            with self._lock:
                if self._tripped:
                    return
                self._tripped = True
                self._last_decision = decision
            try:
                if self._on_violation is not None:
                    self._on_violation(decision)
                elif self._on_exceed is not None and decision.usage is not None:
                    self._on_exceed(decision.usage)
                elif self._on_exceed is not None:
                    # Enforcement failure: still invoke with a sentinel usage-less path
                    self._on_exceed(decision)
            except Exception:
                logger.exception("child quota on_violation failed")
            return


def format_quota_exceeded_message(usage: QuotaUsage) -> str:
    parts = []
    if usage.workspace_over:
        parts.append(
            f"workspace {usage.workspace_bytes}+reserved {usage.reserved_bytes} "
            f"> quota {usage.quota_bytes}"
        )
    if usage.temp_over:
        parts.append(
            f"temp {usage.temp_bytes} > quota {usage.temp_quota_bytes}"
        )
    return "Workspace quota exceeded by child process: " + "; ".join(parts)


def format_decision_message(decision: ChildQuotaDecision) -> str:
    if decision.message:
        return decision.message
    if decision.usage is not None:
        return format_quota_exceeded_message(decision.usage)
    return decision.code or CODE_ENFORCEMENT_FAILED
