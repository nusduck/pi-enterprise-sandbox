# ADR 0017: 后台进程不跨 exec 重启存活，输出持久化

| 字段 | 值 |
|---|---|
| 状态 | **Accepted**（2026-10-03，产品确认） |
| 日期 | 2026-10-03 |
| 决策所有者 | Sandbox isolation maintainers |
| 适用范围 | `exec/` 的作业登记（`MySqlJobRegistry`）与作业输出落盘；`agent/` 模型侧 job 工具；STATUS C7 的验收口径 |
| 关联决策 | [ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) D7（作业管理自建、记录落 MySQL） |

---

## 背景

plan §32 对长任务的要求是"使用 Process Handle，不让 Tool Call 占用 HTTP 请求"，并没有要求进程跨执行面重启存活。
STATUS C7 一直把"日志缓冲与活句柄不能跨 exec 重启恢复"列为剩余缺口。

活句柄是 exec 进程里的 `ChildProcess`，bwrap 子进程随 exec 容器一起结束。要让它跨重启存活，作业就得交给
exec 之外的守护进程托管，再由 exec 凭 pid 与启动身份重新接管。这会把进程与隔离的所有权搬出 exec，
与 AGENTS.md §1 "exec 是工作区字节、进程与 Bubblewrap 隔离的唯一拥有者"冲突。

## 决策

**D1 — 进程不跨 exec 重启存活。** exec 重启后，仍为 running 的作业由启动期孤儿回收标为终态
（`orphaned: worker restarted`）；对它们的 signal / kill / stdin 返回"无活句柄"。这是设计边界，不再算 C7 缺口。

**D2 — 输出跨 exec 重启保留。** exec 把每个作业的输出保留窗口写到控制根 `job-output/`
（运行中约每秒一次、结束时强制一次，上限与内存缓冲相同）。内存条目回收或 exec 重启后，按同一套游标续读；
运行中最多丢失最近一个落盘间隔的输出。

**D3 — 丢失必须显式。** 输出既不在内存也不在磁盘时，exec 返回 `lossy: true, outputUnavailable: true`，
模型侧 `job_output` 给出"输出不可用"提示，不能表现成"没有新输出"。

## 后果

- C7 的验收口径：进程句柄登记与控制（start / list / log / signal / cancel、跨用户 404）、跨 Worker 查询、
  输出跨 exec 重启可读、丢失显式。不包含进程跨 exec 重启存活。
- 输出文件目前只在工作区删除时清理，按时间回收另行处理。
- 实现见 #115，证据见 [evidence/2026-10-03-c7-job-output-persist.md](../evidence/2026-10-03-c7-job-output-persist.md)。
