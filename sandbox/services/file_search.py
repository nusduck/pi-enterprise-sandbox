"""Structured, budgeted file discovery and text search within a workspace.

Tools: ls / find / grep. Never shells out; never returns physical workspace roots.
Callers may only tighten limits (server clamps to hard maxima).
"""

from __future__ import annotations

import fnmatch
import os
import re
import time
from pathlib import Path

from sandbox.models import (
    FileSearchItem,
    FileSearchResponse,
    FileSearchSkipped,
    FileSearchStats,
    GrepMatch,
    GrepResponse,
)
from sandbox.paths import SandboxPathScope, sanitize_path_error
from sandbox.security.path_validation import (
    enforce_path_within_workspace,
    resolve_sandbox_path,
)

# ── Hard ceilings (callers may only tighten) ────────────────────────────

LS_MAX_ITEMS = 1000
LS_MAX_DEPTH = 5

FIND_DEFAULT_MAX_DEPTH = 20
FIND_MAX_DEPTH = 20
FIND_DEFAULT_LIMIT = 500
FIND_MAX_LIMIT = 500

GREP_DEFAULT_LIMIT = 500
GREP_MAX_LIMIT = 500
GREP_MAX_CONTEXT = 5
GREP_MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB
GREP_MAX_TOTAL_BYTES = 100 * 1024 * 1024  # 100 MB
GREP_TIMEOUT_S = 5.0
GREP_BINARY_PROBE = 8192
GREP_MAX_PATTERN_LEN = 512

# Patterns that commonly cause catastrophic backtracking; reject when regex=True.
_UNSAFE_REGEX = re.compile(
    r"("
    r"\(\?[#=!:<]"  # lookaround / named groups / comments
    r"|\\[0-9]{2,}"  # large backrefs
    r"|(\.\*){3,}"  # chained .*
    r"|(\+\+|\*\*|\\s\+|\\S\+)"  # possessive-ish / stacked quantifiers
    r"|\{\d+,\}"  # open-ended quantifier
    r"|\([^)]*[+*][^)]*\)[+*{]"  # nested quantifiers e.g. (a+)+ or (.*)*
    r")"
)

_VALID_ENTRY_TYPES = frozenset({"file", "dir", "symlink"})


def _clamp_int(value: int | None, default: int, lo: int, hi: int) -> int:
    if value is None:
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _workspace_root(workspace_path: str) -> Path:
    return Path(workspace_path).resolve()


def _to_rel(root: Path, path: Path, public_prefix: str | None = None) -> str:
    """Workspace-relative POSIX path; never leak absolute/physical roots."""
    try:
        rel = path.resolve(strict=False).relative_to(root)
    except (ValueError, OSError, RuntimeError):
        # Fallback: try without resolve
        try:
            rel = path.relative_to(root)
        except ValueError:
            return path.name or "."
    s = rel.as_posix()
    relative = s if s and s != "." else "."
    if public_prefix is None:
        return relative
    return public_prefix if relative == "." else f"{public_prefix}/{relative}"


def _resolve_search_root(
    workspace_path: str,
    path: str,
    temp_path: str | None,
) -> tuple[Path, Path, str | None]:
    if temp_path is None:
        root = _workspace_root(workspace_path)
        return root, enforce_path_within_workspace(workspace_path, path), None
    parsed, start = resolve_sandbox_path(workspace_path, temp_path, path)
    if parsed.scope == SandboxPathScope.TEMP:
        return Path(temp_path).resolve(), start, "/tmp"
    return _workspace_root(workspace_path), start, None


def _is_hidden_name(name: str) -> bool:
    return name.startswith(".") and name not in (".", "..")


