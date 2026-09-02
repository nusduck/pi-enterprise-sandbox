# DSH 重建分支全功能回归测试

本目录是 `refactor/dsh-rebuild` 的浏览器回归测试案例，面向重建后的 Compose 栈和真实用户路径。

- [测试案例](test-cases.md)

## 当前状态

案例已按真实使用面补全。2026-09-01 至 2026-09-02 的首次 Browser 实测暴露了文件搜索、Dataset/附件、图片 MIME、Artifact、Skill、输入等待、子 Agent 和 job/Process 投影等问题；随后已按根因修复、重建全部相关镜像并重新复测。2026-09-03 又补测了普通用户首登、Settings 导航、Skill 归档上传、Artifact 导入/刷新、交互 CAS、敏感环境变量传递、后台 `job_kill`、Run/Worker/sandbox 恢复和定时任务策略。管理员专属路径与破坏性删除仍按范围跳过；完整 stdin、Steer/Resume、双 Browser 并发、A2A、上下文压缩、预算边界和 ISO quota 仍未关闭，详见测试案例 §9。

本地 Compose 栈若已重建，入口是 `http://127.0.0.1:3000/`。空库必须先跑 AUTH-02 注册；若 `admin` 已在本轮前注册好，按 AUTH-02 的「admin 已存在时」执行——不要为了复现空库分支去 `down -v`，但名单外注册与 `role` 注入两步仍必须跑。

## 测试基线

| 项目 | 基线 |
|---|---|
| 分支 | `refactor/dsh-rebuild` |
| 修复前基线 HEAD | `39ce73f9` |
| 预期前端 | `http://127.0.0.1:3000/`（如修改 `FRONTEND_PORT`，以实际配置为准） |
| 操作方式 | Browser / Computer Use；必要时补充本地 HTTP 与容器检查 |
| 主账号 | 用户提供的 `admin` 账号；密码只在登录表单中输入，不写入文件、截图、日志或报告 |
| 模型依赖 | `LLMIO_BASE_URL`、`LLMIO_API_KEY` 和可用模型；实际值不写入文档 |
| 测试数据 | 仅使用合成数据，名称带 `rt-YYYYMMDD-` 前缀；本轮普通用户案例使用 `rt-20260903-` |

## 重要前提

本轮除历史 admin 复测外，已通过 `@Browser` 创建合成普通用户并完成注册、登录、刷新恢复和普通用户 Settings/Chat/Schedules 路径；管理员专属管理分支按用户要求跳过。没有清空数据库重跑空库注册，因此不把普通用户结果外推为管理员能力，也不把隔离 HTTP 客户端的跨租户检查外推为双 Browser 并发验收。

本测试不替代六套自动化测试，也不替代 Linux/CI 上的 Bubblewrap 和容器级故障恢复验证。案例中标为“辅助链路”的项目必须单独记录操作方式和证据来源。

## 本轮执行范围

- 执行时间：2026-09-01 至 2026-09-03（Asia/Singapore）。
- 运行方式：先复用旧栈完成首次 Browser 复现；修复后执行 `agent`、`api-server`、`sandbox`、`sandbox-mcp` 和 `frontend` 的统一重建与重建容器，再通过 Browser/Chrome 页面复测，并用容器内健康探针、只读 HTTP 和容器配置检查辅助确认。
- 已确认：BFF live/ready、Agent health 返回 200；前端可交互；admin 和合成普通用户的登录/登出/刷新恢复；Capabilities 五个页面加载；A2A Agent Card 可见；纯文本、多轮、模型隔离、工具、交互、部分定时任务和管理详情链路可运行；未登录受保护 API 返回 401；sandbox-mcp facade 的认证工具调用返回 200，错误内部路径返回 404。
- 首次实测已发现并已修复：glob/grep 路径解析、图片上传 MIME、`submit_artifact` 返回 schema、系统/用户 Skill 的 `skill` 工具发现、ask_user/subagent 结果序列化、MCP 重复/stale Running 投影、job 与 Process 账本不一致、durable 子 Agent 的 Worker 并发自阻塞、Artifact 导入的 workspace 映射，以及 bwrap `--setenv` 将业务 DB 值放入进程参数的问题。
- 未记录：密码、Cookie、JWT、Bearer token、API key、A2A 一次性凭据和个人数据。测试产生的合成会话、文件、Draft、Artifact 和定时任务暂未清理；定时任务已暂停，未擅自执行删除。

真实使用最小闭环见 [test-cases.md](test-cases.md) §1：ENV → 注册/登录 → 纯文本 → 工作区/上传 → **办公 Skill + Artifact** → Skill 草稿启用 → 取消/删会话 → **普通用户正向闭环** → 跨租户。修复后 admin 和普通用户的关键工具链、Artifact、交互、恢复和部分定时任务策略已在 Browser 复测；删除、双 Browser 并发、A2A、上下文/预算及完整 exec 控制仍不能据此宣称通过。

## 执行安全

执行会创建测试会话、文件、Artifact、进程、定时任务和可能的 A2A 凭据。所有资源必须使用测试前缀；删除会话/任务、撤销凭据、停止进程等清理动作应在浏览器中执行前再次确认。A2A 一次性凭据只可短暂使用，禁止截图或写入日志，本轮未擅自执行清理。

本目录是带执行结果的回归报告，不改变 `docs/STATUS.md`。本次已同步修改生产代码、回归测试、运行文档和本报告；修复后的自动化测试与 Browser 结果见 [test-cases.md](test-cases.md) §9。`docs/STATUS.md` 仍保留未执行的管理员专属、多身份深测、A2A、完整恢复、隔离 quota 和上下文/预算等缺口，不能以本轮绿色结果替代。
