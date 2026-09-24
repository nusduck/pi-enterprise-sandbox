#!/usr/bin/env python3.13
"""UPRedis 兼容性探针 —— 回答"我们这套代码能不能跑在这台 Redis 上"。

**零第三方依赖**：内置最小 RESP2 客户端，只用标准库。银联环境里 pip 装不动包也能跑。

用法：
    python3.13 upredis_probe.py redis://:password@<upredis-host>:6379/0
    python3.13 upredis_probe.py --host <host> --port 6379 --password xxx
    python3.13 upredis_probe.py <url> --idle-test 120     # 额外测空闲断链
    python3.13 upredis_probe.py <url> --allow-script-flush # 额外测 NOSCRIPT 回退

退出码：0 = 无 BLOCKER；1 = 有 BLOCKER；2 = 连不上/参数错。

对应改造方案：docs/reviews/2026-09-07-updrdb-dbpm/migration-plan.md §4
"""

from __future__ import annotations

import argparse
import hashlib
import socket
import ssl
import sys
import time
from dataclasses import dataclass, field
from urllib.parse import unquote, urlparse

if sys.version_info < (3, 11):
    sys.exit("需要 Python 3.11+（目标 3.13）")

# 应用直接调用 ∪ BullMQ 5.80.7 Lua 脚本调用的命令全集。缺任何一条都要当回事。
REQUIRED_COMMANDS = [
    "get", "set", "del", "exists", "expire", "pexpire", "pttl", "persist", "rename", "type", "incr",
    "hset", "hget", "hdel", "hexists", "hgetall", "hincrby", "hlen", "hmget", "hmset",
    "lindex", "llen", "lpop", "lpush", "lrange", "lrem", "lset", "ltrim",
    "rpop", "rpoplpush", "rpush",
    "sadd", "scard", "sismember", "smembers", "srem",
    "xadd", "xrange", "xlen", "xtrim",
    "zadd", "zcard", "zcount", "zpopmin", "zrange", "zrangebyscore", "zrem",
    "zremrangebyrank", "zremrangebyscore", "zrevrange", "zrevrangebyscore", "zscore", "bzpopmin",
    "eval", "evalsha", "script", "info",
]

# 我们自己 3 个锁模块用的就是这个形状（numkeys=1，GET 比对后 DEL）。
CAS_RELEASE_LUA = (
    'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0'
)

# BullMQ 单条脚本最多 14 个 KEY（moveToFinished-14）。主备拓扑下应无碍，仍实测。
MULTIKEY_LUA = """
local n = 0
for i = 1, #KEYS do
  redis.call('SET', KEYS[i], ARGV[1])
  n = n + 1
end
return n
"""


# 本次探针建过的所有 key，用于精确清理（不用 KEYS 全库扫描）。
CREATED: list[str] = []

# 探测到的服务端版本，用于判断某些命令缺失是否真的要紧（见 LPOS）。
SERVER_VERSION: list[int] = []


def mark(*keys: str) -> None:
    CREATED.extend(keys)


class RedisError(Exception):
    """服务端返回的 -ERR / -NOPERM 等错误应答。"""


class Resp:
    """够用就好的 RESP2 客户端：连接、AUTH、发命令、解析应答。"""

    def __init__(self, host: str, port: int, *, timeout: float, use_tls: bool) -> None:
        self.sock = socket.create_connection((host, port), timeout=timeout)
        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            self.sock = ctx.wrap_socket(self.sock)
        self.sock.settimeout(timeout)
        self.buf = b""

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass

    def _readline(self) -> bytes:
        while b"\r\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接被对端关闭")
            self.buf += chunk
        line, _, self.buf = self.buf.partition(b"\r\n")
        return line

    def _readexact(self, n: int) -> bytes:
        while len(self.buf) < n + 2:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接被对端关闭")
            self.buf += chunk
        data, self.buf = self.buf[:n], self.buf[n + 2 :]
        return data

    def _parse(self):
        line = self._readline()
        tag, rest = line[:1], line[1:]
        match tag:
            case b"+":
                return rest.decode()
            case b"-":
                raise RedisError(rest.decode())
            case b":":
                return int(rest)
            case b"$":
                n = int(rest)
                return None if n == -1 else self._readexact(n)
            case b"*":
                n = int(rest)
                return None if n == -1 else [self._parse() for _ in range(n)]
            case _:
                raise RedisError(f"无法解析的应答首字节 {tag!r}: {line!r}")

    def cmd(self, *args, timeout: float | None = None):
        """发一条命令并读回应答。timeout 用于 BZPOPMIN 这类阻塞命令临时放宽。"""
        parts = [f"*{len(args)}\r\n".encode()]
        for a in args:
            b = a if isinstance(a, bytes) else str(a).encode()
            parts.append(b"$%d\r\n%s\r\n" % (len(b), b))
        old = self.sock.gettimeout()
        if timeout is not None:
            self.sock.settimeout(timeout)
        try:
            self.sock.sendall(b"".join(parts))
            return self._parse()
        finally:
            if timeout is not None:
                self.sock.settimeout(old)