def _safe_lstat(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except OSError:
        return None


def _entry_type(path: Path, st: os.stat_result | None = None) -> str:
    try:
        if path.is_symlink():
            return "symlink"
    except OSError:
        pass
    if st is None:
        st = _safe_lstat(path)
    if st is None:
        return "file"
    if stat_isdir(st):
        return "dir"
    return "file"


def stat_isdir(st: os.stat_result) -> bool:
    return stat_mode_isdir(st.st_mode)


def stat_mode_isdir(mode: int) -> bool:
    return (mode & 0o170000) == 0o040000


def stat_isfile(st: os.stat_result) -> bool:
    return (st.st_mode & 0o170000) == 0o100000


def _within_workspace(root: Path, path: Path) -> bool:
    """True if *path* (resolved) stays inside *root*. Does not raise."""
    try:
        resolved = path.resolve(strict=False)
        return resolved == root or root in resolved.parents or resolved.is_relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return False


def _is_binary_bytes(sample: bytes) -> bool:
    if not sample:
        return False
    if b"\x00" in sample:
        return True
    # High ratio of non-text control bytes → treat as binary
    nontext = sum(1 for b in sample if b < 9 or (13 < b < 32 and b != 27) or b == 0x7F)
    return (nontext / max(len(sample), 1)) > 0.30


def _is_binary_file(path: Path) -> bool:
    try:
        with open(path, "rb") as f:
            sample = f.read(GREP_BINARY_PROBE)
        return _is_binary_bytes(sample)
    except OSError:
        return True


def _compile_grep_query(
    query: str,
    *,
    regex: bool,
    case_sensitive: bool,
) -> re.Pattern[str]:
    if not query or not isinstance(query, str):
        raise ValueError("query is required")
    if len(query) > GREP_MAX_PATTERN_LEN:
        raise ValueError(f"query exceeds max length ({GREP_MAX_PATTERN_LEN})")

    flags = 0 if case_sensitive else re.IGNORECASE
    if not regex:
        return re.compile(re.escape(query), flags)

    if _UNSAFE_REGEX.search(query):
        raise ValueError("regex pattern rejected: potentially unsafe construct")
    try:
        return re.compile(query, flags)
    except re.error as exc:
        raise ValueError(f"invalid regex: {exc}") from exc


def _scandir_sorted(path: Path) -> list[os.DirEntry[str]]:
    try:
        entries = list(os.scandir(path))
    except OSError:
        return []
    entries.sort(key=lambda e: e.name.lower())
    return entries


class FileSearchService:
    """Budgeted ls / find / grep confined to a session workspace."""

    # ── ls ────────────────────────────────────────────────────────────

    def ls(
        self,
        workspace_path: str,
        path: str = ".",
        depth: int = 1,
        include_hidden: bool = False,
        *,
        temp_path: str | None = None,
    ) -> FileSearchResponse:
        depth = _clamp_int(depth, 1, 0, LS_MAX_DEPTH)
        root, start, public_prefix = _resolve_search_root(
            workspace_path, path, temp_path
        )

        t0 = time.monotonic()
        items: list[FileSearchItem] = []
        skipped: list[FileSearchSkipped] = []
        examined = 0
        depth_reached = 0
        truncated = False
        stop_reason: str | None = None

        if not start.exists():
            return FileSearchResponse(
                items=[],
                skipped=[FileSearchSkipped(path=_to_rel(root, start, public_prefix), reason="not_found")],
                stats=FileSearchStats(
                    examined=0,
                    matched=0,
                    skipped=1,
                    duration_ms=(time.monotonic() - t0) * 1000,
                ),
                truncated=False,
                stop_reason="not_found",
            )

        # depth 0: only the start path itself
        if depth == 0:
            st = _safe_lstat(start)
            et = _entry_type(start, st)
            size = int(st.st_size) if st and et == "file" else 0
            items.append(
                FileSearchItem(
                    path=_to_rel(root, start, public_prefix),
                    name=start.name or ".",
                    type=et,
                    size=size,
                )
            )
            return FileSearchResponse(
                items=items,
                skipped=[],
                stats=FileSearchStats(
                    examined=1,
                    matched=1,
                    duration_ms=(time.monotonic() - t0) * 1000,
                    depth_reached=0,
                ),
            )

        if not start.is_dir() and not (start.is_symlink() and start.is_dir()):
            # Non-directory start: return single entry
            st = _safe_lstat(start)
            et = _entry_type(start, st)
            size = int(st.st_size) if st and et == "file" else 0
            items.append(
                FileSearchItem(
                    path=_to_rel(root, start, public_prefix),
                    name=start.name,
                    type=et,
                    size=size,
                )
            )
            return FileSearchResponse(
                items=items,
                stats=FileSearchStats(
                    examined=1,
                    matched=1,
                    duration_ms=(time.monotonic() - t0) * 1000,
                ),
            )

        def visit(dir_path: Path, current_depth: int) -> bool:
            """Return False to abort walk (budget exhausted)."""
            nonlocal examined, depth_reached, truncated, stop_reason
            if current_depth > depth:
                return True
            depth_reached = max(depth_reached, current_depth)

            for entry in _scandir_sorted(dir_path):
                name = entry.name
                if not include_hidden and _is_hidden_name(name):
                    continue

                child = dir_path / name
                examined += 1
                rel = _to_rel(root, child, public_prefix)

                try:
                    is_link = entry.is_symlink()
                except OSError:
                    skipped.append(FileSearchSkipped(path=rel, reason="stat_error"))
                    continue

                # Symlink safety: never follow escape; list as symlink entry.
                if is_link:
                    if not _within_workspace(root, child):
                        skipped.append(
                            FileSearchSkipped(path=rel, reason="symlink_escape")
                        )
                        continue
                    et = "symlink"
                    try:
                        size = int(entry.stat(follow_symlinks=False).st_size)
                    except OSError:
                        size = 0
                    items.append(
                        FileSearchItem(path=rel, name=name, type=et, size=size)
                    )
                    if len(items) >= LS_MAX_ITEMS:
                        truncated = True
                        stop_reason = "item_limit"
                        return False
                    # Do not descend into symlink directories
                    continue

                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_file = entry.is_file(follow_symlinks=False)
                except OSError:
                    skipped.append(FileSearchSkipped(path=rel, reason="stat_error"))
                    continue

                if is_dir:
                    items.append(
                        FileSearchItem(path=rel, name=name, type="dir", size=0)
                    )
                    if len(items) >= LS_MAX_ITEMS:
                        truncated = True
                        stop_reason = "item_limit"
                        return False
                    if current_depth < depth:
                        if not visit(child, current_depth + 1):
                            return False
                elif is_file:
                    try:
                        size = int(entry.stat(follow_symlinks=False).st_size)
                    except OSError:
                        size = 0
                    items.append(
                        FileSearchItem(path=rel, name=name, type="file", size=size)
                    )
                    if len(items) >= LS_MAX_ITEMS:
                        truncated = True
                        stop_reason = "item_limit"
                        return False
                else:
                    # sockets, fifos, etc.
                    skipped.append(FileSearchSkipped(path=rel, reason="unsupported_type"))

            return True

        visit(start, 1)

        # Stable sort by path
        items.sort(key=lambda it: it.path.lower())

        return FileSearchResponse(
            items=items,
            skipped=skipped,
            stats=FileSearchStats(
                examined=examined,
                matched=len(items),
                skipped=len(skipped),
                duration_ms=(time.monotonic() - t0) * 1000,
                depth_reached=depth_reached,
            ),
            truncated=truncated,
            stop_reason=stop_reason,
        )

    # ── find ──────────────────────────────────────────────────────────

    def find(
        self,
        workspace_path: str,
        path: str = ".",
        pattern: str = "*",
        type: str | None = None,  # noqa: A002 — matches tool schema
        max_depth: int | None = None,
        limit: int | None = None,
        *,
        temp_path: str | None = None,
    ) -> FileSearchResponse:
        max_depth = _clamp_int(
            max_depth, FIND_DEFAULT_MAX_DEPTH, 0, FIND_MAX_DEPTH
        )
        limit = _clamp_int(limit, FIND_DEFAULT_LIMIT, 1, FIND_MAX_LIMIT)
        type_filter = (type or "").strip().lower() or None
        if type_filter and type_filter not in _VALID_ENTRY_TYPES:
            raise ValueError(
                f"invalid type filter: {type!r}; expected one of "
                f"{sorted(_VALID_ENTRY_TYPES)}"
            )
        if not pattern or not isinstance(pattern, str):
            pattern = "*"
        if len(pattern) > 256:
            raise ValueError("pattern exceeds max length (256)")

        root, start, public_prefix = _resolve_search_root(
            workspace_path, path, temp_path
        )

        t0 = time.monotonic()
        items: list[FileSearchItem] = []
        skipped: list[FileSearchSkipped] = []
        examined = 0
        depth_reached = 0
        truncated = False
        stop_reason: str | None = None

        if not start.exists():
            return FileSearchResponse(
                items=[],
                skipped=[
                    FileSearchSkipped(path=_to_rel(root, start, public_prefix), reason="not_found")
                ],
                stats=FileSearchStats(
                    skipped=1,
                    duration_ms=(time.monotonic() - t0) * 1000,
                ),
                stop_reason="not_found",
            )

        def name_matches(name: str) -> bool:
            return fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(
                name.lower(), pattern.lower()
            )

        def consider(child: Path, name: str, et: str, size: int) -> bool:
            """Append if matches; return False when limit hit."""
            nonlocal truncated, stop_reason
            if type_filter and et != type_filter:
                return True
            if not name_matches(name):
                return True
            items.append(
                FileSearchItem(
                    path=_to_rel(root, child, public_prefix),
                    name=name,
                    type=et,
                    size=size,
                )
            )
            if len(items) >= limit:
                truncated = True
                stop_reason = "item_limit"
                return False
            return True

        # Include start itself at depth 0 when it matches
        st0 = _safe_lstat(start)
        et0 = _entry_type(start, st0)
        size0 = int(st0.st_size) if st0 and et0 == "file" else 0
        examined += 1
        if not consider(start, start.name or ".", et0, size0):
            items.sort(key=lambda it: it.path.lower())
            return FileSearchResponse(
                items=items,
                skipped=skipped,
                stats=FileSearchStats(
                    examined=examined,
                    matched=len(items),
                    skipped=len(skipped),
                    duration_ms=(time.monotonic() - t0) * 1000,
                    depth_reached=0,
                ),
                truncated=truncated,
                stop_reason=stop_reason,
            )

        def visit(dir_path: Path, current_depth: int) -> bool:
            nonlocal examined, depth_reached, truncated, stop_reason
            if current_depth > max_depth:
                return True
            if not dir_path.is_dir():
                return True
            depth_reached = max(depth_reached, current_depth)

            for entry in _scandir_sorted(dir_path):
                name = entry.name
                child = dir_path / name
                examined += 1
                rel = _to_rel(root, child, public_prefix)

                try:
                    is_link = entry.is_symlink()
                except OSError:
                    skipped.append(FileSearchSkipped(path=rel, reason="stat_error"))
                    continue

                if is_link:
                    if not _within_workspace(root, child):
                        skipped.append(
                            FileSearchSkipped(path=rel, reason="symlink_escape")
                        )
                        continue
                    try:
                        size = int(entry.stat(follow_symlinks=False).st_size)
                    except OSError:
                        size = 0
                    if not consider(child, name, "symlink", size):
                        return False
                    # Never descend into symlink dirs
                    continue

                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    is_file = entry.is_file(follow_symlinks=False)
                except OSError:
                    skipped.append(FileSearchSkipped(path=rel, reason="stat_error"))
                    continue

                if is_dir:
                    if not consider(child, name, "dir", 0):
                        return False
                    if current_depth < max_depth:
                        if not visit(child, current_depth + 1):
                            return False
                elif is_file:
                    try:
                        size = int(entry.stat(follow_symlinks=False).st_size)
                    except OSError:
                        size = 0
                    if not consider(child, name, "file", size):
                        return False
                else:
                    skipped.append(
                        FileSearchSkipped(path=rel, reason="unsupported_type")
                    )

            return True

        if et0 == "dir" and max_depth >= 1:
            visit(start, 1)

        items.sort(key=lambda it: it.path.lower())
        return FileSearchResponse(
            items=items,
            skipped=skipped,
            stats=FileSearchStats(
                examined=examined,
                matched=len(items),
                skipped=len(skipped),
                duration_ms=(time.monotonic() - t0) * 1000,
                depth_reached=depth_reached,
            ),
            truncated=truncated,
            stop_reason=stop_reason,
        )

    # ── grep ──────────────────────────────────────────────────────────

    def grep(
        self,
        workspace_path: str,
        path: str = ".",
        query: str = "",
        glob: str | None = None,
        regex: bool = False,
        case_sensitive: bool = True,
        context: int | None = None,
        limit: int | None = None,
        *,
        temp_path: str | None = None,
    ) -> GrepResponse:
        context_n = _clamp_int(context, 0, 0, GREP_MAX_CONTEXT)
        limit_n = _clamp_int(limit, GREP_DEFAULT_LIMIT, 1, GREP_MAX_LIMIT)
        pattern = _compile_grep_query(
            query, regex=bool(regex), case_sensitive=bool(case_sensitive)
        )
        glob_pat = glob.strip() if isinstance(glob, str) and glob.strip() else None
        if glob_pat and len(glob_pat) > 256:
            raise ValueError("glob exceeds max length (256)")

        root, start, public_prefix = _resolve_search_root(
            workspace_path, path, temp_path
        )

        t0 = time.monotonic()
        deadline = t0 + GREP_TIMEOUT_S
        matches: list[GrepMatch] = []
        skipped: list[FileSearchSkipped] = []
        examined = 0
        bytes_scanned = 0
        truncated = False
        stop_reason: str | None = None

        def timed_out() -> bool:
            return time.monotonic() >= deadline

        def budget_ok() -> bool:
            nonlocal truncated, stop_reason
            if timed_out():
                truncated = True
                stop_reason = "timeout"
                return False
            if bytes_scanned >= GREP_MAX_TOTAL_BYTES:
                truncated = True
                stop_reason = "scan_budget"
                return False
            if len(matches) >= limit_n:
                truncated = True
                stop_reason = "match_limit"
                return False
            return True

        def glob_ok(name: str) -> bool:
            if not glob_pat:
                return True
            return fnmatch.fnmatch(name, glob_pat) or fnmatch.fnmatch(
                name.lower(), glob_pat.lower()
            )

        def scan_file(file_path: Path) -> bool:
            """Scan one file. Return False to abort overall search."""
            nonlocal examined, bytes_scanned, truncated, stop_reason
            if not budget_ok():
                return False

            rel = _to_rel(root, file_path, public_prefix)
            examined += 1

            if file_path.is_symlink():
                if not _within_workspace(root, file_path):
                    skipped.append(
                        FileSearchSkipped(path=rel, reason="symlink_escape")
                    )
                    return True
                # Follow only if target is still inside workspace
                try:
                    target = file_path.resolve(strict=True)
                except OSError:
                    skipped.append(FileSearchSkipped(path=rel, reason="symlink_error"))
                    return True
                if not _within_workspace(root, target):
                    skipped.append(
                        FileSearchSkipped(path=rel, reason="symlink_escape")
                    )
                    return True
                file_path = target

            try:
                st = file_path.stat()
            except OSError:
                skipped.append(FileSearchSkipped(path=rel, reason="stat_error"))
                return True

            if not stat_isfile(st):
                return True

            if st.st_size > GREP_MAX_FILE_BYTES:
                skipped.append(FileSearchSkipped(path=rel, reason="file_too_large"))
                return True

            if _is_binary_file(file_path):
                skipped.append(FileSearchSkipped(path=rel, reason="binary"))
                return True

            try:
                # Read with size cap
                with open(file_path, "rb") as f:
                    raw = f.read(GREP_MAX_FILE_BYTES + 1)
            except OSError:
                skipped.append(FileSearchSkipped(path=rel, reason="read_error"))
                return True

            if len(raw) > GREP_MAX_FILE_BYTES:
                skipped.append(FileSearchSkipped(path=rel, reason="file_too_large"))
                return True

            if _is_binary_bytes(raw[:GREP_BINARY_PROBE]):
                skipped.append(FileSearchSkipped(path=rel, reason="binary"))
                return True

            bytes_scanned += len(raw)
            if bytes_scanned > GREP_MAX_TOTAL_BYTES:
                truncated = True
                stop_reason = "scan_budget"
                return False

            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("utf-8", errors="replace")

            lines = text.splitlines()
            for idx, line in enumerate(lines):
                if not budget_ok():
                    return False
                m = pattern.search(line)
                if not m:
                    continue
                before = lines[max(0, idx - context_n) : idx] if context_n else []
                after = (
                    lines[idx + 1 : idx + 1 + context_n] if context_n else []
                )
                matches.append(
                    GrepMatch(
                        path=rel,
                        line=idx + 1,
                        column=m.start() + 1,
                        text=line,
                        before=list(before),
                        after=list(after),
                    )
                )
                if len(matches) >= limit_n:
                    truncated = True
                    stop_reason = "match_limit"
                    return False
            return True

        if not start.exists():
            return GrepResponse(
                matches=[],
                skipped=[
                    FileSearchSkipped(path=_to_rel(root, start, public_prefix), reason="not_found")
                ],
                stats=FileSearchStats(
                    skipped=1,
                    duration_ms=(time.monotonic() - t0) * 1000,
                ),
                stop_reason="not_found",
            )

        if start.is_file() or (start.is_symlink() and not start.is_dir()):
            if glob_ok(start.name):
                scan_file(start)
        else:
            # Walk without following symlinks
            for dirpath, dirnames, filenames in os.walk(
                start, topdown=True, followlinks=False
            ):
                if not budget_ok():
                    break
                # Stable order
                dirnames.sort(key=str.lower)
                filenames.sort(key=str.lower)

                # Prune symlink dirs and escape risks
                keep_dirs: list[str] = []
                base = Path(dirpath)
                for dname in dirnames:
                    dpath = base / dname
                    if dpath.is_symlink():
                        skipped.append(
                            FileSearchSkipped(
                                path=_to_rel(root, dpath, public_prefix),
                                reason="symlink_dir_skipped",
                            )
                        )
                        continue
                    if not _within_workspace(root, dpath):
                        skipped.append(
                            FileSearchSkipped(
                                path=_to_rel(root, dpath, public_prefix),
                                reason="path_escape",
                            )
                        )
                        continue
                    keep_dirs.append(dname)
                dirnames[:] = keep_dirs

                for fname in filenames:
                    if not budget_ok():
                        break
                    if not glob_ok(fname):
                        continue
                    fpath = base / fname
                    if not scan_file(fpath):
                        break

        # Stable sort: path then line
        matches.sort(key=lambda m: (m.path.lower(), m.line, m.column))

        # Sanitize any accidental physical roots in match text (defensive)
        for m in matches:
            m.text = sanitize_path_error(m.text, physical_workspace=str(root))
            m.before = [
                sanitize_path_error(b, physical_workspace=str(root)) for b in m.before
            ]
            m.after = [
                sanitize_path_error(a, physical_workspace=str(root)) for a in m.after
            ]

        return GrepResponse(
            matches=matches,
            skipped=skipped,
            stats=FileSearchStats(
                examined=examined,
                matched=len(matches),
                skipped=len(skipped),
                bytes_scanned=bytes_scanned,
                duration_ms=(time.monotonic() - t0) * 1000,
            ),
            truncated=truncated,
            stop_reason=stop_reason,
        )


file_search_service = FileSearchService()
