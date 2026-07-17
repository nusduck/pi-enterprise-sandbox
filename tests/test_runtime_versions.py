"""Machine-checkable runtime / SDK version pin consistency (PR-01).

Single source of truth: ``runtime-versions.json`` at the repo root.
This suite only reads manifests, Dockerfiles, CI, and docs — no network,
no package installs, no business behavior.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PINS_PATH = REPO_ROOT / "runtime-versions.json"


@pytest.fixture(scope="module")
def pins() -> dict:
    assert PINS_PATH.is_file(), "runtime-versions.json must exist at repo root"
    data = json.loads(PINS_PATH.read_text(encoding="utf-8"))
    assert "node" in data and "python" in data and "pi_sdk" in data
    return data


def _read(rel: str) -> str:
    return (REPO_ROOT / rel).read_text(encoding="utf-8")


def _read_json(rel: str) -> dict:
    return json.loads(_read(rel))


# ── SSOT shape ──────────────────────────────────────────────────────────────


def test_pins_declare_fixed_baselines(pins: dict) -> None:
    assert pins["node"]["major"] == 22
    assert pins["node"]["ci"] == "22"
    assert pins["node"]["docker_image"] == "node:22-slim"
    assert pins["node"]["engines"] == ">=22.19.0 <23"
    assert pins["python"]["major_minor"] == "3.11"
    assert pins["python"]["ci"] == "3.11"
    assert pins["python"]["docker_image"] == "python:3.11-slim"
    assert pins["python"]["requires"] == ">=3.11,<3.12"
    assert pins["pi_sdk"]["pi_coding_agent"] == "0.80.3"
    assert pins["pi_sdk"]["pi_ai"] == "0.80.3"
    assert pins["sandbox_tooling_node"]["nodesource_setup"] == "setup_22.x"


def test_version_files_match_pins(pins: dict) -> None:
    assert _read(".node-version").strip() == pins["node"]["file"]
    assert _read(".python-version").strip() == pins["python"]["file"]


# ── package.json engines + Pi SDK exact pins ────────────────────────────────


@pytest.mark.parametrize(
    "rel",
    [
        "agent/package.json",
        "api-server/package.json",
        "frontend/package.json",
        "agent/packages/enterprise-agent-kit/package.json",
    ],
)
def test_package_engines_match_pins(pins: dict, rel: str) -> None:
    pkg = _read_json(rel)
    engines = pkg.get("engines") or {}
    assert engines.get("node") == pins["node"]["engines"], rel


def test_agent_sdk_exact_pins(pins: dict) -> None:
    pkg = _read_json("agent/package.json")
    deps = pkg.get("dependencies") or {}
    coding = pins["pi_sdk"]["package_names"]["pi_coding_agent"]
    ai = pins["pi_sdk"]["package_names"]["pi_ai"]
    assert deps.get(coding) == pins["pi_sdk"]["pi_coding_agent"]
    assert deps.get(ai) == pins["pi_sdk"]["pi_ai"]
    # exact pin: no range operators
    for name in (coding, ai):
        spec = deps[name]
        assert re.fullmatch(r"\d+\.\d+\.\d+", spec), f"{name} must be exact x.y.z, got {spec}"


def test_enterprise_kit_peer_pins(pins: dict) -> None:
    pkg = _read_json("agent/packages/enterprise-agent-kit/package.json")
    peers = pkg.get("peerDependencies") or {}
    coding = pins["pi_sdk"]["package_names"]["pi_coding_agent"]
    ai = pins["pi_sdk"]["package_names"]["pi_ai"]
    assert peers.get(coding) == pins["pi_sdk"]["pi_coding_agent"]
    assert peers.get(ai) == pins["pi_sdk"]["pi_ai"]


def test_api_server_does_not_depend_on_sdk(pins: dict) -> None:
    pkg = _read_json("api-server/package.json")
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    coding = pins["pi_sdk"]["package_names"]["pi_coding_agent"]
    ai = pins["pi_sdk"]["package_names"]["pi_ai"]
    assert coding not in deps
    assert ai not in deps


def test_frontend_does_not_depend_on_coding_agent_sdk(pins: dict) -> None:
    pkg = _read_json("frontend/package.json")
    deps = {**(pkg.get("dependencies") or {}), **(pkg.get("devDependencies") or {})}
    coding = pins["pi_sdk"]["package_names"]["pi_coding_agent"]
    assert coding not in deps
    # Removed unused pi-web-ui (no imports in frontend/src); must stay absent.
    assert "@earendil-works/pi-web-ui" not in deps


def test_frontend_declares_types_node_explicitly(pins: dict) -> None:
    """vite.config.ts imports ``node:url``; types must not come from transitive deps.

    After removing unused ``pi-web-ui``, builds failed without a direct ``@types/node``.
    Pin major must match the Node 22 service baseline (not host Node 26 types).
    """
    pkg = _read_json("frontend/package.json")
    dev = pkg.get("devDependencies") or {}
    assert "@types/node" in dev, "@types/node must be a direct frontend devDependency"
    expected = pins["frontend_dev_types"]["types_node"]
    spec = dev["@types/node"]
    assert spec == expected, f"expected exact @types/node {expected}, got {spec}"
    assert re.fullmatch(r"\d+\.\d+\.\d+", spec), f"@types/node must be exact x.y.z, got {spec}"
    major = int(spec.split(".")[0])
    assert major == pins["frontend_dev_types"]["types_node_major"]
    assert major == pins["node"]["major"]

    lock = _read_json("frontend/package-lock.json")
    root_dev = (lock.get("packages") or {}).get("", {}).get("devDependencies") or {}
    assert root_dev.get("@types/node") == expected
    entry = (lock.get("packages") or {}).get("node_modules/@types/node") or {}
    assert entry.get("version") == expected


def test_agent_lockfile_pins_match_package_json(pins: dict) -> None:
    pkg = _read_json("agent/package.json")
    lock = _read_json("agent/package-lock.json")
    root_deps = (lock.get("packages") or {}).get("", {}).get("dependencies") or {}
    coding = pins["pi_sdk"]["package_names"]["pi_coding_agent"]
    ai = pins["pi_sdk"]["package_names"]["pi_ai"]
    assert root_deps.get(coding) == pkg["dependencies"][coding]
    assert root_deps.get(ai) == pkg["dependencies"][ai]
    # installed package versions when present in lock
    for name, key in (
        (coding, f"node_modules/{coding}"),
        (ai, f"node_modules/{ai}"),
    ):
        entry = (lock.get("packages") or {}).get(key)
        if entry is not None:
            assert entry.get("version") == pins["pi_sdk"][
                "pi_coding_agent" if name == coding else "pi_ai"
            ]


# ── Python requires-python ──────────────────────────────────────────────────


def test_pyproject_requires_python(pins: dict) -> None:
    text = _read("pyproject.toml")
    # exact requires-python assignment
    m = re.search(r'(?m)^requires-python\s*=\s*"([^"]+)"\s*$', text)
    assert m, "requires-python missing in pyproject.toml"
    assert m.group(1) == pins["python"]["requires"]


def test_uv_lock_requires_python(pins: dict) -> None:
    text = _read("uv.lock")
    m = re.search(r'(?m)^requires-python\s*=\s*"([^"]+)"\s*$', text)
    assert m, "requires-python missing in uv.lock"
    assert m.group(1) == pins["python"]["requires"]


def test_pyproject_has_no_unused_service_deps() -> None:
    """Service pyproject must not reintroduce statically unused deps.

    Evidence (PR-01 audit): no ``import aiofiles`` / ``import sqlalchemy`` under
    sandbox/ or tests/. sqlalchemy remains allowed in sandbox/requirements.txt
    for agent-executed workload tooling inside the container.
    """
    text = _read("pyproject.toml")
    # extract dependencies array roughly
    assert "aiofiles" not in text
    assert "sqlalchemy" not in text


# ── Dockerfiles ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "rel",
    [
        "agent/Dockerfile",
        "api-server/Dockerfile",
        "frontend/Dockerfile",
    ],
)
def test_node_service_dockerfiles_use_pinned_image(pins: dict, rel: str) -> None:
    text = _read(rel)
    image = pins["node"]["docker_image"]
    assert re.search(rf"^FROM\s+{re.escape(image)}\b", text, re.M), rel
    # reproducible installs where a lockfile exists
    assert "npm ci" in text, rel


def test_sandbox_dockerfile_python_and_tooling_node(pins: dict) -> None:
    text = _read("sandbox/Dockerfile")
    assert re.search(
        rf"^FROM\s+{re.escape(pins['python']['docker_image'])}\b",
        text,
        re.M,
    )
    setup = pins["sandbox_tooling_node"]["nodesource_setup"]
    assert setup in text
    assert "setup_20.x" not in text


# ── GitHub Actions ──────────────────────────────────────────────────────────


def test_github_actions_versions(pins: dict) -> None:
    text = _read(".github/workflows/test.yml")
    assert re.search(
        rf'(?m)^  NODE_VERSION:\s*"{re.escape(pins["node"]["ci"])}"\s*$',
        text,
    )
    assert re.search(
        rf'(?m)^  PYTHON_VERSION:\s*"{re.escape(pins["python"]["ci"])}"\s*$',
        text,
    )
    # jobs must consume the shared env (not hard-code divergent majors)
    assert "node-version: ${{ env.NODE_VERSION }}" in text
    assert "uv python install ${{ env.PYTHON_VERSION }}" in text
    assert 'node-version: "20"' not in text
    assert "uv python install 3.12" not in text
    assert "uv python install 3.10" not in text


# ── Active docs (light) ─────────────────────────────────────────────────────


def test_active_docs_mention_pinned_majors(pins: dict) -> None:
    """Active developer-facing docs must not advertise stale Node 20 / open-ended pins only."""
    contributing = _read("CONTRIBUTING.md")
    development = _read("docs/development.md")
    # CONTRIBUTING previously said Node.js 20+
    assert "Node.js 20+" not in contributing
    assert f"Node.js {pins['node']['major']}" in contributing or f"Node {pins['node']['major']}" in contributing
    assert f"Python {pins['python']['major_minor']}" in contributing
    assert f"Node.js {pins['node']['major']}" in development or f"Node {pins['node']['major']}" in development
    assert "runtime-versions.json" in development
