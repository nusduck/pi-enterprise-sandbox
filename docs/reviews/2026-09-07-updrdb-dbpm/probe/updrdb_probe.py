#!/usr/bin/env python3.13
"""UPDRDB 兼容性探针 —— 回答"我们的 schema 和 SQL 能不能跑在这台 UPDRDB 上"。

依赖：**PyMySQL**（纯 Python，可 `pip install PyMySQL`，也可把 pymysql 包目录拷到本脚本旁边）。

用法：
    python3.13 updrdb_probe.py "mysql://user:pass@<updrdb-host>:4049/probe_db"
    python3.13 updrdb_probe.py --host <host> --port 4049 --user u --password p --database d
    python3.13 updrdb_probe.py <url> --keep      # 出错时保留探针表便于排查

**会在目标库里建/删若干 `t_probe_*` 临时表**，跑完自动清理（--keep 可保留）。
建议用一个专门的探针库，不要直接对生产库跑。

退出码：0 = 无 BLOCKER；1 = 有 BLOCKER；2 = 连不上/缺依赖。

对应改造方案：docs/reviews/2026-09-07-updrdb-dbpm/migration-plan.md §1–§3
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass, field
from urllib.parse import unquote, urlparse

if sys.version_info < (3, 11):
    sys.exit("需要 Python 3.11+（目标 3.13）")

try:
    import pymysql
    from pymysql.err import MySQLError
except ImportError:
    sys.exit("缺少 PyMySQL：pip install PyMySQL（或把 pymysql 包目录拷到本脚本旁边）")

P = "t_probe_"


@dataclass
class Report:
    rows: list[tuple[str, str, str]] = field(default_factory=list)

    def add(self, level: str, name: str, detail: str) -> None:
        self.rows.append((level, name, detail))

    def blockers(self) -> int:
        return sum(1 for lv, _, _ in self.rows if lv == "BLOCKER")

    def render(self) -> None:
        icon = {"OK": "✅", "WARN": "⚠️ ", "BLOCKER": "❌", "INFO": "ℹ️ "}
        print("\n=== UPDRDB 兼容性探针结果 ===\n")
        section = None
        for level, name, detail in self.rows:
            head, _, rest = name.partition("|")
            if head != section:
                section = head
                print(f"\n── {section} ──")
            print(f"{icon.get(level, '  ')} {rest or head}\n     {detail}")
        n = self.blockers()
        print(f"\n{'✅ 未发现 BLOCKER。' if n == 0 else f'❌ {n} 个 BLOCKER，切换前必须解决。'}\n")


class Db:
    """薄封装：统一异常与自动提交语义，方便"这条语句能不能跑"式探测。"""

    def __init__(self, **kw) -> None:
        self.conn = pymysql.connect(**kw)

    def one(self, sql: str, args=None):
        with self.conn.cursor() as c:
            c.execute(sql, args)
            return c.fetchone()

    def all(self, sql: str, args=None):
        with self.conn.cursor() as c:
            c.execute(sql, args)
            return c.fetchall()

    def run(self, sql: str, args=None) -> int:
        with self.conn.cursor() as c:
            return c.execute(sql, args)

    def quiet_drop(self, *stmts: str) -> None:
        for s in stmts:
            try:
                self.run(s)
            except MySQLError:
                pass


def probe(rep: Report, section: str, name: str, fn, *,
          expect_fail: bool = False, fail_level: str = "BLOCKER",
          ok_note: str = "", fail_note: str = "") -> object:
    """跑一条探测。expect_fail=True 时"报错"才是预期结果（用于确认 8.0 语法确实不可用）。"""
    label = f"{section}|{name}"
    try:
        got = fn()
    except MySQLError as e:
        code = e.args[0] if e.args else "?"
        msg = str(e.args[1])[:150] if len(e.args) > 1 else str(e)[:150]
        if expect_fail:
            rep.add("OK", label, f"如期被拒（错误 {code}）{(' —— ' + ok_note) if ok_note else ''}")
        else:
            rep.add(fail_level, label, f"错误 {code}: {msg}{(' —— ' + fail_note) if fail_note else ''}")
        return None
    if expect_fail:
        rep.add("INFO", label, f"竟然支持（返回 {got!r}）—— 比 5.7 基线更宽松，不影响我们")
    else:
        rep.add("OK", label, f"{got if got is not None else '通过'}"
                             f"{(' —— ' + ok_note) if ok_note else ''}")
    return got


# ── 1. 身份与拓扑 ──────────────────────────────────────────────
def sec_identity(db: Db, rep: Report) -> None:
    s = "1 身份与拓扑"
    row = db.one("SELECT VERSION(), @@version_comment, DATABASE(), USER(), @@hostname")
    rep.add("OK", f"{s}|版本与身份",
            f"VERSION={row[0]}  comment={row[1]}  db={row[2]}  user={row[3]}  host={row[4]}")
    if row[0] and not row[0].startswith("5.7"):
        rep.add("WARN", f"{s}|版本基线",
                f"手册口径是 MySQL 5.7；这台报 {row[0]}。若确为 8.x，SKIP LOCKED 等结论要重估")

    # DRDB 扩展语法只有走 proxy 才认；直连 datanode 或 upsql 会报语法错。
    try:
        rows = db.all("DRDB SHOW STATUS")
        kinds = {r[0] for r in rows if r}
        nodes = [r for r in rows if r and str(r[0]).lower() == "datanode"]
        mode = "分库（多 datanode）" if len(nodes) > 2 else "透传或单组"
        rep.add("INFO" if len(nodes) <= 2 else "BLOCKER", f"{s}|DRDB SHOW STATUS",
                f"组件={sorted(kinds)}  datanode 行数={len(nodes)} → 推断 {mode}"
                + ("" if len(nodes) <= 2 else "  ← 方案假设透传模式，分库要重做 §1.3 的评估"))
    except MySQLError as e:
        rep.add("INFO", f"{s}|DRDB SHOW STATUS",
                f"不可用（{str(e.args[-1])[:80]}）→ 多半是透传模式或直连 upsql，符合方案假设")

    for var in ("sql_mode", "transaction_isolation", "tx_isolation", "autocommit",
                "character_set_server", "collation_server", "time_zone", "system_time_zone",
                "log_bin", "log_bin_trust_function_creators", "innodb_lock_wait_timeout",
                "wait_timeout", "interactive_timeout", "max_allowed_packet",
                "lower_case_table_names", "default_storage_engine"):
        try:
            r = db.one("SHOW VARIABLES LIKE %s", (var,))
            if r:
                rep.add("INFO", f"{s}|变量 {var}", str(r[1]))
        except MySQLError:
            pass

    try:
        grants = db.all("SHOW GRANTS")
        rep.add("INFO", f"{s}|SHOW GRANTS", " | ".join(str(g[0])[:160] for g in grants)[:600])
    except MySQLError as e:
        rep.add("INFO", f"{s}|SHOW GRANTS", f"不可用: {str(e.args[-1])[:80]}")


# ── 2. P0-1 SKIP LOCKED ────────────────────────────────────────
def sec_skip_locked(db: Db, rep: Report, connect_kw: dict) -> None:
    s = "2 P0-1 行锁抢占"
    t = f"{P}lock"
    db.quiet_drop(f"DROP TABLE IF EXISTS {t}")
    db.run(f"CREATE TABLE {t} (id INT PRIMARY KEY, s VARCHAR(16)) ENGINE=InnoDB")
    db.run(f"INSERT INTO {t} VALUES (1,'a'),(2,'b')")
    db.conn.commit()

    probe(rep, s, "SELECT … FOR UPDATE（普通行锁）",
          lambda: f"{len(db.all(f'SELECT id FROM {t} WHERE s=%s FOR UPDATE', ('a',)))} 行",
          ok_note="5.7 就有，代码里 20+ 处依赖它")
    db.conn.rollback()

    got = probe(rep, s, "SELECT … FOR UPDATE SKIP LOCKED（MySQL 8.0 独有）",
                lambda: f"{len(db.all(f'SELECT id FROM {t} FOR UPDATE SKIP LOCKED'))} 行",
                expect_fail=True,
                ok_note="确认需要按方案 §P0-1 改成 claim-then-read")
    db.conn.rollback()
    if got is not None:
        rep.add("INFO", f"{s}|结论", "SKIP LOCKED 可用 → §P0-1 的改造可以不做（但要复核这是不是 5.7）")
    else:
        rep.add("INFO", f"{s}|结论", "SKIP LOCKED 不可用 → §P0-1 必须做（outbox + cron 两处）")

    probe(rep, s, "UPDATE … ORDER BY … LIMIT（claim-then-read 的替代写法）",
          lambda: f"抢到 {db.run(f'UPDATE {t} SET s=%s WHERE s=%s ORDER BY id LIMIT 1', ('c', 'a'))} 行",
          ok_note="§P0-1 推荐方案 B 依赖这条语法")
    db.conn.commit()
    sec_claim_race(db, rep, t, connect_kw)
    db.quiet_drop(f"DROP TABLE IF EXISTS {t}")


def sec_claim_race(db: Db, rep: Report, t: str, connect_kw: dict) -> None:
    """P0-1 替代方案的关键验证：两个连接同时抢，必须恰好一个拿到。

    `SKIP LOCKED` 不可用时我们靠"单条 UPDATE 抢占 + affectedRows 判定"来做互斥。
    这条语义要是不成立，方案 B 就是错的 —— 必须实测，不能靠推断。
    """
    s = "2 P0-1 行锁抢占"
    try:
        db.run(f"UPDATE {t} SET s='PENDING'")
        db.conn.commit()
        other = Db(**connect_kw)
        try:
            claim_sql = (f"UPDATE {t} SET s=%s WHERE id=%s AND s='PENDING'")
            a = db.run(claim_sql, ("worker-A", 1))
            db.conn.commit()
            b = other.run(claim_sql, ("worker-B", 1))
            other.conn.commit()
            winner = db.one(f"SELECT s FROM {t} WHERE id=1")[0]
            ok = (a, b) == (1, 0) and winner == "worker-A"
            rep.add("OK" if ok else "BLOCKER", f"{s}|claim-then-read 互斥（两连接同抢一行）",
                    f"A 抢到 {a} 行、B 抢到 {b} 行，最终归属 {winner}"
                    + ("（恰好一个赢，方案 B 成立）" if ok
                       else "  ← 期望 (1, 0)。互斥不成立，§P0-1 方案 B 不可用！"))
        finally:
            other.conn.close()
    except MySQLError as e:
        rep.add("BLOCKER", f"{s}|claim-then-read 互斥", f"错误 {e.args[0]}: {str(e.args[-1])[:120]}")


# ── 3. P0-2 触发器（四步） ─────────────────────────────────────
def sec_triggers(db: Db, rep: Report) -> None:
    s = "3 P0-2 触发器"
    t, trg = f"{P}trg", f"{P}trg_forbid_update"
    db.quiet_drop(f"DROP TRIGGER IF EXISTS {trg}", f"DROP TABLE IF EXISTS {t}")
    db.run(f"CREATE TABLE {t} (id INT PRIMARY KEY, v INT) ENGINE=InnoDB")

    created = probe(rep, s, "① CREATE TRIGGER（append-only 的真实形状）",
                    lambda: db.run(
                        f"CREATE TRIGGER {trg} BEFORE UPDATE ON {t} "
                        f"FOR EACH ROW SIGNAL SQLSTATE '45000' "
                        f"SET MESSAGE_TEXT = 'append-only: updates forbidden'") or "已创建",
                    fail_note="→ 走方案 §P0-2 分支 2（应用层 + REVOKE 权限）") is not None

    if created:
        # 关键：建成功 ≠ 生效。手册里 UNLOCK TABLES 就是"应答成功但实际无影响"的先例。
        db.run(f"INSERT INTO {t} VALUES (1, 1)")
        db.conn.commit()
        blocked = False
        try:
            db.run(f"UPDATE {t} SET v=2 WHERE id=1")
            db.conn.commit()
        except MySQLError:
            blocked = True
        db.conn.rollback()
        v = db.one(f"SELECT v FROM {t} WHERE id=1")
        really = blocked and v and v[0] == 1
        rep.add("OK" if really else "BLOCKER", f"{s}|② 触发器是否真的拦住 UPDATE",
                "UPDATE 被拒且值未变 —— 真正生效" if really else
                f"⚠️ 建成功但没拦住（UPDATE {'报错' if blocked else '成功'}，当前值={v[0] if v else '?'}）"
                " ← 这就是 proxy 吞掉 DDL 的典型症状，等同于不可用")

        probe(rep, s, "③ DROP TRIGGER（迁移 down() 依赖）",
              lambda: db.run(f"DROP TRIGGER IF EXISTS {trg}") or "已删除",
              fail_note="→ CREATE 能用但 DROP 不能，回滚路径要单独处理")

        probe(rep, s, "④ SHOW TRIGGERS", lambda: f"{len(db.all('SHOW TRIGGERS'))} 条")

        # UPDRDB 2.3.0 给 CREATE TRIGGER 加的扩展；可用则能让建触发器幂等。
        probe(rep, s, "⑤ CREATE OR DISPLACE TRIGGER（UPDRDB 专属扩展）",
              lambda: db.run(
                  f"CREATE OR DISPLACE TRIGGER {trg} BEFORE UPDATE ON {t} "
                  f"FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x'") or "支持",
              fail_level="INFO", fail_note="不支持也无妨，只是少一个幂等化手段")

    db.quiet_drop(f"DROP TRIGGER IF EXISTS {trg}", f"DROP TABLE IF EXISTS {t}")


# ── 4. P0-3 预处理语句 ────────────────────────────────────────
def sec_prepared(db: Db, rep: Report, connect_kw: dict) -> None:
    s = "4 P0-3 预处理语句"

    # (a) SQL 层 PREPARE —— 手册明写"不支持"的那一项。
    probe(rep, s, "SQL 层 PREPARE / EXECUTE",
          lambda: (db.run("PREPARE probe_stmt FROM 'SELECT 1'"),
                   db.all("EXECUTE probe_stmt"),
                   db.run("DEALLOCATE PREPARE probe_stmt"), "支持")[-1],
          expect_fail=True, ok_note="与手册一致；我们代码不用它")

    # (b) 二进制协议 COM_STMT_PREPARE —— mysql2 的 execute() 走的就是这条，是真正的 P0-3。
    try:
        c2 = pymysql.connect(**connect_kw)
        try:
            c2._execute_command(0x16, "SELECT 1")   # COM_STMT_PREPARE
            pkt = c2._read_packet()
            ok = not pkt.is_error_packet()
            rep.add("OK" if ok else "BLOCKER", f"{s}|二进制协议 COM_STMT_PREPARE",
                    "服务端接受预处理 → 45 处 pool.execute() 其实能用，P0-3 从必做降为按手册建议做（手册明确不推荐服务端 prepare）"
                    if ok else "服务端拒绝 → **45 处 pool.execute() 必须改成 pool.query()**（exec/ 31 处 + agent/mysql-session-store.ts 14 处）")
        finally:
            c2.close()
    except Exception as e:  # noqa: BLE001 —— 这里任何异常都当"不可用"处理
        rep.add("BLOCKER", f"{s}|二进制协议 COM_STMT_PREPARE",
                f"探测失败/被拒: {str(e)[:120]} → 按不可用处理，exec/ 必须改 query()")

    rep.add("INFO", f"{s}|knex 路径", "knex 的 mysql2 方言走 connection.query()（文本协议），不受影响")


# ── 5. 语法基线（确认是不是 5.7） ─────────────────────────────
def sec_syntax(db: Db, rep: Report) -> None:
    s = "5 语法基线"
    for name, sql, expect_fail, note in [
        ("CTE（WITH …）", "WITH x AS (SELECT 1 AS a) SELECT a FROM x", True, "8.0 特性；代码零使用"),
        ("窗口函数 ROW_NUMBER()", "SELECT ROW_NUMBER() OVER (ORDER BY 1) AS r", True, "8.0 特性；代码零使用"),
        ("JSON_TABLE", "SELECT * FROM JSON_TABLE('[1]', '$[*]' COLUMNS(v INT PATH '$')) AS t", True, "8.0 特性；代码零使用"),
        ("utf8mb4_0900_ai_ci 排序规则", "SELECT _utf8mb4'a' COLLATE utf8mb4_0900_ai_ci", True, "8.0 专属；我们统一用 utf8mb4_unicode_ci"),
        ("JSON 函数 JSON_EXTRACT", "SELECT JSON_EXTRACT('{\"a\":1}', '$.a')", False, "5.7 就有"),
        ("SHA2()（生成列用到）", "SELECT SHA2('x', 256)", False, "core schema 的生成列依赖它"),
        ("utf8mb4_unicode_ci 排序规则", "SELECT _utf8mb4'a' COLLATE utf8mb4_unicode_ci", False, "全部 49 处索引/列在用"),
        ("SHOW WARNINGS", "SHOW WARNINGS", False, "手册标'结果不保证正确性'，仅记录"),
    ]:
        probe(rep, s, name, lambda q=sql: (db.all(q), "可用")[1],
              expect_fail=expect_fail, ok_note=note, fail_level="WARN", fail_note=note)


# ── 6. 事务与锁 ───────────────────────────────────────────────
def sec_txn(db: Db, rep: Report) -> None:
    s = "6 事务与锁"
    probe(rep, s, "START TRANSACTION / COMMIT / ROLLBACK",
          lambda: (db.run("START TRANSACTION"), db.run("ROLLBACK"), "可用")[-1])
    probe(rep, s, "SAVEPOINT（UPDRDB 手册标不支持）",
          lambda: (db.run("START TRANSACTION"), db.run("SAVEPOINT sp1"),
                   db.run("ROLLBACK TO SAVEPOINT sp1"), db.run("ROLLBACK"), "可用")[-1],
          expect_fail=True,
          ok_note="不影响我们：仓储用 isTransaction 判断显式规避了嵌套事务")
    db.conn.rollback()
    # 必须锁一张真实存在的表，否则 1146（表不存在）会被误判成"语法不支持"。
    tl = f"{P}locktbl"
    db.quiet_drop(f"DROP TABLE IF EXISTS {tl}")
    db.run(f"CREATE TABLE {tl} (id INT PRIMARY KEY) ENGINE=InnoDB")
    db.conn.commit()
    probe(rep, s, "LOCK TABLES（手册：应答成功但实际无影响）",
          lambda: (db.run(f"LOCK TABLES {tl} READ"), "应答成功")[-1],
          expect_fail=True, fail_level="INFO",
          ok_note="代码未使用；注意手册说它'成功应答但实际无影响'，应答成功不代表真锁上了")
    db.quiet_drop("UNLOCK TABLES", f"DROP TABLE IF EXISTS {tl}")
    probe(rep, s, "SET SESSION TRANSACTION ISOLATION LEVEL",
          lambda: (db.run("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"), "可用")[-1],
          fail_level="WARN", fail_note="手册标 SET TRANSACTION 不支持；确认 knex 不会发它")


# ── 7. 真实 schema 形状 ───────────────────────────────────────
def sec_schema(db: Db, rep: Report) -> None:
    """按 core_platform_schema 的真实特征建一张表：CHAR(26) ULID 主键、JSON、
    STORED 生成列、DATETIME(3)、外键、唯一索引。任何一项挂了迁移就跑不完。"""
    s = "7 真实 schema 形状"
    parent, child = f"{P}parent", f"{P}child"
    db.quiet_drop(f"DROP TABLE IF EXISTS {child}", f"DROP TABLE IF EXISTS {parent}")

    probe(rep, s, "父表：CHAR(26) 主键 + JSON + DATETIME(3) + ON UPDATE",
          lambda: (db.run(f"""
            CREATE TABLE {parent} (
              id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              org_id VARCHAR(64) NOT NULL,
              config_json JSON NOT NULL,
              name VARCHAR(255) NOT NULL,
              created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
              updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                     ON UPDATE CURRENT_TIMESTAMP(3),
              PRIMARY KEY (id),
              UNIQUE KEY uq_org_name (org_id, name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"""), "已建")[-1],
          fail_note="core schema 的基础形状")

    probe(rep, s, "STORED 生成列 SHA2(...)（artifacts 表在用）",
          lambda: (db.run(f"""
            ALTER TABLE {parent} ADD COLUMN path_hash
              CHAR(64) CHARACTER SET ascii COLLATE ascii_bin
              GENERATED ALWAYS AS (LOWER(SHA2(`name`, 256))) STORED NOT NULL"""), "已加")[-1],
          fail_note="20260718000001 迁移会失败")

    probe(rep, s, "外键（core schema 43 处）",
          lambda: (db.run(f"""
            CREATE TABLE {child} (
              id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              parent_id CHAR(26) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
              payload_json JSON NULL,
              PRIMARY KEY (id),
              KEY idx_parent (parent_id),
              CONSTRAINT fk_probe_parent FOREIGN KEY (parent_id)
                REFERENCES {parent}(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"""), "已建")[-1],
          fail_note="分库模式下 FK 不可用 → 完整性要挪到应用层（§1.3）")

    def fk_enforced() -> str:
        try:
            db.run(f"INSERT INTO {child} (id, parent_id) VALUES ('x', 'nonexistent')")
            db.conn.commit()
            return "❌ 外键未生效（脏数据插进去了）"
        except MySQLError:
            db.conn.rollback()
            return "外键真实生效（拒绝了孤儿行）"
    got = probe(rep, s, "外键是否真的生效（不只是建成功）", fk_enforced)
    if isinstance(got, str) and got.startswith("❌"):
        rep.add("BLOCKER", f"{s}|外键约束形同虚设", "建表成功但不拦孤儿行 —— 等同于没有外键")

    db.run(f"INSERT INTO {parent} (id, org_id, config_json, name) VALUES "
           f"('01ABCDEFGHIJKLMNOPQRSTUVWX','org-1','{{\"a\":1}}','n1')")
    db.conn.commit()

    probe(rep, s, "JSON 列往返（wire 格式）",
          lambda: f"读回 {db.one(f'SELECT config_json FROM {parent} LIMIT 1')[0]!r}",
          ok_note="mysql2 侧配了 jsonStrings=true，期望是字符串形态")
    probe(rep, s, "唯一索引冲突（幂等键依赖）",
          lambda: (db.run(f"INSERT INTO {parent} (id, org_id, config_json, name) VALUES "
                          f"('01ZZZZZZZZZZZZZZZZZZZZZZZZ','org-1','{{}}','n1')"), "未冲突")[-1],
          expect_fail=True, ok_note="冲突被拒 = 唯一性真实生效（分库模式下只保证分片内唯一）")
    db.conn.rollback()
    probe(rep, s, "INSERT … ON DUPLICATE KEY UPDATE",
          lambda: (db.run(f"INSERT INTO {parent} (id, org_id, config_json, name) VALUES "
                          f"('01ABCDEFGHIJKLMNOPQRSTUVWX','org-1','{{}}','n1') "
                          f"ON DUPLICATE KEY UPDATE org_id=VALUES(org_id)"), "可用")[-1])
    db.conn.commit()

    probe(rep, s, "多语句事务原子性（回滚真的回滚）",
          lambda: (db.run("START TRANSACTION"),
                   db.run(f"UPDATE {parent} SET org_id='org-2'"),
                   db.run("ROLLBACK"),
                   f"回滚后 org_id={db.one(f'SELECT org_id FROM {parent} LIMIT 1')[0]}")[-1],
          ok_note="期望仍是 org-1")

    # mysql2 侧配了 timezone=Z + dateStrings=true。若服务端时区语义与预期不符，
    # 存进去和读出来会差几个小时 —— 这是最典型也最难查的生产事故。
    def datetime_roundtrip() -> str:
        db.run(f"UPDATE {parent} SET created_at = %s WHERE id = %s",
               ("2026-01-02 03:04:05.678", "01ABCDEFGHIJKLMNOPQRSTUVWX"))
        db.conn.commit()
        got = db.one(f"SELECT created_at FROM {parent} WHERE id = %s",
                     ("01ABCDEFGHIJKLMNOPQRSTUVWX",))[0]
        same = str(got).startswith("2026-01-02 03:04:05")
        return ("写入 2026-01-02 03:04:05.678，读回 "
                f"{got}{'' if same else '  ← 值被时区偏移了！'}")
    got = probe(rep, s, "DATETIME(3) 往返不偏移", datetime_roundtrip)
    if isinstance(got, str) and "偏移" in got:
        rep.add("BLOCKER", f"{s}|时区语义不一致", "所有时间戳字段都会错，必须先解决")

    # 服务端默认排序规则若不是 utf8mb4_unicode_ci，任何**没显式写 COLLATE 的**新表
    # 都会继承服务端默认，将来和既有表做列对列比较时报 1267 Illegal mix of collations。
    def collation_mix() -> str:
        srv = db.one("SELECT @@collation_server")[0]
        db.quiet_drop(f"DROP TABLE IF EXISTS {P}nocollate")
        db.run(f"CREATE TABLE {P}nocollate (v VARCHAR(64)) ENGINE=InnoDB")
        got = db.one(f"SELECT table_collation FROM information_schema.tables "
                     f"WHERE table_schema=DATABASE() AND table_name=%s", (f"{P}nocollate",))[0]
        mixed = None
        try:
            db.one(f"SELECT 1 FROM {P}nocollate a JOIN {parent} b ON a.v = b.name LIMIT 1")
            mixed = "可比较"
        except MySQLError as e:
            mixed = f"比较报错 {e.args[0]}"
        db.quiet_drop(f"DROP TABLE IF EXISTS {P}nocollate")
        return (f"@@collation_server={srv}；不写 COLLATE 的新表落成 {got}；"
                f"与 utf8mb4_unicode_ci 列对比 → {mixed}")
    got = probe(rep, s, "排序规则混用风险", collation_mix)
    if isinstance(got, str) and "1267" in got:
        rep.add("WARN", f"{s}|排序规则不一致",
                "服务端默认与我们的 utf8mb4_unicode_ci 不同 → **每张表、每个索引列都必须显式写 "
                "COLLATE**（现有 22 个迁移都写了，但新增迁移漏写会在跨表比较时炸）")

    probe(rep, s, "SHOW CREATE TABLE（看服务端实际落成什么）",
          lambda: db.one(f"SHOW CREATE TABLE {parent}")[1].replace("\n", " ")[:400])
    db.quiet_drop(f"DROP TABLE IF EXISTS {child}", f"DROP TABLE IF EXISTS {parent}")


# ── 8. knex 迁移器自身的依赖 ──────────────────────────────────
def sec_knex(db: Db, rep: Report) -> None:
    """knex.migrate.latest() 自己要建两张表并做锁，跑不通迁移一步都走不了。"""
    s = "8 knex 迁移器"
    a, b = f"{P}knex_migrations", f"{P}knex_migrations_lock"
    db.quiet_drop(f"DROP TABLE IF EXISTS {a}", f"DROP TABLE IF EXISTS {b}")
    probe(rep, s, "knex_migrations 表形状",
          lambda: (db.run(f"""CREATE TABLE {a} (
              id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(255), batch INT, migration_time TIMESTAMP
                DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)"""), "可建")[-1])
    probe(rep, s, "knex_migrations_lock + 自增",
          lambda: (db.run(f"""CREATE TABLE {b} (
              index_ INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
              is_locked INT)"""),
                   db.run(f"INSERT INTO {b} (is_locked) VALUES (0)"),
                   f"LAST_INSERT_ID={db.one('SELECT LAST_INSERT_ID()')[0]}")[-1],
          ok_note="分库模式下自增用雪花算法，不保证递增（§1.3）")
    probe(rep, s, "迁移锁的 UPDATE … WHERE 语义",
          lambda: f"抢锁影响 {db.run(f'UPDATE {b} SET is_locked=1 WHERE is_locked=0')} 行（期望 1）")
    db.conn.commit()
    db.quiet_drop(f"DROP TABLE IF EXISTS {a}", f"DROP TABLE IF EXISTS {b}")


# ── 9. 连接行为 ───────────────────────────────────────────────
def sec_conn(db: Db, rep: Report, connect_kw: dict) -> None:
    s = "9 连接行为"
    t0 = time.monotonic()
    try:
        c = pymysql.connect(**connect_kw)
        c.close()
        rep.add("OK", f"{s}|建连耗时", f"{(time.monotonic()-t0)*1000:.0f} ms"
                                       "（手册建议 connectTimeout=3000）")
    except MySQLError as e:
        rep.add("WARN", f"{s}|建连耗时", str(e)[:100])
    probe(rep, s, "SET NAMES utf8mb4（驱动握手会发）",
          lambda: (db.run("SET NAMES utf8mb4"), "可用")[-1],
          fail_note="非透传模式需要在 proxy 白名单里")
    probe(rep, s, "SET SESSION 变量（白名单外的应被拒）",
          lambda: (db.run("SET SESSION sql_safe_updates=0"), "可用")[-1], fail_level="INFO")
    # 【重要】不能真去改全局变量 —— 托管实例上那是持久副作用。
    # 先读回当前值，再"设成它自己"：语法能力照样被检验，成功也只是空操作。
    try:
        cur = db.one("SELECT @@global.connect_timeout")[0]
        probe(rep, s, "SET GLOBAL（手册明确不支持，预期失败；此处设为原值，无副作用）",
              lambda: (db.run(f"SET GLOBAL connect_timeout={int(cur)}"), "竟然可用（已设回原值）")[-1],
              expect_fail=True, ok_note="符合预期；应用不应依赖全局变量")
    except MySQLError as e:
        rep.add("INFO", f"{s}|SET GLOBAL", f"连 @@global 都读不到：{str(e.args[-1])[:80]}")


def parse_target(args) -> dict:
    if args.url:
        u = urlparse(args.url)
        if not u.scheme.startswith("mysql"):
            sys.exit(f"不认识的 scheme: {u.scheme}")
        return {
            "host": u.hostname or "127.0.0.1", "port": u.port or 3306,
            "user": unquote(u.username or ""), "password": unquote(u.password or ""),
            "database": (u.path or "/").lstrip("/"),
        }
    return {"host": args.host, "port": args.port, "user": args.user,
            "password": args.password, "database": args.database}


def main() -> int:
    ap = argparse.ArgumentParser(description="UPDRDB 兼容性探针")
    ap.add_argument("url", nargs="?", help="mysql://user:pass@host:port/db")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3306)
    ap.add_argument("--user", default="")
    ap.add_argument("--password", default="")
    ap.add_argument("--database", default="")
    ap.add_argument("--timeout", type=int, default=10)
    ap.add_argument("--keep", action="store_true", help="保留探针表（默认跑完清理）")
    args = ap.parse_args()

    kw = parse_target(args) | {
        "charset": "utf8mb4", "autocommit": False,
        "connect_timeout": args.timeout, "read_timeout": args.timeout * 6,
        "write_timeout": args.timeout * 6,
    }
    if not kw["database"]:
        sys.exit("必须指定库名 —— 探针会建临时表，请用专门的探针库，不要对生产库跑")

    rep = Report()
    try:
        db = Db(**kw)
    except MySQLError as e:
        print(f"连不上 {kw['host']}:{kw['port']}/{kw['database']} —— {e}", file=sys.stderr)
        return 2

    try:
        sec_identity(db, rep)
        sec_skip_locked(db, rep, kw)
        sec_triggers(db, rep)
        sec_prepared(db, rep, kw)
        sec_syntax(db, rep)
        sec_txn(db, rep)
        sec_schema(db, rep)
        sec_knex(db, rep)
        sec_conn(db, rep, kw)
    finally:
        if not args.keep:
            for t in ("child", "parent", "lock", "locktbl", "trg", "nocollate",
                      "knex_migrations", "knex_migrations_lock"):
                db.quiet_drop(f"DROP TABLE IF EXISTS {P}{t}")
            db.quiet_drop(f"DROP TRIGGER IF EXISTS {P}trg_forbid_update")
            db.conn.commit()
        db.conn.close()

    rep.render()
    return 1 if rep.blockers() else 0


if __name__ == "__main__":
    sys.exit(main())