@dataclass
class Report:
    rows: list[tuple[str, str, str]] = field(default_factory=list)

    def add(self, level: str, name: str, detail: str) -> None:
        self.rows.append((level, name, detail))

    def blockers(self) -> int:
        return sum(1 for lv, _, _ in self.rows if lv == "BLOCKER")

    def render(self) -> None:
        icon = {"OK": "✅", "WARN": "⚠️ ", "BLOCKER": "❌", "INFO": "ℹ️ "}
        print("\n=== UPRedis 兼容性探针结果 ===\n")
        for level, name, detail in self.rows:
            print(f"{icon.get(level, '  ')} {name}\n     {detail}")
        n = self.blockers()
        print(f"\n{'✅ 未发现 BLOCKER。' if n == 0 else f'❌ {n} 个 BLOCKER，切换前必须解决。'}\n")


def classify(err: Exception) -> tuple[str, str]:
    """区分 rename-command 摘掉 / ACL 拒绝 / 其他 —— 三者处置方式完全不同。"""
    m = str(err)
    low = m.lower()
    if "unknown command" in low:
        return "BLOCKER", f"命令不存在（多半被 rename-command 摘掉）: {m}"
    if "noperm" in low or "no permissions" in low:
        return "BLOCKER", f"被 ACL 拒绝: {m}"
    if "not allowed" in low:
        return "BLOCKER", f"命令被禁用: {m}"
    return "WARN", m


def parse_target(args: argparse.Namespace) -> tuple[str, int, str | None, str | None, int, bool]:
    if args.url:
        u = urlparse(args.url)
        if u.scheme not in ("redis", "rediss"):
            sys.exit(f"不认识的 scheme: {u.scheme}（只支持 redis:// 和 rediss://）")
        db = int(u.path.lstrip("/") or 0)
        return (
            u.hostname or "127.0.0.1",
            u.port or 6379,
            unquote(u.username) if u.username else None,
            unquote(u.password) if u.password else None,
            db,
            u.scheme == "rediss",
        )
    return args.host, args.port, args.user, args.password, args.db, args.tls


def info_field(info: str, key: str) -> str:
    for line in info.splitlines():
        if line.startswith(key + ":"):
            return line.split(":", 1)[1].strip()
    return ""


