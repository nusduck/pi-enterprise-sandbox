# ADR 0006: 用户态 Skill 的审批闸门移到「启用」

| 字段 | 值 |
|------|----|
| 状态 | Proposed |
| 日期 | 2026-08-28 |
| 决策所有者 | Agent runtime / Sandbox isolation maintainers |
| 适用范围 | `agent/` 的 skill-lifecycle 与 tool-risk 表、`sandbox/` 的 Skill 绑定、前端 Skill 管理面 |
| 关联决策 | `plan.md` §14.2、§22、[ADR 0004](0004-session-persistent-tmp.md)、`architecture.md` 审批段 |

## 背景

当前四个用户态 Skill 变更工具在平台风险表里被钉在 `high`
（`config/agent/tool-risk.json`），因此每一次都 `require_approval`：

| 工具 | 分类 | 风险 | 决策 |
|------|------|------|------|
| `skill_list` | `local_low` | low | allow |
| `skill_install` / `skill_create` / `skill_edit` / `skill_uninstall` | `local_low` | **high** | **require_approval** |

分类器本身把它们判为 `local_low`（写的是 Agent 自己的 Skill 卷，不是外部系统）；是风险表
主动抬高的。审批是 owner-scoped 的（`approval-decision-service.js` 按 Run 的
`orgId`/`userId` 取），没有独立的 reviewer 角色，所以**发起 Run 的人就是审批的人**。

「自己审自己」这个观察成立，但推不出「不必审批」：闸门的对手方不是另一个人，是模型。
用户没有要求装 Skill，模型自己决定装的时候，审批横幅是**唯一一处人会看到这件事发生**的地方。

需要闸门的具体理由有两条，都能落到代码：

1. **持久污染上下文**：用户层 Skill 会被自动列进该用户之后每一个 Run 的 system prompt
   （Pi `formatSkillsForPrompt`）。一次被 prompt injection 诱导的安装会静默影响后续所有会话，
   这和「往 workspace 写个文件」不是一个量级——后者不会自己回到上下文里。
2. **引入的是将来免审执行的代码**：`arg-guards.js` 放行
   `python <skill>/<pkg>/scripts/<file>.py`，而 `bash` 的风险是 `low`（allow）。所以链路是
   「`skill_install`（high，要审批）落盘脚本 → `bash python …/scripts/x.py`（low，直接放行）」。
   安装是这条链上唯一的闸门。

但当前粒度有真实代价：每次变更一次横幅，一个多文件改动就是 N 次确认，用户点到第三次会
变成机械同意——审批疲劳本身在削弱这道闸门；而且用户可能批准出一个只改了一半的 package。

## 决策

分两段。**P0 已实施**，**P1 待实施**。

### P0（已实施，不改架构）

不改变「变更即审批」的模型，只消除它的两项无谓成本，并修复一个既存缺陷：

1. `skill_edit` 接受 `files: [{path, content}]`，一次提交一组改动（同一个 package，最多 32
   个文件，全成或全败）。旧的单文件 `path` + `content` 形参仍然接受，这样部署前记录的审批
   仍能重放。**一次语义改动 = 一次审批。**
2. Skill 入口脚本允许嵌套在 `scripts/` 子目录下。此前的 `/scripts/<单个文件>$` 让仓库自带的
   首方包当场跑不了（`xlsx/scripts/office/pack.py`）。放开嵌套的同时显式拒绝路径中的 `..`。
3. 拒绝信息与 system prompt 都写明完整的可执行形态与被排除的写法。此前拒绝理由没提
   `scripts/` 这条约束，prompt 一个字没讲怎么执行，模型只能反复试。

P0 不放宽任何权限边界：`cat`、`cd &&`、管道、重定向、`$(...)`、glob、`python -m`、换解释器
仍然全部拒绝。放宽这些是 P1 的结果，不是前提。

### P1（待实施）：闸门移到「启用」

引入每个用户对每个 Skill 的**启用态**，把唯一的 `high` 风险工具变成 `skill_enable`；
`skill_install` / `skill_create` / `skill_edit` / `skill_uninstall` 全部降到 `low` + 审计。

这样审批问的是一个用户真能判断的问题——「要不要让这个包从今往后每轮都加载进我的上下文」，
而不是「要不要把这 400 行 content 写进 `scripts/util.py`」。

**该方案只有在同时满足以下三条时才成立**，其中第一条是分水岭：

