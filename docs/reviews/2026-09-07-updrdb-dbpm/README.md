# UPDRDB / UPRedis / DBPM 数据库改造（2026-09-07 ~ 09-08）

把正式拓扑从 MySQL 8 + Redis 7.2 换成公司内部的 **UPDRDB 2.4.1（透传模式）**
与 **UPRedis 5.0.14**，口令改由 **DBPM** 在启动时下发。

| 文件 | 内容 |
|------|------|
| [`migration-plan.md`](./migration-plan.md) | **改造方案定稿**：现状盘点、6 个 P0 的结论与做法、分阶段计划、验证证据、风险与剩余待明确项 |
| [`deployment-topology.md`](./deployment-topology.md) | **内网部署拓扑定稿**：K8s 4 个工作负载 + VM 2 个容器、Service/LB 配置、无状态核查、跨机明文的风险与补偿、内网源与 LLM 网关 |
| [`probe/`](./probe/) | 兼容性探针工具与真机输出，见 [probe/README.md](./probe/README.md) |
| [`probe-redis.mjs`](./probe-redis.mjs) | Redis 探针的 Node 版（能跑真实 BullMQ 端到端；Python 版覆盖面更广） |

**决策已固化为 [ADR 0011](../../adr/0011-updrdb-upredis-dbpm-migration.md)。**
本目录是支撑该 ADR 的调研与实测记录。

## 结论摘要

6 个 P0 里 1 个取消、1 个降级，剩 4 个必做且都不改业务逻辑：

| # | 项 | 状态 |
|---|---|---|
| P0-1 | `SKIP LOCKED` → claim-then-read | ❌ 必做（替代方案互斥语义真机验证成立） |
| P0-2 | append-only 触发器 | ✅ **取消**（真机全过，不需降级路径） |
| P0-3 | 45 处 `.execute()` → `.query()` | ⬇️ 降为技术债（真机接受预处理） |
| P0-4 | 两个 Proxy 故障切换 | ❌ 必做（应用侧自研） |
| P0-5 | 移除 `agent-migrate`，手工 DDL + 启动校验 | ❌ 必做（生产与测试均无 DDL 权限） |
| P0-6 | 时区 `+08:00` vs 应用 UTC 差 8 小时 | ❌ 必做（会话级 `SET time_zone`，已实测有效） |

UPRedis 侧两个真 BLOCKER：BullMQ prefix 改 `{bull}` hash tag（配置项）、
`maxmemory-policy` 改 `noeviction`（运维一条命令）。

## 状态

**数据库改造方案与决策完成，实施未开始。** 阶段 1–3 不依赖任何未决项，可直接开工。
剩余待明确项见方案 §12，均不阻塞。

**内网部署拓扑已按 2026-09-10 的新环境事实重写**：K8s **双集群**各 5 个 Deployment
（frontend / api-server / agent / agent-worker / **sandbox-mcp**）+ 一台**裸装**虚拟机
跑 `sandbox`（银河麒麟 V11，无 Docker）。跨集群一律经 LB，共 5 条；A2A 对外暴露；
不做 TLS（内网不考虑抓包）。

相对 09-09 版的四处推翻见拓扑文档开头的说明。VM 装机清单已按 RPM 系重列，
**待 [`probe/vm_preflight.sh`](./probe/vm_preflight.sh) 的体检结果回填**（拓扑 §4.3）。
新增代码工作项 5 个（拓扑 §7），待确认 6 项（拓扑 §8）。

> **2026-09-11：VM 机器尚未到手**，体检脚本一次都没在目标环境跑过。
> VM 侧暂按「bwrap 可行」的**假设**推进，口径与后果见拓扑 §4.0——
> 该假设不成立时 VM 方案整体重谈，无降级路径。预计 09 月第 3 周有结果。

行动项落地后，按 AGENTS.md §8 归档到 `docs/archive/reviews/` 并修正活跃引用。
