# AGENTS.md — AI Agent 工作规范

本文件约束 AI Agent（以及人类贡献者）在本仓库中的工作方式：**改动落在哪一层、
怎么验证、哪些不变量不能破、文档怎么同步**。动手前请读完 §1–§4。

环境搭建与本地命令不在这里重复，见 [`docs/development.md`](docs/development.md)。

---

## 1. 三十秒定位

四个可独立部署的服务，**权威边界是本仓库最重要的约定**——改错层是最常见的错误：

| 服务 | 是什么 | 拥有哪些权威事实 | 不该有什么 |
|------|--------|------------------|-----------|
| `frontend/` | Vite + React SPA | UI 状态投影 | 零 Agent SDK、零 LLM key |
| `api-server/` | 薄 BFF | 浏览器会话、上传/下载代理、SSE 中继 | 不做编排、不判 Run 状态、**不依赖 pi SDK** |
| `agent/` | 独立 Agent 服务 + Worker | **Run / ToolExecution / Conversation / 审批的唯一账本（MySQL）** | 不直接碰工作区字节 |
| `sandbox/` | Python FastAPI 执行面 | **工作区与 /tmp 的字节、进程、隔离** | 不存 Run 账本（`/agent-runs` 已删，勿重建） |

推论（都踩过坑）：

- Run 状态、工具账本、审批的问题 → 改 `agent/`，不要在 BFF 里补状态。
- 模型的工具调用走 `/internal/v1/*` HMAC 面（带 claim + fence + replay 防护）；
  浏览器侧的运维操作走会话作用域的公共适配器。**两者不可互相替代**——浏览器请求
  没有 fence token，内部面也不认它。
- BFF 只做转发与鉴权投影；它的 `X-Acting-*` 必须由服务端解析后写入，永远不能透传浏览器的。

源码根与分层约定见 [`docs/module-layout.md`](docs/module-layout.md)。

## 2. 不可回退的安全不变量

改动若触及以下任一条，必须在同一 PR 里给出验证；**没有把握就不要"顺手简化"**：

- **fail-closed 优先**：鉴权/密钥/隔离配置缺失时必须关闭能力，不能回退到默认可用。
  已有先例：Agent `/internal/*` 空 token 关闭平面、Sandbox 无 JWT secret 拒绝启动。
- **跨租户一律 404**，不用 403——存在性本身不能泄漏。
- **令牌比较用常量时间**（`timingSafeEqual` / `hmac.compare_digest`）。
- **容器非 root 运行**：`api-server`/`agent` 以 `node` 用户运行；`sandbox` 以 root 启动
  仅为搭建 Bubblewrap，随后 `setpriv` 降权。
- **所有出站调用有超时**：无界 fetch 会让一个挂起的依赖拖垮全站。
- **不把密钥写进文档、日志、`.env.example`**（只允许占位符）。

代码里标着"fail-closed 护栏""安全兜底"的分支是有意保留的，删除前先确认它真的不可达
（见 §3 的复现要求）。

## 3. 工作流：先复现，再修，最后真机验证

这是本仓库对 AI Agent 的**硬性要求**，按顺序：

1. **复现**——用失败的测试或对运行中的栈发起的真实请求证明缺陷存在。
   猜测性修复过去多次改错了地方；无法复现就在 PR 里明说，并说明退而求其次做了什么。
2. **定位根因**——不要止步于症状。示例：「取消返回 500」的根因是未分类的 MySQL 瞬时
   失败，而不是取消逻辑本身。
3. **修复 + 回归测试**——新增的测试必须在修复前失败、修复后通过。
4. **真机验证**——见 §4。删除代码或改动运行路径时**必须**做，四套单测全绿不代表链路可用。

## 4. 验证清单

四套测试（命令详见 `docs/development.md`）：

```bash
uv run pytest -q                    # sandbox（含仓库结构与版本钉检查）
npm test --prefix agent             # agent
npm test --prefix api-server        # BFF
npm test --prefix frontend && npx tsc --noEmit -p frontend/tsconfig.json
```

**什么时候必须重建容器并跑真实链路**：改了 `agent/`、`api-server/`、`sandbox/` 的运行
路径，或删除了任何生产代码。镜像**不挂载源码**，不重建就是在验证旧代码：

```bash
docker compose build agent api-server sandbox && docker compose up -d
```

真实链路最少覆盖：登录 → 建会话 → 一轮带工具的 run → 进程 logs/signal → 跨租户 404。

**已知环境陷阱**（撞上先别怀疑自己的改动）：

- 宿主机存在 `~/.pi/agent/mcp.json` 时，`agent/tests/pi/mcp-seam.unit.test.js` 的 6 个用例
  必失败（企业运行时禁止 ambient MCP 配置）。移开该文件即可确认。
- `scripts/smoke-cross-service.mjs` 依赖 bubblewrap，**只能在 Linux/CI 跑**，macOS 上必失败。
- `tests/test_repository_layout.py` 是棘轮：生产文件默认 ≤1000 行，热点文件的预算钉在当前
  行数，只能减不能增。加行就会失败——优先按职责拆分，确需提高预算必须在 commit message
  说明理由。
