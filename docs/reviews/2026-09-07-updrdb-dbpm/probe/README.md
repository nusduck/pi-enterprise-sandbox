# 探针工具（阶段 0 用）

一组**自包含**脚本，拷到能访问目标环境的机器上直接跑，回答改造方案里
"文档这么说，实际到底行不行"的问题。都不写业务数据、跑完自清理。

| 脚本 | 目标 | 依赖 | 回答方案哪一节 |
|---|---|---|---|
| [`updrdb_probe.py`](./updrdb_probe.py) | UPDRDB / UPSQL | **PyMySQL** | §1 现状盘点、§2 三个 P0、§5 语法基线 |
| [`upredis_probe.py`](./upredis_probe.py) | UPRedis | **无**（内置 RESP2 客户端） | §4 Redis 评估、§4.5 UPRedis 专项 |
| [`dbpm_probe.py`](./dbpm_probe.py) | DBPM 取密 | **无** | §5 DBPM 接入 |
| [`updrdb_recheck.py`](./updrdb_recheck.py) | **补跑**：时区一致性 / claim-then-read 互斥 / 排序规则混用 | **PyMySQL** | §6.3、§6.4 |
| [`fake_dbpm_server.py`](./fake_dbpm_server.py) | **本地假 DBPM**（开发挡板，说真协议） | **无** | §5.2 挡板方案 |
| [`vm_preflight.sh`](./vm_preflight.sh) | **VM 装机前体检**（麒麟 V11 / bwrap 实测 / 源与资源） | **无**（纯 bash） | 部署拓扑 §4 VM 侧 |

Python **3.13**（最低 3.11）。退出码统一：`0` 无 BLOCKER / `1` 有 BLOCKER / `2` 连不上。
`vm_preflight.sh` 是 bash，只用前两个退出码。

## 快速开始

```bash
# 1. UPDRDB —— 需要一个**专门的探针库**，脚本会建/删 t_probe_* 表
pip install PyMySQL     # 装不了就把 pymysql 包目录拷到脚本旁边（纯 Python）
python3.13 updrdb_probe.py "mysql://user:pass@<updrdb-host>:4049/probe_db"

# 2. UPRedis —— 零依赖
python3.13 upredis_probe.py "redis://:password@<upredis-host>:6379/0"
python3.13 upredis_probe.py "<url>" --idle-test 300        # 额外测代理空闲断链
python3.13 upredis_probe.py "<url>" --allow-script-flush   # 额外测 NOSCRIPT 回退

# 3. DBPM —— 零依赖，不打印口令明文
python3.13 dbpm_probe.py --url "<dbpm-primary>:7000,<dbpm-standby>:7000" \
    --db-name rstlmrdsdb --db-user rstlmap
```

## 四条使用纪律

1. **UPDRDB 探针要用专门的库**，不要对生产库跑。它会建 `t_probe_*` 表、建触发器、
   开事务、故意制造唯一键冲突。默认跑完清理，`--keep` 可保留现场排查。
2. **`--allow-script-flush` 在共享 Redis 上别加**。`SCRIPT FLUSH` 会清掉同实例上
   其他应用的脚本缓存。
3. **口令不会被打印**。DBPM 探针只输出 `len=N sha256:xxxxxxxx`，够比对主备是否一致，
   不泄露明文（AGENTS.md §2）。
4. **两个探针都不改服务端状态**。UPDRDB 的 `SET GLOBAL` 测试会先读回当前值再设成它自己
   （语法能力照测，成功也是空操作）；Redis 探针**不用 `KEYS`**（大实例上是阻塞的
   O(N) 全库扫描），只删自己建过的 key，并在目标 db 非空时告警。

## 已验证的场景（2026-09-07，本机 Docker）

不是"写完就交"，三个脚本都对着真实服务端跑过正反两路：

| 脚本 | 被测 | 结果 |
|---|---|---|
| `updrdb_probe.py` | **MySQL 5.7**（UPDRDB 的语法基线） | 正确报出 `SKIP LOCKED` / CTE / 窗口函数 / `JSON_TABLE` / `utf8mb4_0900` 全部不可用；触发器建得起来且真的拦住 UPDATE；真实 schema 形状（CHAR(26) 主键 + JSON + STORED 生成列 + 外键 + DATETIME(3)）全部建成 |
| `updrdb_probe.py` | MySQL 8.0（对照组） | `SKIP LOCKED` 报"竟然支持"并给出"§P0-1 可以不做"的结论 |
| `upredis_probe.py` | **Redis 6.0.12** | 全绿：58 条命令齐全、EVAL/EVALSHA/CAS/14-KEY 脚本均通过、`SCRIPT FLUSH` 后 EVAL 回退自愈、BZPOPMIN 阻塞 2.1s 正常返回、读己之写 200 轮无 miss |
| `upredis_probe.py` | 6.0.12 + `--rename-command EVAL ""` | 正确报出 4 个 BLOCKER 并跳过后续 Lua 测试 |
| `upredis_probe.py` | 6.0.12 + `maxmemory-policy=allkeys-lru` | 正确报出驱逐策略 BLOCKER |
| `upredis_probe.py` | Redis 7.2（当前生产版本） | 全绿 |
| `dbpm_probe.py` | `fake_dbpm_server.py` | 四种情况都正确：主备一致 → 0；口令不一致 → 1；单台可用 → 1；两台皆挂 → 2 |
| `updrdb_probe.py` | 5.7 复验（改版后） | `SET GLOBAL` 跑完 `@@global.connect_timeout` 仍为 10（无副作用）；DATETIME(3) 往返不偏移；**claim-then-read 互斥成立：A 抢到 1 行、B 抢到 0 行** |
| `upredis_probe.py` | 7.2 复验（改版后） | 跑完目标 db `DBSIZE=0`（精确清理生效）；对非空 db 正确告警 |

## 跑完之后

把三份输出贴进 `docs/evidence/`（AGENTS.md §6：只新增，不改写），
然后按结果更新方案里对应的待确认项：

- `SKIP LOCKED` 不可用 → §P0-1 必做
- 触发器四步任一失败 → 走 §P0-2 分支 2（应用层 + REVOKE）
- `COM_STMT_PREPARE` 被拒 → §P0-3 必做
- Redis 有 BLOCKER → 阶段 4 不要开始

## VM 装机前体检

在目标虚拟机上以**部署账号**（非 root）直接跑，只读、不装任何东西：

```bash
bash vm_preflight.sh                                  # 直接看结果
bash vm_preflight.sh > preflight-$(hostname).txt 2>&1  # 存档给管理员提工单
```

第 4 节是重点：它用 `exec/src/isolation/render.ts` 生产路径下发的**同一组 flag**
实测 bubblewrap，分三步（user namespace + uid 映射 → 私有 `/proc` → 完整全集），
失败时能指出卡在哪一层。**`--uid 10001` 那步同时回答了 `SANDBOX_BWRAP_UID`
默认值在非 root 账号下成不成立。**
