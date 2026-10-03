# 2026-10-03 第二、三轮：缺陷修复与清理批次的真实链路

**范围：** 单组织开发栈，Docker Desktop（macOS）上的 Compose，不是目标环境。接续
[`2026-10-03-integration-live-chain.md`](2026-10-03-integration-live-chain.md)（#82–#87），本文件覆盖 #95–#111。

## 一、验证方式

- 运行时：Node 22（`node:22-slim`），MySQL 5.7，Redis 5.0.14，DSH `0.1.1-rc.2`；`runtime-versions.json` 未改。
- 每个 PR 在自己的 worktree 里构建被改服务的镜像（`dsh-enterprise-agent:<tag>` 等），用 `AGENT_IMAGE` /
  `API_IMAGE` / `SANDBOX_IMAGE` / `SANDBOX_MCP_IMAGE` / `FRONTEND_IMAGE` 覆盖后只重建对应容器，`docker ps`
  核对运行镜像；验证后合并。合并完成后整栈按 `main @ bb810344` 重建（agent、agent-worker、api-server、
  sandbox、sandbox-mcp、frontend），全部容器运行 `:latest`。
- 启动：`--profile sso-dev`、`--env-file .env --env-file .runtime/sso-dev.env`，另加不提交的覆盖文件
  （mailpit 邮件通知、`hi-helper` 指向开发假 HiAgent）。
- 驱动：Playwright（Docker 内，转发 `localhost:3000` → frontend、`:8090` → mock-oidc）。账号 `admin`（本地），
  `user` / `user2` / `reviewer` / `nomail` 经 mock-oidc 登录。
- 模型：真实 LLMIO 网关（`deepseek-flash`），没有替身。
- 除 HTTP 状态外，文件系统与账本结论以宿主机 `docker exec` 读取的目录与 MySQL 行为准。

## 二、阶段脚本与覆盖

| 阶段 | 覆盖 |
|---|---|
| phase1 | 四个 SSO 账号登录；资料通知开关与 422；带工具 Run（前台 `bash` + 后台忽略 TERM 的长进程）；进程登记、日志、`signal` SIGKILL 后终态；跨用户读 Run / 会话 / 进程 / 工具账本一律 404 |
| phase3b | Worker 重启后取消 Run，工具账本不留 RUNNING |
| phase4 | 设置页通知开关（reviewer 可见「待我审核」）、定时任务「完成后通知」、成员页部门列 |
| phase5 | 交付物下载头、`reason_code` 透传、浏览器伪造 `X-Acting-*` 无效、`run.started.skillDiagnostics` |
| phase6 | 两个标签页同时启用智能体版本 → 后者收到冲突提示且草稿保留；审批拒绝原因落库；Run 进行中刷新后看到终态正文 |
| phase6b | 浏览器打开进程控制台即加载日志（看到 `tick`）、中文文案、点「取消进程 → 确认」后控制台显示「已取消」 |
| phase7 | Run 写 `marker.txt` 并起后台作业；他人删除会话 404 且工作区与 temp 仍在；本人删除 204 后宿主机确认 `/var/sandbox/workspaces/<workspace_id>` 与 `tmp_<workspace_id>` 均不存在，`tbl_agsvc_exec_jobs` 行为 `killed: SIGTERM`，进程已不在 |
| phase8 | 有 sid 会话退出 → `confirmed`；退出后 `/me` 401；再次退出 → `not_required` |
| phase9 | 6 个已删除 BFF 端点返回 404；agents / approvals / conversations / capabilities 照常 200 |

## 三、结果

| PR | 验证对象 | 结果 |
|---|---|---|
| #95 exec signal 语义、终态不被 stopping 覆盖 | sandbox | phase1：忽略 TERM 的后台进程收到 kill 后终态 `cancelled`；phase6b：取消后控制台显示终态 |
| #98 进程控制台 | frontend | phase6b 3/3 |
| #104 ChatContext 拆分 | frontend | phase4 6/6、phase6b 3/3、phase6 前 5 条通过 |
| #105 流式工具调用丢名 | agent | 修复前同一上游连续 3 次 phase1 12/14（工具账本空、进程未登记）；修复后 17/17，journal 中调用 id 仍为 `chatcmpl-tool-…`、工具名为 `bash` |
| #106 删除旧数据升级路径 | agent + api-server | phase8 4/4、phase1 17/17、phase6 5/6（失败项为旧英文选择器，已移入 phase6b） |
| #107 删除会话清理工作区 | sandbox + sandbox-mcp + agent | 第一版（只补 exec 路由）删除返回 204 但工作区仍在——agent 传的是 `sandbox_session_id`，目录名是 `workspace_id`；改为传 `workspace_id` 后 phase7 5/5 |
| #108 删除无调用方 BFF 端点 | api-server | phase9 11/11、phase1 17/17（改用 `signal` 端点）、phase6b 3/3、phase4 6/6；CI 跨服务冒烟首轮因脚本仍调已删路由失败，脚本改为 `POST /api/runs` 后通过 |
| #109 类型收紧 L2 | agent | phase1 17/17、phase7 5/5、phase8 4/4、phase6 5/5 |
| #110 类型收紧 L1 | agent + frontend | phase1 17/17、phase6 5/5、phase6b 3/3、phase7 5/5、phase8 4/4、phase4 6/6、phase9 11/11 |
| #111 类型收紧 L3 | agent | phase1 17/17、phase3b 4/4、phase5 9/9、phase6 5/5、phase6b 3/3、phase7 5/5、phase8 4/4、phase9 11/11 |
| 合并后 `main @ bb810344` | 全部服务 | phase1 17/17、phase7 5/5 |

## 四、范围与未覆盖

- 单测、类型检查与 CI 结果见各 PR 描述，本文件只记录运行链路。
- HiAgent 只对开发假服务验证；真实火山 HiAgent 未验收（缺 base URL 与测试 AppKey）。
- 模型侧 `job_status` / `job_output` 查询**不在本进程内存里的作业**（Worker 重启后或由其他 Worker 启动）
  未覆盖：`agent/src/runtime/providers/remote-jobs.ts` 的 `get` / `read` / `kill` 对这类 id 返回占位快照，
  向 exec 发出的 RPC 结果被丢弃，只有 `wait` 真正轮询 exec。这是 STATUS C7 的剩余缺口之一。
- 本轮合并前已删除的会话遗留 2 个工作区，已用新路由手工回收；不提供自动回填。
