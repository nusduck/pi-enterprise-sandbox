# 验证记录：S1 用户 Skill 账本发现、按摘要分版本、exec 按清单挂载

日期：2026-09-14。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §3.3（S1 接口检查点）；用户确认按推荐方案实施
（S1-Q1 摘要分版本目录、S1-Q2 宽限期默认 24 小时可配置、S1-Q3 草稿根保持共写）。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`33377a85` + 本次未提交改动（随本证据同一 commit） |
| 测试运行时 | 全部在容器内，Node v22.23.2；宿主仅 `uv run pytest`（Python 3.11.15） |
| 运行栈 | 开发 Compose：MySQL 5.7.44、Redis 5.0.14、dbpm-fake |
| 镜像（重建，容器已换新） | `pi-enterprise-agent` `d2bc4593f004`（agent / agent-worker）、`enterprise-sandbox` `3c9873fc3cdd`（sandbox / sandbox-mcp） |

## 实施前复现的问题

| 问题 | 证据 | 处理 |
|---|---|---|
| 已启用用户 Skill 对模型不可见 | 已在 `33377a85` 修复，见 [证据](skill-discovery-fix-2026-09-14.md) | — |
| 模型可见 Skill 路径与 exec 挂载不一致 | 同一证据：`skill` 工具给出 `<base>/<org>/<user>/path-probe`，`read` 得 `FS_SANDBOX_DENIED: skill package not enabled: <orgId>` | 本次第 6 条 |
| exec 扫 owner 目录、任何异常返回空集 | `exec/src/http/app.ts` 旧 `enabledSkillPackagesFromRoot`（静态核对） | 本次第 2、3 条 |
| 启用非事务、无锁，先改字节后写账本 | `skill-enablement-service.ts` 旧实现（静态核对） | 本次第 4、5 条 |
| GET 内部请求的 query 不在签名内 | exec `security/hmac.ts` 对空请求体算摘要；实施中发现 | 一并修正，回归测试见下 |

## 改动要点

- contract：`skill-manifest.ts`（清单校验、`canonicalQueryBytes`、版本路径、侧车解析）；传输错误码 `SKILL_PACKAGE_UNAVAILABLE` / `SKILL_STORE_UNAVAILABLE`。
- exec：`enabledSkillPackagesFromManifest` 只核对清单点名的版本目录与侧车；内部 fs / shell / artifact 解析 `enabledSkills`；GET 验签覆盖规范化 query、重复参数拒绝。
- agent：`publishDraftVersion` / `readPublishedVersion` / `collectStaleSkillVersions`；账本仓储 `lockOwner` / `get` / `listForOwner`；`mutateSkillWithLedger` 事务化；Worker `resolveRunSkillPaths` 按账本核对；Run 内 `published-skills-provider` 对外给逻辑路径；`exec-rpc` 随请求携带清单；能力投影按账本；`SKILL_VERSION_GC_GRACE_MS`。
- 文档：`api.md`、`webui.md`、`deployment.md`、`development.md`、`.env.example`、design §3.3、CHANGELOG、STATUS B3 清单计数。

## 验证结果

| 项 | 环境 / 命令 | 结果 |
|---|---|---|
| contract | 容器内 `tsc --noEmit` + `npm test` | 通过；109/109（含清单、规范化 query、版本路径、侧车用例） |
| exec | 容器内 uid 10001、`--cap-drop ALL`、仓库 seccomp、bwrap 0.8.0 | 通过；374/374，0 skip（含按清单解析 5 例、GET 签名路由级 401 回归） |
| agent | 容器内整仓拷贝 `npm run typecheck` + `npm test` | typecheck 通过；1306 / 1303 pass / 0 fail / **3 cancelled**（`remote-providers.test.ts` 已知组，不记为通过）；含 B3 Map 清单棘轮 28 → 31 |
| 锁集成测试 | 运行器镜像接开发栈 MySQL（专用库 `pi_gate_skilllock`，跑后删除） | 4/4：同 owner 第二事务等待提交、另一 owner 不阻塞、无 membership 不给锁、真实事务启用写行 / 停用删行 |
| 仓库卫生 | 宿主 `uv run pytest -q` | 123 passed |

GET 签名回归用例说明：修正前 GET 的 `body_sha256` 固定为空串摘要，路由级用例中「换 target」一项会通过认证；修正后三项（换 target、加清单、重复参数）均 401。该用例与修正同批编写，未在修正前单独运行。

## 真实链路（新镜像，客户端在 Node 22 容器内经 `api-server:4000`）

| 步骤 | 结果 |
|---|---|
| 上传 `path-probe` 草稿 / 启用 | 201 / 200；`publishedPath` 为 `…/path-probe/.v/810574ed…/path-probe`，`reused: false` |
| 能力投影（启用后） | `path-probe` 来源 `user-skill-root`；草稿 `published: true` |
| Run：`skill` 加载 + 按基础目录 `read` | `skill:succeeded`；`read:succeeded`，路径 `/home/sandbox/skill-user/path-probe/reference/marker.txt`，内容 `SKILL-MARKER-7f3a`（修改前同一路径被拒） |
| 停用 | 200，`{ name: "path-probe", removed: true }` |
| 能力投影（停用后） | 仅剩草稿条目，草稿 `published: false`、`status: draft` |
| Run：停用后加载 | `skill:failed`，`unknown or no longer available` |
| 停用后字节 | Agent 卷中 `.v/<digest>/path-probe/` 与侧车仍在（留给运行中的 Run） |
| 日志 | sandbox 无 `SKILL_*` 错误；worker 无「排除」告警 |

## 未做 / 边界

- 多副本 Agent / Worker、双集群共享存储挂载、VM exec 与存储断开、并发启停的目标环境验收（§3.2 最少实测）未做。
- 回收只在同名包下次启停时触发；未在真实链路中等待宽限期演示回收（单测覆盖保留集合与宽限期）。
- 「存储不可读」只由 exec 单测（chmod 000）覆盖，未在容器栈中制造挂载掉线。
- api-server、frontend 本次无改动，未重跑；其最近全量通过见 [证据](release-gates-docker-2026-09-14.md)。
- agent 3 例 `remote-providers.test.ts` cancelled 为 D2b 已知组，不记为通过。
