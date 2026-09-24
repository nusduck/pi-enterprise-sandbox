"""OrbStack 本地 K8s 清单与 up.sh 的发布/生命周期约束（K8s 部署评审 2026-09-19，K3–K5）。

- K3：所有用本地固定 tag 镜像（imagePullPolicy: Never）的 Deployment 都要在 up.sh 的重启列表里，
  否则重建镜像后 Pod 模板不变、不会滚动（frontend 曾漏掉）；
- K4：Worker 的终止宽限必须大于应用的排空期限 AGENT_WORKER_DRAIN_TIMEOUT_MS 默认值加关停尾部；
- K5：Agent HTTP 在启动链走完后才 listen，必须有 startupProbe；探针都显式给 timeoutSeconds，
  且 readiness 超时不小于应用自身的依赖检查预算。

清单是 flow 风格的单行映射，这里按行正则解析，不依赖 PyYAML。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
K8S = ROOT / "scripts" / "dev" / "k8s"
MANIFESTS = (K8S / "manifests.yaml").read_text(encoding="utf-8")
UP_SH = (K8S / "up.sh").read_text(encoding="utf-8")

# 与 agent/src/bootstrap/worker-drain.ts 的 DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS 对齐。
WORKER_DRAIN = (ROOT / "agent" / "src" / "bootstrap" / "worker-drain.ts").read_text(encoding="utf-8")
# 关停尾部：清理上限 + 关探针 listener（2s）+ 余量。
PROBE_CLOSE_SECONDS = 2


def _deployments() -> dict[str, str]:
    out: dict[str, str] = {}
    for doc in MANIFESTS.split("\n---"):
        if not re.search(r"(?m)^kind: Deployment\s*$", doc):
            continue
        name = re.search(r"(?m)^metadata: \{ name: ([\w-]+),", doc)
        assert name, doc[:200]
        out[name.group(1)] = doc
    return out


def _probe(doc: str, kind: str) -> str | None:
    match = re.search(rf"(?m)^\s+{kind}: (\{{.*\}})\s*$", doc)
    return match.group(1) if match else None


def _int_field(probe: str, field: str) -> int | None:
    match = re.search(rf"\b{field}: (\d+)", probe)
    return int(match.group(1)) if match else None


def test_up_sh_restarts_every_locally_built_deployment() -> None:
    local = {
        name
        for name, doc in _deployments().items()
        if re.search(r"(?m)^\s+imagePullPolicy: Never\s*$", doc)
    }
    assert "frontend" in local
    listed = re.search(r'(?m)^APP_DEPLOYMENTS="([^"]+)"', UP_SH)
    assert listed, "up.sh must name the restarted deployments in APP_DEPLOYMENTS"
    assert set(listed.group(1).split()) == local
    assert re.search(r"rollout restart \$\(printf 'deployment/%s ' \$APP_DEPLOYMENTS\)", UP_SH)


def test_worker_grace_covers_drain_deadline() -> None:
    drain_ms = re.search(r"DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS = ([\d_]+);", WORKER_DRAIN)
    assert drain_ms
    drain_seconds = int(drain_ms.group(1).replace("_", "")) / 1000
    teardown_ms = re.search(r"WORKER_TEARDOWN_TIMEOUT_MS = ([\d_]+);", WORKER_DRAIN)
    assert teardown_ms
    teardown_seconds = int(teardown_ms.group(1).replace("_", "")) / 1000
    worker = _deployments()["agent-worker"]
    grace = re.search(r"terminationGracePeriodSeconds: (\d+)", worker)
    assert grace
    # 期限从收到信号起算，覆盖整个排空；之后是有上限的清理，再关探针。
    assert int(grace.group(1)) > drain_seconds + teardown_seconds + PROBE_CLOSE_SECONDS


def test_agent_http_has_startup_probe_before_liveness() -> None:
    agent = _deployments()["agent"]
    startup = _probe(agent, "startupProbe")
    assert startup, "Agent listens only after MCP preflight / DBPM / schema check"
    budget = (_int_field(startup, "periodSeconds") or 10) * (_int_field(startup, "failureThreshold") or 3)
    # MCP SDK 对无响应服务器的初始化超时是 60s，外加 DBPM、建连与 schema 核对。
    assert budget >= 120


def test_every_probe_sets_a_timeout() -> None:
    for name, doc in _deployments().items():
        for kind in ("startupProbe", "livenessProbe", "readinessProbe"):
            probe = _probe(doc, kind)
            if probe is None:
                continue
            assert _int_field(probe, "timeoutSeconds"), f"{name} {kind} relies on the 1s default"


def test_readiness_timeouts_cover_dependency_budgets() -> None:
    # 各服务 /ready 内部最长依赖检查（秒）：Agent 并行 data plane 2s / 执行面 3s；
    # BFF 并行 Agent 4s / 执行面 3s；Worker 与 facade 并行各 2s。
    budgets = {"agent": 3, "api-server": 4, "agent-worker": 2, "sandbox-mcp": 2}
    deployments = _deployments()
    for name, budget in budgets.items():
        probe = _probe(deployments[name], "readinessProbe")
        assert probe
        assert (_int_field(probe, "timeoutSeconds") or 1) > budget, name
