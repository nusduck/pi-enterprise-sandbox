"""In-process execution supervisor for internal tool routes.

Strongly references spawned :class:`asyncio.Task` objects so client disconnect
cannot drop work. Route waiters use ``asyncio.shield`` so cancellation only
cancels the waiter; the supervised task continues to finalize.

Admission is OPEN / CLOSING / CLOSED with a strict positive ``max_active``
capacity. Closing fail-closes new work (coroutine closed, no unawaited
warning). Drain waits for in-flight tasks without cancelling them.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any, Final, TypeVar

logger = logging.getLogger("sandbox.services.internal_execution_supervisor")

T = TypeVar("T")

SUPERVISOR_STATE_OPEN: Final = "OPEN"
SUPERVISOR_STATE_CLOSING: Final = "CLOSING"
SUPERVISOR_STATE_CLOSED: Final = "CLOSED"

# Conservative default for internal tool concurrency (DoS bound).
_DEFAULT_MAX_ACTIVE: Final = 64


class SupervisorAdmissionError(RuntimeError):
    """Supervisor rejected a new task (capacity full or not OPEN)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class InternalExecutionSupervisor:
    """Track in-flight internal execution tasks; consume exceptions on done."""

    def __init__(self, *, max_active: int = _DEFAULT_MAX_ACTIVE) -> None:
        if type(max_active) is not int or isinstance(max_active, bool) or max_active < 1:
            raise ValueError("max_active must be a strict positive int")
        self._max_active = max_active
        self._state: str = SUPERVISOR_STATE_OPEN
        self._tasks: set[asyncio.Task[Any]] = set()

    @property
    def max_active(self) -> int:
        return self._max_active

    @property
    def state(self) -> str:
        return self._state

    @property
    def active_count(self) -> int:
        return len(self._tasks)

    def spawn(self, coro: Coroutine[Any, Any, T]) -> asyncio.Task[T]:
        """Schedule *coro* under admission control; retain strong ref until done.

        Admission is synchronous on a single event loop (check + create_task +
        register before any await), so concurrent waiters cannot exceed
        ``max_active``. On rejection the coroutine is closed so it is not left
        unawaited.
        """
        if self._state != SUPERVISOR_STATE_OPEN:
            coro.close()
            raise SupervisorAdmissionError(
                f"supervisor is {self._state}; not admitting new work"
            )
        if len(self._tasks) >= self._max_active:
            coro.close()
            raise SupervisorAdmissionError(
                f"supervisor at capacity ({self._max_active})"
            )

        task: asyncio.Task[T] = asyncio.create_task(coro)
        self._tasks.add(task)

        def _on_done(t: asyncio.Task[Any]) -> None:
            self._tasks.discard(t)
            try:
                exc = t.exception()
            except asyncio.CancelledError:
                return
            except Exception:  # pragma: no cover — defensive
                logger.exception("supervisor done-callback failed")
                return
            if exc is not None:
                logger.error(
                    "supervised task failed: %s",
                    type(exc).__name__,
                    exc_info=exc,
                )

        task.add_done_callback(_on_done)
        return task

    async def run_shielded(self, coro: Coroutine[Any, Any, T]) -> T:
        """Spawn *coro* and await it under shield.

        Client cancellation of the waiter does not cancel the supervised task.
        Admission failures close *coro* and raise :class:`SupervisorAdmissionError`.
        """
        task = self.spawn(coro)
        return await asyncio.shield(task)

    async def close_and_drain(self, timeout: float) -> bool:
        """Stop admitting and wait for in-flight tasks (never cancels them).

        * Sets state to CLOSING (or leaves CLOSED).
        * New ``spawn`` / ``run_shielded`` fail closed.
        * Waits up to *timeout* seconds for currently registered tasks.
        * On full drain: state becomes CLOSED and returns True.
        * On timeout: returns False, keeps strong references, leaves CLOSING
          so a later drain can finish without re-running work.

        *timeout* must be a non-negative number (int or float, not bool).
        """
        if type(timeout) not in (int, float) or isinstance(timeout, bool):
            raise ValueError("timeout must be a non-negative number")
        if timeout < 0:
            raise ValueError("timeout must be a non-negative number")

        if self._state == SUPERVISOR_STATE_CLOSED and not self._tasks:
            return True

        if self._state == SUPERVISOR_STATE_OPEN:
            self._state = SUPERVISOR_STATE_CLOSING

        pending = set(self._tasks)
        if not pending:
            self._state = SUPERVISOR_STATE_CLOSED
            return True

        _done, still = await asyncio.wait(
            pending,
            timeout=float(timeout),
            return_when=asyncio.ALL_COMPLETED,
        )
        if still:
            # Do not cancel — ledger finalization must not be interrupted.
            return False

        self._state = SUPERVISOR_STATE_CLOSED
        return True


__all__ = [
    "SUPERVISOR_STATE_CLOSED",
    "SUPERVISOR_STATE_CLOSING",
    "SUPERVISOR_STATE_OPEN",
    "InternalExecutionSupervisor",
    "SupervisorAdmissionError",
]
