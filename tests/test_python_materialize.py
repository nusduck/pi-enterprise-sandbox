"""PR-08: Python tool materialization, args, injection resistance."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from sandbox.config import settings
from sandbox.paths import temp_id_for_workspace_id
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.execution_manager import ExecutionManager
from sandbox.services.python_materialize import (
    PYTHON_INLINE_MAX_BYTES,
    plan_python_launch,
    should_materialize,
)


@pytest.fixture
def relax_limits(monkeypatch):
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)


@pytest.fixture
def ctx(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    temp = tmp_path / "temp"
    temp.mkdir()
    return SandboxExecutionContext(
        session_id="s1",
        workspace_id="ws1",
        temp_id="tmp_ws1",
        physical_workspace=ws,
        physical_temp=temp,
        user_id="user_a",
    )


class TestShouldMaterialize:
    def test_short_single_line_inline(self):
        assert should_materialize("print(1)") is False

    def test_multiline_materializes(self):
        assert should_materialize("print(1)\nprint(2)") is True

    def test_long_single_line_materializes(self):
        code = "x = " + ("a" * (PYTHON_INLINE_MAX_BYTES + 10))
        assert should_materialize(code) is True


class TestPlanPythonLaunch:
    def test_inline_argv_no_shell(self, ctx):
        plan = plan_python_launch(
            code="print('hi')",
            execution_id="exec_abc",
            context=ctx,
            args=["--flag", "value"],
        )
        assert plan.mode == "inline"
        assert plan.argv[0] == "python3"
        assert plan.argv[1] == "-c"
        assert plan.argv[2] == "print('hi')"
        assert plan.argv[3:] == ["--flag", "value"]
        assert plan.materialized_path is None

    def test_multiline_atomic_workspace_file(self, ctx):
        code = "import sys\nprint(sys.argv[1])\n"
        plan = plan_python_launch(
            code=code,
            execution_id="exec_ml01",
            context=ctx,
            args=["arg1"],
            isolation_backend="direct",
        )
        assert plan.mode == "file"
        assert plan.materialized_path is not None
        assert ".runtime/python/exec_ml01.py" in plan.materialized_path
        assert plan.physical_path is not None
        assert plan.physical_path.is_file()
        assert plan.physical_path.read_text(encoding="utf-8") == code
        assert plan.argv[:2] == ["python3", "-u"]
        assert plan.argv[-1] == "arg1"
        # Must stay under workspace (no escape).
        plan.physical_path.resolve().relative_to(ctx.physical_workspace.resolve())

    def test_injection_code_not_shell_joined(self, ctx):
        evil = "print(1); import os; os.system('echo pwned')"
        plan = plan_python_launch(
            code=evil,
            execution_id="exec_inj",
            context=ctx,
        )
        # Still list argv; no bash -c wrapping.
        assert plan.argv[0] == "python3"
        assert "-c" in plan.argv or plan.mode == "file"
        assert all(x != "bash" for x in plan.argv)

    def test_rejects_nul_and_oversized_args(self, ctx):
        with pytest.raises(ValueError):
            plan_python_launch(
                code="print(1)",
                execution_id="exec_x",
                context=ctx,
                args=["a\x00b"],
            )
        with pytest.raises(ValueError):
            plan_python_launch(
                code="print(1)",
                execution_id="exec_x",
                context=ctx,
                args=["x" * 2000],
            )


class TestExecutionManagerPython:
    def test_multiline_runs_and_returns_metadata(self, relax_limits, ctx):
        mgr = ExecutionManager()
        code = "print('hello-ml')\nprint('line2')\n"
        result = mgr.run_python("s1", code, context=ctx, timeout=30)
        assert result.get("status") in ("SUCCESS", "success")
        assert "hello-ml" in (result.get("stdout_preview") or "")
        assert result.get("python_mode") == "file"
        assert result.get("materialized_path")
        # Intermediate file remains under workspace .runtime
        mat = ctx.physical_workspace / ".runtime" / "python"
        assert any(mat.glob("*.py"))

    def test_inline_short(self, relax_limits, ctx):
        mgr = ExecutionManager()
        result = mgr.run_python("s1", "print(42)", context=ctx, timeout=30)
        assert result.get("status") in ("SUCCESS", "success")
        assert "42" in (result.get("stdout_preview") or "")
        assert result.get("python_mode") == "inline"
        assert result.get("materialized_path") is None

    def test_args_passed(self, relax_limits, ctx):
        mgr = ExecutionManager()
        code = "import sys\nprint(sys.argv[1])\n"
        result = mgr.run_python(
            "s1", code, context=ctx, timeout=30, args=["from-args"]
        )
        assert result.get("status") in ("SUCCESS", "success")
        assert "from-args" in (result.get("stdout_preview") or "")

    def test_invalid_code_rejected(self, relax_limits, ctx):
        mgr = ExecutionManager()
        result = mgr.run_python("s1", "", context=ctx)
        assert result.get("status") == "invalid"
