# AGENTS.md — AI Agent 工作规范

本文件约束 AI Agent（以及人类贡献者）在本仓库中的工作方式：**改动落在哪一层、
怎么验证、哪些不变量不能破、文档怎么同步**。动手前请读完 §1–§4。

环境搭建见 [`docs/development.md`](docs/development.md)；本文只保留执行任务必需的规则。

开始任务时：

- 先确认用户要的是 review、计划还是实施，以及本轮范围、明确禁用的工具/skill 和分工。
  用户已授权的工作继续完成；常规可逆修改不重复确认，也不把“做计划”自行扩大成实施。
- 查看 `git status --short`、当前分支和相关目录下的补充规范，区分本任务与已有改动。
  先按入口 → 应用服务 → 权威存储/执行面追踪接线，再修改；优先用 `rg` 定向查找。
- 区分已复现事实、静态推断和待验证项。不把设计文档、mock 测试或模型口头回答当作运行证据。
- 用户要求多人协作时，明确文件所有权、接口契约、共享构建/容器负责人和验收人；
  不同时编辑同一文件或重建同一运行栈。交接需说明完成项、剩余项和验证结果。

---

## 1. 三十秒定位

按以下职责边界定位改动；不要把职责数量当成进程数量。
`agent` HTTP 与 `agent-worker` 在 Compose 中是独立服务，共享 Agent 镜像与账本：

| 服务 | 是什么 | 拥有哪些权威事实 | 不该有什么 |
|------|--------|------------------|-----------|
| `frontend/` | Vite + React SPA | UI 状态投影 | 零 Agent SDK、零 LLM key |
| `api-server/` | 薄 BFF | 浏览器会话、上传/下载代理、SSE 中继 | 不做编排、不判 Run 状态、**不依赖 Agent SDK** |
| `agent/` | 独立 Agent 服务 + Worker | **Run / ToolExecution / Conversation / 审批的唯一账本（MySQL）** | 不直接碰工作区字节 |
| `exec/` | TypeScript 执行面（`dist/main.js`） | **工作区与 /tmp 的字节、进程、Bubblewrap 隔离、产物快照** | 不存 Run 账本（`/agent-runs` 已删，勿重建） |
| `exec/`（第二入口 `dist/mcp-main.js`） | 对外的 MCP facade，compose 里叫 `sandbox-mcp` | 外部 `context_id` → 沙箱身份的映射（Redis） | **够不到 `/internal/v1/*`**；只走 `/internal/mcp/v1/*` 窄桥 |

> **`agent/src/runtime/`** 是 agent 私有的 DSH 组合层（provider / policy / projection），
> 不是独立服务或对外公共 SDK：只有 `agent/` 消费它，与 Agent 源码一起编译。
> `contract/` 是 exec 与 agent 共用的 RPC 契约包。模型侧 MCP 由出厂
> `@deepseek-ai/dsh-mcp-client` 承担（ADR 0009 H7 退役了自建的 `pi-mcp-adapter`），
> server 清单**只来自进程环境变量 `MCP_SERVERS_JSON`**，不进提交的 YAML。

推论（都踩过坑）：

- Run 状态、工具账本、审批的问题 → 改 `agent/`，不要在 BFF 里补状态。
- 模型的工具调用走 `/internal/v1/*` HMAC 面（带 claim + fence + replay 防护）；
  浏览器侧的运维操作走会话作用域的公共适配器。**两者不可互相替代**——浏览器请求
  没有 fence token，内部面也不认它。
- BFF 只做转发与鉴权投影；它的 `X-Acting-*` 必须由服务端解析后写入，永远不能透传浏览器的。
- MCP facade 与执行面**同镜像、不同入口、不同凭据**。对外 MCP 入口只持有窄桥 token，
  不能因共用镜像获得完整内部面凭据；具体端口暴露以 Compose 与部署配置为准。

源码根与分层约定见 [`docs/module-layout.md`](docs/module-layout.md)。

## 2. 不可回退的安全不变量