def check_identity(r: Resp, rep: Report, db: int) -> None:
    try:
        raw = r.cmd("INFO", "server")
        info = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        ver = info_field(info, "redis_version") or "(未返回)"
        mode = info_field(info, "redis_mode") or "(未返回)"
        rep.add("OK", "INFO server", f"redis_version={ver}  redis_mode={mode}")
        try:
            SERVER_VERSION[:] = [int(x) for x in ver.split(".")[:3]]
        except ValueError:
            pass
        if ver == "(未返回)":
            rep.add("BLOCKER", "INFO 缺 redis_version",
                    "BullMQ 启动时靠它做版本门禁，读不到直接抛错起不来")
        if mode == "cluster":
            rep.add("BLOCKER", "Cluster 模式",
                    "与'只做主备'的说法不符；BullMQ 的 14-KEY 脚本需要 hash tag")
    except (RedisError, OSError) as e:
        lv, d = classify(e)
        rep.add("BLOCKER" if lv == "WARN" else lv, "INFO server",
                f"{d}（BullMQ 靠 INFO 读版本，不可用=起不来）")

    try:
        raw = r.cmd("INFO", "replication")
        info = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        role = info_field(info, "role")
        slaves = info_field(info, "connected_slaves")
        master = info_field(info, "master_host")
        extra = f"  master_host={master}" if master else ""
        if role == "master":
            lv, note = "OK", ""
        elif not role:
            # 代理通常不透传 INFO replication —— 读不到不等于连到了备库。
            lv, note = "WARN", "  ← 代理未透传 INFO replication；以下面的\"读己之写\"结果为准"
        else:
            lv, note = "BLOCKER", "  ← 连到了备库！BullMQ 需要读己之写，必须连主"
        rep.add(lv, "INFO replication", f"role={role}  connected_slaves={slaves}{extra}{note}")
    except (RedisError, OSError) as e:
        rep.add("WARN", "INFO replication", str(e))

    try:
        rep.add("OK", "ACL WHOAMI",
                f"当前用户={_s(r.cmd('ACL', 'WHOAMI'))}（非 default 时 DSN 要写成 redis://user:pass@host）")
    except (RedisError, OSError) as e:
        rep.add("INFO", "ACL WHOAMI", f"不可用：{str(e)[:70]} —— 未必是问题")

    for key, want, why in [
        ("maxmemory-policy", "noeviction", "BullMQ 要求 noeviction，否则作业数据被静默驱逐 → 丢 Run"),
        # Redis 自身的 timeout 不会掐断阻塞中的客户端（clientsCron 跳过 blocked client），
        # 所以非 0 只是提示；真正会打断 BZPOPMIN 的是**前置代理**的空闲阈值 → 用 --idle-test 测。
        ("timeout", None, "服务端空闲断链阈值（0=不断）。注意 Redis 本身不掐阻塞中的客户端，"
                          "真正的风险是前置代理的空闲超时 —— 用 --idle-test 实测"),
        ("appendonly", None, "持久化方式，仅记录"),
        ("maxmemory", None, "内存上限，仅记录"),
    ]:
        try:
            got = r.cmd("CONFIG", "GET", key)
            val = _s(got[1]) if isinstance(got, list) and len(got) > 1 else "(空)"
            if want is None:
                rep.add("INFO", f"CONFIG {key}", f"{val}  —— {why}")
            else:
                rep.add("OK" if val == want else "BLOCKER", f"CONFIG {key}",
                        f"{val}（期望 {want}）—— {why}")
        except (RedisError, OSError) as e:
            rep.add("WARN", f"CONFIG GET {key}", f"{str(e)[:70]} → 读不到就要运维书面确认")

    try:
        r.cmd("SELECT", db)
        rep.add("OK", "SELECT db", f"db={db} 可用")
    except (RedisError, OSError) as e:
        rep.add("BLOCKER", "SELECT db", f"db={db}: {e}")

    # 连接数上限决定 BullMQ + 应用池能开多少连接（Queue/Worker 各需独立连接）。
    try:
        got = r.cmd("CONFIG", "GET", "maxclients")
        rep.add("INFO", "CONFIG maxclients",
                f"{_s(got[1]) if isinstance(got, list) and len(got) > 1 else '?'}"
                "  —— BullMQ 的 Queue 与 Worker 各需独立连接，池规模要留余量")
    except (RedisError, OSError):
        pass

    # 安全提示：万一指到了在用的库，先让人知道，别以为是空库随便写。
    try:
        raw = r.cmd("INFO", "keyspace")
        info = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        line = info_field(info, f"db{db}")
        if line:
            rep.add("WARN", f"目标 db{db} 非空",
                    f"{line}  ← 这是个在用的库。探针只写 `__probe:*` 前缀且跑完清理，"
                    "但请确认你确实想对它跑")
        else:
            rep.add("OK", f"目标 db{db} 为空", "干净环境")
    except (RedisError, OSError):
        pass


