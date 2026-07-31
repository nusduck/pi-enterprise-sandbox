"""Repository structure ratchets for source size, tests, and documentation."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE_LINE_LIMIT = 1_000
LOCAL_GENERATED_DIRECTORIES = frozenset(
    {
        ".runtime",
        ".venv",
        ".pytest_cache",
        "__pycache__",
        "node_modules",
        "workspaces",
        "tmp-workspaces",
        "artifacts",
        "control",
        "pi-agent-home",
    }
)

# Existing hotspots are explicit debt, not a silent exception. Budgets are at
# or below the 2026-07-30 baseline so these files can shrink but cannot grow.
HOTSPOT_LINE_BUDGETS = {
    "agent/src/application/execute-run-service.js": 1_484,
    "agent/src/application/fenced-tool-governance-recorder.js": 1_716,
    "agent/src/application/pi-run-executor.js": 1_707,
    "agent/src/bootstrap/container.js": 1_477,
    "agent/src/bootstrap/create-http-server.js": 1_518,
    "agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js": 1_382,
    "agent/src/infrastructure/mysql/repositories/tool-execution-repository.js": 1_131,
    "agent/src/infrastructure/mysql/repositories/trace-span-repository.js": 1_046,
    "agent/src/infrastructure/pi/pi-runtime-factory.js": 1_120,
    "agent/src/infrastructure/sandbox/internal-files-read-http.js": 1_420,
    "sandbox/app/persistence/repositories/tool_execution_claim_validator.py": 1_111,
    "sandbox/config.py": 1_469,
    "sandbox/services/process_manager.py": 1_887,
}


def _production_sources() -> list[Path]:
    sources = [
        *ROOT.joinpath("agent", "src").rglob("*.js"),
        *ROOT.joinpath("sandbox").rglob("*.py"),
    ]
    sources.extend(ROOT.joinpath("agent").glob("*.js"))
    return sorted(path for path in sources if "__pycache__" not in path.parts)


def test_production_source_files_respect_line_budgets() -> None:
    violations: list[str] = []
    stale_exceptions = set(HOTSPOT_LINE_BUDGETS)
    for path in _production_sources():
        relative = path.relative_to(ROOT).as_posix()
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        budget = HOTSPOT_LINE_BUDGETS.get(relative, DEFAULT_SOURCE_LINE_LIMIT)
        stale_exceptions.discard(relative)
        if line_count > budget:
            violations.append(f"{relative}: {line_count} > {budget}")

    assert not stale_exceptions, (
        "Remove stale hotspot budgets after moving/deleting files: "
        + ", ".join(sorted(stale_exceptions))
    )
    assert not violations, (
        "Split files by responsibility instead of increasing line budgets:\n"
        + "\n".join(violations)
    )


def test_agent_uses_one_tests_directory() -> None:
    assert not ROOT.joinpath("agent", "testing").exists()
    assert ROOT.joinpath("agent", "tests", "support").is_dir()


def test_local_runtime_data_defaults_to_runtime_root() -> None:
    pyproject = ROOT.joinpath("pyproject.toml").read_text(encoding="utf-8")
    compose = ROOT.joinpath("docker-compose.yml").read_text(encoding="utf-8")
    env_example = ROOT.joinpath(".env.example").read_text(encoding="utf-8")

    assert 'cache_dir = ".runtime/pytest-cache"' in pyproject
    for path in (
        ".runtime/sandbox/workspaces",
        ".runtime/sandbox/tmp",
        ".runtime/sandbox/artifacts",
        ".runtime/sandbox/control",
    ):
        assert path in compose
        assert path in env_example


def test_project_markdown_lives_under_docs_except_readmes() -> None:
    misplaced: list[str] = []
    for path in ROOT.rglob("*.md"):
        relative = path.relative_to(ROOT)
        if (
            path.name == "README.md"
            or relative.parts[0] in {"docs", "skills"}
            or any(part in LOCAL_GENERATED_DIRECTORIES for part in relative.parts)
        ):
            continue
        misplaced.append(relative.as_posix())
    assert not misplaced, (
        "Move project documentation under docs/ (README.md is the exception): "
        + ", ".join(sorted(misplaced))
    )
