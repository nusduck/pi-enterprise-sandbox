"""File edit / apply_patch helpers (ADR 0002 §9).

Guarantees:
- old_string must match exactly once; multi-match returns count + line numbers
- returns unified diff + before/after SHA-256 hashes
- optional expected_hash race check
- apply_patch for unified diffs
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from difflib import unified_diff
from pathlib import Path

from sandbox.config import settings
from sandbox.models import FileEditResponse
from sandbox.security.path_validation import enforce_path_within_workspace


def content_sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def find_match_line_numbers(content: str, old_string: str) -> list[int]:
    """Return 1-based line numbers where each non-overlapping match starts."""
    if not old_string:
        return []
    lines_out: list[int] = []
    start = 0
    while True:
        idx = content.find(old_string, start)
        if idx < 0:
            break
        # 1-based line of the match start
        line_no = content.count("\n", 0, idx) + 1
        lines_out.append(line_no)
        start = idx + max(len(old_string), 1)
    return lines_out


def make_unified_diff(
    path: str,
    before: str,
    after: str,
    *,
    fromfile: str | None = None,
    tofile: str | None = None,
) -> str:
    a = before.splitlines(keepends=True)
    b = after.splitlines(keepends=True)
    # Ensure trailing newline handling for difflib readability
    if a and not a[-1].endswith("\n"):
        a[-1] = a[-1] + "\n"
    if b and not b[-1].endswith("\n"):
        b[-1] = b[-1] + "\n"
    src = fromfile or f"a/{path}"
    dst = tofile or f"b/{path}"
    return "".join(unified_diff(a, b, fromfile=src, tofile=dst))


def count_changed_lines(diff: str) -> int:
    """Count added+removed content lines in a unified diff (exclude headers)."""
    n = 0
    for line in diff.splitlines():
        if not line:
            continue
        if line.startswith("+++") or line.startswith("---") or line.startswith("@@"):
            continue
        if line.startswith("+") or line.startswith("-"):
            n += 1
    return n


@dataclass
class EditPlan:
    """In-memory edit result before disk write."""

    ok: bool
    before: str = ""
    after: str = ""
    before_hash: str = ""
    after_hash: str = ""
    diff: str = ""
    changed_lines: int = 0
    error: str | None = None
    match_count: int | None = None
    match_lines: list[int] = field(default_factory=list)

    def to_response(self, path: str) -> FileEditResponse:
        return FileEditResponse(
            path=path,
            before_hash=self.before_hash,
            after_hash=self.after_hash,
            diff=self.diff,
            changed_lines=self.changed_lines,
            ok=self.ok,
            error=self.error,
            match_count=self.match_count,
            match_lines=self.match_lines or None,
        )


def plan_unique_edit(
    content: str,
    old_string: str,
    new_string: str,
    *,
    path: str = "file",
    expected_hash: str | None = None,
) -> EditPlan:
    """Plan a unique old→new replacement without writing disk."""
    before_hash = content_sha256(content)
    if expected_hash is not None and expected_hash != before_hash:
        return EditPlan(
            ok=False,
            before=content,
            before_hash=before_hash,
            error=(
                f"file changed since read: expected_hash={expected_hash[:12]}… "
                f"actual={before_hash[:12]}…"
            ),
        )
    if not old_string:
        return EditPlan(
            ok=False,
            before=content,
            before_hash=before_hash,
            error="old_string must be non-empty",
        )

    match_lines = find_match_line_numbers(content, old_string)
    match_count = len(match_lines)
    if match_count == 0:
        return EditPlan(
            ok=False,
            before=content,
            before_hash=before_hash,
            match_count=0,
            match_lines=[],
            error=f"old_string not found in {path}",
        )
    if match_count > 1:
        return EditPlan(
            ok=False,
            before=content,
            before_hash=before_hash,
            match_count=match_count,
            match_lines=match_lines,
            error=(
                f"old_string matched {match_count} times in {path} "
                f"(lines {', '.join(str(n) for n in match_lines)}); "
                "refusing silent multi-match edit — provide a more unique old_string"
            ),
        )

    idx = content.find(old_string)
    after = content[:idx] + new_string + content[idx + len(old_string) :]
    after_hash = content_sha256(after)
    diff = make_unified_diff(path, content, after)
    return EditPlan(
        ok=True,
        before=content,
        after=after,
        before_hash=before_hash,
        after_hash=after_hash,
        diff=diff,
        changed_lines=count_changed_lines(diff),
        match_count=1,
        match_lines=match_lines,
    )


_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def apply_unified_patch_to_content(content: str, patch: str) -> str:
    """Apply a single-file unified diff to *content*; raise ValueError on failure.

    Supports standard ``@@ -old,len +new,len @@`` hunks with `` ``/``+``/``-`` lines.
    Context lines must match the current file (fail-closed on mismatch).
    """
    if not patch or not patch.strip():
        raise ValueError("patch must be non-empty")

    # Work on newline-stripped logical lines + track whether original ended with \n
    ends_with_nl = content.endswith("\n") if content else True
    src_lines = content.splitlines()
    out: list[str] = []
    i = 0  # index into src_lines

    patch_lines = patch.splitlines()
    # Skip file headers
    idx = 0
    while idx < len(patch_lines):
        line = patch_lines[idx]
        if line.startswith("---") or line.startswith("+++"):
            idx += 1
            continue
        if line.startswith("diff ") or line.startswith("index "):
            idx += 1
            continue
        break

    while idx < len(patch_lines):
        line = patch_lines[idx]
        if not line.strip():
            idx += 1
            continue
        m = _HUNK_RE.match(line)
        if not m:
            # Ignore trailing noise
            if line.startswith("\\"):
                idx += 1
                continue
            raise ValueError(f"invalid patch line (expected hunk header): {line!r}")

        old_start = int(m.group(1))
        # old_len = int(m.group(2) or "1")  # unused; driven by body
        # Copy unchanged prefix up to old_start (1-based)
        target = old_start - 1
        if target < i:
            raise ValueError(
                f"hunk out of order: old_start={old_start} but cursor at line {i + 1}"
            )
        while i < target:
            if i >= len(src_lines):
                raise ValueError("hunk starts past end of file")
            out.append(src_lines[i])
            i += 1

        idx += 1
        while idx < len(patch_lines):
            pl = patch_lines[idx]
            if pl.startswith("@@"):
                break
            if pl.startswith("---") or pl.startswith("+++"):
                break
            if pl.startswith("\\"):  # "\ No newline at end of file"
                idx += 1
                continue
            if pl.startswith(" "):
                expected = pl[1:]
                if i >= len(src_lines) or src_lines[i] != expected:
                    actual = src_lines[i] if i < len(src_lines) else "<EOF>"
                    raise ValueError(
                        f"context mismatch at line {i + 1}: "
                        f"expected {expected!r}, got {actual!r}"
                    )
                out.append(src_lines[i])
                i += 1
            elif pl.startswith("-"):
                expected = pl[1:]
                if i >= len(src_lines) or src_lines[i] != expected:
                    actual = src_lines[i] if i < len(src_lines) else "<EOF>"
                    raise ValueError(
                        f"delete mismatch at line {i + 1}: "
                        f"expected {expected!r}, got {actual!r}"
                    )
                i += 1
            elif pl.startswith("+"):
                out.append(pl[1:])
            else:
                # Some diffs omit the leading space on context; treat as context
                if i < len(src_lines) and src_lines[i] == pl:
                    out.append(src_lines[i])
                    i += 1
                else:
                    raise ValueError(f"unrecognized patch body line: {pl!r}")
            idx += 1

    # Remainder of file
    while i < len(src_lines):
        out.append(src_lines[i])
        i += 1

    if not out:
        return "\n" if ends_with_nl and content == "\n" else ""
    result = "\n".join(out)
    if ends_with_nl or content.endswith("\n"):
        result += "\n"
    return result


def plan_apply_patch(
    content: str,
    patch: str,
    *,
    path: str = "file",
    expected_hash: str | None = None,
) -> EditPlan:
    before_hash = content_sha256(content)
    if expected_hash is not None and expected_hash != before_hash:
        return EditPlan(
            ok=False,
            before=content,
            before_hash=before_hash,
            error=(
                f"file changed since read: expected_hash={expected_hash[:12]}… "
                f"actual={before_hash[:12]}…"
            ),
        )
    try:
        after = apply_unified_patch_to_content(content, patch)
    except ValueError as exc:
        return EditPlan(
            ok=False,
            before=content,
            before_hash=before_hash,
            error=str(exc),
        )
    after_hash = content_sha256(after)
    diff = make_unified_diff(path, content, after)
    return EditPlan(
        ok=True,
        before=content,
        after=after,
        before_hash=before_hash,
        after_hash=after_hash,
        diff=diff,
        changed_lines=count_changed_lines(diff),
    )


class FileEditService:
    """Workspace-scoped edit / apply_patch operations."""

    def _read_text(self, workspace_path: str, user_path: str) -> tuple[Path, str]:
        safe = enforce_path_within_workspace(workspace_path, user_path)
        if not safe.exists():
            raise FileNotFoundError(f"file not found: {user_path}")
        if not safe.is_file():
            raise ValueError(f"not a file: {user_path}")
        size = safe.stat().st_size
        max_bytes = settings.max_file_size_mb * 1024 * 1024
        if size > max_bytes:
            raise ValueError(
                f"file exceeds max size of {settings.max_file_size_mb}MB "
                f"({size} bytes)"
            )
        content = safe.read_text(encoding="utf-8", errors="replace")
        return safe, content

    def _write_text(self, safe: Path, content: str) -> None:
        content_bytes = content.encode("utf-8")
        max_bytes = settings.max_file_size_mb * 1024 * 1024
        if len(content_bytes) > max_bytes:
            raise ValueError(
                f"Content exceeds max file size of {settings.max_file_size_mb}MB"
            )
        safe.parent.mkdir(parents=True, exist_ok=True)
        safe.write_text(content, encoding="utf-8")

    def edit(
        self,
        workspace_path: str,
        user_path: str,
        old_string: str,
        new_string: str,
        *,
        expected_hash: str | None = None,
    ) -> FileEditResponse:
        try:
            safe, content = self._read_text(workspace_path, user_path)
        except FileNotFoundError as exc:
            return FileEditResponse(path=user_path, ok=False, error=str(exc))
        except ValueError as exc:
            return FileEditResponse(path=user_path, ok=False, error=str(exc))

        plan = plan_unique_edit(
            content,
            old_string,
            new_string,
            path=user_path,
            expected_hash=expected_hash,
        )
        if not plan.ok:
            return plan.to_response(user_path)
        try:
            self._write_text(safe, plan.after)
        except ValueError as exc:
            return FileEditResponse(
                path=user_path,
                before_hash=plan.before_hash,
                ok=False,
                error=str(exc),
            )
        return plan.to_response(user_path)

    def apply_patch(
        self,
        workspace_path: str,
        user_path: str,
        patch: str,
        *,
        expected_hash: str | None = None,
    ) -> FileEditResponse:
        try:
            safe, content = self._read_text(workspace_path, user_path)
        except FileNotFoundError as exc:
            return FileEditResponse(path=user_path, ok=False, error=str(exc))
        except ValueError as exc:
            return FileEditResponse(path=user_path, ok=False, error=str(exc))

        plan = plan_apply_patch(
            content, patch, path=user_path, expected_hash=expected_hash
        )
        if not plan.ok:
            return plan.to_response(user_path)
        try:
            self._write_text(safe, plan.after)
        except ValueError as exc:
            return FileEditResponse(
                path=user_path,
                before_hash=plan.before_hash,
                ok=False,
                error=str(exc),
            )
        return plan.to_response(user_path)


file_edit_service = FileEditService()
