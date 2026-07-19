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


def test_read_pid_namespace_id_parses_proc_ns_link(monkeypatch):
    monkeypatch.setattr(process_identity.sys, "platform", "linux")
    monkeypatch.setattr(
        process_identity.os,
        "readlink",
        lambda path: "pid:[4026531836]" if path == "/proc/42/ns/pid" else (_ for _ in ()).throw(FileNotFoundError()),
    )
    assert process_identity.read_pid_namespace_id(42) == "pid:4026531836"


def test_find_pid_namespace_init_selects_child_with_nspid_1(monkeypatch):
    monkeypatch.setattr(process_identity.sys, "platform", "linux")

    def fake_open(path, *args, **kwargs):
        if path == "/proc/100/task/100/children":
            return io.StringIO("200 201\n")
        if path == "/proc/200/status":
            return io.StringIO("Name:\tbwrap\nNSpid:\t200 5\n")
        if path == "/proc/201/status":
            return io.StringIO("Name:\tsleep\nNSpid:\t201 1\n")
        raise FileNotFoundError(path)

    monkeypatch.setattr("builtins.open", fake_open)
    assert process_identity.find_pid_namespace_init(100, attempts=1, delay_seconds=0) == 201
