"""Persistent OS process identity for PID-reuse-safe kill / recovery (PR-08).

Identity is ``pid`` + **re-capturable** ``start_identity`` (+ optional ``pgid``).

Capture order:
1. Linux: ``/proc/<pid>/stat`` starttime jiffies → ``linux-starttime:<n>``
2. macOS: ctypes ``proc_pidinfo(PROC_PIDTBSDINFO)`` via
   ``/usr/lib/libproc.dylib`` (no subprocess) →
   ``darwin-bsdinfo-v1:start=<sec>.<usec>|pgid=<n>|ppid=<n>``
3. Optional last-resort ``ps`` (may be blocked by sandbox policy; never
   required for macOS success).

Never invent non-re-verifiable tokens (no ``spawn-token``). If capture fails,
``start_identity is None`` — callers must retain live Popen handles and must
not claim identity-based cancel success.
"""

from __future__ import annotations

import logging
import os
import re
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("sandbox.process_identity")

_PROC_STAT_RE = re.compile(r"^\d+\s+\(.*\)\s+[A-Za-z]\s+(.*)$")

# Darwin sys/proc_info.h
_PROC_PIDTBSDINFO = 3
# MAXCOMLEN == 16 → pbi_comm[16], pbi_name[32]; total sizeof(proc_bsdinfo) == 136
_PROC_BSDINFO_SIZE = 136
_LIBPROC_PATHS = (
    "/usr/lib/libproc.dylib",
    "libproc.dylib",
)

# Optional ps only — never the macOS primary path.
_PS_CANDIDATES = (
    "/bin/ps",
    "/usr/bin/ps",
)
_PID_NAMESPACE_RE = re.compile(r"^pid:\[(\d+)\]$")


@dataclass(frozen=True, slots=True)
class ProcessOsIdentity:
    pid: int
    pgid: int | None
    start_identity: str | None
    """None when the platform could not produce a re-verifiable identity."""


def read_linux_starttime(pid: int) -> str | None:
    """Return kernel starttime field from ``/proc/<pid>/stat``, or None."""
    if pid <= 0:
        return None
    path = f"/proc/{int(pid)}/stat"
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    except (FileNotFoundError, PermissionError, OSError):
        return None
    m = _PROC_STAT_RE.match(raw.strip())
    if not m:
        return None
    rest = m.group(1).split()
    # ``rest`` starts at proc stat field 4 (ppid).  Kernel starttime is
    # field 22, therefore index 18 after fields 1-3 have been removed.
    if len(rest) < 19:
        return None
    starttime = rest[18]
    if not starttime.isdigit():
        return None
    return f"linux-starttime:{starttime}"


def read_pid_namespace_id(pid: int) -> str | None:
    """Return the Linux PID-namespace inode for *pid*, when observable."""
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return None
    if pid_i <= 0 or not sys.platform.startswith("linux"):
        return None
    try:
        target = os.readlink(f"/proc/{pid_i}/ns/pid")
    except (FileNotFoundError, PermissionError, OSError, TypeError, ValueError):
        return None
    match = _PID_NAMESPACE_RE.fullmatch(target)
    return f"pid:{match.group(1)}" if match else None


