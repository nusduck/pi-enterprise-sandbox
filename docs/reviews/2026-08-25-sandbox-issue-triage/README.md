# 2026-08-25 pi-sandbox 问题清单：复现与处置

对外部测试报告 `pi-sandbox-issues-detailed.md`（九项）的逐条复现记录。
**结论先行**：八项已复现并在同一分支修复（含回归测试），其中问题六、七已用容器内真实
bwrap 验证；两项（八、九）是设计/产品问题，不属于缺陷修复范围。

修复本身的用户可见描述见 [`../../CHANGELOG.md`](../../CHANGELOG.md) `[Unreleased] → Fixed`。
本文只记录**复现方法、根因判定与未落地项的行动建议**。

| # | 问题 | 复现 | 处置 |
|---|------|------|------|
| 1 | A2A 流式返回 `application/json` | ✅ 单元级 | ✅ 已修 |
| 2 | `write` 无法写中文文件名 | ✅ 单元级 | ✅ 已修 |
| 3 | Run 进行中刷新丢失 assistant 正文 | ✅ 单元级 | ✅ 已修 |
| 4 | Skill 目录 `ls`/`find`/`grep` 不一致 | ✅ 双层实测 | ✅ 已修（口径统一） |
| 5 | 长参数触发 replay args integrity 冲突 | ✅ 单元级 | ✅ 已修 |
| 6 | `~/.config` 类应用无法持久化配置 | ✅ 真实 bwrap 复现 | ✅ 已修 |
| 7 | Skill install 污染 bwrap source path | ✅ 已复现（用户提供触发条件后） | ✅ 已修 |
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

## 问题六：`~/.config` 无法持久化（已复现、已修）

**初次排查判定"无法在本机验证"，这一判断也是错的**。当时 `docker compose exec` 跑
bwrap 报 `Operation not permitted`，便据此结论。真实原因是 **exec 进去默认是 root**，
而该容器 `cap_drop: ALL` 只补了 `CHOWN/FOWNER/KILL/SETGID/SETUID`——没有
`CAP_SYS_ADMIN`，root 反而建不了 namespace。服务本身以 **uid 10001** 运行，
以同一 uid 进去（`docker compose exec --user 10001:10001`）bwrap 就能正常创建
namespace（自定义 seccomp profile 明确放行了 `clone/unshare/mount/pivot_root/umount`，
注释写着"Bubblewrap child/user/mount namespace syscalls; no CAP_SYS_ADMIN is granted"）。

**复现**（容器内真实 bwrap，两次独立执行）：

```
== run 1: write a config ==   WROTE: macro
== run 2: read it back ==     GONE
```

**根因**：bwrap 未指定 `--bind / /` 或 `--tmpfs /`，根文件系统是**每次执行新建的
tmpfs**；`--dir /home/sandbox` 在该 tmpfs 上建目录，持久绑定只有
`--bind <workspace> /home/sandbox/workspace` 与 `--bind <temp> /tmp`。于是 `$HOME`
可写但每次调用都归零。

**修复**：把 `~/.config`、`~/.cache`、`~/.local/share` 绑到 `<session tmp>/.home/`
下的对应目录，并同步设置 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME`。
用 `--bind` 而非 `--bind-try`——后者在源缺失时会静默跳过，把调用者又丢回临时
tmpfs，正是这个 bug 本身；所以绑定前先 `mkdir(parents=True, exist_ok=True)`。

**为什么放在 Session 的 `/tmp` 树里**：保留策略、配额、清理全部沿用
[ADR 0004](../../adr/0004-session-persistent-tmp.md) 已经定义好的那一套（Session 私有、
随 Session 清理），不新增第四个存储根，也就天然不跨租户共享——报告里"应用不能借此
访问其他用户配置"那条验收标准由构造保证，而不是靠额外的权限判断。

**验证**（同样在容器内跑真实 bwrap，用生产代码生成的 argv）：

```
== run 1: app writes its profile ==      WROTE
== run 2: separate execution, same session ==  PERSISTED: macro
== workspace/tmp still writable ==       RW_OK
```

## 问题七：Skill 安装打坏 bwrap bind source（已复现、已修）

**初次排查的结论是错的**，记录在此以免重蹈：当时只看到用户层用的是 `--ro-bind-try`，
便推断"源不存在会被静默跳过，因此报不出这个错"。遗漏的前提是——
**`--ro-bind-try` 只宽容 `ENOENT`，不宽容 `EACCES`**。用户补充了触发条件
（"都是产生在我通过 skill 上传 button 上传 skill.zip 后"）之后，链条立刻闭合。

**根因**（`agent/src/skills/install.js`）：

Node 的 `fs.mkdir` 会把 `mode` 施加到递归创建的**每一级**目录。安装的第一个动作是

```js
const stagingRoot = path.join(skillRoot, `.tmp-install-${token}`);
await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
```

其中 `skillRoot` = `<base>/<org>/<user>`。某用户**首次**安装时这两级尚不存在，于是
`<org>` 与 `<user>` 一并被创建成 `0700`、属主 `node`(uid 1000)。已实测确认：

```
0755 /tmp/skilltest
0700 /tmp/skilltest/ORG26CHARS0000000000000000
0700 /tmp/skilltest/ORG26CHARS0000000000000000/USER26CHARS000000000000000
0700 /tmp/skilltest/.../.tmp-install-abc
```

而 `<base>/<org>/<user>` 正是 Bubblewrap 用户 Skill 层的 **bind source**。
Sandbox 以 uid 10001 解析它 → `realpath()` 得到 `EACCES` → bwrap
`Can't find source path …` → **该用户的每一次沙盒启动全部失败**（`bash`、`python`、
连 `pwd` 都不行），且不会自愈。`read`/`write`/`ls`/`find`/`grep` 仍然可用，因为它们
走内部文件面、不经过 bwrap——这与用户截图里的现象完全吻合。

同一缺陷也存在于 Agent 生成 Skill 的路径（`.tmp-create-…`，`mkdir(packageSource,
{ recursive: true, mode: 0o700 })`）。

**修复**：两条路径都先 `ensureTraversableUserSkillRoot()` 以 `0755` 建好身份目录，再建
私有 staging；该函数同时修复已被打坏的目录，所以受影响用户在下一次安装时自愈。
回归测试覆盖上传、生成、以及"已被打坏的目录被修复"三种情形，去掉修复即三条全红。

**为什么 `0755` 不是放松**：这条路径上其它目录（`copyTree` 建的包内目录、
`atomicReplaceDir` 建的父目录）本来就是 `0755`；`0700` 是 `recursive` + `mode` 的意外
副作用，不是有意的租户边界——两个容器里各自都只有一个 uid 在跑，这两位权限位从未
起到隔离作用。真正的租户隔离是"只把调用者自己的 `<org>/<user>` bind 进命名空间"
（`_skill_binds` 的注释写得很清楚），那一条没有改动。

**纵深防御**：Sandbox 侧现在 bind 之前先 `stat()` 探测源，`ENOENT`（没装过，正常）与
其它 `OSError`（不可遍历）都降级为"只挂系统层"并记 warning。丢掉一个用户的 Skill
不应该等于丢掉他的全部工具——这正是报告里"缺失一个 Skill 不影响 bash/python 启动"
那条验收标准。

**顺带修的系统层**：系统 Skill 层是硬 `--ro-bind` 且 `skills_root.resolve()` 不做存在性
检查，缺失时同样在启动后才爆 `can't find source path`。现改为启动前检查并点名
`SKILLS_ROOT`，保留"缺失即部署故障、应当大声失败"的语义，只让它可诊断。

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
