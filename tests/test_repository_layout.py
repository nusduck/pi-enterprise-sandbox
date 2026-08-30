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
        # Per-developer local tooling state (gitignored, never part of the repo).
        ".claude",
    }
)

# Existing hotspots are explicit debt, not a silent exception. Every budget is
# pinned to the file's current length, so a hotspot can shrink but never grow:
# adding to one fails this test in the same PR that added the lines. Growing a
# hotspot on purpose means splitting it or raising its budget here, with the
# reason in the commit message — never silently.
HOTSPOT_LINE_BUDGETS = {
    # W2-D 曾为 @ts-expect-error 横幅抬到 1_493；Wave 6 换成 JSDoc 形状后收回
    # 1_482；转 TS 又收回 16 行。
    "agent/src/application/execute-run-service.ts": 1_466,
    # W2-D 曾抬到 1_672；去掉 expect-error 后收回 1_663；转 TS 又收回 9 行
    # （提升上去的 JSDoc @param 块比加上的类型声明更长）。仍是全仓最长的
    # 文件，阶段 D 收尾时应当拆。
    "agent/src/application/fenced-tool-governance-recorder.ts": 1_654,
    # 转 TS 时拆出 pi-run-executor-deps.ts（依赖面类型 + 三个不读 this 的
    # 纯判定），1_597 -> 1_526，预算收紧。
    "agent/src/application/pi-run-executor.ts": 1_526,
    # 转 TS 时拆出 container-mcp.ts（MCP 发现状态机），1_178 -> 1_065，预算收紧。
    "agent/src/bootstrap/container.ts": 1_065,
    # W2-D 曾抬到 1_443；Wave 6 收回。转 TS 时拆出 presentation/http/health-routes.ts
    # （/health + /ready），1_439 -> 1_399，预算收紧。
    "agent/src/bootstrap/create-http-server.ts": 1_399,
    "agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js": 1_268,
    # +6 (1_131 -> 1_137): packJsonWithIntegrity now raises a stable
    # ARGUMENT_TOO_LARGE code instead of a bare message, so callers can tell
    # "too big to store" apart from a redaction-truncated replay conflict.
    "agent/src/infrastructure/mysql/repositories/tool-execution-repository.js": 1_137,
    # W2-D 曾为 inline 收窄抬到 1_057；Wave 6 抽 asRecord 后收回。
    "agent/src/infrastructure/mysql/repositories/trace-span-repository.js": 1_041,
    # frontend/src joined this ratchet on 2026-08-26 (full-repo standards
    # review): AGENTS.md §3 applies to every production file, but only
    # agent/ and sandbox/ were pinned, so these three grew past 1000 lines
    # unnoticed. Pinned at their current length — split, do not raise.
    "frontend/src/features/chat/ChatContext.tsx": 1_456,
    "frontend/src/features/chat/entityBridge.ts": 1_176,
    "frontend/src/shared/state/runReducer.ts": 1_492,
    "frontend/src/widgets/runtime-steps/InlineRuntimeSteps.tsx": 1_011,
}


def _production_sources() -> list[Path]:
    sources = [
        *ROOT.joinpath("agent", "src").rglob("*.js"),
        # 阶段 C 起 agent/src 同时有 .js 和 .ts。**两种都要扫**：只扫 .js 的话，
        # 一个文件转成 TS 就会静悄悄退出这条棘轮——http-handler 正是这样在转换里
        # 从 993 长到 1009 而没人发现。
        *ROOT.joinpath("agent", "src").rglob("*.ts"),
        *ROOT.joinpath("sandbox").rglob("*.py"),
        *ROOT.joinpath("frontend", "src").rglob("*.ts"),
        *ROOT.joinpath("frontend", "src").rglob("*.tsx"),
        *ROOT.joinpath("api-server", "src").rglob("*.js"),
        # DSH 重建的三个新 TS 包（ADR 0007 / 0008）。刻意**不给任何 hotspot
        # 预算**：新代码从第一天就守 1000 行上限，不把既有债务复制过去。
        *ROOT.joinpath("contract", "src").rglob("*.ts"),
        *ROOT.joinpath("agent", "runtime", "src").rglob("*.ts"),
        *ROOT.joinpath("exec", "src").rglob("*.ts"),
    ]
    sources.extend(ROOT.joinpath("agent").glob("*.js"))
    sources.extend(ROOT.joinpath("api-server").glob("*.js"))
    return sorted(
        path
        for path in sources
        if not any(
            part in LOCAL_GENERATED_DIRECTORIES
            for part in path.relative_to(ROOT).parts
        )
    )


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
            # AGENTS.md is read from the repository root by convention — the
            # agent working spec has to sit where an agent looks for it.
            path.name in {"README.md", "AGENTS.md"}
            or relative.parts[0] in {"docs", "skills"}
            or any(part in LOCAL_GENERATED_DIRECTORIES for part in relative.parts)
        ):
            continue
        misplaced.append(relative.as_posix())
    assert not misplaced, (
        "Move project documentation under docs/ (README.md is the exception): "
        + ", ".join(sorted(misplaced))
    )


def test_deferred_items_board_records_when_it_was_last_audited() -> None:
    """The deferred board rots silently without a visible audit marker.

    It went 2.5 weeks unmaintained once and three of its rows described work
    that had already shipped, which is worse than no board: a reader trusts it.
    Requiring the marker does not keep the board fresh by itself, but it makes
    staleness readable at a glance instead of only discoverable by spot-check.
    """
    board = ROOT / "docs" / "review-deferred-items.md"
    text = board.read_text(encoding="utf-8")
    assert "**Last audited:**" in text, (
        "docs/review-deferred-items.md must carry a '**Last audited:** <commit> (<date>)' "
        "line so a reader can tell how stale the board is"
    )
    assert "## Closed in the current refactor" not in text, (
        "Closure evidence belongs in docs/archive/reviews/, not on the live "
        "deferred board — it buries the rows that still need a decision"
    )