def _read_nspid_values(pid: int) -> list[int]:
    try:
        with open(f"/proc/{int(pid)}/status", "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("NSpid:"):
                    values = []
                    for token in line.split()[1:]:
                        if token.isdigit():
                            values.append(int(token))
                    return values
    except (FileNotFoundError, PermissionError, OSError, TypeError, ValueError):
        return []
    return []


def find_pid_namespace_init(wrapper_pid: int, *, attempts: int = 20, delay_seconds: float = 0.01) -> int | None:
    """Find the outer PID corresponding to a Bubblewrap PID-namespace init.

    Bubblewrap's outer wrapper remains the direct parent in the host PID
    namespace. The first child whose ``NSpid`` ends in ``1`` is the namespace
    init and is therefore the safe recovery control point.
    """
    try:
        wrapper = int(wrapper_pid)
    except (TypeError, ValueError):
        return None
    if wrapper <= 0 or not sys.platform.startswith("linux"):
        return None
    for attempt in range(max(1, int(attempts))):
        try:
            with open(f"/proc/{wrapper}/task/{wrapper}/children", "r", encoding="ascii") as fh:
                children = [int(token) for token in fh.read().split() if token.isdigit()]
        except (FileNotFoundError, PermissionError, OSError, ValueError):
            children = []
        for child_pid in children:
            nspids = _read_nspid_values(child_pid)
            if nspids and nspids[-1] == 1:
                return child_pid
        if attempt + 1 < max(1, int(attempts)):
            time.sleep(max(0.0, float(delay_seconds)))
    return None


def _load_libproc() -> Any | None:
    """Load libproc without relying on PATH / find_library side effects."""
    if sys.platform != "darwin":
        return None
    try:
        import ctypes
    except ImportError:
        return None
    for path in _LIBPROC_PATHS:
        try:
            return ctypes.CDLL(path, use_errno=True)
        except OSError:
            continue
    return None


def _proc_bsdinfo_type() -> Any:
    """ctypes Structure matching Darwin ``struct proc_bsdinfo`` (size 136)."""
    import ctypes

    # Field layout from <sys/proc_info.h> (xnu). Do not reorder.
    class proc_bsdinfo(ctypes.Structure):
        _fields_ = [
            ("pbi_flags", ctypes.c_uint32),
            ("pbi_status", ctypes.c_uint32),
            ("pbi_xstatus", ctypes.c_uint32),
            ("pbi_pid", ctypes.c_uint32),
            ("pbi_ppid", ctypes.c_uint32),
            ("pbi_uid", ctypes.c_uint32),  # uid_t
            ("pbi_gid", ctypes.c_uint32),  # gid_t
            ("pbi_ruid", ctypes.c_uint32),
            ("pbi_rgid", ctypes.c_uint32),
            ("pbi_svuid", ctypes.c_uint32),
            ("pbi_svgid", ctypes.c_uint32),
            ("rfu_1", ctypes.c_uint32),
            ("pbi_comm", ctypes.c_char * 16),  # MAXCOMLEN
            ("pbi_name", ctypes.c_char * 32),  # 2 * MAXCOMLEN
            ("pbi_nfiles", ctypes.c_uint32),
            ("pbi_pgid", ctypes.c_uint32),
            ("pbi_pjobc", ctypes.c_uint32),
            ("e_tdev", ctypes.c_uint32),
            ("e_tpgid", ctypes.c_uint32),
            ("pbi_nice", ctypes.c_int32),
            ("pbi_start_tvsec", ctypes.c_uint64),
            ("pbi_start_tvusec", ctypes.c_uint64),
        ]

    assert ctypes.sizeof(proc_bsdinfo) == _PROC_BSDINFO_SIZE, (
        f"proc_bsdinfo size {ctypes.sizeof(proc_bsdinfo)} != {_PROC_BSDINFO_SIZE}"
    )
    return proc_bsdinfo


def read_libproc_start_identity(pid: int) -> str | None:
    """macOS primary: ``proc_pidinfo(PROC_PIDTBSDINFO)`` — no subprocess.

    Identity format::

        darwin-bsdinfo-v1:start=<tvsec>.<tvusec>|pgid=<n>|ppid=<n>

    All fields are re-read on verify. Returns None on non-Darwin or failure.
    """
    if pid <= 0 or sys.platform != "darwin":
        return None
    try:
        import ctypes
    except ImportError:
        return None

    lib = _load_libproc()
    if lib is None:
        return None

    proc_bsdinfo = _proc_bsdinfo_type()
    info = proc_bsdinfo()
    size = ctypes.sizeof(info)
    if size != _PROC_BSDINFO_SIZE:
        return None

    try:
        lib.proc_pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        lib.proc_pidinfo.restype = ctypes.c_int
        got = int(
            lib.proc_pidinfo(
                int(pid),
                _PROC_PIDTBSDINFO,
                ctypes.c_uint64(0),
                ctypes.byref(info),
                size,
            )
        )
    except Exception:
        logger.debug("proc_pidinfo failed for pid=%s", pid, exc_info=True)
        return None

    # Darwin returns the number of bytes written; must be full struct.
    if got != size:
        return None
    if int(info.pbi_pid) != int(pid):
        return None

    tvsec = int(info.pbi_start_tvsec)
    tvusec = int(info.pbi_start_tvusec)
    if tvsec < 0 or tvusec < 0 or tvusec >= 1_000_000:
        # Reject obviously corrupt timeval (allow 0 for very early boot).
        if tvusec < 0 or tvusec >= 1_000_000:
            return None

    return (
        f"darwin-bsdinfo-v1:start={tvsec}.{tvusec:06d}"
        f"|pgid={int(info.pbi_pgid)}|ppid={int(info.pbi_ppid)}"
    )


def _ps_env() -> dict[str, str]:
    env = dict(os.environ)
    env["LC_ALL"] = "C"
    env["LANG"] = "C"
    path = env.get("PATH") or ""
    env["PATH"] = "/bin:/usr/bin:" + path if path else "/bin:/usr/bin"
    return env


def _run_ps(argv: list[str]) -> str | None:
    """Optional last-resort ps. Failures are silent (policy may block exec)."""
    tail = argv[1:] if argv and argv[0] == "ps" else argv
    for binary in _PS_CANDIDATES:
        try:
            proc = subprocess.run(
                [binary, *tail],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
                env=_ps_env(),
            )
        except (FileNotFoundError, OSError, PermissionError, subprocess.SubprocessError):
            continue
        if proc.returncode != 0:
            continue
        out = (proc.stdout or "").strip()
        if out:
            return out
    return None


def _ps_field(pid: int, field: str) -> str | None:
    pid_s = str(int(pid))
    for args in (
        ["ps", "-p", pid_s, "-o", f"{field}="],
        ["ps", "-o", f"{field}=", "-p", pid_s],
    ):
        text = _run_ps(args)
        if not text:
            continue
        lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
        if not lines:
            continue
        if lines[0].lower().replace(" ", "") in {
            field.lower(),
            "started",
            "lstart",
            "start",
            "pgid",
            "ppid",
        }:
            lines = lines[1:]
        if not lines:
            continue
        return " ".join(lines[0].split())
    return None


def read_ps_start_identity(pid: int) -> str | None:
    """Optional last-resort ps identity (not required for macOS)."""
    if pid <= 0:
        return None
    lstart = _ps_field(pid, "lstart") or _ps_field(pid, "start")
    if not lstart:
        return None
    pgid_s = _ps_field(pid, "pgid")
    ppid_s = _ps_field(pid, "ppid")
    if not pgid_s or not str(pgid_s).lstrip("-").isdigit():
        try:
            pgid_s = str(os.getpgid(int(pid)))
        except OSError:
            return None
    if not ppid_s or not str(ppid_s).lstrip("-").isdigit():
        ppid_s = "?"
    return f"ps-v1:lstart={lstart}|pgid={pgid_s}|ppid={ppid_s}"


def read_macos_lstart(pid: int) -> str | None:
    """Backward-compatible alias — libproc primary."""
    return read_libproc_start_identity(pid)


def capture_start_identity(
    pid: int,
    *,
    attempts: int = 5,
    delay_seconds: float = 0.01,
) -> str | None:
    """Capture a durable, re-capturable start identity for *pid*.

    On Darwin, libproc is the only required path. ``ps`` is never needed for
    success. Retries briefly for post-spawn races.
    """
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return None
    if pid_i <= 0:
        return None

    tries = max(1, int(attempts))
    for i in range(tries):
        linux = read_linux_starttime(pid_i)
        if linux:
            return linux
        # macOS primary — no subprocess.
        darwin = read_libproc_start_identity(pid_i)
        if darwin:
            return darwin
        # Optional last resort only (ignored if policy blocks exec).
        if sys.platform != "darwin":
            ps_id = read_ps_start_identity(pid_i)
            if ps_id:
                return ps_id
        if i + 1 < tries:
            time.sleep(max(0.0, float(delay_seconds)))
    # One final optional ps attempt on Darwin only after libproc exhausted.
    if sys.platform == "darwin":
        return read_ps_start_identity(pid_i)
    return None


def capture_process_identity(
    pid: int,
    *,
    pgid: int | None = None,
) -> ProcessOsIdentity | None:
    """Capture identity for a live pid. ``start_identity`` may be None."""
    if pid is None:
        return None
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return None
    if pid_i <= 0:
        return None
    start = capture_start_identity(pid_i)
    return ProcessOsIdentity(pid=pid_i, pgid=pgid, start_identity=start)


def identity_matches(pid: int | None, expected_start: str | None) -> bool:
    """True only when *pid* is alive and re-captured identity equals expected."""
    if pid is None or not expected_start:
        return False
    if str(expected_start).startswith("spawn-token:"):
        return False
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return False
    if pid_i <= 0:
        return False
    try:
        os.kill(pid_i, 0)
    except OSError:
        return False
    current = capture_start_identity(pid_i, attempts=3, delay_seconds=0.01)
    if current is None:
        return False
    return current == expected_start


def process_alive(pid: int | None) -> bool:
    if pid is None:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def safe_signal_identity(
    *,
    pid: int | None,
    pgid: int | None,
    start_identity: str | None,
    signum: int = signal.SIGTERM,
) -> dict[str, Any]:
    """Signal only when durable identity still matches. Fail closed otherwise."""
    if pid is None:
        return {"ok": False, "reason": "no_pid", "signaled": False}
    if not start_identity:
        return {"ok": False, "reason": "no_identity", "signaled": False}
    if str(start_identity).startswith("spawn-token:"):
        return {"ok": False, "reason": "unverifiable_identity", "signaled": False}
    if not identity_matches(pid, start_identity):
        return {"ok": False, "reason": "identity_mismatch", "signaled": False}

    pid_i = int(pid)
    target_pgid: int | None = None
    if pgid is not None:
        try:
            live_pgid = os.getpgid(pid_i)
            if int(pgid) == int(live_pgid) and int(pgid) != os.getpgrp():
                target_pgid = int(pgid)
        except OSError:
            target_pgid = None

    try:
        if target_pgid is not None:
            os.killpg(target_pgid, signum)
        else:
            os.kill(pid_i, signum)
        return {
            "ok": True,
            "reason": "signaled",
            "signaled": True,
            "via": "pgid" if target_pgid is not None else "pid",
        }
    except OSError as exc:
        return {
            "ok": False,
            "reason": f"signal_failed:{exc}",
            "signaled": False,
        }


def platform_name() -> str:
    return sys.platform
