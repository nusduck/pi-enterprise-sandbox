"""Rebuild this replica's copy of a caller's installed skills.

Bubblewrap binds ``<user_skills_root>/<org>/<user>`` into every execution, so
the Sandbox needs those files on local disk — but the Agent is what installs
them, and in a sharded deployment it runs on different pods. The two used to
meet on a shared ReadWriteMany volume, which made the filesystem the authority
and every writer a potential conflict.

Now ``user_skills`` in MySQL is the authority and this rebuilds a local copy
from it. The directory becomes a cache an ``emptyDir`` can hold, and no volume
is written by more than one pod.

Mirrors ``agent/src/skills/bundle-store.js``: same table, same content digest,
same "extract only what changed" rule. The digest is computed by the Agent from
the directory tree rather than the archive bytes, so this side only has to
compare and store it.

Failure is never fatal. Skills enhance an execution; a database hiccup must not
stop code from running, and one unextractable bundle must not block the rest.
"""

from __future__ import annotations

import logging
import shutil
import tarfile
import threading
import time
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger("sandbox.services.user_skill_materializer")

TABLE = "user_skills"

#: Written beside each skill so the next execution can skip extraction.
DIGEST_MARKER = ".bundle-sha256"

#: How long a freshly reconciled directory is trusted without re-querying.
#: Executions are frequent and bubblewrap-heavy; a skill installed mid-session
#: should appear quickly, but not at the cost of a query per execution.
DEFAULT_FRESHNESS_SECONDS = 10.0

#: Refuse absurd archives before writing them anywhere. Matches the MEDIUMBLOB
#: ceiling the Agent enforces when storing.
MAX_BUNDLE_BYTES = 16 * 1024 * 1024