def check_lua(r: Resp, rep: Report, prefix: str, allow_flush: bool) -> bool:
    """返回 Lua 是否整体可用 —— 不可用时后面的多 KEY / NOSCRIPT 测试没有意义。"""
    lua_ok = True
    # 代理型 Redis（UPRedis Proxy）要求 EVAL 至少带 1 个 key 才能算出路由目标。
    # 所以主判定用 1-key 形式；0-key 只作为**信息**记录代理是否放行，不当 BLOCKER。
    try:
        v = r.cmd("EVAL", "return 1", 1, f"{prefix}eval")
        mark(f"{prefix}eval")
        rep.add("OK" if v == 1 else "WARN", "EVAL（带 1 个 key）", f"返回 {v}")
    except (RedisError, OSError) as e:
        lua_ok = False
        rep.add("BLOCKER", "EVAL（带 1 个 key）",
                f"{classify(e)[1]} → BullMQ 作业状态机 + 三处分布式锁 CAS 全部失效")
    try:
        r.cmd("EVAL", "return 1", 0)
        rep.add("INFO", "EVAL（不带 key）", "放行 —— 无代理或代理不强制路由")
    except (RedisError, OSError) as e:
        rep.add("INFO", "EVAL（不带 key）",
                f"被拒（{str(e)[:60]}）→ **前置代理在按 key 路由**，"
                "留意下面的 14-KEY 测试")

    try:
        sha = _s(r.cmd("SCRIPT", "LOAD", "return 2"))
        v = r.cmd("EVALSHA", sha, 0)
        rep.add("OK" if v == 2 else "WARN", "SCRIPT LOAD + EVALSHA", f"sha={sha[:12]}… 返回 {v}")
    except (RedisError, OSError) as e:
        lua_ok = False
        rep.add("BLOCKER", "SCRIPT LOAD / EVALSHA",
                f"{classify(e)[1]} → ioredis defineCommand（BullMQ 用）路径不可用")

    if not lua_ok:
        rep.add("BLOCKER", "CAS 释放锁脚本", "Lua 不可用，跳过")
        rep.add("BLOCKER", "14-KEY 多键脚本", "Lua 不可用，跳过")
        return False

    try:
        k = f"{prefix}lock"
        mark(k)
        r.cmd("SET", k, "owner-1", "PX", 5000, "NX")
        got = r.cmd("EVAL", CAS_RELEASE_LUA, 1, k, "owner-1")
        rep.add("OK" if got == 1 else "BLOCKER", "CAS 释放锁脚本（我们锁的真实形状）",
                f"返回 {got}（期望 1）")
    except (RedisError, OSError) as e:
        rep.add("BLOCKER", "CAS 释放锁脚本", classify(e)[1])

    try:
        keys = [f"{prefix}mk:{i}" for i in range(14)]
        mark(*keys)
        got = r.cmd("EVAL", MULTIKEY_LUA, 14, *keys, "v")
        rep.add("OK" if got == 14 else "BLOCKER", "14-KEY 多键脚本（BullMQ 最大形状）",
                f"返回 {got}（期望 14）—— 主备无分片时应通过")
        r.cmd("DEL", *keys)
    except (RedisError, OSError) as e:
        lv, d = classify(e)
        hint = "" if "CROSSSLOT" not in str(e).upper() else \
            " ← 代理在做 key 路由！BullMQ 的队列 prefix 需要改成 hash tag 形式"
        rep.add("BLOCKER", "14-KEY 多键脚本", d + hint)

    if allow_flush:
        try:
            sha = _s(r.cmd("SCRIPT", "LOAD", "return 3"))
            r.cmd("SCRIPT", "FLUSH")
            noscript = False
            try:
                r.cmd("EVALSHA", sha, 0)
            except RedisError as e:
                noscript = "NOSCRIPT" in str(e).upper()
            v = r.cmd("EVAL", "return 3", 0)
            rep.add("OK" if v == 3 else "WARN", "SCRIPT FLUSH 后的 NOSCRIPT 回退",
                    f"EVALSHA {'如期报 NOSCRIPT' if noscript else '未报 NOSCRIPT（脚本可能已持久化）'}；"
                    f"EVAL 重发返回 {v} → 主备切换后我们两条路径都能自愈")
        except (RedisError, OSError) as e:
            rep.add("WARN", "NOSCRIPT 回退", str(e)[:120])
    else:
        rep.add("INFO", "NOSCRIPT 回退",
                "跳过（需 --allow-script-flush；SCRIPT FLUSH 会清掉共享实例上别人的脚本缓存）")
    return True


