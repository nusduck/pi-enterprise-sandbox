# 2026-08-25 pi-sandbox 问题清单：复现与处置

对外部测试报告 `pi-sandbox-issues-detailed.md`（九项）的逐条复现记录。
**结论先行**：六项已复现并在同一分支修复（含回归测试），一项无法在当前代码上复现，
两项是设计/产品问题、不属于缺陷修复范围。

修复本身的用户可见描述见 [`../../CHANGELOG.md`](../../CHANGELOG.md) `[Unreleased] → Fixed`。
本文只记录**复现方法、根因判定与未落地项的行动建议**。

| # | 问题 | 复现 | 处置 |
|---|------|------|------|
| 1 | A2A 流式返回 `application/json` | ✅ 单元级 | ✅ 已修 |
| 2 | `write` 无法写中文文件名 | ✅ 单元级 | ✅ 已修 |
| 3 | Run 进行中刷新丢失 assistant 正文 | ✅ 单元级 | ✅ 已修 |
| 4 | Skill 目录 `ls`/`find`/`grep` 不一致 | ✅ 双层实测 | ✅ 已修（口径统一） |
| 5 | 长参数触发 replay args integrity 冲突 | ✅ 单元级 | ✅ 已修 |
| 6 | `~/.config` 类应用无法持久化配置 | ⚠️ 代码级确认，未实测 | ❌ 未改，见下 |
| 7 | Skill install 污染 bwrap source path | ❌ 当前代码无法复现 | ⚠️ 部分加固 |
| 8 | Skill creator 逻辑不合理 | — 设计问题 | ❌ 未改，见下 |
| 9 | User Skill 前端无展示 | — 产品缺口 | ❌ 未改，见下 |

---

## 报告中被证伪的一处推断（问题五）

报告猜测「replay 误把 512 截断后的**摘要**参数当成完整参数参与 integrity
fingerprint」。**方向正确，位置不同**，值得记下来以免下次找错地方：

- `packJsonWithIntegrity()` 的 `$integrity` **始终**是对原始 args 求的哈希，
  从来不对截断值求哈希——报告担心的"对摘要求指纹"并不存在。
- 真正的问题是**读取端**：`mapToolExecutionPublic()` 把 `argumentsJson` 映射成
  `publicJsonView(rawArgs)`，也就是脱敏后的 `$payload`；
  `pi-run-resume.js` 的审批重放拿它去比对，也拿它去执行。
- 因此这不是"完整性校验算错了"，而是"重放输入取错了源"。校验是对的——它正确地
  发现了参数已经不是原来那个。

顺带确认了一个报告没提到的、更严重的后果：**即便指纹侥幸相等，被批准的工具也会用
截断后的参数执行**。修复因此同时是一个正确性修复，不只是一个错误码修复。

## 一个未复现但同类的隐患（问题五相邻）

Pi 的两个事件携带**不同形态**的同一份参数：

- `tool_execution_start` → `args: toolCall.arguments`（模型原样输出）
- `tool_call`（policy hook）→ `args: validatedArgs`
  （`structuredClone` + TypeBox `Value.Convert` 之后）

`tool_execution_start` 先到并建立 `policyPending` 占位行，policy hook 随后
adopt 该行；`getOrCreate()` 在覆盖 `arguments_json` **之前**先做
`assertToolExecutionReplayMatch`。只要模型发出的参数需要类型转换
（例如给 integer 参数发 `"2"`），两份指纹就不同 → 同样的 `args integrity` 冲突。

**本次未修**：无法复现（需要模型恰好发出类型不匹配的参数），按 AGENTS.md §3
不做猜测性修复。若线上再次出现该错误但参数**未**超过 512 字符，应优先查这条路径。
合理的修法是让 adopt 分支直接用 policy 的 validated args 覆盖占位值——该分支已由
`_policyPending && PROPOSED && requestHash == null && resultJson == null` 守卫，
占位行按设计就是"尚未产生任何副作用"，不应被当作权威。

---

## 问题六：`~/.config` 无法持久化（代码级确认，未落地）

**确认的机制**（`sandbox/isolation/bubblewrap.py`）：

- bwrap 未指定 `--bind / /` 或 `--tmpfs /`，因此根文件系统是 **每次执行新建的
  tmpfs**；
- `--dir /home` `--dir /home/sandbox` 在该 tmpfs 里创建目录，`HOME=/home/sandbox`；
- 持久化绑定只有 `--bind <workspace> /home/sandbox/workspace` 与
  `--bind <temp> /tmp`。

