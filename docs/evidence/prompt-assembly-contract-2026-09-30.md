# Prompt 拼装与任务完成约定验收

日期：2026-09-30（Asia/Singapore）。分支 `codex/prompt-assembly-contract`，基线 `bb0b7f19` + 本次未提交改动。
关联 STATUS：A5，维持 `partial`；本次不代表重新验收整个 §32。

## 变更与复现

生产 `DshRuntimeFactory` 在 Agent scope 安装平台路径/Policy（-50）、任务完成约定（-25）、字面量
persona（0）和按能力显示的文件交付指导。`system-prompt/assemble` waterfall 后按本次 schema 过滤
结构化 `tool:<name>` section；jobs/write/edit 分别声明正文涉及的多工具依赖。执行授权 guard 未放松。
移除没有生产调用的 `assembleSystemPrompt` 字符串拼装器；没有历史兼容分支、数据迁移或历史 JSON/hash 改写。
空 persona 是有效配置，通用智能体通过平台 section 获得完成约定。

`agent/tests/runtime/prompt-assembly.test.ts` 起真实 DSH 插件树和生产工厂，截获 `llm/stream` 请求。
修复前首次三条回归 **0 pass / 3 fail**：被 deny 的 write/edit/bash/job schema 已隐藏，但指导仍在；
空人格缺少任务/交付约定，同会话收窄后仍保留调用指导。修复后扩展为四条回归，覆盖 read 合法对照、
两个 scope 隔离、同会话收窄/恢复、零工具、上游多工具依赖，以及字面量 persona 的平台前置顺序。
与原有真实请求、路径与人格测试及工厂单测一起运行：32/32，通过 Agent 两道类型检查。

## 运行环境与离线检查

- Node 22.23.2；DSH `0.1.1-rc.2` / Cordis `4.0.1`，与 `runtime-versions.json` 一致。
- Agent 现有 node_modules 是 Linux ARM64，因此 Agent 测试在 `node:22-slim` 容器挂当前工作树执行。
  其余包的依赖是 Darwin ARM64，在官方 Node 22.23.2 macOS runtime 下执行；没有修改 lockfile。
- pytest：宿主 `uv run`，Python 3.11.15。首次宿主 Agent / 容器 contract 尝试因 esbuild 平台不匹配失败，
  调整执行平台后重跑，未修改类型检查、断言或隔离策略。

| 命令 | 最终结果 |
|---|---|
| `uv run pytest -q` | 223 passed |
| `npm test --prefix contract` | 123 pass / 0 fail |
| `npm test --prefix exec` | 443 pass / 3 skipped / 0 fail（macOS 缺 Linux bwrap 条件） |
| `npm test --prefix agent` | 1585 pass / 0 fail / 0 skipped |
| `npm test --prefix api-server` | 175 pass / 0 fail / 0 cancelled；首轮 173 pass / 2 cancelled，file-proxy 上传替身的事件循环提前结束，单独重跑全套通过 |
| `npm test --prefix frontend` | 427 pass / 0 fail |
| contract / exec `tsc --noEmit` | 通过 |
| `npm --prefix agent run typecheck` | 主程序与 strict runtime 两道均通过 |
| `npm --prefix api-server run typecheck` | 通过 |
| `npm run build --prefix frontend` | 通过；Vite 保留既有大 chunk 提示 |
| `docker compose config -q` / `git diff --check` | 通过 |
| 定向结构棘轮 + runtime 版本卫生检查 | 30 passed |

新请求回归使用替身模型响应、替身会话后端和 exec fetch，因此只证明真实组装与 scope 接线；
数据库、exec 字节/进程与真实模型行为由下面的开发栈验证补充。离线套件没有配置外部 MySQL/Redis
integration 环境，不能据此宣称所有外部服务 release gates 已执行。

## 重建与真实链路

实际开发拓扑：K8s `dsh-dev` 的应用层 + Compose MySQL/Redis/dbpm-fake/执行面。
执行 `docker compose build agent agent-worker api-server sandbox sandbox-mcp`，随后
`docker compose up -d sandbox`、`scripts/dev/k8s/up.sh dev` 更新全部实际消费者。
没有另启一组 Compose Agent/Worker；5 个应用 Deployment rollout 成功，sandbox healthy。
Worker 镜像 ID `sha256:8c16c1f465869357bb2010fa3d7efef938c1f98b07b3a6a53b6b437a474bf317`，容器内
Node 22.23.2，编译后的 prompt installer 与任务约定均存在。frontend 未改代码，沿用既有镜像并滚动。

通过 `http://127.0.0.1:3000/api/*`（frontend → BFF → Agent）驱动真实模型，未使用 fake LLM。
新建两个验收账号；只将刚创建的 B credential 定向放入专用 external org 后重新登录，让 Agent 正常
创建组织/用户映射并签发 JWT。没有伪造 acting headers 或跳过登录。DBPM 仍为开发配置的 fake 服务。

| 检查 | 结果 |
|---|---|
| A/B 注册并正常登录，A 建会话 | 200；两账号属于不同组织 |
| 第一轮 Run | `01M3QBYM9QMX5VZ7N39XR4KARX`，SUCCEEDED |
| 一次不存在文件读取，失败后继续 | read=failed；随后 write×2/read/submit_artifact/bash/job_output 全部 succeeded |
| 文件生成与检查 | 下载 `prompt-smoke.md` 为 200，包含本轮唯一标记；产物列表为 200 |
| 不可变产物快照 | 129 bytes；snapshot 内容标记与账本 SHA-256 匹配，exec uid 10001 下检查 |
| 后台进程 logs | 200，含 PROMPT_TICK；进程 `bash-1ee51d6007cf457cacb05e0f099e45ab` |
| B 越组织访问 | Run / conversation / tools / process detail / process logs / process signal 共 6 项均 404 |
| A 发送 SIGTERM | 200；exec MySQL 进程账本最终为 killed |
| 同会话第二轮读取与续聊 | `01M3QBZJFFHCNVBZSV1SVTDKM1`，SUCCEEDED；恢复后的会话中保留唯一标记 |
| 实际 DSH 请求 header | MySQL 中本会话两条 request/header 均包含 Doing work 与 File delivery |

会话 `01M3QBYM8GFVB03B0D43NW1JVN`，sandbox session `01M3QBYM8K4BAZ7HE0C6ZPBAZS`。
真实链路驱动保存在本地 `.runtime/prompt-verification/live.mjs`；末尾读 MySQL JSON 的 batch 模式
转义造成采集失败，补上 `--raw` 后仅重做请求 header 检查，未重跑已通过的模型任务。
本证据不保存密码、Cookie、token、完整 prompt 或原始工具 payload；验收后台进程已终止。

## 边界

- 四类 prompt 回归证明最终请求与工具可见性的一致性；本次真实任务证明上述工作/交付链可用，
  没有做模型质量 A/B 评测，不能量化宣称回答准确率或完成率提升。
- 没有前端行为/DTO 变更，本次通过真实 HTTP 链路验收，未另做浏览器交互测试。
- 没有查询远端 CI、分支保护或部署到生产环境。