def check_commands(r: Resp, rep: Report) -> None:
    try:
        infos = r.cmd("COMMAND", "INFO", *REQUIRED_COMMANDS)
        missing = [c for c, i in zip(REQUIRED_COMMANDS, infos) if i is None]
        rep.add("OK" if not missing else "BLOCKER", "COMMAND INFO 全量核对",
                f"{len(REQUIRED_COMMANDS)} 条命令全部存在" if not missing
                else f"缺失 {len(missing)} 条: {', '.join(missing)}")
    except (RedisError, OSError) as e:
        rep.add("WARN", "COMMAND INFO", f"{str(e)[:80]} → 退回下面的逐条实跑")

    # LPOS 单独判：Redis 6.0.6 才引入，而 BullMQ **自己做了版本降级**
    # （scripts.js:690 —— 低于 6.0.6 时改用基于 LRANGE 的 getState-8.lua）。
    # 所以旧版本上缺 LPOS 是预期的，不是阻塞项。
    try:
        has_lpos = r.cmd("COMMAND", "INFO", "lpos")[0] is not None
    except (RedisError, OSError):
        has_lpos = False
    old_server = SERVER_VERSION < [6, 0, 6] if SERVER_VERSION else False
    if has_lpos:
        rep.add("OK", "LPOS", "存在")
    elif old_server:
        rep.add("INFO", "LPOS 不存在（预期）",
                f"服务端 {'.'.join(map(str, SERVER_VERSION))} < 6.0.6，LPOS 本就不该有；"
                "BullMQ 会自动降级到 LRANGE 版 getState（已实测端到端可用）→ **不是阻塞项**")
    else:
        rep.add("BLOCKER", "LPOS 缺失但版本 ≥ 6.0.6",
                "该有却没有 → 多半被 rename-command 摘掉，BullMQ 的 getStateV2 会失败")


def check_dataplane(r: Resp, rep: Report, prefix: str) -> None:
    """把代码真正用到的数据结构各跑一遍 —— COMMAND INFO 说存在不等于行为正确。"""
    mark(f"{prefix}s", f"{prefix}h", f"{prefix}x", f"{prefix}z",
         f"{prefix}l", f"{prefix}set", f"{prefix}empty")
    cases: list[tuple[str, callable]] = [
        ("String / TTL（cancel-signal、锁）", lambda: (
            r.cmd("SET", f"{prefix}s", "v", "PX", 3000, "NX"),
            _s(r.cmd("GET", f"{prefix}s")) == "v",
            isinstance(r.cmd("PTTL", f"{prefix}s"), int),
        )[1:]),
        ("Hash（BullMQ 作业体）", lambda: (
            r.cmd("HSET", f"{prefix}h", "f", "1"),
            _s(r.cmd("HGET", f"{prefix}h", "f")) == "1",
        )[1:]),
        ("Stream（run-event-stream）", lambda: (
            r.cmd("XADD", f"{prefix}x", "*", "e", "1"),
            r.cmd("XLEN", f"{prefix}x") == 1,
            len(r.cmd("XRANGE", f"{prefix}x", "-", "+")) == 1,
            r.cmd("XTRIM", f"{prefix}x", "MAXLEN", "~", 1) is not None,
        )[1:]),
        ("ZSet（BullMQ delayed/prioritized）", lambda: (
            r.cmd("ZADD", f"{prefix}z", 1, "a"),
            len(r.cmd("ZRANGE", f"{prefix}z", 0, -1, "WITHSCORES")) == 2,
            len(r.cmd("ZPOPMIN", f"{prefix}z")) == 2,
        )[1:]),
        ("List（BullMQ wait/active）", lambda: (
            r.cmd("RPUSH", f"{prefix}l", "a", "b"),
            r.cmd("LRANGE", f"{prefix}l", 0, -1) is not None,
            r.cmd("LREM", f"{prefix}l", 1, "a") == 1,
        )[1:]),
        ("Set（BullMQ stalled）", lambda: (
            r.cmd("SADD", f"{prefix}set", "m"),
            r.cmd("SISMEMBER", f"{prefix}set", "m") == 1,
        )[1:]),
    ]
    for name, fn in cases:
        try:
            oks = fn()
            rep.add("OK" if all(oks) else "BLOCKER", name,
                    "通过" if all(oks) else f"断言不成立: {oks}")
        except (RedisError, OSError) as e:
            rep.add("BLOCKER", name, classify(e)[1])

    # BZPOPMIN 是 BullMQ worker 等任务的方式，必须能穿过代理正常阻塞并超时返回。
    try:
        t0 = time.monotonic()
        got = r.cmd("BZPOPMIN", f"{prefix}empty", 2, timeout=10)
        elapsed = time.monotonic() - t0
        ok = got is None and 1.5 <= elapsed <= 4.0
        rep.add("OK" if ok else "WARN", "BZPOPMIN 阻塞行为（BullMQ worker 取任务）",
                f"阻塞 {elapsed:.2f}s 后返回 {got!r}（期望 ~2s 后 nil）"
                + ("" if ok else " ← 代理可能改写了阻塞语义"))
    except (RedisError, OSError) as e:
        rep.add("BLOCKER", "BZPOPMIN 阻塞行为", classify(e)[1])


