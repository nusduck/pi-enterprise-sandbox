"""VM exec release 资产的静态契约（design §9.1 / §9.2）。

不构建、不联网。运行期行为（安装、启动、停止、回滚）在带 systemd 的容器里演练，
证据见 docs/evidence；这里守住容易悄悄漂移的几条：

- env 模板只列 exec 代码真正读取的变量（Compose 里大量 Python 时代变量已无读取方）；
- unit 不启用会让 Bubblewrap 失效的加固项，且以非 root、ExecStartPre 预检、KillMode=mixed 运行；
- Node 位于 bwrap 可见的 /usr 下；release 必须带运行期读取的 contract/schema；
- 脚本语法正确、可执行，模板里没有真实凭据。
"""

from __future__ import annotations

import re
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
VM = ROOT / "deploy" / "vm"
UNIT = VM / "dsh-exec.service"
ENV_EXAMPLE = VM / "exec.env.example"
PREFLIGHT = VM / "exec-preflight.sh"
INSTALL = VM / "install-release.sh"
BUILDER = ROOT / "scripts" / "vm" / "release-builder.Dockerfile"
BUILD_SCRIPT = ROOT / "scripts" / "vm" / "build-exec-release.sh"
MANIFEST_WRITER = ROOT / "scripts" / "vm" / "write-release-manifest.mjs"


def _unit_directives() -> dict[str, list[str]]:
    directives: dict[str, list[str]] = {}
    for raw in UNIT.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "[")):
            continue
        key, _, value = line.partition("=")
        directives.setdefault(key.strip(), []).append(value.strip())
    return directives


def _env_keys() -> list[str]:
    keys = []
    for raw in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("#"):
            line = line.lstrip("#").strip()
            if not re.match(r"^[A-Z][A-Z0-9_]*=", line):
                continue
        if not line:
            continue
        key = line.split("=", 1)[0]
        keys.append(key)
    return keys


def _source_text() -> str:
    parts = []
    for base in (ROOT / "exec" / "src", ROOT / "contract" / "src"):
        for path in base.rglob("*.ts"):
            parts.append(path.read_text(encoding="utf-8"))
    return "\n".join(parts)


def test_env_template_only_lists_variables_exec_reads() -> None:
    source = _source_text()
    for key in _env_keys():
        if key in {"LANG", "LC_ALL"}:
            continue
        if key.startswith("SANDBOX_EXEC_ENV_"):
            continue
        assert f"'{key}'" in source or f'"{key}"' in source or f".{key}" in source, (
            f"{key} is in exec.env.example but no exec/contract source reads it"
        )


def test_env_template_has_only_placeholders_for_credentials() -> None:
    text = ENV_EXAMPLE.read_text(encoding="utf-8")
    for key in (
        "SANDBOX_INTERNAL_HMAC_KEYRING",
        "SANDBOX_API_TOKEN",
        "SANDBOX_MCP_INTERNAL_TOKEN",
        "DBPM_URL",
    ):
        match = re.search(rf"^{key}=(.*)$", text, re.M)
        assert match, key
        assert match.group(1).startswith("<"), f"{key} must be a placeholder"
    assert not re.search(r"^EXEC_DATABASE_URL=mysql://[^@<]*:[^@]*@", text, re.M), "DSN must not embed a password"


def test_preflight_requires_what_the_template_marks_required() -> None:
    text = PREFLIGHT.read_text(encoding="utf-8")
    for key in (
        "EXEC_DATABASE_URL",
        "DBPM_URL",
        "SANDBOX_INTERNAL_HMAC_KEYRING",
        "SANDBOX_API_TOKEN",
        "SANDBOX_MCP_INTERNAL_TOKEN",
        "EXEC_INTERNAL_ALLOW_CIDR",
        "SANDBOX_WORKSPACES_ROOT",
        "SANDBOX_CONTROL_ROOT",
    ):
        assert key in text, key
        assert key in _env_keys(), key


def test_unit_runs_non_root_with_preflight_and_cgroup_cleanup() -> None:
    d = _unit_directives()
    assert d["User"] == ["dsh-exec"]
    assert d["EnvironmentFile"] == ["/etc/dsh-exec/exec.env"]
    assert d["ExecStartPre"] == ["/opt/dsh-exec/current/vm/exec-preflight.sh"]
    assert d["ExecStart"] == ["/usr/local/bin/node dist/main.js"]
    assert d["WorkingDirectory"] == ["/opt/dsh-exec/current/exec"]
    assert d["KillMode"] == ["mixed"]
    assert d["NoNewPrivileges"] == ["yes"]
    assert d["ProtectSystem"] == ["strict"]
    assert "/var/lib/dsh-exec" in d["ReadWritePaths"][0]


@pytest.mark.parametrize(
    "directive",
    [
        # 实测让 bwrap 失败、exec 拒启（见 docs/evidence/s2f-*.md）
        "RestrictNamespaces",
        "ProcSubset",
        # systemd 252 兼容，openEuler 24.03 systemd 255 上任一项单独开启即让 bwrap 挂不上 procfs
        "ProtectKernelTunables",
        "ProtectKernelLogs",
        # 未评估或已知不适用
        "PrivateUsers",
        "SystemCallFilter",
        "MemoryDenyWriteExecute",
    ],
)
def test_unit_avoids_directives_that_break_bubblewrap(directive: str) -> None:
    assert directive not in _unit_directives(), directive


def test_unit_keeps_hardening_measured_compatible_with_bubblewrap() -> None:
    d = _unit_directives()
    assert d.get("ProtectProc") == ["invisible"]
    assert d.get("CapabilityBoundingSet") == [""]


def test_node_binary_lives_where_bubblewrap_can_see_it() -> None:
    exec_start = _unit_directives()["ExecStart"][0]
    assert exec_start.startswith("/usr/"), exec_start
    assert 'NODE_BIN="${DSH_EXEC_NODE:-/usr/local/bin/node}"' in PREFLIGHT.read_text(encoding="utf-8")


def test_builder_ships_runtime_files_and_builds_on_target_platform() -> None:
    builder = BUILDER.read_text(encoding="utf-8")
    assert "COPY --from=build /src/contract/schema ./contract/schema" in builder
    assert "npm ci --omit=dev" in builder
    assert "COPY deploy/vm ./vm" in builder
    assert re.search(r"^FROM node:22-slim AS build$", builder, re.M)
    script = BUILD_SCRIPT.read_text(encoding="utf-8")
    assert '--platform "linux/${ARCH}"' in script
    assert "--allow-dirty" in script and "exit 65" in script
    writer = MANIFEST_WRITER.read_text(encoding="utf-8")
    for field in ("git_sha", "git_dirty", "schema_manifest_sha256", "native_modules", "SHA256SUMS"):
        assert field in writer, field


def test_install_script_never_restarts_the_service() -> None:
    text = INSTALL.read_text(encoding="utf-8")
    assert "systemctl restart" not in re.sub(r'echo "[^"]*"', "", text)
    assert "releases are immutable" in text
    assert "sha256sum --quiet --strict -c" in text


@pytest.mark.parametrize("script", [PREFLIGHT, INSTALL, BUILD_SCRIPT])
def test_scripts_are_executable_and_parse(script: Path) -> None:
    assert script.stat().st_mode & stat.S_IXUSR, script
    shell = "sh" if script.read_text(encoding="utf-8").startswith("#!/bin/sh") else "bash"
    result = subprocess.run([shell, "-n", str(script)], capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