- 同一测试还要求项目文档只能放在 `docs/`（`README.md` 与本文件例外）。
- `git ls-files agent/pi-agent-home frontend/dist .runtime pi_enterprise_sandbox.egg-info .claude`
  必须是空输出。

## 5. docs/ 的权威顺序（发生冲突时）

1. **`docs/plan.md`** — 冻结的架构基线 + §32 验收标准。除非产品重新划定范围，否则视为只读。
2. **`docs/adr/*`** — 与 plan 兼容的已锁定决策。新 ADR 从 0005 起编号（0002/0003 已退役，勿引用）。
3. **描述性活跃文档** — `architecture.md`、`api.md`、`deployment.md`、`development.md`、`webui.md`、`module-layout.md`。
4. **`docs/STATUS.md`** — 唯一的 §32 验收缺口看板，必须与代码现实一致。
5. **`docs/evidence/*`** — 带日期的验收证据，支持 STATUS 但不能替代它。
6. **代码本身** — 若 STATUS 与代码冲突，以代码为准，并在同一变更集中修复 STATUS。

## 6. 每类文档的更新规则

| 文档 | 何时必须更新 |
|------|--------------|
| `architecture.md` / `api.md` / `deployment.md` / `development.md` / `webui.md` | **与所描述的行为变更同一个 PR**。改了路由、环境变量、容器拓扑、UI 结构而不改对应文档 = 未完成 |
| `STATUS.md` | 与使某行状态改变的实现或证据**同一 commit**；绿色单测不等于关闭一行 |
| `PROCESS_LOG.md` | 只追加（append-only），不改写历史条目；属于验收计划的变更需记录 STATUS IDs |
| `CHANGELOG.md` | 用户可感知的行为变化（新增能力、修复、破坏性变更）记入 `[Unreleased]` |
| `evidence/*` | 只新增文件；绝不改写过往结论 |
| `review-deferred-items.md` | 只放非阻塞债务；严禁把 P0 验收项藏进这里 |
| `runbooks/*` | 运维步骤变化时同步更新 |
| `adr/*` | 有新的、与 plan 兼容且已锁定的决策时新增 |

## 7. 禁止事项

- ❌ 引用 `archive/` 或 `evidence/` 的内容作为"当前状态"——它们是历史快照，引用前必须重新验证。
- ❌ 直接编辑 `plan.md`（冻结基线）或改写 `evidence/` 的历史结论。
- ❌ 在 `review-deferred-items.md` 里降级/掩盖 open 状态的 §32 条目。
- ❌ 让文档描述已删除的机制（先 grep 验证机制仍存在再写）。
- ❌ 在任何文档中写入真实密钥、token、内网密码（`.env.example` 只允许占位符）。
- ❌ 把与本次任务无关的在途改动卷进提交——用显式路径提交，别用 `git add -A` 一把梭。

## 8. 文档评审与清理产物

- 一次性 review 报告放在 `docs/reviews/<date>-<topic>/`，带 README 索引；
  结论若要落地，须把行动项转入 `review-deferred-items.md` 或直接实施，报告本身随后归档到 `docs/archive/reviews/`。
- `docs/deliverables/` 已被 gitignore（本地交付物），不属于仓库文档体系，不要在活跃文档中引用它。
- `docs/biz-db-mcp/`（业务 MySQL 只读 MCP 设计稿）已于 2026-08-23 删除——该服务是外部项目，
  不在本仓库维护；如需了解方案史可查 git 历史。

## 9. 提交与 PR

- `main` 是**受保护分支**：不能直推，必须走 PR，6 项检查全绿后 **squash 合并**
  （Compose config / Frontend / Python (pytest) / Node BFF / Node Agent / Cross-service smoke）。
- squash 意味着分支上的中间提交不会进 main——**PR 描述与 commit message 是这批改动在
  main 上唯一的记录**，要写清「改了什么、为什么、怎么验证的」。
- 一个 PR 一件事。文档漂移可以随行为变更一起走（§6 要求如此），但不相关的清理另开 PR。
- 运行时版本钉（Node 22 / Python 3.11 / Pi SDK 0.80.3）只改 `runtime-versions.json`，
  由 `tests/test_runtime_versions.py` 校验全仓一致。

## 10. 提交前自检

- [ ] 缺陷是否**先复现**再修的？回归测试在修复前会失败吗？
- [ ] 触及运行路径或删除了代码 → 是否重建容器并跑过真实链路？
- [ ] 四套测试是否全绿？失败项是否确认为 §4 的已知环境陷阱？
- [ ] 本次行为变更涉及的每个活跃文档都已同步？
- [ ] 新增/删除的环境变量在 `.env.example` 与 `deployment.md` 双侧一致？
- [ ] 新增端点在 `api.md` 有条目？删除的端点是否已从文档移除？
- [ ] STATUS 行的状态变化与实现同一 commit？CHANGELOG `[Unreleased]` 有对应条目？
- [ ] 没有在任何文档里引入密钥明文？没有卷入无关的在途改动？
