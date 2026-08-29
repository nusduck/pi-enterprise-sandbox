# W1-B：`exec/src/fs/` 文件系统围栏 ✅

继承 [`_shared.md`](_shared.md)。

## 关键前提
`dsh-fs-local` **已经实现**了 12 个基础操作、文件版本（`dev:ino:size:mtimeNs:ctimeNs`）、原子写、按目标加锁的编辑临界区、`createIfAbsent` 的硬链接抢占、`FS_*` 错误码。
**不重新实现这些**，只 `extends LocalFileSystem` 加一层多租户围栏。

## 范围
只改 `exec/src/fs/` 与 `exec/test/fs-*.test.ts`。

## 交付
- `writable-roots.ts` —— **可写根的单一事实源**（ADR 0008 D2）。文件围栏与 bwrap 挂载计划都由它派生，不得各算一遍。上游理由原文："so the fs fence and the bash runner cannot drift"
- `workspace-fs.ts` —— `WorkspaceFileSystem extends LocalFileSystem`，**只覆盖**租户根解析与写入前紧邻的 containment 复查
- `redact.ts` —— 物理根一律替换成 `<workspace>`
- 测试：`tests/test_path_validation.py` **一条不减**改写；补 `lstat` 符号链接拒绝；`targetKey` 稳定性；版本守卫；`createIfAbsent` 竞态

## 必须逐条保留的安全性质
拒绝 `..` / `~` 展开 / 盘符 / 其它绝对根 / NUL；符号链接解析后的越界检查。
**不宣称消除 TOCTOU**，但"写入前紧邻再规范化"是必须动作。

## 结果
**62/62 通过**。

### review 抓到的问题（已修）
`guard()` **fail-open**：只对 `FsError` 脱敏，而上游 `resolveLocalTarget` 会让非 ENOENT/ENOTDIR 的 `realpath` 失败（EACCES、ELOOP）以**裸 Node `Error`** 穿透——物理路径完整泄漏，**实测复现**。
改为无条件：所有抛出物一律过脱敏。
另：脱敏用的根必须是 **realpath 之后**的形式，否则符号链接场景（macOS `/var`→`/private/var`，生产的软链挂载点）静默失效。

### agent 自己多找到的（比我指出的更隐蔽）
`streamText()` 返回异步迭代器——`guard()` 包住的是"返回迭代器"那次调用，**真正的 I/O 在调用方 `for await` 时才发生**，错误从那里抛出时早已出了作用域。补了 `guardIterable()`，并用 `for await...of` 转发以保证提前 `break` 时文件描述符正确关闭。
还系统性 grep 了上游每一处 `throw error`，证明边界完整而非逐个打补丁。
并主动自曝：原来的 permission-denied 测试把 `await` 写在 `assert.rejects` 外面，**是因为错误的原因碰巧通过的**。