def check_read_after_write(r: Resp, rep: Report, prefix: str, rounds: int) -> None:
    """主备最危险的坑：代理若把读分流到备库，BullMQ 的读己之写会静默出错。"""
    misses = 0
    try:
        for i in range(rounds):
            key = f"{prefix}raw:{i}"
            mark(key)
            r.cmd("SET", key, str(i))
            if _s(r.cmd("GET", key)) != str(i):
                misses += 1
            r.cmd("DEL", key)
    except (RedisError, OSError) as e:
        rep.add("BLOCKER", "读己之写", classify(e)[1])
        return
    rep.add("OK" if misses == 0 else "BLOCKER", f"读己之写（{rounds} 轮写后立即读）",
            f"{rounds} 轮全部读到刚写的值" if misses == 0
            else f"{misses}/{rounds} 轮读到旧值 → 代理把读分流到了备库，BullMQ 会状态错乱")


def check_idle(r: Resp, rep: Report, seconds: int) -> None:
    """BullMQ worker 常年阻塞等任务，代理/服务端的空闲断链会打断它。"""
    print(f"  …空闲 {seconds}s 测断链中（--idle-test）…", file=sys.stderr)
    time.sleep(seconds)
    try:
        r.cmd("PING", timeout=10)
        rep.add("OK", f"空闲 {seconds}s 后连接存活", "未被断开")
    except (RedisError, OSError) as e:
        rep.add("WARN", f"空闲 {seconds}s 后连接存活",
                f"连接已断（{str(e)[:60]}）→ 记下这个阈值，BullMQ 会周期性重连")


def _s(v) -> str:
    return v.decode(errors="replace") if isinstance(v, bytes) else str(v)


def main() -> int:
    ap = argparse.ArgumentParser(description="UPRedis 兼容性探针（零依赖）")
    ap.add_argument("url", nargs="?", help="redis://[user:]pass@host:port/db")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6379)
    ap.add_argument("--user")
    ap.add_argument("--password")
    ap.add_argument("--db", type=int, default=0)
    ap.add_argument("--tls", action="store_true")
    ap.add_argument("--timeout", type=float, default=5.0)
    ap.add_argument("--raw-rounds", type=int, default=200, help="读己之写测试轮数")
    ap.add_argument("--idle-test", type=int, metavar="SEC", help="额外空闲 N 秒测断链")
    ap.add_argument("--allow-script-flush", action="store_true",
                    help="允许 SCRIPT FLUSH 测 NOSCRIPT 回退（会清掉共享实例上别人的脚本缓存）")
    args = ap.parse_args()

    host, port, user, password, db, tls = parse_target(args)
    prefix = f"__probe:{int(time.time())}:"
    rep = Report()

    try:
        r = Resp(host, port, timeout=args.timeout, use_tls=tls)
    except OSError as e:
        print(f"连不上 {host}:{port} —— {e}", file=sys.stderr)
        return 2

    try:
        if password:
            try:
                r.cmd("AUTH", user, password) if user else r.cmd("AUTH", password)
            except RedisError as e:
                print(f"AUTH 失败: {e}", file=sys.stderr)
                return 2
        check_identity(r, rep, db)
        lua_ok = check_lua(r, rep, prefix, args.allow_script_flush)
        check_commands(r, rep)
        check_dataplane(r, rep, prefix)
        check_read_after_write(r, rep, prefix, args.raw_rounds)
        if args.idle_test:
            check_idle(r, rep, args.idle_test)
        if not lua_ok:
            rep.add("INFO", "总体", "Lua 不可用是压倒性问题，其余结论意义有限")
        # 【重要】绝不用 KEYS —— 它在大实例上是阻塞的 O(N) 全库扫描。
        # 只删我们自己建过的 key（全程记录在 CREATED 里）。
        if CREATED:
            try:
                for i in range(0, len(CREATED), 100):
                    r.cmd("DEL", *CREATED[i : i + 100])
            except (RedisError, OSError):
                pass
    finally:
        r.close()

    rep.render()
    return 1 if rep.blockers() else 0


if __name__ == "__main__":
    sys.exit(main())
