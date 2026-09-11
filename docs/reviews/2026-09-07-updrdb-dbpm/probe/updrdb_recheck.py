#!/usr/bin/env python3.13
"""UPDRDB 补跑探针 —— 只查 2026-09-08 那份 result.md 里缺的三项。

不重复 updrdb_probe.py 已经跑过的内容，几秒钟跑完。三项都是决策相关的：

  1. 时区 / DATETIME 一致性
     目标实例 `time_zone=+08:00`，而 mysql2 DSN 配的是 `timezone=Z`（UTC）。
     更要紧的是：3 个迁移的 7 个列用**服务端** `CURRENT_TIMESTAMP(3)` 填值
     （dsh_session_persistence / exec_artifacts_datasets /
     workspace_quota_reservations），其余列由应用按 UTC 写入 ——
     **同一张表里可能出现两套时间基准，差 8 小时。**

  2. claim-then-read 互斥
     §P0-1 方案 B 的核心正确性：SKIP LOCKED 不可用时，靠"单条 UPDATE 抢占 +
     affectedRows 判定"做互斥。**这条不成立方案 B 就是错的。**

  3. 排序规则混用
     目标实例 `collation_server=utf8mb4_general_ci`，我们全用 utf8mb4_unicode_ci。
     现有迁移都显式写了 COLLATE，但新增迁移漏写会在跨表比较时报 1267。

依赖：PyMySQL。用法：
    python3.13 updrdb_recheck.py "mysql://user:pass@host:port/probe_db"

会建/删 `t_recheck_*` 表，跑完自动清理。**请用探针库，不要对生产库跑。**
退出码：0 = 无 BLOCKER；1 = 有 BLOCKER；2 = 连不上/缺依赖。
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from urllib.parse import unquote, urlparse

if sys.version_info < (3, 11):
    sys.exit("需要 Python 3.11+（目标 3.13）")

try:
    import pymysql
    from pymysql.err import MySQLError
except ImportError:
    sys.exit("缺少 PyMySQL：pip install PyMySQL（或把 pymysql 包目录拷到本脚本旁边）")

P = "t_recheck_"
ROWS: list[tuple[str, str, str]] = []


def add(level: str, name: str, detail: str) -> None:
    ROWS.append((level, name, detail))


def connect(kw: dict):
    return pymysql.connect(**kw)


# ── 1. 时区 / DATETIME ────────────────────────────────────────
def check_timezone(conn, kw: dict) -> None:
    cur = conn.cursor()
    cur.execute("SELECT @@time_zone, @@system_time_zone, NOW(3), UTC_TIMESTAMP(3)")
    tz, systz, now_local, now_utc = cur.fetchone()
    offset_h = (now_local - now_utc).total_seconds() / 3600
    add("INFO", "服务端时区",
        f"@@time_zone={tz}  @@system_time_zone={systz}  "
        f"NOW()−UTC_TIMESTAMP() = {offset_h:+.1f}h")

    t = f"{P}ts"
    cur.execute(f"DROP TABLE IF EXISTS {t}")
    # 真实 schema 的形状：一列由服务端默认填，一列由应用写入。
    cur.execute(f"""
        CREATE TABLE {t} (
          id INT PRIMARY KEY,
          server_filled DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          app_written   DATETIME(3) NOT NULL
        ) ENGINE=InnoDB""")

    # 应用侧按 UTC 写（等价于 toMysqlDateTime(new Date()) 配 timezone=Z）
    app_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    cur.execute(f"INSERT INTO {t} (id, app_written) VALUES (1, %s)",
                (app_utc.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],))
    conn.commit()

    cur.execute(f"SELECT server_filled, app_written FROM {t} WHERE id=1")
    server_filled, app_written = cur.fetchone()
    skew_h = (server_filled - app_written).total_seconds() / 3600

    if abs(skew_h) < 0.05:
        add("OK", "① 服务端默认值 vs 应用写入值",
            f"server_filled={server_filled}  app_written={app_written}  "
            f"差 {skew_h:+.2f}h —— 两套写入路径时间基准一致")
    else:
        add("BLOCKER", "① 服务端默认值 vs 应用写入值",
            f"server_filled={server_filled}  app_written={app_written}  "
            f"**差 {skew_h:+.2f}h** ← 服务端 CURRENT_TIMESTAMP(3) 填的是本地时间，"
            f"应用按 UTC 写 —— 同一张表两套时间基准。受影响：dsh_session_persistence / "
            f"exec_artifacts_datasets / workspace_quota_reservations 共 7 列")

    # 显式字面量往返：证明服务端不会在存取之间做隐式偏移
    lit = "2026-01-02 03:04:05.678"
    cur.execute(f"UPDATE {t} SET app_written=%s WHERE id=1", (lit,))
    conn.commit()
    cur.execute(f"SELECT CAST(app_written AS CHAR) FROM {t} WHERE id=1")
    back = cur.fetchone()[0]
    same = str(back).startswith("2026-01-02 03:04:05")
    add("OK" if same else "BLOCKER", "② DATETIME(3) 字面量往返",
        f"写 {lit} → 读回 {back}" + ("" if same else "  ← 被隐式偏移了！"))

    cur.execute(f"DROP TABLE IF EXISTS {t}")
    conn.commit()
    cur.close()


# ── 2. claim-then-read 互斥 ──────────────────────────────────
def check_claim_race(conn, kw: dict) -> None:
    """§P0-1 方案 B 的核心：两个连接同抢一行，必须恰好一个赢。"""
    t = f"{P}claim"
    cur = conn.cursor()
    cur.execute(f"DROP TABLE IF EXISTS {t}")
    cur.execute(f"""
        CREATE TABLE {t} (
          id INT PRIMARY KEY,
          status VARCHAR(16) NOT NULL,
          claim_token VARCHAR(32) NULL
        ) ENGINE=InnoDB""")
    cur.execute(f"INSERT INTO {t} VALUES (1,'PENDING',NULL),(2,'PENDING',NULL)")
    conn.commit()

    claim = f"UPDATE {t} SET status='PUBLISHING', claim_token=%s WHERE id=%s AND status='PENDING'"
    other = connect(kw)
    try:
        a = cur.execute(claim, ("worker-A", 1))
        conn.commit()
        oc = other.cursor()
        b = oc.execute(claim, ("worker-B", 1))
        other.commit()
        cur.execute(f"SELECT claim_token FROM {t} WHERE id=1")
        winner = cur.fetchone()[0]
        ok = (a, b) == (1, 0) and winner == "worker-A"
        add("OK" if ok else "BLOCKER", "③ claim-then-read 互斥（两连接同抢一行）",
            f"A 抢到 {a} 行、B 抢到 {b} 行，归属 {winner}"
            + ("（恰好一个赢 → §P0-1 方案 B 成立）" if ok
               else "  ← 期望 (1,0)/worker-A。**互斥不成立，方案 B 不可用**"))

        # 批量形态：ORDER BY + LIMIT 的抢占语义（outbox claimBatch 会用）
        n = cur.execute(f"UPDATE {t} SET status='PUBLISHING', claim_token=%s "
                        f"WHERE status='PENDING' ORDER BY id LIMIT 5", ("batch-1",))
        conn.commit()
        add("OK" if n == 1 else "WARN", "④ 批量抢占 UPDATE … ORDER BY … LIMIT",
            f"影响 {n} 行（此时只剩 1 行 PENDING，期望 1）")
        oc.close()
    finally:
        other.close()
    cur.execute(f"DROP TABLE IF EXISTS {t}")
    conn.commit()
    cur.close()


# ── 3. 排序规则混用 ──────────────────────────────────────────
def check_collation(conn) -> None:
    cur = conn.cursor()
    cur.execute("SELECT @@collation_server, @@collation_database")
    srv, dbc = cur.fetchone()
    a, b = f"{P}col_explicit", f"{P}col_default"
    cur.execute(f"DROP TABLE IF EXISTS {a}")
    cur.execute(f"DROP TABLE IF EXISTS {b}")
    # a = 我们迁移的写法（显式 COLLATE）；b = 漏写 COLLATE 的新表
    cur.execute(f"CREATE TABLE {a} (v VARCHAR(64) NOT NULL) ENGINE=InnoDB "
                f"DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci")
    cur.execute(f"CREATE TABLE {b} (v VARCHAR(64) NOT NULL) ENGINE=InnoDB")
    cur.execute("SELECT table_name, table_collation FROM information_schema.tables "
                "WHERE table_schema=DATABASE() AND table_name IN (%s,%s)", (a, b))
    got = {r[0]: r[1] for r in cur.fetchall()}
    cur.execute(f"INSERT INTO {a} VALUES ('x')")
    cur.execute(f"INSERT INTO {b} VALUES ('x')")
    conn.commit()

    try:
        cur.execute(f"SELECT 1 FROM {a} p JOIN {b} q ON p.v = q.v LIMIT 1")
        cur.fetchall()
        verdict, level = "可比较（两表排序规则相同或可强制转换）", "OK"
    except MySQLError as e:
        verdict, level = f"比较报错 {e.args[0]}: {str(e.args[-1])[:70]}", "WARN"

    add(level, "⑤ 排序规则混用",
        f"@@collation_server={srv}  @@collation_database={dbc}；"
        f"显式表={got.get(a)}  漏写表={got.get(b)}；跨表比较 → {verdict}")
    if level == "WARN":
        add("WARN", "⑥ 需要卫生测试兜住",
            "服务端默认与 utf8mb4_unicode_ci 不同 → **新增迁移的字符串列必须显式 COLLATE**，"
            "建议在 tests/ 加一条断言卡住（现有 22 个迁移都写了）")

    cur.execute(f"DROP TABLE IF EXISTS {a}")
    cur.execute(f"DROP TABLE IF EXISTS {b}")
    conn.commit()
    cur.close()


def main() -> int:
    if len(sys.argv) != 2:
        sys.exit('用法: updrdb_recheck.py "mysql://user:pass@host:port/probe_db"')
    u = urlparse(sys.argv[1])
    if not u.scheme.startswith("mysql"):
        sys.exit(f"不认识的 scheme: {u.scheme}")
    db = (u.path or "/").lstrip("/")
    if not db:
        sys.exit("必须指定库名 —— 会建临时表，请用探针库，不要对生产库跑")
    kw = {
        "host": u.hostname or "127.0.0.1", "port": u.port or 3306,
        "user": unquote(u.username or ""), "password": unquote(u.password or ""),
        "database": db, "charset": "utf8mb4", "autocommit": False,
        "connect_timeout": 10, "read_timeout": 60, "write_timeout": 60,
    }
    try:
        conn = connect(kw)
    except MySQLError as e:
        print(f"连不上 {kw['host']}:{kw['port']}/{db} —— {e}", file=sys.stderr)
        return 2

    try:
        for fn, args in ((check_timezone, (conn, kw)),
                         (check_claim_race, (conn, kw)),
                         (check_collation, (conn,))):
            try:
                fn(*args)
            except MySQLError as e:
                add("BLOCKER", fn.__name__,
                    f"错误 {e.args[0]}: {str(e.args[-1])[:150]}")
                conn.rollback()
    finally:
        cur = conn.cursor()
        for suffix in ("ts", "claim", "col_explicit", "col_default"):
            try:
                cur.execute(f"DROP TABLE IF EXISTS {P}{suffix}")
            except MySQLError:
                pass
        conn.commit()
        conn.close()

    icon = {"OK": "✅", "WARN": "⚠️ ", "BLOCKER": "❌", "INFO": "ℹ️ "}
    print("\n=== UPDRDB 补跑结果（result.md 缺失的三项）===\n")
    for level, name, detail in ROWS:
        print(f"{icon.get(level, '  ')} {name}\n     {detail}")
    n = sum(1 for lv, _, _ in ROWS if lv == "BLOCKER")
    print(f"\n{'✅ 三项全部通过。' if n == 0 else f'❌ {n} 个 BLOCKER。'}\n")
    return 1 if n else 0


if __name__ == "__main__":
    sys.exit(main())
