"""Internal workspace file reader for Agent read tools (PR-07B foundation).

Does **not** reuse legacy :class:`~sandbox.services.file_manager.FileManager`.
Opens via :func:`~sandbox.security.secure_workspace_file.open_workspace_regular_file`
(fd-relative, anti-TOCTOU). No HTTP route registration in this module.

Contract highlights:

- ``workspace_id``: formal ULID (validated).
- ``path``: Agent-normalized logical path under
  ``/home/sandbox/workspace/<relative>`` only (rejects relative, root itself,
  ``/tmp``, skill, other absolutes).
- ``offset`` int 0..JS_MAX_SAFE_INTEGER (0-based line skip; Agent has no
  50000 offset ceiling), ``limit`` 1..50000, ``max_bytes`` 1..262144 —
  strict ``type is int`` (no bool/float/str).
- UTF-8 strict text; NUL or invalid UTF-8 → binary (no content).
- LF logical lines; ``max_bytes`` hard limit never splits a multi-byte char
  or a half line.
- Streamed read: fixed-size chunks only; memory O(chunk + max_bytes + line
  bound). Never loads the full file into bytes/string/line lists.
- Deterministic failures use typed codes (never UNKNOWN). No DB finalize.
"""

from __future__ import annotations

import codecs
import mimetypes
import os
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Callable

from sandbox.config import settings
from sandbox.paths import AGENT_WORKSPACE_PATH, sanitize_path_error
from sandbox.security.path_validation import validate_formal_id
from sandbox.security.secure_workspace_file import (
    SecureWorkspaceFileError,
    fstat_identity,
    identities_equal,
    open_workspace_regular_file,
)

# Agent read bounds (must match sandbox-bridge constants).
# offset has no 50_000 ceiling on the Agent side — only JS safe integer.
_JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_MAX_OFFSET = _JS_MAX_SAFE_INTEGER
_MAX_LIMIT = 50_000
_MAX_BYTES_CAP = 262_144  # 256 KiB
_MIN_POSITIVE = 1

# Fixed read syscall bound — never request more than this per os.read.
# Injectable via InternalFileReader.read(read_chunk_size=...) for tests.
_READ_CHUNK_SIZE = 64 * 1024  # 64 KiB