推论：`~/.config` **可写但不持久**——每次 `bash`/`python` 工具调用都拿到一个全新的
空 HOME。LibreOffice 这类应用因此每次重建用户 profile，写进
`~/.config/libreoffice/4/user/basic/Standard/Module1.xba` 的宏在下一次调用中消失。
这与报告描述一致（"目录没有持久化"）。

**为什么本次不改**：这是隔离层的运行路径变更，AGENTS.md §3/§4 要求真机验证，而
bwrap 无法在开发机的 `docker compose exec` 上下文中运行
（`Operation not permitted`，命名空间权限在容器启动时授予其自身进程树）。
未经验证就改动仓库里最敏感的安全边界，正是 §3 要避免的猜测性修复。

**建议的落地方式**（需在 Linux/CI 上验证）：在会话持久目录下开一个
`home/` 子树，按 XDG 显式映射，而不是把整个 `$HOME` 变成可写持久面：

```
--bind <session>/home/.config      /home/sandbox/.config
--bind <session>/home/.cache       /home/sandbox/.cache
--bind <session>/home/.local/share /home/sandbox/.local/share
```

三个目录都必须是**每 sandbox session** 独立的，绝不能跨用户共享——否则一个租户的
应用配置会被另一个租户读到。同时需要明确 session 重启后的保留策略，并在
`deployment.md` 记录新增的磁盘占用面。

## 问题七：bwrap source path 污染（当前代码无法复现）

报告的错误是 `bwrap: can't find source path /home/sandbox/skill-user/<org>/<user>/...`。
在当前 `main` 上：

- 用户 Skill 层用的是 **`--ro-bind-try`**——源不存在时静默跳过，不会产生该错误
  （`bubblewrap.py:_skill_binds`，注释明确写了"没装过 Skill 是正常状态"）；
- 报告建议的"启动前对每个 source path 做存在性检查"**在用户层已经等价存在**。

也就是说该错误要么来自比 `44aca423`（per-user skill 特性）更早的镜像，要么来自
系统层。已实测的相邻事实是：容器侧 user-skill 根路径与沙盒内逻辑路径**同名**
（`docker-compose.yml` 把 `agent_user_skills` 卷挂到 `/home/sandbox/skill-user`），
所以报错里那个"看起来像沙盒内路径"的 source 其实就是宿主容器里的真实路径——这解释了
报告为何觉得路径被"污染"。

**已做的加固**：系统 Skill 层是硬 `--ro-bind` 且 `skills_root.resolve()` 不做存在性
检查，缺失时同样以 `can't find source path` 在**启动后**爆出来——表现为 `pwd`/`bash`/
`python` 一起失败，完全看不出是挂载问题。现改为启动前检查并点名
`SKILLS_ROOT`。**保留硬失败语义**（缺少内置 Skill 根是部署故障，不应静默降级），
只让它变得可诊断。

**仍需线上确认**：请提供复现时的镜像 digest 与完整 bwrap 命令行。若确实发生在当前代码
上，则说明存在第三条 mount 组装路径，本次排查未覆盖。

## 问题八：Skill creator 的形态

报告的主张——"skill 创建不该是一个 tool 调用，应该由模型直接按格式写进 user skill
目录"——是**产品/架构决策**，不是缺陷。需要产品重新划定范围后再动，且与问题四同源：
Skill 树对模型是否应当可写、可列、可搜，目前三层的答案并不统一（本次只统一了
"不可搜索、只可 `read`" 这一条读侧口径）。

值得在决策时一并考虑的约束：Skill 目录在 Sandbox 侧是**只读挂载**
（`--ro-bind`，dev 与 prod 皆然），所以"模型直接写进去"不能走沙盒文件工具，仍然需要
一条特权路径——无论它长得像不像一个 tool。换言之，"改成模型直接写"并不能消除那次
受控写入，只能改变它的外观。建议开 ADR 而不是直接改实现。

## 问题九：User Skill 的前端可观测性

真实缺口，但属于**新增功能**而非缺陷修复，需要产品与 API 面共同设计：
前端要展示"已安装哪些 Skill / 是否 reload 成功 / 是否已挂载 / 本轮 Run 用了哪个"，
Agent 侧需要先有对应的查询端点与 Run 级归因数据，`api.md` 也要同步。
本次未纳入——把它塞进一个缺陷修复 PR 会让两件事都做不干净。

**与问题七的关联值得优先做**：报告里"用户只能看到 Run failed / bash failed，
无法判断是安装失败、reload 失败还是 mount 失败"这一点，本次已经部分缓解——
缺失的系统 Skill 根现在会明确报出路径与挂载名，而不是伪装成 bash 坏掉。
剩下的部分需要前端展示才能补齐。
