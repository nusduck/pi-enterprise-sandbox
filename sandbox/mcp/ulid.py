"""Pure-Python Crockford Base32 ULID generator (no external deps).

Compatible with formal domain IDs: 26 uppercase Crockford characters.
Not UUID and never produces ``exec_...`` prefixes.
"""

from __future__ import annotations

import os
import threading
import time

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CROCKFORD_LEN = 32

# Entropy is 80 bits (10 bytes); time component is 48 bits (ms).
_RANDOM_BYTES = 10

_lock = threading.Lock()
_last_ms: int = -1
_last_random: bytearray | None = None


def _encode_time(ms: int) -> str:
    if ms < 0 or ms >= (1 << 48):
        raise ValueError("ULID time component out of range")
    chars = ["\0"] * 10
    for i in range(9, -1, -1):
        chars[i] = _CROCKFORD[ms & 0x1F]
        ms >>= 5
    return "".join(chars)


def _encode_random(raw: bytes) -> str:
    if len(raw) != _RANDOM_BYTES:
        raise ValueError("ULID entropy must be 10 bytes")
    # 80 bits → 16 Crockford chars
    n = int.from_bytes(raw, "big")
    chars = ["\0"] * 16
    for i in range(15, -1, -1):
        chars[i] = _CROCKFORD[n & 0x1F]
        n >>= 5
    return "".join(chars)


def _increment_random(buf: bytearray) -> bool:
    """Increment 10-byte entropy in place; return False on overflow."""
    for i in range(len(buf) - 1, -1, -1):
        if buf[i] == 0xFF:
            buf[i] = 0
            continue
        buf[i] = (buf[i] + 1) & 0xFF
        return True
    return False


def new_ulid() -> str:
    """Generate a new monotonic-within-ms ULID (uppercase Crockford)."""
    global _last_ms, _last_random
    with _lock:
        ms = int(time.time() * 1000)
        if ms > _last_ms:
            _last_ms = ms
            _last_random = bytearray(os.urandom(_RANDOM_BYTES))
        else:
            # Same ms or clock went backwards → bump entropy.
            if _last_random is None:
                _last_random = bytearray(os.urandom(_RANDOM_BYTES))
            elif not _increment_random(_last_random):
                raise RuntimeError("ULID entropy exhausted within the same millisecond")
            ms = _last_ms
        return _encode_time(ms) + _encode_random(bytes(_last_random))


__all__ = ["new_ulid"]