改动若触及以下任一条，必须在同一 PR 里给出验证；**没有把握就不要"顺手简化"**：

- **fail-closed 优先**：鉴权/密钥/隔离配置缺失时必须关闭能力，不能回退到默认可用。
  例如 Agent `/internal/*` 空 token 关闭平面；不能为了启动成功绕过必需的鉴权配置。
- **跨租户一律 404**，不用 403——存在性本身不能泄漏。
- **令牌比较用常量时间**（`timingSafeEqual`）。
- **容器非 root 运行**：`api-server`/`agent` 以 `node` 用户运行；`sandbox`/`sandbox-mcp`
  以 uid 10001 运行。exec 进程自身若带着 capabilities，会在 exec bwrap 之前用
  `setpriv --inh-caps=-all --ambient-caps=-all` 剥掉——镜像里缺 `setpriv` 时
  **fail-closed 拒绝执行**，不是降级放行。
- **所有出站调用有超时**：无界 fetch 会让一个挂起的依赖拖垮全站。
- **不把密钥写进文档、日志、`.env.example`**（只允许占位符）。

代码里标着"fail-closed 护栏""安全兜底"的分支是有意保留的，删除前先确认它真的不可达
（见 §3 的复现要求）。

## 3. 工作流：先复现，再修，最后真机验证

缺陷修复按以下顺序执行；功能开发先明确可观察的验收结果，纯 review/文档任务不改生产代码：

1. **复现**——用失败的测试或对运行中的栈发起的真实请求证明缺陷存在。
   猜测性修复过去多次改错了地方；无法复现就在 PR 里明说，并说明退而求其次做了什么。
2. **定位根因**——不要止步于症状。示例：「取消返回 500」的根因是未分类的 MySQL 瞬时
   失败，而不是取消逻辑本身。
3. **修复 + 回归测试**——新增的测试必须在修复前失败、修复后通过。
4. **真机验证**——见 §4。删除代码或改动运行路径时**必须**做，六套单测全绿不代表链路可用。

实施时同时遵守：

- 测试断言对外行为与副作用；权限测试既要有拒绝对照，也要有合法操作成功的对照，
  避免“全部拒绝”假通过。生产工厂、scope、guard、持久账本的接线不能只用手工注入替身证明。
- 前后端共同变更先明确 DTO、错误码、鉴权作用域、空值/默认值与兼容规则；服务端是语义权威。
  UI 至少覆盖加载失败、字段错误、过期响应、草稿保留和并发冲突，不能把请求失败当成空能力集。
- 配置新增字段必须追到实际消费者；保存、预览、执行不能各自猜语义。
  无效或未支持字段应明确诊断，不能“保存成功”却静默不生效。历史配置与迁移影响须单独说明。
- 改动按可审查的小阶段推进。阶段测试通过后继续下一阶段；未经完整验收，不宣称任务已完成。

## 4. 验证清单

验证按改动性质执行，不为纯文档改动启动完整运行栈，也不以单测替代运行链路：

| 改动 | 最低验证要求 |
|---|---|
| 纯文档、review、计划 | 核对引用、路径与当前代码；涉及仓库规范时运行对应卫生检查；不要求缺陷复现或六套业务测试 |
| 代码/配置实施的阶段检查 | 先运行相关回归和类型检查；记录失败原因，修正后重跑受影响检查 |
| 代码/配置实施的最终交付 | 六套测试、各包类型检查、前端 build；涉及 Compose 时校验配置；再按下文触发真实链路 |
| 前端行为或前后端接口变更 | 另做浏览器实际操作，验证保存/错误/冲突等本次路径；不能只检查 API mock |

六套测试（从仓库根执行，使用 `runtime-versions.json` 指定版本）：

```bash
uv run pytest -q                    # 仓库卫生：结构棘轮、版本钉、compose 安全、SSE 夹具
npm test --prefix exec              # 执行面 + MCP facade（TypeScript）
npm test --prefix contract          # RPC 契约
npm test --prefix agent             # agent
npm test --prefix api-server        # BFF
npm test --prefix frontend
npm run build --prefix frontend     # 包含 TypeScript 检查与 Vite 构建
```