**(A) 启用态必须控制绑定，不能只控制 prompt 列表。**
`sandbox/isolation/bubblewrap.py` 现在把 `<base>/<orgId>/<userId>` **整个目录**一次性
`--ro-bind` 到 `/home/sandbox/skill-user`。如果启用只决定「列不列进 prompt」，未启用的包
照样躺在挂载里，照样能被 `python /home/sandbox/skill-user/<pkg>/scripts/x.py` 执行，而
`bash` 不审批——闸门形同虚设。必须改成按启用集逐包绑定，或在 Sandbox 侧的路径校验里带上
启用集。启用集必须与执行时的绑定走同一个事实源，不能两处各算一遍。

**(B) 启用必须绑定内容摘要，不能只绑名字。**
否则有一条平凡的绕过：让用户批准启用一个无害包 → 再 `skill_edit` 改写它的 `scripts/` →
得到「已启用 + 已变质」，全程一次审批。启用记录必须带 package 的内容摘要；任何
install / edit 覆盖导致摘要变化，就**自动落回未启用**，需要重新审批。

这是既有机制的自然延伸而非新发明：`skill-lifecycle/index.js` 里
`source: "sandbox"` 的 `source_digest` 已经在做同一件事——因为 high 风险工具的参数是
审批后重放的，路径不等于内容，所以用 sha256 把审批钉在字节上。P1 只是把它从「单次调用」
提升为「常驻状态」。

**(C) 启用态存在 Agent 的 owner-scoped MySQL 表里。**
不能放 `agent_version.configJson`——那是 Run 创建时冻结的不可变快照（`plan.md` §14），
承载不了用户级的动态开关。按 AGENTS.md §1，审批与账本的唯一权威在 `agent/`。

满足 (A)(B) 之后，挂载里只剩批准过的内容，`arg-guards.js` 的执行形态约束才可以合理放宽
（允许 `cd` 进包目录、`python -m`、venv 解释器、glob 参数等）。**当前的严苛是「挂载内容
未经审批」的必然产物，不是独立的设计偏好**——先放宽执行、后收紧启用，顺序反了就是净损失。

## 取舍

- **接受**：P1 引入一张新表、一个新工具、Sandbox 绑定逻辑的改动和一个前端管理面。跨四个
  服务，按 AGENTS.md §4 必须重建容器跑真实链路。
- **接受**：启用摘要会让「改一个字就要重新启用」。这是刻意的——摘要变化正是需要重新过人眼
  的那件事。批量 `skill_edit`（P0 已做）让一次改动只花一次重新启用。
- **拒绝**：直接把四个工具降到 `low` 而不引入启用态。那会同时打开「一轮之内写入并执行任意
  脚本、全程无人看到」的路径，并让 `source_digest` 整套机制变成死代码。
- **拒绝**：按参数区分风险（例如只放行 `source: "attachment"` 的安装）。
  `resolveToolRiskLevel()` 只按工具名解析，不看参数；加参数感知的风险钩子会把「风险由风险表
  决定」这条约束打散到各个工具里。
- **不采纳的类比**：Claude Code 之类的单机 Agent 不审 Skill 安装。那里装了也不给新权限——
  模型本来就有用户自己权限的无限制 shell，用户也能 `ls` / `git diff` 看见装了什么。本项目是
  多租户服务端，用户没有 shell，Skill 树在 Sandbox 里是只读挂载，内容还会自动进入之后每一轮
  的 prompt。该类比支持的是放松粒度，不是取消闸门。

## 影响

- P0 落地文件：`agent/src/skills/install.js`、`agent/src/skills/manager.js`、
  `agent/src/extensions/skill-lifecycle/index.js`、`agent/src/skills/paths.js`、
  `agent/src/extensions/enterprise-policy/arg-guards.js`、
  `agent/src/infrastructure/pi/enterprise-system-prompt.js`。
- P1 会触及 `config/agent/tool-risk.json`、`sandbox/isolation/bubblewrap.py`、
  Sandbox 的执行上下文（`user_skill_dir` → 启用集）、一张新的 owner-scoped 表、
  前端 Skill 管理面，以及 `architecture.md` / `api.md` / `webui.md` / `STATUS.md`。
- 在 P1 落地前，`config/agent/tool-risk.json` 里四个 `high` 条目**不得下调**：它们是
  当前唯一阻止「写入即执行」链路的东西。