class UserSkillMaterializer:
    """Reconciles one replica's local skill cache with the durable store."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._conn_factory: Callable[[], Any] | None = None
        # (org_id, user_id) -> monotonic deadline until which the local copy is
        # trusted without a query.
        self._fresh_until: dict[tuple[str, str], float] = {}

    def set_connection_factory(self, factory: Callable[[], Any] | None) -> None:
        """Install or clear the lifespan-owned database connection factory."""
        with self._lock:
            self._conn_factory = factory
            if factory is None:
                self._fresh_until.clear()

    @property
    def installed(self) -> bool:
        with self._lock:
            return self._conn_factory is not None

    # ── reconciliation ──────────────────────────────────────────────

    def ensure_current(
        self,
        *,
        org_id: str,
        user_id: str,
        skill_dir: Path,
        freshness_seconds: float = DEFAULT_FRESHNESS_SECONDS,
    ) -> bool:
        """Bring ``skill_dir`` in line with the durable store.

        Returns True when the directory is believed current — including when it
        was already fresh. False means the store could not be consulted and the
        caller is looking at whatever was there before, which is still better
        than failing the execution.
        """
        with self._lock:
            factory = self._conn_factory
            key = (org_id, user_id)
            if factory is None:
                # No database: single-process development, where the Agent and
                # the Sandbox share one filesystem and nothing needs copying.
                return True
            # A zero window means "do not trust the cache" — used to force a
            # re-check rather than merely to shorten the next one.
            if (
                freshness_seconds > 0
                and self._fresh_until.get(key, 0.0) > time.monotonic()
            ):
                return True

        try:
            wanted = self._load_digests(factory, org_id, user_id)
        except Exception as exc:
            logger.warning(
                "cannot list durable skills for %s/%s: %s",
                org_id,
                user_id,
                type(exc).__name__,
            )
            return False

        try:
            self._reconcile(factory, org_id, user_id, skill_dir, wanted)
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning(
                "skill materialization failed for %s/%s: %s",
                org_id,
                user_id,
                type(exc).__name__,
            )
            return False

        with self._lock:
            self._fresh_until[(org_id, user_id)] = (
                time.monotonic() + float(freshness_seconds)
            )
        return True

    def _load_digests(
        self, factory: Callable[[], Any], org_id: str, user_id: str
    ) -> dict[str, str]:
        with factory() as conn:
            conn.execute(
                f"""
                SELECT skill_name, sha256
                FROM {TABLE}
                WHERE org_id = %s AND user_id = %s
                """,
                (org_id, user_id),
            )
            return {
                str(row["skill_name"]): str(row["sha256"])
                for row in conn.fetchall()
            }

    def _load_bundle(
        self, factory: Callable[[], Any], org_id: str, user_id: str, name: str
    ) -> bytes | None:
        with factory() as conn:
            conn.execute(
                f"""
                SELECT bundle
                FROM {TABLE}
                WHERE org_id = %s AND user_id = %s AND skill_name = %s
                """,
                (org_id, user_id, name),
            )
            row = conn.fetchone()
        if row is None:
            return None
        blob = row["bundle"]
        return bytes(blob) if blob is not None else None

    def _reconcile(
        self,
        factory: Callable[[], Any],
        org_id: str,
        user_id: str,
        skill_dir: Path,
        wanted: dict[str, str],
    ) -> None:
        skill_dir.mkdir(parents=True, exist_ok=True)

        for name, digest in wanted.items():
            if not _safe_skill_name(name):
                logger.warning("refusing unsafe skill name %r", name)
                continue
            target = skill_dir / name
            if _local_digest(target) == digest:
                continue
            bundle = self._load_bundle(factory, org_id, user_id, name)
            if bundle is None:
                continue
            try:
                _extract(bundle, target, digest)
            except Exception as exc:
                # One bad bundle must not stop the others from materializing.
                logger.warning(
                    "failed to materialize skill %s: %s", name, type(exc).__name__
                )

        # Drop skills the user uninstalled; otherwise this replica keeps
        # offering something that exists nowhere else.
        for child in skill_dir.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            if child.name in wanted:
                continue
            shutil.rmtree(child, ignore_errors=True)

    def reset_for_tests(self) -> None:
        with self._lock:
            self._conn_factory = None
            self._fresh_until.clear()


def _safe_skill_name(name: str) -> bool:
    """A skill name becomes a path component, so it must not traverse."""
    return (
        bool(name)
        and name not in (".", "..")
        and "/" not in name
        and "\\" not in name
        and not name.startswith(".")
    )


def _local_digest(skill_dir: Path) -> str | None:
    try:
        return (skill_dir / DIGEST_MARKER).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def _extract(bundle: bytes, target: Path, digest: str) -> None:
    """Extract a bundle into place via a staging directory.

    Staging then renaming means an execution never observes a half-written
    skill, and a failed extraction leaves the previous copy intact.
    """
    if len(bundle) > MAX_BUNDLE_BYTES:
        raise ValueError(f"skill bundle exceeds {MAX_BUNDLE_BYTES} bytes")

    staging = target.parent / f".tmp-{target.name}-{threading.get_ident()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(fileobj=BytesIO(bundle), mode="r:gz") as tar:
            for member in tar.getmembers():
                # The archive comes from our own installer, but it arrives via
                # the database and is extracted with the service's privileges —
                # so treat member paths as untrusted regardless of origin.
                _assert_contained(member.name)
                if member.issym() or member.islnk():
                    raise ValueError("skill bundles must not contain links")
                if not (member.isfile() or member.isdir()):
                    raise ValueError("skill bundles may only contain files and dirs")
            tar.extractall(staging)  # noqa: S202 — members validated above

        (staging / DIGEST_MARKER).write_text(digest, encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        staging.rename(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _assert_contained(name: str) -> None:
    path = Path(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe path in skill bundle: {name!r}")


#: Process-global materializer, installed by the internal-plane wiring.
user_skill_materializer = UserSkillMaterializer()


__all__ = [
    "DEFAULT_FRESHNESS_SECONDS",
    "DIGEST_MARKER",
    "MAX_BUNDLE_BYTES",
    "TABLE",
    "UserSkillMaterializer",
    "user_skill_materializer",
]