TypeScript 侧另运行类型检查，**不要假设 `npm test` 已覆盖完整检查**：

```bash
npx tsc --noEmit -p exec/tsconfig.json
npx tsc --noEmit -p contract/tsconfig.json
npm --prefix api-server run typecheck  # BFF
npm --prefix agent run typecheck       # 主程序（宽松）+ src/runtime（strict）两道
```


组合层用例在 agent 的主测试套件中。其中 `agent/tests/runtime/boot.test.ts`
会**起真实插件树**（子进程），改动
`agent/src/runtime/bundle/cordis.patch.yml` 或 provider 路径后必须跑它——
cordis 的 patch 装不上插件时不报错，只是出厂实现留在原位。
同理，`agent/tests/runtime/mcp-live.test.ts` 会**起一台真的 stdio MCP server**（子进程），
证明 `dsh-mcp-client` 连得上、注册成 `mcp__<server>__<tool>`、调得通；
`mcp-entries.test.ts` 只证 patch 条目的形状，用假数据也能全绿，两者不可互相替代。

**什么时候必须重建容器并跑真实链路**：改了 `agent/`、`api-server/`、`exec/` 的运行
路径，或删除了任何生产代码。镜像**不挂载源码**，不重建就是在验证旧代码：

```bash
docker compose build agent agent-worker api-server sandbox sandbox-mcp
docker compose up -d
```

> `agent` / `agent-worker`、`sandbox` / `sandbox-mcp` 分别共享镜像。
> 构建后确认所有消费者都已更新容器；镜像重建成功不代表运行容器已经换新。
> 若验证部署版前端，另执行 `docker compose build frontend` 并更新前端容器。

真实链路最少覆盖：登录 → 建会话 → 一轮带工具的 run → 进程 logs/signal → 跨租户 404。

验证记录必须包括：代码版本/未提交改动、runtime 版本、命令、结果与跳过原因、验证对象是否
重建。使用 fake provider、内存仓储或外部服务替身时明确其边界；模型参数以最终请求为证，
持久化/审批以真实事务和重放行为为证。环境阻塞时交付已完成部分与剩余验收，不记为通过；
不要为了跑绿而放松隔离、鉴权、类型检查或测试断言。

**已知环境陷阱**（撞上先别怀疑自己的改动）：

- 不要修改宿主机 `~/.pi/agent/mcp.json` 来修本仓库 MCP；当前清单入口见 §1。
- `scripts/smoke-cross-service.mjs` 在**宿主机**起进程，不走 Docker。macOS 内核没有
  bwrap 要的 user namespace，这条脚本在 Mac 上失败是预期的，应在 Linux/CI 跑。
- Mac 的 Docker 执行面运行在 Linux VM，可使用 bwrap。遇到 namespace 错误，先检查
  `exec/seccomp-bubblewrap.json` 是否挂载、是否放行 `clone`/`unshare`/`mount`，以及执行用户。
  容器内验证用 `docker compose exec --user 10001:10001 sandbox ...`；不要直接归因于
  “Docker Desktop 不支持”，也不要改成 root 或关闭隔离来通过验证。
- `tests/test_repository_layout.py` 是棘轮：生产文件默认 ≤1000 行，热点文件的预算钉在当前
  行数，只能减不能增。加行就会失败——优先按职责拆分，确需提高预算必须在 commit message
  说明理由。
- 同一测试还要求项目文档只能放在 `docs/`（只有 `README.md`、本文件和 `CLAUDE.md` 例外）。
- `git ls-files agent/pi-agent-home frontend/dist .runtime pi_enterprise_sandbox.egg-info .claude`
  必须是空输出。

## 5. 设计约束与当前事实（发生冲突时）

以下顺序用于判断“应该怎样实现”；判断“现在是否实现”须核对代码与本次验证。
发现偏差应记录并修复，不能把未生效的文档承诺当作事实，也不能以现有 bug 推翻设计约束。

