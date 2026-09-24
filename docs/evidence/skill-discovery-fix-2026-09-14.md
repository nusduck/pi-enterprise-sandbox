# 验证记录：已启用用户 Skill 对模型不可见（执行器工厂漏转发 `skillRootsForRun`）

日期：2026-09-14。S1（[统一 design](../design/updrdb-dbpm-deployment.md) §3.3）实施前核对「模型可见 Skill 路径」时发现。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`1a00e487` + 本次未提交改动（随本证据同一 commit） |
| 运行栈 | 开发 Compose（MySQL 5.7、Redis 5.0.14、dbpm-fake） |
| 镜像 | 修复后 `pi-enterprise-agent` `06d5c5bc4f3d`（agent / agent-worker 均已换新容器） |
| 测试运行时 | 容器内 Node v22.23.2；复现客户端同样在 `node:22-slim` 容器内经 `api-server:4000` |

## 复现

测试包 `path-probe`（`SKILL.md` + `reference/marker.txt`，内容 `SKILL-MARKER-7f3a`）。流程：注册用户 →
`POST /api/capabilities/skills/drafts` 上传（201）→ `POST /api/capabilities/skills/path-probe/enable`（200，账本行写入）→
Run 要求模型用 `skill` 工具加载并读取资源文件。

| 观察 | 结果 |
|---|---|
| `skill` 工具加载 `path-probe` | 失败：`skill "path-probe" is unknown or no longer available` |
| 对照：同栈加载系统 Skill `grill-me` | 成功 |
| exec 侧 | 模型经 bash 能读 `/home/sandbox/skill-user/path-probe/reference/marker.txt`，挂载正常 |
| Worker 容器文件与权限 | `node` 用户可读已发布副本 |
| 身份 | Run 的 `org_id` / `user_id` 与账本、发布路径一致；在 Worker 内调用 `resolveSkillRootsForRun` 返回系统根 + 用户根 |
| 同配置单独构造 `FileSystemSkillProvider` | 列出 14 个 Skill，含 `path-probe` |
| Worker 重启后作为第一个 Run | 仍失败（排除进程内缓存） |
| **运行时探针**：临时 Worker 预加载补丁打印 `FileSystemSkillProvider.list` | 真实 Run 中 `provider=run-filesystem dirs=["/home/sandbox/skill"]`，6 次调用均无用户根 |

## 根因

`agent/src/application/dsh-run-executor-factory.ts` 逐项把依赖传给 `DshRunExecutor`，漏掉 `skillRootsForRun`
（`container-run-executor.ts` 已放入 `factoryOpts`，类型 `DshRunExecutorDeps` 也声明了该字段，所以类型检查不报）。
执行器因此不传 `additionalSkillPaths`，运行时工厂退回进程级默认值（仅系统根）。

## 修复与验证

- 工厂补上 `skillRootsForRun` 转发；`agent/tests/executor/dsh-run-executor.unit.test.js` 新增回归用例。
- 回归用例修复前在容器内失败（38 tests / 37 pass / 1 fail），修复后 38/38。
- agent（整仓拷贝、容器内）：`npm run typecheck` 通过；`npm test` 1301 / 1298 pass / 0 fail / **3 cancelled**
  （`remote-providers.test.ts` 同一组已知项，不记为通过）。
- 重建 agent 镜像并换新 agent / agent-worker 容器后重跑复现：`skill` 工具加载 `path-probe` **成功**（provider `run-filesystem`）。
- `uv run pytest -q`：123 passed。

## 同次复现确认、本次未修的问题

`skill` 工具返回的基础目录是 Agent 本地路径 `/home/sandbox/skill-user/<org>/<user>/path-probe`。模型按它 `read`
得到 `FS_SANDBOX_DENIED: skill package not enabled: <orgId>`（exec 把第一段当包名），bash `cat` 报不存在；
实际挂载在 `/home/sandbox/skill-user/path-probe`，模型自行探查后才读到标记。该问题归入 S1 第 6 条（按账本构造、
对模型给逻辑路径的 provider）实施，不在本次提交内。

## 未做 / 边界

- 仅在开发栈验证；未覆盖多副本 Worker 与共享存储。
- 已发布字节仍是原地替换布局，账本仍非发现依据；均属 S1 后续阶段。
