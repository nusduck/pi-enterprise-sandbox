# 验证记录：pi 命名改为 dsh、旧引擎遗留代码清理

日期：2026-09-23。分支 `refactor/updrdb-dbpm`，基线 `360d31d1` + 本次未提交改动（随本证据同批提交）。

> **结论：** 六套测试、类型检查、前端 build 全绿；开发库存量数据经迁移 `20260923000002_dsh_naming.js` 改写后，
> 105 个迁移前的活跃会话全部能由新代码恢复；重建全部镜像后真实链路 17/17，浏览器实测对话与历史回放正常。

## 代码与环境

| 项 | 值 |
|---|---|
| runtime | 测试：`node:22-slim` 容器（非 root、`--cap-drop=ALL`，依赖在镜像内 `npm ci`）；pytest 在宿主 `uv run`（Python 3.11） |
| 镜像 | `docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend`（本次工作树）；清单重新生成后再次构建 agent / agent-worker / sandbox / sandbox-mcp |
| 运行栈 | 纯 Compose（本地 `.env` 保留 `COMPOSE_PROJECT_NAME=pi-enterprise-sandbox`，数据卷沿用），容器全部为新名 `dsh-enterprise-*` 且 healthy |
| 模型 | 开发栈配置的真实模型，非 fake provider |

## 离线

| 命令 | 结果 |
|---|---|
| `uv run pytest -q` | 226 passed |
| `npm test --prefix contract` | 118/118 |
| `npm test --prefix exec`（node 用户、无 capability） | 416 pass / 2 skipped / 0 fail。以 root 运行时 4 条隔离相关用例失败（进程带 capability、无 bwrap），属环境差异 |
| `npm test --prefix agent` | 1412/1412（首轮 1 失败：测试文件改名后重复导入，已修） |
| `npm test --prefix api-server` | 165/165 |
| `npm test --prefix frontend` + `npm run build --prefix frontend` | 367/367，build 成功 |
| `tsc --noEmit`（contract / exec）、`api-server typecheck`、`agent typecheck`（两道） | 全部通过 |

## 数据库迁移（开发库 `sandbox`，含存量数据）

执行前停 agent / agent-worker / api-server / sandbox / sandbox-mcp，并 mysqldump 备份。`cli-schema sql --from 20260923000001_upspec_naming.js`
导出 1 段 15 条语句，mysql 客户端执行，随后 `cli-schema verify` → `ok, drifts: []`。

| 数据 | 迁移前 | 迁移后 |
|---|---|---|
| journal entry 行 | `pi_journal_entry` 541 | `session_journal_entry` 541（`content_json.kind` 同步） |
| journal header 行 | `pi_journal_header` 105 | `session_journal_header` 105；`session_entry_id` 仍为 `__pi_session_header__` |
| UI 助手消息的条目键 | `piEntryId` 391 | `sessionEntryId` 391，旧键 0 |
| 快照格式 | `pi_jsonl_v3` 150 | `session_jsonl_v3` 150 |
| 触发器 | 4 | 4（UPDATE 触发器摘下后原样装回） |

存量会话恢复：在 agent 镜像里用新代码对迁移前创建的 105 个 active 会话逐个调用 `SessionRecoveryService.recover()`
（事务强制回滚、`markSuspendedOnFailure: false`，只读），105/105 成功，全部走快照路径（快照 checksum 与 journal
digest / protected manifest 校验通过）。

schema 清单由新镜像在空影子库 `dsh_schema_shadow` 上跑全部迁移重新生成（29 个迁移、42 张表、4 个触发器）。

## 真实链路（经 BFF `:4000`，驱动跑在 `node:22-slim` 容器里）

17/17：A/B 注册（Cookie 为 `dsh_enterprise_session`）→ `sessions/ensure` → 带工具 Run `SUCCEEDED`（台账
`bash` ×2、`job_output`）→ 后台 TICK 进程 logs → B 对进程 detail / logs / signal 均 404 → A SIGTERM → 进程
`cancelled` → B 对 run / conversation / tools / ensure 均 404 → A 自己 200 → 第二轮（从第一轮的快照 / journal
恢复）`SUCCEEDED` 且记得第一轮输出。新写入的行使用新标记。

## 浏览器

`http://localhost:3000`（Compose frontend）：旧 Cookie 失效后显示未登录（预期）；注册后 Agent 设置页正常列出
Agent 与版本号（DTO 已无 `pi_sdk_version`）；在对话框发送带工具的消息，Run 成功、工具步骤与输出渲染正常；刷新后
历史回放正常；控制台无错误。

## 未做 / 边界

- 本地 OrbStack K8s 仍在旧命名空间 `pi-dev` 运行旧镜像，且与 Compose 共用开发库；迁移后旧镜像的 Pod 与新库不兼容。
  未处理，需要时 `kubectl delete namespace pi-dev` 后 `scripts/dev/k8s/up.sh dev`。
- VM exec 的路径改名（`pi-exec` → `dsh-exec`）只改了资产与文档，未在 openEuler 演练容器上重跑安装。
- `down` 迁移未在真实库上执行。
- GitHub 仓库名与本地目录名仍为 `pi-enterprise-sandbox`（对外可见，未改）。
