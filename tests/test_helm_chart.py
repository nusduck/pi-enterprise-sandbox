"""Helm chart invariants for multi-replica deployment.

These assert the properties that make sharding work, because getting them wrong
fails silently rather than loudly: a Deployment instead of a StatefulSet still
starts, a ClusterIP node address still resolves, and a duplicated node id still
serves requests — right up until two replicas reap each other's processes.

Rendering needs the `helm` binary; the tests skip without it rather than
pretending to pass.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "deploy" / "helm" / "pi-enterprise-sandbox"

pytestmark = pytest.mark.skipif(
    shutil.which("helm") is None, reason="helm binary not available"
)

# Minimum required values; the chart refuses to render without them, which is
# itself part of the contract.
_REQUIRED = [
    "secrets.mysqlUser=pi",
    "secrets.mysqlPassword=secret",
    "secrets.internalHmacKeyring={}",
    "secrets.internalHmacActiveKid=k1",
]


def _render(*extra: str) -> list[dict]:
    cmd = ["helm", "template", "pi", str(CHART)]
    for setting in [*_REQUIRED, *extra]:
        cmd += ["--set", setting]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    import yaml  # imported lazily: only this module needs it

    return [doc for doc in yaml.safe_load_all(out) if doc]


@pytest.fixture(scope="module")
def manifests() -> list[dict]:
    return _render()


def _by_kind(manifests: list[dict], kind: str) -> list[dict]:
    return [m for m in manifests if m.get("kind") == kind]


def _named(manifests: list[dict], kind: str, suffix: str) -> dict:
    for m in _by_kind(manifests, kind):
        if str(m["metadata"]["name"]).endswith(suffix):
            return m
    raise AssertionError(f"no {kind} ending in {suffix!r}")


def test_chart_lints() -> None:
    subprocess.run(
        ["helm", "lint", str(CHART), *sum((["--set", s] for s in _REQUIRED), [])],
        capture_output=True,
        text=True,
        check=True,
    )


def test_sandbox_is_a_statefulset_with_per_pod_storage(manifests) -> None:
    """A Deployment would let two pods claim one workspace and share no volume."""
    sts = _named(manifests, "StatefulSet", "-sandbox")
    claims = {c["metadata"]["name"] for c in sts["spec"]["volumeClaimTemplates"]}
    assert claims == {"workspaces", "sandbox-tmp", "artifacts", "control"}
    for claim in sts["spec"]["volumeClaimTemplates"]:
        assert claim["spec"]["accessModes"] == ["ReadWriteOnce"], (
            "per-pod volumes are single-writer by design; RWX here would imply "
            "workspaces are shareable, which they are not"
        )
    # No Deployment may also manage the sandbox component.
    for deploy in _by_kind(manifests, "Deployment"):
        labels = deploy["spec"]["template"]["metadata"]["labels"]
        assert labels.get("app.kubernetes.io/component") != "sandbox"


def test_sandbox_node_identity_comes_from_the_pod_name(manifests) -> None:
    """Two replicas sharing a node id would reap each other's live processes."""
    sts = _named(manifests, "StatefulSet", "-sandbox")
    env = {e["name"]: e for e in sts["spec"]["template"]["spec"]["containers"][0]["env"]}

    node_id = env["SANDBOX_NODE_ID"]
    assert node_id["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.name", (
        "identity must come from the StatefulSet's stable pod name"
    )

    address = env["SANDBOX_NODE_ADDRESS"]["value"]
    assert "$(SANDBOX_NODE_ID)" in address
    assert "headless" in address, (
        "the address must be per-pod DNS; a ClusterIP would land on an "
        "arbitrary shard that has neither the workspace nor the process"
    )


def test_sandbox_headless_service_publishes_not_ready_addresses(manifests) -> None:
    """Placement can name a replica before its readiness probe passes."""
    svc = _named(manifests, "Service", "-sandbox-headless")
    assert svc["spec"]["clusterIP"] == "None"
    assert svc["spec"]["publishNotReadyAddresses"] is True


def test_sandbox_security_context_carries_the_bubblewrap_requirements(manifests) -> None:
    sts = _named(manifests, "StatefulSet", "-sandbox")
    pod = sts["spec"]["template"]["spec"]
    container = pod["containers"][0]

    assert pod["securityContext"]["seccompProfile"]["type"] == "Localhost"
    assert pod["securityContext"]["appArmorProfile"]["type"] == "Unconfined"
    # No clean Kubernetes equivalent for Docker's systempaths=unconfined.
    assert container["securityContext"]["procMount"] == "Unmasked"
    assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
    assert set(container["securityContext"]["capabilities"]["add"]) == {
        "CHOWN",
        "FOWNER",
        "SETUID",
        "SETGID",
        "KILL",
    }


def test_sandbox_workers_pinned_to_one(manifests) -> None:
    """A second worker in one pod re-breaks the in-process execution lock."""
    config = _named(manifests, "ConfigMap", "-config")
    assert config["data"]["SANDBOX_UVICORN_WORKERS"] == "1"


def test_migrations_run_once_as_a_hook_not_on_every_replica(manifests) -> None:
    job = _named(manifests, "Job", "-migrate")
    hooks = job["metadata"]["annotations"]["helm.sh/hook"]
    assert "pre-install" in hooks and "pre-upgrade" in hooks

    config = _named(manifests, "ConfigMap", "-config")
    assert config["data"]["AGENT_MIGRATE_ON_START"] == "false", (
        "N replicas racing the same DDL during a rollout is what the hook avoids"
    )


def test_bff_readiness_probe_is_self_scoped(manifests) -> None:
    """A dependency probe would fail every replica together on one blip."""
    deploy = _named(manifests, "Deployment", "-api")
    container = deploy["spec"]["template"]["spec"]["containers"][0]
    assert container["readinessProbe"]["httpGet"]["path"] == "/health/ready"
    assert container["livenessProbe"]["httpGet"]["path"] == "/health/live"
    # /health/deps exists for dashboards but must never gate endpoints.
    assert "deps" not in json.dumps(container["readinessProbe"])


def test_bff_has_writable_tmp_for_upload_spooling(manifests) -> None:
    deploy = _named(manifests, "Deployment", "-api")
    spec = deploy["spec"]["template"]["spec"]
    mounts = {m["mountPath"] for m in spec["containers"][0]["volumeMounts"]}
    assert "/tmp" in mounts, "multipart uploads spill to disk before forwarding"
    assert any("emptyDir" in v for v in spec["volumes"])


def test_stateless_components_scale_without_affinity(manifests) -> None:
    for suffix in ("-agent", "-api", "-frontend"):
        deploy = _named(manifests, "Deployment", suffix)
        assert deploy["spec"]["replicas"] >= 2, (
            f"{suffix} is stateless and should default to more than one replica"
        )


def test_agent_discovery_url_is_the_service_not_a_pod(manifests) -> None:
    """Discovery is the one call any replica may answer."""
    config = _named(manifests, "ConfigMap", "-config")
    discovery = config["data"]["SANDBOX_DISCOVERY_URL"]
    assert "headless" not in discovery
    assert discovery.endswith(":8081")


def test_no_volume_is_written_by_more_than_one_pod(manifests) -> None:
    """The chart must need no ReadWriteMany storage class at all.

    RWX was the last coupling that made a volume shared state rather than
    per-pod. User skills now live in MySQL and are materialised into a local
    cache, so a new RWX claim here would mean a new multi-writer dependency
    that deserves to be argued for explicitly.
    """
    for claim in _by_kind(manifests, "PersistentVolumeClaim"):
        assert "ReadWriteMany" not in claim["spec"]["accessModes"], (
            f"{claim['metadata']['name']} reintroduces a shared-write volume"
        )
    sts = _named(manifests, "StatefulSet", "-sandbox")
    for claim in sts["spec"]["volumeClaimTemplates"]:
        assert "ReadWriteMany" not in claim["spec"]["accessModes"]


def test_skill_cache_is_ephemeral_on_every_consumer(manifests) -> None:
    """Agent, worker and Sandbox each rebuild their own copy from MySQL."""
    consumers = ["-agent", "-agent-worker"]
    for suffix in consumers:
        spec = _named(manifests, "Deployment", suffix)["spec"]["template"]["spec"]
        volume = next(v for v in spec["volumes"] if v["name"] == "user-skills")
        assert "emptyDir" in volume, f"{suffix} skill cache must be ephemeral"

    sts_spec = _named(manifests, "StatefulSet", "-sandbox")["spec"]["template"]["spec"]
    volume = next(v for v in sts_spec["volumes"] if v["name"] == "user-skills")
    assert "emptyDir" in volume
