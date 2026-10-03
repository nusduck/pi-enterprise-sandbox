# 派活指引：dsh-crew 与 agy-staff

本文约束 Agent 把子任务派给外部 worker（DeepSeek Harness、Antigravity CLI）时的选路、
目录隔离与验收方式。派活不改变 AGENTS.md 的任何规则：worker 的产出与自己写的代码
同等对待，**必须复核后才算数**。

适用范围：dsh-crew 插件（`0.1.0-rc.11` 起）与 agy-staff 插件（`0.7.3` 起）。
两者的行为以插件自带文档为准（`~/.claude/plugins/cache/` 下各插件的 `README.md`、
`docs/REFERENCE.md`、`skills/*/SKILL.md`）；升级后若与本文不一致，先核对再改本文。

---

## 1. 先决定：要不要派

- 用户没提派活就不要主动派；用户点名 agy / grok 时才走对应通道。
- 适合派：范围清晰、可独立验收的子任务（机械改动、调研、独立审查）。
- 不适合派：触及 AGENTS.md §2 安全不变量的改动、需要重建容器跑真实链路（§4）的
  改动判断、需要在多个服务之间对齐 DTO 的设计。这类自己做，或自己做完再让 worker 审。
- 派出去的任务必须自包含：worker 没有会话上下文，要写清绝对路径、验收标准、
  禁止事项（例如“不要提交、不要改 `plan.md`、不要动 `evidence/`”）。

## 2. 通道总览

| 通道 | 调用方式 | 同步/异步 | 目录怎么定 | 适合 |
|---|---|---|---|---|
| dsh MCP `dsh_run_worker` | 直接调工具 | 同步阻塞 | 显式 `cwd` 参数 | 短任务、要拿完整结果 |
| dsh MCP `dsh_spawn_worker` | 直接调工具 | 异步 | 显式 `cwd` 参数 | 长任务，配 `dsh_worker_status/result/cancel` |
| dsh subagent `ds-flash` / `ds-pro` | Agent 工具 | 后台，完成后通知 | haiku 自行取“当前项目目录” | 主目录内的简单单任务 |
| agy 插件技能 `/agy:*` | 技能 → `agy-companion.mjs` | 默认异步（仅 `ask` 同步） | **命令执行时所在目录** | 调研、审查、独立实现 |
| `dsh_run_worker(worker="agy")` | dsh 旁路 | 同步阻塞 | 显式 `cwd` 参数 | **不是** agy 插件本身，只能证明 CLI 能跑，不要当作插件入口 |

要点：

- **subagent 只是薄封装**：`ds-flash` / `ds-pro` 是跑在 haiku 上的传话员，把任务原样交给
  `dsh_run_worker`，自己不改文件。干活的仍是 DeepSeek worker。
- subagent 拿不到精细控制：不能指定 `cwd`、超时、`worker=`。需要 worktree 或精确参数时
  用 MCP 通道。
- agy 只有 `ask` 是同步的；staffer / researcher / reviewer / implementer 都是后台作业，
  返回 job id，经 `/agy:jobs` 收结果。
- agy 的 `implement` 默认带 `--dangerously-skip-permissions`（全量放行）。
  **派给它的任务范围要写死**，不要给开放式目标。

## 3. 结果与副作用：文件改动不在返回值里

两个插件一致：

- 返回值里的文本是 worker 最后的**自述总结**，不是改动清单。
- worker 直接在工作区读写磁盘；dsh 的 JSON 只给 `toolCalls` 次数和 token 统计。
- 因此派完写任务后，**自己跑 `git status` 与 `git diff`** 核对实际改动，再对照总结。
  总结与 diff 不一致以 diff 为准。
- 默认不让 worker 提交、推送、开 PR。用户明确要求时，才把该要求原样写进任务文本
  （agy 的默认是拒绝有副作用的操作，只有任务文本明说才放开）。本仓库提交遵循
  CLAUDE.md：用显式路径，不 `git add -A`。

## 4. 并行与 worktree

两个插件都**不负责创建 worktree、分支、提交或合并**，这些由派活的人做。

规则：

