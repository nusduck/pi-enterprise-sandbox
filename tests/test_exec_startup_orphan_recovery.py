"""exec 入口必须在 listen 之前收孤儿。

`MySqlJobRegistry.recoverOrphans()` 的注释写着「启动期调用（用户路由挂载之前）」，
但从它被写出来到 2026-09-04，`exec/src/main.ts` 里**一个调用点都没有**——只有一条
单测在调。这类缺陷单测抓不到：注册表自己的行为是对的，错的是没人用它。

为什么顺序是硬要求：
- `listActiveForRecovery` 是**无租户过滤**的全表扫描，只有在还没有任何用户请求
  进来的时候才是安全的；
- 没收干净就开门的话，上一轮遗留的 `running`/`stopping` 行会一直占着
  `countActiveForOwner` 的每 owner 并发额度，攒够上限该 owner 就再也起不了作业。

这条守卫只读源码，不跑 Docker、不连 MySQL。
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "exec" / "src" / "main.ts"


def test_exec_entrypoint_recovers_orphans_before_listening() -> None:
    source = MAIN.read_text(encoding="utf-8")

    recover = source.find("recoverOrphans()")
    assert recover != -1, (
        "exec/src/main.ts must call runtime.recoverOrphans() at startup; "
        "without it every exec restart leaves the previous run's jobs stuck "
        "in running/stopping forever"
    )

    listen = source.find("listenHono(")
    assert listen != -1, "exec/src/main.ts must still listen"
    assert recover < listen, (
        "recoverOrphans() must be awaited BEFORE listenHono() — the recovery "
        "scan is tenant-unfiltered and must not race user requests"
    )
    assert "await runtime.recoverOrphans()" in source, (
        "recoverOrphans() must be awaited, not fired and forgotten"
    )


def test_recovery_failure_is_fail_closed() -> None:
    source = MAIN.read_text(encoding="utf-8")
    assert "process.exit(1)" in source, (
        "a failed orphan recovery must stop the process (AGENTS.md §2 fail-closed), "
        "not fall through to listen with a table full of zombie rows"
    )
