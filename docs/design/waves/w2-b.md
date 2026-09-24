# W2-B：`exec/src/shell/job-registry.ts` 作业登记 🔄

继承 [`_shared.md`](_shared.md)。

## 为什么不能用上游的
`dsh-jobs-local` **全部记录在内存里，重启即丢**。我们要求"Worker 重启后仍能查到进程"，
所以自建 `MySqlJobRegistry`，实现 `dsh-jobs` 的登记契约但记录落 MySQL（ADR 0008 D7）。
**先读上游 README 与 `.d.ts` 搞清契约**，再决定哪些语义照搬（准入控制、first-wins 结算、owner 作用域）、哪些必须换。

## 范围
只改 `exec/src/shell/job-registry.ts` 及其拆分出的同目录文件 + `exec/test/shell-job*.test.ts`。
**不碰** `executor.ts` / `safe-env.ts`（W2-A）、`exec/src/workspace/`（W2-C）。

## 交付
起进程 / 查状态 / 读输出 / 发信号 / 写 stdin / 杀掉，记录落 MySQL。

**必须保留今天已有且正确的部分**：
1. **增量读游标** —— 连续读不重复返回；丢数据标 `lossy` 并指向 spill 文件。**这个模型与上游 `ShellProcess.readOutput()` 完全同形**，是运气好的地方，别改坏
2. **孤儿进程检测与清理**
3. **归属校验** —— 只有起进程的租户能操作它
4. **stdin 写入、信号发送**

## 数据库
W3-D 才做正式仓储层。**不要建平行仓储体系。**
把持久化收在窄接口（`JobStore`）后面，给一个 `mysql2` 实现 + 一个测试用内存实现。
**报告里必须写出 `JobStore` 接口全文**，主控转交 W3-D。
**不要自己写迁移**——迁移权威在 `agent/`；报告里说明需要哪些列。

## 参考（只读）
`sandbox/services/process_manager.py`（**1733 行，全仓最大单文件——必须按职责拆开，不要移植成一个巨型文件**）、`process_cursor.py`、`process_handle_store.py`、`process_identity.py`、`process_owner_access.py`、`process_runtime_support.py`、`sandbox/app/persistence/repositories/process_repository.py`
