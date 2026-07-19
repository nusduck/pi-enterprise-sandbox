"""PID identity parsing tests for crash-safe process recovery."""

from __future__ import annotations

import io

from sandbox.services import process_identity


def test_linux_starttime_reads_kernel_field_22(monkeypatch):
    fields = ["0"] * 52
    fields[22 - 4] = "987654321"
    stat = "42 (worker (nested)) S " + " ".join(fields) + "\n"

    def fake_open(path, *args, **kwargs):
        assert path == "/proc/42/stat"
        return io.StringIO(stat)

    monkeypatch.setattr("builtins.open", fake_open)

    assert process_identity.read_linux_starttime(42) == "linux-starttime:987654321"


def test_linux_starttime_rejects_short_stat(monkeypatch):
    monkeypatch.setattr("builtins.open", lambda *args, **kwargs: io.StringIO("42 (x) S 1 2"))

    assert process_identity.read_linux_starttime(42) is None
