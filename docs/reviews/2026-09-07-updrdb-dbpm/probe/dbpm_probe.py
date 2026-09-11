#!/usr/bin/env python3.13
"""DBPM 取密探针 —— 验证主备两台都能取到口令，且我们打算实现的 Node 客户端有依据。

**零第三方依赖。绝不打印口令明文**：只输出长度和 SHA-256 前 8 位，
方便与另一台/另一次取到的值做比对，同时不违反 AGENTS.md §2（口令不进日志）。

用法：
    python3.13 dbpm_probe.py --url "<dbpm-primary>:7000,<dbpm-standby>:7000" \
        --db-name rstlmrdsdb --db-user rstlmap
    python3.13 dbpm_probe.py --url "..." --db-name ... --db-user ... --rounds 5

退出码：0 = 两台都可用；1 = 只有一台可用或口令不一致；2 = 两台都不可用/参数错。

对应改造方案：docs/reviews/2026-09-07-updrdb-dbpm/migration-plan.md §5
"""

from __future__ import annotations

import argparse
import hashlib
import socket
import sys
import time

if sys.version_info < (3, 11):
    sys.exit("需要 Python 3.11+（目标 3.13）")

# 私有二进制协议头，见 docs/ref/dbpm/usage.py
HEADER = b"\x0e\x02"


class DbpmError(Exception):
    """DBPM 返回了非 'OK: ' 开头的应答。"""


def fetch(host: str, port: int, db_name: str, db_user: str, timeout: float) -> tuple[str, float]:
    """向一台 DBPM 取口令，返回 (口令, 耗时秒)。

    与 usage.py 样例的三点差异，都是要移植进 Node 客户端的：
      1. 显式超时（样例的 connect/recv 无超时，挂起的 DBPM 会拖住整个启动）；
      2. 按 \\n 收全再解析（样例 recv(128) 一次读，长口令或分包会截断）；
      3. 错误应答不回显正文（可能含敏感信息）。
    """
    t0 = time.monotonic()
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall(HEADER + f" {db_name} {db_user}\n".encode())
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                raise DbpmError("连接被对端关闭且未收到完整应答")
            buf += chunk
            if len(buf) > 65536:
                raise DbpmError("应答超过 64KB，协议异常")
    rsp = buf.split(b"\n", 1)[0].decode(errors="replace")
    if not rsp.startswith("OK: "):
        raise DbpmError(f"非成功应答（前 40 字符）: {rsp[:40]!r}")
    return rsp[4:], time.monotonic() - t0


def fingerprint(pwd: str) -> str:
    """口令指纹：只暴露长度 + 哈希前 8 位，够比对，不泄露。"""
    return f"len={len(pwd)} sha256:{hashlib.sha256(pwd.encode()).hexdigest()[:8]}"


def main() -> int:
    ap = argparse.ArgumentParser(description="DBPM 取密探针（零依赖，不打印明文）")
    ap.add_argument("--url", required=True, help='"ip1:port1,ip2:port2"（主备两台）')
    ap.add_argument("--db-name", required=True)
    ap.add_argument("--db-user", required=True)
    ap.add_argument("--timeout", type=float, default=5.0, help="连接+读取超时（秒），默认 5")
    ap.add_argument("--rounds", type=int, default=3, help="每台取几次，验证稳定性")
    args = ap.parse_args()

    parts = [p.strip() for p in args.url.split(",") if p.strip()]
    if len(parts) != 2:
        sys.exit(f'--url 必须是 "ip1:port1,ip2:port2" 两个地址，实际解析到 {len(parts)} 个')
    targets = []
    for p in parts:
        host, _, port = p.rpartition(":")
        if not host or not port.isdigit():
            sys.exit(f"地址格式错误: {p}")
        targets.append((host, int(port)))

    print("=== DBPM 取密探针 ===\n")
    print(f"db_name={args.db_name}  db_user={args.db_user}  timeout={args.timeout}s\n")

    results: dict[str, str | None] = {}
    for host, port in targets:
        label = f"{host}:{port}"
        fps, costs, err = set(), [], None
        for _ in range(args.rounds):
            try:
                pwd, cost = fetch(host, port, args.db_name, args.db_user, args.timeout)
                fps.add(fingerprint(pwd))
                costs.append(cost)
            except (OSError, DbpmError) as e:
                err = f"{type(e).__name__}: {e}"
                break
        if err:
            print(f"❌ {label}\n     不可用 —— {err}")
            results[label] = None
        elif len(fps) != 1:
            print(f"⚠️  {label}\n     {args.rounds} 次取到 {len(fps)} 个不同口令: {sorted(fps)}"
                  f"\n     ← 取密期间发生了轮换？启动时取一次的方案要重新评估")
            results[label] = None
        else:
            fp = fps.pop()
            print(f"✅ {label}\n     {fp}  平均 {sum(costs)/len(costs)*1000:.0f} ms"
                  f"（{args.rounds} 次一致）")
            results[label] = fp

    ok = [v for v in results.values() if v]
    print()
    if len(ok) == 2 and len(set(ok)) == 1:
        print("✅ 主备两台都可用且口令一致 —— 符合 §5.2 的高可用假设。")
        rc = 0
    elif len(ok) == 2:
        print("❌ 两台都可用但**口令不一致** —— 主备切换后连接会认证失败，必须先让运维对齐。")
        rc = 1
    elif len(ok) == 1:
        print("⚠️  只有一台可用 —— 单点。§5.2 的主备切换逻辑届时无处可切，请运维修复另一台。")
        rc = 1
    else:
        print("❌ 两台都不可用 —— 按 §5.2 的 fail-closed 设计，服务将拒绝启动。")
        rc = 2

    print("\n提示：本探针只验证取密链路。容器内可达性要在目标容器里跑一遍——")
    print("      现有 compose 里 agent-migrate / sandbox-mcp 只挂 backend_internal（internal:true，")
    print("      完全不能出网），见方案 §5.5。")
    return rc


if __name__ == "__main__":
    sys.exit(main())
