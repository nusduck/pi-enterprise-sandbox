# W2-C：`exec/src/workspace/` 工作区、配额与锁 🔄

继承 [`_shared.md`](_shared.md)。

## 范围
只改 `exec/src/workspace/` + `exec/test/workspace-*.test.ts`。
**不碰** `exec/src/shell/`（W2-A、W2-B）、`fs/`、`isolation/`、`types.ts`。

**`exec/src/fs/path-policy.ts` 与 `redact.ts` 已由 W1-B 实现路径校验与脱敏——直接复用，不要另写一份。**

## 交付

### 1. 工作区管理
一个 Agent Session 独占一个稳定工作区，多轮 Run 复用同一 `workspaceId`；初始化与清理。
**物理根只存在于这一层**，绝不进入 API、日志、模型上下文或错误文本。

### 2. 会话私有持久 `/tmp`（[ADR 0004](../../adr/0004-session-persistent-tmp.md)，语义一字不改）
`SANDBOX_TEMP_ROOT/tmp_{workspace_id}`，跨 Run 持久，**不是每次执行独立 tmpfs**。
XDG 三个子目录住在会话自己的持久 temp 树里，继承其生命周期与配额；
**不构成第四个存储根，也不跨租户共享**。

### 3. 配额（两套都要）
- **控制面配额账本**：预留记录存在**工作区外面**——因为不可信子进程能删掉工作区内的文件，账本放里面就能被篡改来超卖配额。**这条设计意图必须写进注释。**
- **子进程磁盘监控**：`bash`/`python` 直接往绑定里写，只有 `RLIMIT_FSIZE` 挡着，能用大量小文件写满磁盘

### 4. 单实例锁抽象（ADR 0008 D5 的预留扩展点）
- 加锁抽象成 `WorkspaceLock` 接口，进程内实现是默认；将来换 MySQL 咨询锁只换实现
- **启动时断言进程数为 1**，多实例必须显式开开关——防止有人悄悄加副本导致静默丢写（Python 版的 `SANDBOX_UVICORN_WORKERS` 就是这个隐患）

## 数据库
同 W2-B：收在窄接口（`WorkspaceStore` / `QuotaStore`）后面，`mysql2` 实现 + 内存实现。
**报告里写出接口全文**，主控转交 W3-D。**不要自己写迁移。**

## 参考（只读）
`sandbox/services/workspace_manager.py`、`workspace_quota_ledger.py`、`child_workspace_quota.py`、`sandbox/paths.py`、`sandbox/isolation/bubblewrap.py:82-101`（XDG 绑定）
