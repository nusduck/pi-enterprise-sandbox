"""K8s 内运行的镜像统一以 up_docker（1000:1000）运行（目标环境要求，2026-09-18 用户确认）。

- agent（含 agent-worker）、api-server、sandbox-mcp facade、frontend 的终态 USER 都是数字 `1000:1000`：
  写名字时 K8s 的 runAsNonRoot 无法校验，会拒绝建容器；
- 镜像里 uid 1000 的用户名是 up_docker；
- frontend 以非 root 运行，只能监听非特权端口 8080，Compose 与边缘 nginx 跟着改；
- 执行面镜像（bwrap 隔离内 uid 映射）与 VM 上的 exec 不在此列，仍是 10001。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _final_stage(dockerfile: Path) -> str:
    text = dockerfile.read_text(encoding="utf-8")
    return re.split(r"(?m)^FROM ", text)[-1]


def _stage(dockerfile: Path, name: str) -> str:
    text = dockerfile.read_text(encoding="utf-8")
    for block in re.split(r"(?m)^FROM ", text)[1:]:
        if re.match(rf"\S+ AS {re.escape(name)}\s*$", block.splitlines()[0]):
            return block
    raise AssertionError(f"{dockerfile} has no stage {name}")


@pytest.mark.parametrize(
    "stage",
    [
        pytest.param(lambda: _final_stage(ROOT / "agent" / "Dockerfile"), id="agent"),
        pytest.param(lambda: _final_stage(ROOT / "api-server" / "Dockerfile"), id="api-server"),
        pytest.param(lambda: _stage(ROOT / "exec" / "Dockerfile", "facade"), id="sandbox-mcp"),
        pytest.param(lambda: _final_stage(ROOT / "frontend" / "Dockerfile"), id="frontend"),
    ],
)
def test_k8s_images_run_as_up_docker(stage) -> None:
    text = stage()
    users = re.findall(r"(?m)^USER (\S+)$", text)
    assert users and users[-1] == "1000:1000", users
    assert "up_docker" in text


def test_execution_plane_image_keeps_its_isolation_uid() -> None:
    assert re.findall(r"(?m)^USER (\S+)$", _final_stage(ROOT / "exec" / "Dockerfile"))[-1] == "10001:10001"


def test_compose_runs_facade_as_up_docker() -> None:
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    block = compose.split("\n  sandbox-mcp:\n", 1)[1].split("\n  # ──", 1)[0]
    assert 'user: "1000:1000"' in block
    assert "10001" not in block


def test_frontend_listens_on_unprivileged_port_everywhere() -> None:
    template = (ROOT / "frontend" / "nginx" / "default.conf.template").read_text(encoding="utf-8")
    assert re.search(r"(?m)^\s*listen 8080;", template)
    assert not re.search(r"(?m)^\s*listen 80;", template)
    assert re.search(r"(?m)^EXPOSE 8080$", _final_stage(ROOT / "frontend" / "Dockerfile"))
    compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
    assert '"127.0.0.1:${FRONTEND_PORT:-3000}:8080"' in compose
    locations = (ROOT / "nginx" / "templates" / "locations.conf").read_text(encoding="utf-8")
    assert "proxy_pass http://frontend:8080;" in locations
    assert "frontend:80;" not in locations
