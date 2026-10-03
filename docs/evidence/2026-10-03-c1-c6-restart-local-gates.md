# 2026-10-03 C1 / C6 与 Worker 重启本地 gate

**对象：** `main @ 67f0f9c4` 加本分支的两处测试改动；macOS Docker Desktop 上运行的 Compose 开发栈。容器内 Node v22.23.2；MySQL、Redis 和其余版本按 `runtime-versions.json` 与开发栈配置。本次不是目标环境或真实生产模型验收。

## C1：并发创建与 1:1 约束

- 在独立的 `dsh_gate_c1_20261003` MySQL 库运行 `npx tsx --test tests/mysql/default-agent-race.integration.test.js`，结束后删除该库；没有使用开发会话库。
- 结果 3/3：同一组织 8 个用户同时创建首批会话全部成功；每个返回的会话都能在持久 `tbl_agsvc_agent_sessions` 中找到对应的 Workspace 与 Sandbox Session，二者各有 8 个不同 ID。将第二个 AgentSession 的 `workspace_id` 改为第一个的值，MySQL 返回 `ER_DUP_ENTRY`。默认 Agent 只生成一份，已有默认 Agent 的并发正对照也通过。
- 这一 gate 验证 Agent/MySQL 一侧的并发绑定和冲突拒绝。2026-09-01 的 BFF → Agent → Sandbox 映射真机证据与 2026-10-03 的删除回收链路另见 STATUS C1 引用。本次没有在目标集群制造并发流量。

## C6：多行 Python 的真实执行

- 在运行中的 Compose `sandbox` 容器里以 uid 10001 调用镜像内生产 `dist/shell/executor.js` 的 `IsolatedShellExecutor.runPython`，使用唯一临时 workspace、tmp 和 execution ID。输入为 `from pathlib import Path\nprint('C6_LIVE_OK')\nprint(Path.cwd())`。
- 结果：`exitCode=0`，标准输出为 `C6_LIVE_OK` 与 `/home/sandbox/workspace`；物化文件 `.runtime/python/<executionId>.py` 存在且内容与输入一致。执行器使用容器内 `/usr/bin/bwrap` 和 `/opt/dsh-python/venv/bin/python3`。只清理本次建立的两个目录。
- 这是生产执行器到 bwrap 的真机路径，未经过 Agent 或 HTTP；它补上 STATUS C6 原先写明的 Compose 内 bwrap 验证缺口。

## G2：Worker 重启 gate 复跑

- `scripts/dev/release-gate-dsh-restart.sh` 使用独立 `dsh_gate_dsh` 库、Redis、sandbox 与数据根，真实 DSH 运行时和生产 Worker 组合，假模型；脚本收尾删除专用资源。
- 首次为 4/5：模型 SIGKILL 重放、停泊后续跑、sandbox 中断记 UNKNOWN 通过；工具派发边界用例的正对照因测试辅助 `ExecRpcClient` 未传必需 `systemSkills`，在发请求前抛 `cfg.systemSkills is not iterable`。补齐空系统清单后重跑 5/5，通过“派发边界不重放”和真实内部面写文件的正对照。
- 此 gate 证明 G2 的 Run/工具恢复语义；它没有覆盖 C7 的模型侧跨 Worker `job_list`/`job_output`、exec 重启后的日志缓冲和活句柄恢复。C7 仍为 `partial`。

## 提交前检查

- Agent 全套在 Node v22.23.2 运行器中、只读挂载仓库测试所需的 `docs/`、`tests/`、`skills/` 与 Compose 文件后 2098/2098 通过；Agent、BFF、contract、exec 类型检查通过。
- contract 157/157、BFF 319/319、frontend 713/713；frontend build 通过。exec 首次在其他套件并行运行时有 1 个 100 ms readiness 超时断言失败；单独复跑该文件 8/8，全套复跑 499 通过、3 跳过、0 失败。
- `uv run pytest -q` 为 222 通过、1 失败：布局检查发现工作区原有、未纳入 git 的 `.agy-staff/jobs/*.result.md`；排除此项后 222/222 通过。没有删除这些本地文件或改弱断言。