1. 同一目录只允许**一个**写任务。多个写任务要并行，必须各用独立 git worktree。
2. 只读任务（审查、调研）可以与写任务并行，也可以彼此并行。
3. 并行之前先把共享的接口、命名、方案定下来，写进每个任务的简报，不要让 worker 各自猜。
4. worktree 统一放在 `.runtime/worktrees/`（见 `development.md`，该目录已被 Git 与
   Docker build context 忽略），不放进仓库其他位置。

```bash
# 建：每个并行写任务一个 worktree + 分支
git worktree add .runtime/worktrees/<task> -b <task-branch>

# 用完：先确认改动已被审过并合入，再移除
git worktree remove .runtime/worktrees/<task>
```

按通道的差异：

- **dsh**：`dsh_run_worker` / `dsh_spawn_worker` 的 `cwd` 填 worktree 绝对路径。dsh 有
  cwd 咨询锁——同一 cwd 已有写任务时，第二个写任务被**拒绝**（不排队）；
  `dsh_worker_status` 可见谁占着哪个目录。`allow_concurrent_cwd: true` 只给只读任务。
- **agy**：没有 `cwd` 参数，**在哪个目录执行 companion，哪个目录就是工作区**，所以要在
  worktree 里启动。作业状态与续聊按 worktree 存放（各自的 `.agy-staff/`）；续聊/重启只能在
  同一 worktree 内，跨 worktree 会报 `recovery cannot switch worktrees`。文档里没有
  dsh 那样的 cwd 锁，**不要假设同目录并发写会被拦下**。
- **agy 的命令要在沙箱外执行**：它需要本地端口和 OAuth 令牌文件，沙箱会让它失败。
- **subagent**：无法保证落在 worktree。需要 worktree 时不要用 subagent。

## 5. 收结果与验收

- dsh 异步任务：用 `dsh_worker_status` 看进度，`dsh_worker_result` 取结果，
  `dsh_worker_cancel` 取消。
- agy 作业：按 `/agy:jobs` 的协议——起后台 `wait <id>`，按退出码处理
  （0 完成、2 仍在跑再等、3 出错、4 已取消、5 超时可续）。作业运行期间**不要轮询进度、
  不要翻日志**，用户明确问进度时才用 `observe`。作业默认上限 60 分钟，最长 120 分钟。
- 超时（exit 5）不要自动重试或续聊：先看 `git status` / `git diff` 确认半成品，再问用户。
- “完成”只表示调用结束、结果送达，**不表示验收通过**。验收按 AGENTS.md：
  - 代码/配置改动：先跑相关回归与类型检查，最终交付跑 §4 的六套测试。
  - 触及 `agent/`、`api-server/`、`exec/` 运行路径或删除生产代码：重建容器跑真实链路，
    单测全绿不算完成。
  - 权限类测试要有拒绝对照与合法成功对照，防止“全部拒绝”假通过。
- 不得把 worker 的口头结论、自述“测试已通过”当作运行证据（AGENTS.md 开头：
  不把模型口头回答当作运行证据）。
- 不要替 worker 补做或“顺手清理”它的改动，除非用户确认；有问题就写明具体差距，
  用 `continue` 或新任务让它改。
- 不要把无关的在途改动卷进提交：派活前先记下 `git status --short`，以便区分哪些是
  worker 改的、哪些是已有的。

## 6. 配置现状与已知注意点

- dsh 两个档位走 `opencode-go` 提供商：`flash` 对应 `deepseek-v4.1-flash`，
  `pro` 对应 `muse-spark-1.3-contributor`（两档已分化，不再是同一模型）；
  这是会话级配置，随时可能变，用 `dsh_worker_config`（无参数）读取当前值。
  `pro` 档只支持 effort `high`。
  自定义路由在首次调度前未验证，换路由后先派一个只读冒烟任务。
- dsh 默认 effort 为 `max`，小任务会偏慢、偏费 token；确有必要再显式降档。
- agy 的安装后冒烟验证是 `/agy:ask`（同步、零工具）。
- 首次用 agy 派活后检查 `git status`：若出现 `.agy-staff/`，需要忽略或确认其归属，
  不要被误提交。
