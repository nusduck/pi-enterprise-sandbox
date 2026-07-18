"""Child workspace quota monitoring: bounded fail-closed measurement."""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from sandbox.config import ProductionConfigError, Settings, validate_production_settings
from sandbox.services.child_workspace_quota import (
    CODE_ENFORCEMENT_FAILED,
    CODE_INODE_LIMIT,
    CODE_QUOTA_EXCEEDED,
    ChildQuotaMeasureError,
    ChildWorkspaceQuotaWatch,
    assert_child_quota_admit,
    evaluate_child_quota,
    format_decision_message,
    measure_child_quota_usage,
    measure_tree_bounded,
)
from tests.test_env_production_security import _production_kwargs


def test_admit_refuses_when_workspace_already_over(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", True)
    monkeypatch.setattr(settings, "workspace_quota_mb", 1)
    monkeypatch.setattr(settings, "temp_quota_mb", 500)
    monkeypatch.setattr(settings, "workspace_child_quota_max_entries", 100_000)
    ws = tmp_path / "ws"
    tmp = tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    (ws / "big.bin").write_bytes(b"x" * (1024 * 1024 + 512 * 1024))
    decision = assert_child_quota_admit(ws, tmp, workspace_id="w1")
    assert not decision.allow
    assert decision.code == CODE_QUOTA_EXCEEDED
    assert decision.usage is not None and decision.usage.workspace_over


def test_admit_ok_when_under_quota(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", True)
    monkeypatch.setattr(settings, "workspace_quota_mb", 10)
    monkeypatch.setattr(settings, "temp_quota_mb", 10)
    ws = tmp_path / "ws"
    tmp = tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    (ws / "small.txt").write_text("hello")
    decision = assert_child_quota_admit(ws, tmp, workspace_id="w2")
    assert decision.allow


def test_zero_byte_inode_flood_trips_entry_limit(tmp_path, monkeypatch):
    """Huge numbers of zero-byte files must not cause unbounded scan."""
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", True)
    monkeypatch.setattr(settings, "workspace_quota_mb", 500)
    monkeypatch.setattr(settings, "temp_quota_mb", 500)
    monkeypatch.setattr(settings, "workspace_child_quota_max_entries", 50)
    ws = tmp_path / "ws"
    ws.mkdir()
    for i in range(80):
        (ws / f"z{i}").write_bytes(b"")
    with pytest.raises(ChildQuotaMeasureError) as ei:
        measure_tree_bounded(ws, max_entries=50)
    assert ei.value.code == CODE_INODE_LIMIT

    decision = evaluate_child_quota(ws, None, workspace_id="flood")
    assert not decision.allow
    assert decision.code == CODE_INODE_LIMIT


def test_measurement_oserror_fails_closed(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", True)
    monkeypatch.setattr(settings, "workspace_quota_mb", 500)
    # Path that cannot be scanned as a directory tree.
    missing = tmp_path / "no-such-root-never"
    # exists() false → empty measure OK; force scandir failure via file-as-root.
    file_root = tmp_path / "not_a_dir"
    file_root.write_text("x")
    with pytest.raises(ChildQuotaMeasureError) as ei:
        measure_tree_bounded(file_root, max_entries=100)
    assert ei.value.code == CODE_ENFORCEMENT_FAILED

    decision = evaluate_child_quota(file_root, None, workspace_id="bad")
    assert not decision.allow
    assert decision.code == CODE_ENFORCEMENT_FAILED


def test_watch_fail_closed_on_inode_flood(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", True)
    monkeypatch.setattr(settings, "workspace_quota_mb", 500)
    monkeypatch.setattr(settings, "temp_quota_mb", 500)
    monkeypatch.setattr(settings, "workspace_child_quota_max_entries", 20)
    monkeypatch.setattr(settings, "workspace_child_quota_sample_interval_s", 0.5)
    ws = tmp_path / "ws"
    tmp = tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    (ws / "seed").write_text("ok")

    events: list = []
    watch = ChildWorkspaceQuotaWatch(
        workspace_path=ws,
        temp_path=tmp,
        workspace_id="w3",
        on_violation=lambda d: events.append(d),
        sample_interval_s=0.5,
    )
    watch.start()
    for i in range(40):
        (ws / f"f{i}").write_bytes(b"")
    deadline = time.time() + 5.0
    while time.time() < deadline and not events:
        time.sleep(0.1)
    watch.stop()
    assert events, "monitor must trip fail-closed on inode flood"
    assert events[0].code == CODE_INODE_LIMIT
    assert watch.exceeded


def test_watch_does_not_ignore_measurement_errors(tmp_path, monkeypatch):
    """Measurement errors must not continue the sample loop silently."""
    from sandbox.config import settings
    import sandbox.services.child_workspace_quota as cq

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", True)
    monkeypatch.setattr(settings, "workspace_quota_mb", 500)
    monkeypatch.setattr(settings, "workspace_child_quota_sample_interval_s", 0.5)

    def boom(*_a, **_k):
        raise RuntimeError("inject measure boom")

    monkeypatch.setattr(cq, "measure_child_quota_usage", boom)
    ws = tmp_path / "ws"
    ws.mkdir()
    events: list = []
    watch = ChildWorkspaceQuotaWatch(
        workspace_path=ws,
        temp_path=None,
        workspace_id="w4",
        on_violation=lambda d: events.append(d),
        sample_interval_s=0.5,
    )
    watch.start()
    deadline = time.time() + 4.0
    while time.time() < deadline and not events:
        time.sleep(0.1)
    watch.stop()
    assert events
    assert events[0].code == CODE_ENFORCEMENT_FAILED
    assert "boom" in format_decision_message(events[0])


def test_enforcement_disabled_skips_admit(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_child_quota_enforcement", False)
    monkeypatch.setattr(settings, "workspace_quota_mb", 1)
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "big.bin").write_bytes(b"z" * (2 * 1024 * 1024))
    assert assert_child_quota_admit(ws, None, workspace_id="w5").allow


def test_production_requires_monitoring_and_hard_backend_assertion():
    s = Settings(
        **_production_kwargs(
            workspace_quota_mb=500,
            temp_quota_mb=500,
            workspace_child_quota_enforcement=True,
            workspace_quota_hard_backend_asserted=False,
        )
    )
    with pytest.raises(ProductionConfigError, match="HARD_BACKEND_ASSERTED"):
        validate_production_settings(s)

    s2 = Settings(
        **_production_kwargs(
            workspace_quota_mb=500,
            workspace_child_quota_enforcement=False,
            workspace_quota_hard_backend_asserted=True,
        )
    )
    with pytest.raises(ProductionConfigError, match="CHILD_QUOTA_ENFORCEMENT"):
        validate_production_settings(s2)


def test_production_passes_with_monitoring_and_hard_backend():
    s = Settings(
        **_production_kwargs(
            workspace_quota_mb=500,
            workspace_child_quota_enforcement=True,
            workspace_quota_hard_backend_asserted=True,
            workspace_child_quota_sample_interval_s=2.0,
            workspace_child_quota_max_entries=100_000,
        )
    )
    validate_production_settings(s)


def test_measure_includes_both_trees(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspace_quota_mb", 100)
    monkeypatch.setattr(settings, "temp_quota_mb", 100)
    monkeypatch.setattr(settings, "workspace_child_quota_max_entries", 100_000)
    ws = tmp_path / "ws"
    tmp = tmp_path / "tmp"
    ws.mkdir()
    tmp.mkdir()
    (ws / "a").write_bytes(b"a" * 100)
    (tmp / "b").write_bytes(b"b" * 50)
    usage = measure_child_quota_usage(ws, tmp, workspace_id=None, reserved_bytes=0)
    assert usage.workspace_bytes == 100
    assert usage.temp_bytes == 50