class InternalFileReadError(Exception):
    """Typed read failure. ``code`` is stable for Agent/tool mapping."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.name = "InternalFileReadError"


@dataclass(frozen=True)
class _ValidatedReadInput:
    workspace_id: str
    logical_path: str
    relative_parts: tuple[str, ...]
    offset: int
    limit: int
    max_bytes: int


def _require_strict_int(
    value: Any, field: str, *, min_v: int, max_v: int
) -> int:
    """Reject bool/float/str and out-of-range; no coercion."""
    if type(value) is not int:  # noqa: E721 — bool is int subclass
        raise InternalFileReadError(
            "INVALID_ARGUMENT",
            f"{field} must be an integer (no bool/float/string coercion)",
        )
    if value < min_v or value > max_v:
        raise InternalFileReadError(
            "INVALID_ARGUMENT",
            f"{field} must be in range {min_v}..{max_v}",
        )
    return value


def _parse_workspace_logical_path(path: Any) -> tuple[str, tuple[str, ...]]:
    """Require ``/home/sandbox/workspace/<relative>`` with non-empty relative."""
    if not isinstance(path, str) or path == "":
        raise InternalFileReadError(
            "PATH_INVALID", "path must be a non-empty string"
        )
    if "\x00" in path:
        raise InternalFileReadError("PATH_INVALID", "path contains NUL")
    if "\\" in path:
        raise InternalFileReadError(
            "PATH_INVALID", "backslash paths rejected"
        )
    if not path.startswith("/"):
        raise InternalFileReadError(
            "PATH_INVALID",
            "path must be absolute under /home/sandbox/workspace",
        )
    root = AGENT_WORKSPACE_PATH  # /home/sandbox/workspace
    if path == root or path == root + "/":
        raise InternalFileReadError(
            "PATH_INVALID",
            "workspace root itself is not a readable file path",
        )
    prefix = root + "/"
    if not path.startswith(prefix):
        raise InternalFileReadError(
            "PATH_INVALID",
            "path must be under /home/sandbox/workspace/<relative>",
        )
    relative = path[len(prefix) :]
    if relative == "" or relative.endswith("/"):
        raise InternalFileReadError(
            "PATH_INVALID", "path must address a file, not a directory"
        )
    pure = PurePosixPath(relative)
    if pure.is_absolute():
        raise InternalFileReadError("PATH_INVALID", "invalid relative path")
    parts: list[str] = []
    for seg in pure.parts:
        if seg in ("", "."):
            raise InternalFileReadError(
                "PATH_INVALID", "empty or '.' path segment rejected"
            )
        if seg == "..":
            raise InternalFileReadError(
                "PATH_INVALID", "parent traversal rejected"
            )
        if "/" in seg or "\\" in seg or "\x00" in seg:
            raise InternalFileReadError(
                "PATH_INVALID", "invalid path segment"
            )
        parts.append(seg)
    if not parts:
        raise InternalFileReadError(
            "PATH_INVALID", "path must include a file name"
        )
    logical = f"{root}/{'/'.join(parts)}"
    return logical, tuple(parts)


def _validate_input(
    *,
    workspace_id: Any,
    path: Any,
    offset: Any,
    limit: Any,
    max_bytes: Any,
) -> _ValidatedReadInput:
    if not isinstance(workspace_id, str):
        raise InternalFileReadError(
            "INVALID_ARGUMENT", "workspace_id must be a string"
        )
    try:
        safe_ws = validate_formal_id(workspace_id, "workspace_id")
    except ValueError as exc:
        raise InternalFileReadError(
            "INVALID_ARGUMENT", "workspace_id must be a formal ULID"
        ) from exc

    logical, parts = _parse_workspace_logical_path(path)
    off = _require_strict_int(offset, "offset", min_v=0, max_v=_MAX_OFFSET)
    lim = _require_strict_int(
        limit, "limit", min_v=_MIN_POSITIVE, max_v=_MAX_LIMIT
    )
    mb = _require_strict_int(
        max_bytes, "max_bytes", min_v=_MIN_POSITIVE, max_v=_MAX_BYTES_CAP
    )
    return _ValidatedReadInput(
        workspace_id=safe_ws,
        logical_path=logical,
        relative_parts=parts,
        offset=off,
        limit=lim,
        max_bytes=mb,
    )


def _guess_mime(logical_path: str) -> str:
    mime, _ = mimetypes.guess_type(logical_path)
    return mime or "application/octet-stream"


def _map_open_error(exc: SecureWorkspaceFileError) -> InternalFileReadError:
    code = exc.code
    if code == "FILE_NOT_FOUND":
        return InternalFileReadError("FILE_NOT_FOUND", "file not found")
    if code in ("SYMLINK_REJECTED", "NOT_REGULAR_FILE"):
        return InternalFileReadError(
            "NOT_REGULAR_FILE", "not a regular file"
        )
    if code == "PATH_INVALID":
        return InternalFileReadError(
            "PATH_INVALID", str(exc) or "invalid path"
        )
    if code == "PERMISSION_DENIED":
        return InternalFileReadError("PERMISSION_DENIED", "permission denied")
    return InternalFileReadError(
        "READ_FAILED", sanitize_path_error(str(exc)) or "open failed"
    )


def _split_lf_lines(text: str) -> list[str]:
    """Split *text* into LF logical lines, preserving ``\\n`` terminators.

    ``"a\\nb\\n"`` → ``["a\\n", "b\\n"]``; ``"a\\nb"`` → ``["a\\n", "b"]``;
    empty string → ``[]``. CRLF keeps the ``\\r`` on the line body.

    Retained as a pure helper for unit tests; the reader stream path does not
    build a full-file line list.
    """
    if text == "":
        return []
    if text.endswith("\n"):
        return [ln + "\n" for ln in text[:-1].split("\n")]
    parts = text.split("\n")
    return [ln + "\n" for ln in parts[:-1]] + [parts[-1]]


@dataclass
class _LineSelectState:
    """Incremental LF line selection with O(max_bytes) retained content.

    Skipped lines (before offset) and post-selection scan retain no line text.
    Pending content is only held while assembling a candidate return line and
    is bounded by max_bytes (+ one undecoded chunk worth of decoded chars at
    the tip-over check).
    """

    offset: int
    limit: int
    max_bytes: int
    line_idx: int = 0
    selected: list[str] = field(default_factory=list)
    selected_bytes: int = 0
    pending_parts: list[str] = field(default_factory=list)
    pending_bytes: int = 0
    mid_line_unretained: bool = False  # skip/scan mid-line without buffer
    select_finished: bool = False
    budget_truncated: bool = False
    next_offset: int | None = None
    saw_extra: bool = False

    def feed(self, text: str) -> None:
        if not text:
            return
        if self.select_finished:
            # Any further decoded content means more logical lines exist.
            self.saw_extra = True
            return

        start = 0
        n = len(text)
        while start < n:
            if self.select_finished:
                self.saw_extra = True
                return
            nl = text.find("\n", start)
            if nl == -1:
                self._append_fragment(text[start:])
                return
            # Complete line ending at nl (inclusive of '\n').
            self._append_fragment(text[start : nl + 1])
            self._finish_pending_line()
            start = nl + 1

    def finish(self) -> None:
        """Flush a final line without trailing LF (if any)."""
        if self.select_finished:
            if self.pending_parts or self.mid_line_unretained:
                self.saw_extra = True
            self.pending_parts.clear()
            self.pending_bytes = 0
            self.mid_line_unretained = False
            return
        if self.pending_parts or self.mid_line_unretained:
            self._finish_pending_line()

    def result(self) -> tuple[str, bool, int, int | None]:
        content = "".join(self.selected)
        returned = len(self.selected)
        if self.budget_truncated:
            return content, True, returned, self.next_offset
        if returned > 0 and returned >= self.limit and self.saw_extra:
            no = (
                self.next_offset
                if self.next_offset is not None
                else self.line_idx
            )
            return content, True, returned, no
        if self.saw_extra and returned == 0 and self.offset > 0:
            # offset past start but we saw content only before offset? then
            # saw_extra shouldn't apply for empty selection past EOF.
            pass
        if self.saw_extra and not self.select_finished:
            # Should not happen; treat as truncated for safety.
            return content, True, returned, self.line_idx
        # limit hit but no extra content, or natural EOF
        if (
            returned >= self.limit
            and self.select_finished
            and not self.saw_extra
        ):
            return content, False, returned, None
        return content, False, returned, None

    def _append_fragment(self, fragment: str) -> None:
        if not fragment:
            return
        if self.select_finished:
            self.saw_extra = True
            return

        # Still skipping lines before offset: count only, retain nothing.
        if self.line_idx < self.offset:
            self.mid_line_unretained = True
            return

        # Past selection capacity.
        if len(self.selected) >= self.limit:
            self.select_finished = True
            self.saw_extra = True
            self.next_offset = self.line_idx
            self.mid_line_unretained = True
            self.pending_parts.clear()
            self.pending_bytes = 0
            return

        frag_bytes = len(fragment.encode("utf-8"))
        new_pending = self.pending_bytes + frag_bytes

        # First return line must fit entirely in max_bytes.
        if len(self.selected) == 0 and new_pending > self.max_bytes:
            raise InternalFileReadError(
                "FILE_LINE_TOO_LARGE",
                "first line to return exceeds max_bytes",
            )

        # Non-first candidate already over remaining budget (even incomplete).
        if (
            len(self.selected) > 0
            and self.selected_bytes + new_pending > self.max_bytes
        ):
            self.budget_truncated = True
            self.select_finished = True
            self.saw_extra = True
            self.next_offset = self.line_idx
            self.pending_parts.clear()
            self.pending_bytes = 0
            self.mid_line_unretained = True
            return

        self.pending_parts.append(fragment)
        self.pending_bytes = new_pending
        self.mid_line_unretained = False

    def _finish_pending_line(self) -> None:
        """Emit the current pending line (complete, with or without ``\\n``)."""
        if self.select_finished:
            self.saw_extra = True
            self.pending_parts.clear()
            self.pending_bytes = 0
            self.mid_line_unretained = False
            return

        if self.line_idx < self.offset:
            # Skipped line ends.
            self.line_idx += 1
            self.mid_line_unretained = False
            self.pending_parts.clear()
            self.pending_bytes = 0
            return

        if len(self.selected) >= self.limit:
            self.select_finished = True
            self.saw_extra = True
            self.next_offset = self.line_idx
            self.pending_parts.clear()
            self.pending_bytes = 0
            self.mid_line_unretained = False
            return

        line = "".join(self.pending_parts)
        self.pending_parts.clear()
        line_bytes = self.pending_bytes
        self.pending_bytes = 0
        self.mid_line_unretained = False

        # Empty pending can happen for consecutive processing; a line is at
        # least empty-string logical line only when we had mid_line or parts.
        # finish()/feed always call this after a '\n' or EOF with content.
        if len(self.selected) == 0 and line_bytes > self.max_bytes:
            raise InternalFileReadError(
                "FILE_LINE_TOO_LARGE",
                "first line to return exceeds max_bytes",
            )
        if self.selected_bytes + line_bytes > self.max_bytes:
            self.budget_truncated = True
            self.select_finished = True
            self.saw_extra = True
            self.next_offset = self.line_idx
            return

        self.selected.append(line)
        self.selected_bytes += line_bytes
        self.line_idx += 1
        if len(self.selected) >= self.limit:
            self.select_finished = True
            self.next_offset = self.line_idx


@dataclass(frozen=True)
class _StreamReadOutcome:
    binary: bool
    content: str
    truncated: bool
    returned_lines: int
    next_offset: int | None
    bytes_read: int


def _stream_read_and_select(
    fd: int,
    *,
    offset: int,
    limit: int,
    max_bytes: int,
    chunk_size: int = _READ_CHUNK_SIZE,
    read_fn: Callable[[int, int], bytes] | None = None,
) -> _StreamReadOutcome:
    """Stream *fd* in fixed-size chunks; select lines without full-file buffers.

    Memory is O(chunk_size + max_bytes + pending line ≤ max_bytes). Continues
    to EOF after selection to validate strict UTF-8 / NUL (binary) without
    retaining body text. Each read request size is exactly *chunk_size*.
    """
    if type(chunk_size) is not int or chunk_size <= 0:  # noqa: E721
        raise InternalFileReadError(
            "INVALID_ARGUMENT", "read_chunk_size must be a positive int"
        )
    reader = read_fn if read_fn is not None else os.read
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    selector = _LineSelectState(
        offset=offset, limit=limit, max_bytes=max_bytes
    )
    bytes_read = 0
    is_binary = False

    while True:
        try:
            chunk = reader(fd, chunk_size)
        except OSError as exc:
            raise InternalFileReadError(
                "READ_FAILED", "read failed"
            ) from exc
        if not chunk:
            break
        bytes_read += len(chunk)

        if is_binary:
            # Drain remainder for size / stability checks; retain nothing.
            continue

        if b"\x00" in chunk:
            is_binary = True
            continue

        try:
            text = decoder.decode(chunk, final=False)
        except UnicodeDecodeError:
            is_binary = True
            continue

        if text:
            selector.feed(text)

    if not is_binary:
        try:
            tail = decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            is_binary = True
        else:
            if tail:
                selector.feed(tail)
            selector.finish()

    if is_binary:
        return _StreamReadOutcome(
            binary=True,
            content="",
            truncated=False,
            returned_lines=0,
            next_offset=None,
            bytes_read=bytes_read,
        )

    content, truncated, returned, next_off = selector.result()
    return _StreamReadOutcome(
        binary=False,
        content=content,
        truncated=truncated,
        returned_lines=returned,
        next_offset=next_off,
        bytes_read=bytes_read,
    )


class InternalFileReader:
    """Read a single workspace regular file for internal Agent tool paths."""

    def __init__(
        self,
        *,
        workspaces_path: str | os.PathLike[str] | None = None,
        max_file_size_mb: int | None = None,
    ) -> None:
        self._workspaces_path = (
            str(workspaces_path)
            if workspaces_path is not None
            else str(settings.workspaces_path)
        )
        mb = (
            max_file_size_mb
            if max_file_size_mb is not None
            else int(settings.max_file_size_mb)
        )
        if type(mb) is not int or mb <= 0:  # noqa: E721
            raise ValueError("max_file_size_mb must be a positive int")
        self._max_file_bytes = mb * 1024 * 1024

    def read(
        self,
        *,
        workspace_id: Any,
        path: Any,
        offset: Any,
        limit: Any,
        max_bytes: Any,
        # Test hooks (not for production callers):
        after_open: Callable[[int], None] | None = None,
        before_second_fstat: Callable[[int], None] | None = None,
        read_chunk_size: int | None = None,
        read_fn: Callable[[int, int], bytes] | None = None,
    ) -> dict[str, Any]:
        """Read file content with anti-TOCTOU fstat bracketing.

        Returns a dict compatible with Agent ``formatReadResult``:
        text: ``{path, binary:false, content, truncated, offset, limit, size, ...}``
        binary: ``{path, binary:true, size, mimeType}`` (no content).

        Streaming: fixed-size chunks from the same leaf fd; never
        ``Path.read_bytes`` / full-file join. Optional *read_chunk_size* /
        *read_fn* are test injection points for request-size assertions.
        """
        inp = _validate_input(
            workspace_id=workspace_id,
            path=path,
            offset=offset,
            limit=limit,
            max_bytes=max_bytes,
        )
        chunk_size = (
            _READ_CHUNK_SIZE if read_chunk_size is None else read_chunk_size
        )
        try:
            with open_workspace_regular_file(
                self._workspaces_path,
                inp.workspace_id,
                inp.relative_parts,
            ) as fd:
                if after_open is not None:
                    after_open(fd)

                before = fstat_identity(fd)
                if before.st_size > self._max_file_bytes:
                    raise InternalFileReadError(
                        "FILE_TOO_LARGE",
                        "file exceeds max_file_size_mb",
                    )

                outcome = _stream_read_and_select(
                    fd,
                    offset=inp.offset,
                    limit=inp.limit,
                    max_bytes=inp.max_bytes,
                    chunk_size=chunk_size,
                    read_fn=read_fn,
                )

                if before_second_fstat is not None:
                    before_second_fstat(fd)

                after = fstat_identity(fd)
                if not identities_equal(before, after):
                    raise InternalFileReadError(
                        "FILE_CHANGED_DURING_READ",
                        "file changed during read",
                    )
                if outcome.bytes_read != before.st_size:
                    raise InternalFileReadError(
                        "FILE_CHANGED_DURING_READ",
                        "file size mismatch during read",
                    )
        except SecureWorkspaceFileError as exc:
            raise _map_open_error(exc) from exc

        mime = _guess_mime(inp.logical_path)

        if outcome.binary:
            return {
                "path": inp.logical_path,
                "binary": True,
                "size": before.st_size,
                "mimeType": mime,
            }

        text_mime = mime if mime != "application/octet-stream" else "text/plain"
        return {
            "path": inp.logical_path,
            "binary": False,
            "content": outcome.content,
            "truncated": outcome.truncated,
            "offset": inp.offset,
            "limit": inp.limit,
            "size": before.st_size,
            "returnedLines": outcome.returned_lines,
            "nextOffset": outcome.next_offset,
            "mimeType": text_mime,
        }


def read_workspace_file(
    *,
    workspace_id: Any,
    path: Any,
    offset: Any = 0,
    limit: Any = 20_000,
    max_bytes: Any = _MAX_BYTES_CAP,
    workspaces_path: str | os.PathLike[str] | None = None,
    max_file_size_mb: int | None = None,
) -> dict[str, Any]:
    """Module-level convenience wrapper around :class:`InternalFileReader`."""
    return InternalFileReader(
        workspaces_path=workspaces_path,
        max_file_size_mb=max_file_size_mb,
    ).read(
        workspace_id=workspace_id,
        path=path,
        offset=offset,
        limit=limit,
        max_bytes=max_bytes,
    )
