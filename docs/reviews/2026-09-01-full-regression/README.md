# DSH 重建分支全功能回归测试

本目录是 `refactor/dsh-rebuild` 的浏览器回归测试案例，面向重建后的 Compose 栈和真实用户路径。

- [测试案例](test-cases.md)

## 当前状态

案例已按真实使用面补全。2026-09-01 至 2026-09-02 的首次 Browser 实测暴露了文件搜索、Dataset/附件、图片 MIME、Artifact、Skill、输入等待、子 Agent 和 job/Process 投影等问题；随后已按根因修复、重建全部相关镜像并重新复测。修复后的 Browser 关键路径（搜索、CSV、办公 Skill/docx、图片、Artifact、子 Agent、后台 job）均成功；`INPUT-01` 已能进入持久化 Waiting input，但本轮没有擅自代答。普通用户、跨租户、A2A 凭据 JSON-RPC、Worker/exec 故障恢复、上下文压缩和预算边界等仍未执行，详见测试案例 §7。

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
| 测试数据 | 仅使用合成数据，名称统一带 `rt-20260901-` 前缀 |

## 重要前提

本轮已确认用户提供的 `admin` 凭据可登录，页面显示 admin，登出后重新登录和刷新恢复均成功。管理员身份仍由 Agent 的管理员用户名配置决定；本轮没有清空数据库重跑空库注册，也没有创建普通用户，因此不能把 admin 结果外推为普通用户或跨租户验收。

本测试不替代六套自动化测试，也不替代 Linux/CI 上的 Bubblewrap 和容器级故障恢复验证。案例中标为“辅助链路”的项目必须单独记录操作方式和证据来源。

## 本轮执行范围

- 执行时间：2026-09-01 至 2026-09-02（Asia/Singapore）。
- 运行方式：先复用旧栈完成首次 Browser 复现；修复后执行 `agent`、`api-server`、`sandbox`、`sandbox-mcp` 和 `frontend` 的统一重建与重建容器，再通过 Browser/Chrome 页面复测，并用容器内健康探针、只读 HTTP 和容器配置检查辅助确认。
- 已确认：BFF live/ready、Agent health 返回 200；前端可交互；admin 登录/登出/刷新恢复；Capabilities 五个页面加载；A2A Agent Card 可见；纯文本、多轮、模型隔离、部分工具和管理详情链路可运行；未登录受保护 API 返回 401；sandbox-mcp facade 的认证工具调用返回 200，错误内部路径返回 404。
- 首次实测已发现并已修复：glob/grep 路径解析、图片上传 MIME、`submit_artifact` 返回 schema、系统/用户 Skill 的 `skill` 工具发现、ask_user/subagent 结果序列化、MCP 重复/stale Running 投影、job 与 Process 账本不一致，以及 durable 子 Agent 的 Worker 并发自阻塞。
- 未记录：密码、Cookie、JWT、Bearer token、API key、A2A 一次性凭据和个人数据。测试产生的合成会话和文件暂未清理，未擅自执行删除。

真实使用最小闭环见 [test-cases.md](test-cases.md) §1：ENV → 注册/登录 → 纯文本 → 工作区/上传 → **办公 Skill + Artifact** → Skill 草稿启用 → 取消/删会话 → **普通用户正向闭环** → 跨租户。修复后 admin 的 CSV、图片、docx Skill 和 Artifact 关键链路已在 Browser 复测通过；普通用户、跨租户和需要破坏性操作的恢复案例仍不能据此宣称通过。

## 执行安全

执行会创建测试会话、文件、Artifact、进程、定时任务和可能的 A2A 凭据。所有资源必须使用测试前缀并在结束时清理；删除会话/任务、撤销凭据、停止进程等动作应在浏览器中执行前再次确认。A2A 一次性凭据只可短暂使用，禁止截图或写入日志。

本目录是带执行结果的回归报告，不改变 `docs/STATUS.md`。本次已同步修改生产代码、回归测试、运行文档和本报告；修复后的自动化测试与 Browser 结果见 [test-cases.md](test-cases.md) §7。`docs/STATUS.md` 仍保留未执行的多身份、A2A、恢复、隔离深测等缺口，不能以本轮绿色结果替代。
