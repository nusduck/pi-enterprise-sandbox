"""Control-plane workspace quota ledger (PR-09).

Reservations live under ``control_root/quota/{workspace_id}/`` — **outside**
the untrusted workspace bind. Untrusted children cannot delete/tamper
reservation files to oversell quota.

Same-host multi-worker safety via fcntl lock on the control-plane quota dir.
"""

from __future__ import annotations

import os
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from sandbox.config import settings
from sandbox.services.control_plane_storage import ensure_quota_dir
from sandbox.services.file_manager import workspace_size_bytes

try:
    import fcntl  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]


class QuotaExceededError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 413) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def _res_dir(workspace_id: str) -> Path:
    return ensure_quota_dir(workspace_id) / "res"


def _sum_disk_reservations(workspace_id: str) -> int:
    root = _res_dir(workspace_id)
    if not root.is_dir():
        return 0
    total = 0
    try:
        for p in root.iterdir():
            try:
                st = p.lstat()
            except OSError:
                continue
            if not stat_is_reg(st):
                continue
            try:
                text = p.read_text(encoding="utf-8").strip()
                total += max(0, int(text))
            except (OSError, ValueError):
                continue
    except OSError:
        return total
    return total


def stat_is_reg(st: os.stat_result) -> bool:
    import stat as statmod

    return statmod.S_ISREG(st.st_mode) and not statmod.S_ISLNK(st.st_mode)


@contextmanager
def _exclusive_quota_lock(workspace_id: str) -> Iterator[None]:
    qdir = ensure_quota_dir(workspace_id)
    lock_path = qdir / "lock"
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            if fcntl is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass


@dataclass
class QuotaReservation:
    workspace_id: str
    workspace_path: str
    bytes: int
    reservation_id: str
    _ledger: "WorkspaceQuotaLedger"
    _released: bool = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._ledger._release(self)

    def commit(self) -> None:
        self.release()


class WorkspaceQuotaLedger:
    """Disk-backed reserved-byte accounting on the control plane."""

    def __init__(self) -> None:
        self._lock = threading.RLock()

    def quota_bytes(self, *, quota_mb: int | None = None) -> int:
        mb = settings.workspace_quota_mb if quota_mb is None else int(quota_mb)
        return max(0, mb) * 1024 * 1024

    def reserve(
        self,
        workspace_path: str,
        workspace_key: str,
        nbytes: int,
        *,
        quota_mb: int | None = None,
    ) -> QuotaReservation:
        if nbytes < 0:
            raise ValueError("reserve nbytes must be >= 0")
        workspace_id = (workspace_key or "").strip()
        if not workspace_id or "/" in workspace_id or "\\" in workspace_id:
            raise ValueError("workspace_key must be an opaque workspace id")
        res_id = uuid.uuid4().hex
        if nbytes == 0:
            return QuotaReservation(
                workspace_id=workspace_id,
                workspace_path=workspace_path,
                bytes=0,
                reservation_id=res_id,
                _ledger=self,
            )
        quota = self.quota_bytes(quota_mb=quota_mb)
        with self._lock:
            with _exclusive_quota_lock(workspace_id):
                used = workspace_size_bytes(workspace_path)
                reserved = _sum_disk_reservations(workspace_id)
                projected = used + reserved + nbytes
                if projected > quota:
                    raise QuotaExceededError(
                        "workspace_quota_exceeded",
                        (
                            f"Workspace quota exceeded: usage {used} + reserved "
                            f"{reserved} + request {nbytes} = {projected} bytes, "
                            f"quota {quota} bytes"
                        ),
                        status=413,
                    )
                res_root = _res_dir(workspace_id)
                res_root.mkdir(parents=True, exist_ok=True)
                res_path = res_root / res_id
                fd = os.open(
                    str(res_path),
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                )
                try:
                    os.write(fd, str(nbytes).encode("utf-8"))
                    os.fsync(fd)
                finally:
                    os.close(fd)
                return QuotaReservation(
                    workspace_id=workspace_id,
                    workspace_path=workspace_path,
                    bytes=nbytes,
                    reservation_id=res_id,
                    _ledger=self,
                )

    def _release(self, reservation: QuotaReservation) -> None:
        if reservation.bytes <= 0 and not reservation.reservation_id:
            return
        path = _res_dir(reservation.workspace_id) / reservation.reservation_id
        with self._lock:
            with _exclusive_quota_lock(reservation.workspace_id):
                try:
                    st = path.lstat()
                    import stat as statmod

                    if statmod.S_ISREG(st.st_mode) or statmod.S_ISLNK(st.st_mode):
                        path.unlink(missing_ok=True)
                except OSError:
                    pass

    def try_grow(
        self,
        workspace_path: str,
        reservation: QuotaReservation,
        new_total: int,
        *,
        quota_mb: int | None = None,
    ) -> None:
        if reservation._released:
            raise RuntimeError("reservation already released")
        if new_total < 0:
            raise ValueError("new_total must be >= 0")
        if new_total == reservation.bytes:
            return
        workspace_id = reservation.workspace_id
        if new_total < reservation.bytes:
            with self._lock:
                with _exclusive_quota_lock(workspace_id):
                    path = _res_dir(workspace_id) / reservation.reservation_id
                    if new_total == 0:
                        try:
                            path.unlink(missing_ok=True)
                        except OSError:
                            pass
                    else:
                        path.write_text(str(new_total), encoding="utf-8")
                    reservation.bytes = new_total
            return

        extra = new_total - reservation.bytes
        quota = self.quota_bytes(quota_mb=quota_mb)
        with self._lock:
            with _exclusive_quota_lock(workspace_id):
                used = workspace_size_bytes(workspace_path)
                reserved = _sum_disk_reservations(workspace_id)
                projected = used + reserved + extra
                if projected > quota:
                    raise QuotaExceededError(
                        "workspace_quota_exceeded",
                        (
                            f"Workspace quota exceeded during stream: usage {used} + "
                            f"reserved {reserved} + extra {extra} = {projected} bytes, "
                            f"quota {quota} bytes"
                        ),
                        status=413,
                    )
                path = _res_dir(workspace_id) / reservation.reservation_id
                if reservation.bytes == 0:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    fd = os.open(
                        str(path),
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600,
                    )
                    try:
                        os.write(fd, str(new_total).encode("utf-8"))
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                else:
                    path.write_text(str(new_total), encoding="utf-8")
                reservation.bytes = new_total


workspace_quota_ledger = WorkspaceQuotaLedger()