1. **`docs/plan.md`** — 冻结的架构基线 + §32 验收标准。除非产品重新划定范围，否则视为只读。
2. **`docs/adr/*`** — 与 plan 兼容的已锁定决策；按各文档状态及明确的 supersede 关系读取，
   不在此处维护易过期的“最新编号”。新增前检查目录并使用未占用编号。
   [ADR 0010](docs/adr/0010-retain-custom-a2a-server-layer.md) 已撤销 0007 D8，保留自建 A2A 服务端。
   0003 已删除，勿引用；0001/0002/0005 标着
   "Superseded by 0007"，但它们不是废纸——0002 的 DSH 调研与 seam 限制被 0007/0009 直接复用，
   引用时说明是"被取代文档中仍然有效的那部分"。
3. **描述性活跃文档** — `architecture.md`、`api.md`、`deployment.md`、`development.md`、
   `webui.md`、`module-layout.md`、`sandbox-mcp.md`、`artifact-module.md`。
   （`feature-inventory.md` 是换引擎前的历史盘点，**不是当前状态**，按 §7 第一条对待。）
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

- 一次性 review 报告放在 `docs/reviews/<date>-<topic>/`，带 README 索引。
  阻塞项进入实施计划或对应 STATUS 条目，不能转为非阻塞债务；只有非阻塞项可转入
  `review-deferred-items.md`。行动项已有去向后，再归档到 `docs/archive/reviews/`，修正活跃引用。
- `docs/deliverables/` 已被 gitignore（本地交付物），不属于仓库文档体系，不要在活跃文档中引用它。
- `docs/biz-db-mcp/`（业务 MySQL 只读 MCP 设计稿）已于 2026-08-23 删除——该服务是外部项目，
  不在本仓库维护；如需了解方案史可查 git 历史。

## 9. 提交与 PR

- `main` 禁止直推，必须走 PR，检查通过后 **squash 合并**。工作流以
  [`.github/workflows/test.yml`](.github/workflows/test.yml) 为准；合并时核对远端实际的必需检查，
  不根据本文猜分支保护状态。还要检查工作流内未被设为必需的 job，尤其 contract / exec；
  “允许合并”不等于全部验证通过。未查询远端时明确说明，不能声称 CI 或保护规则已核验。
- squash 意味着分支上的中间提交不会进 main——**PR 描述与 commit message 是这批改动在
  main 上唯一的记录**，要写清「改了什么、为什么、怎么验证的」。
- 一个 PR 一件事。文档漂移可以随行为变更一起走（§6 要求如此），但不相关的清理另开 PR。
- 运行时版本的权威源是 `runtime-versions.json`；升级先改此文件，再同步它约束的
  manifest、lockfile、镜像与 CI 声明，由 `tests/test_runtime_versions.py` 校验全仓一致。
  不单独改某个消费者的版本钉，也不以宿主机碰巧安装的版本代替验收版本。

## 10. 提交前自检

- [ ] 缺陷是否**先复现**再修的？回归测试在修复前会失败吗？
- [ ] 触及运行路径或删除了代码 → 是否重建容器并跑过真实链路？
- [ ] 是否按 §4 选择验证范围？代码交付的六套测试、类型检查和前端 build 是否全绿？跳过、替身与环境限制是否明确记录？
- [ ] 涉及前端接入时，是否核对真实 DTO、浏览器操作、错误与并发冲突？
- [ ] 本次行为变更涉及的每个活跃文档都已同步？
- [ ] 新增/删除的环境变量在 `.env.example` 与 `deployment.md` 双侧一致？
- [ ] 新增端点在 `api.md` 有条目？删除的端点是否已从文档移除？
- [ ] STATUS 行的状态变化与实现同一 commit？CHANGELOG `[Unreleased]` 有对应条目？
- [ ] 没有在任何文档里引入密钥明文？没有卷入无关的在途改动？
