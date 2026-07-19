# ADR 0004: Agent Session 私有持久化 `/tmp`

- 状态：Accepted
- 日期：2026-07-19
- 适用范围：Sandbox 内的不可信执行进程

## 背景

`plan.md` 16.4 给出的 Bubblewrap 参数示例使用 `--tmpfs /tmp`，但该段是推荐
参数而不是锁定约束。当前产品把同一 Agent Session 的多个 Run 视为一个连续工作
上下文；Python/Node 脚本物化、长 Process Handle 和用户显式使用的 `/tmp/...` 都
可能跨越单次短执行。

若每次执行创建独立 tmpfs，后续 Run 无法读取这些临时文件，Sandbox 重启后的
Process 对账也失去脚本和有限诊断上下文。把 `/tmp` 绑定到进程全局目录则会破坏
租户与 Session 隔离。

## 决策

Sandbox 保留 **Agent Session 私有、受配额约束、随 Session 生命周期持久化** 的
`/tmp`：

1. 物理目录固定为
   `SANDBOX_TEMP_ROOT/tmp_{workspace_id}`，与唯一 `workspace_id` 一一对应。
2. 每次 Bubblewrap 执行只把当前 Session 的物理目录读写绑定到 `/tmp`；不存在
   进程全局可变软链接或共享 presentation path。
3. 目录创建权限为 `0700`，路径解析拒绝 traversal、其他绝对根和 symlink escape。
4. Workspace 与 temp 的子进程用量由同一有界监控器检查；生产正数配额还要求
   `SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=true` 对应的外部硬配额。
5. Agent Session 关闭时，Workspace 与配对 temp 必须一起删除；任一删除失败时
   不得释放 ownership binding，避免残留目录被新 Session 复用。
6. Dataset staging、Artifact 快照和内部 control 数据继续位于独立 control-plane
   根目录，绝不绑定进 Bubblewrap 的 `/tmp`。
7. `/tmp` 不是用户交付源。只有 `submit_artifact` 产生的不可变 Artifact 快照可被
   BFF/A2A 下载；普通临时文件不会自动出现在前端。

Agent 服务自身用于 `pi-mcp-adapter` 的运行时密钥目录不属于 Sandbox `/tmp`。
它由 Agent 进程私有目录管理，密钥文件权限为 `0600`，runtime dispose 时删除。

## 取舍

选择持久化 temp 会占用磁盘，且必须纳入清理与硬配额运维；这些成本由 Session
生命周期和 quota gate 显式承担。收益是多轮 Run 与长进程语义稳定，并且没有为了
tmpfs 引入另一套脚本存储或恢复路径。

若未来产品明确改为“每次执行的 `/tmp` 必须不可恢复”，需要先迁移所有跨执行
脚本和 Process Handle 到 Workspace 内部的受控私有目录，再把 Bubblewrap bind
替换为 `--tmpfs /tmp`。不能只改挂载参数。

## 验证

- `tests/test_bubblewrap_isolation.py` 验证每次执行只绑定当前 Session 的 temp。
- `tests/test_workspace_manager.py` 验证 Workspace/temp 一一对应及失败时不释放绑定。
- `tests/test_path_validation.py` 验证 `/tmp` 逻辑路径与 traversal/symlink 边界。
- `tests/test_child_workspace_quota.py` 验证 Workspace 与 temp 的联合有界计量。

