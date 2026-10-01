# SSO 预留 P1 验证记录

日期：2026-10-01（Asia/Singapore）。验收人：主代理。
基线 main `5bc21550`，工作分支 `codex/sso-reservation-main`，验收对象为未提交工作区；
开始时 clean。未推送、未查询远端 CI、未改冻结 plan/历史 evidence/原 STATUS 状态。
本次改动与 review 明细见 [review 索引](../reviews/2026-10-01-sso-reservation/README.md)。

实现树指纹（git 列出的 agent/api-server/frontend/contract/tests 文件，按路径排序，
每项拼接路径、NUL、文件 SHA256 后再次 SHA256，不含 ignored 构建产物）：
`f9ff5e3962ca13fca13c1447f9462ea00cc1b646a07f623dc7aefdfea6ca4c48`。

## Runtime 与环境

权威为 `runtime-versions.json`：Node22（>=22.19,<23），Python3.11。
首次宿主检查使用 Node22.19.0；最终 BFF/frontend 检查使用 Node22.23.2，Python3.11.15。
Node22.19.0 归档从官方 nodejs.org 下载并校验官方 SHASUMS。
Agent 全套最终在 Linux/Docker Node22.23.2 运行，避免 macOS Cordis native loader 限制。
依赖来自现有 lockfile/install，没有为跑绿降级类型检查或鉴权。

真实栈是本地 Docker Compose，真实 MySQL5.7、Redis、Agent HTTP/worker、BFF 与 bwrap 执行面。
工具 Run 使用运行栈的真实模型，不是 fake provider。Compose 中 `dbpm-fake` 仍为外部 DBPM 替身；
本次没有验收生产 UPDRDB/UPRedis、公司 issuer 或公司账户。
单测中的内存仓储、fake Agent、stdio echo MCP、timeout blackhole 分别只证明对应代码/协议路径。

## 六套检查、类型与构建

| 命令/对象 | 最终结果 | 边界 |
|-----------|----------|------|
| `uv run --python 3.11 pytest -q` | 223 passed | 最后文档/树卫生已重跑 |
| `npm test --prefix exec`（宿主 Node22.19.0） | 475 passed，0 failed，runner 汇总 3 skipped | 真库/宿主 bwrap 条件门禁未全部启用；不得说这些门禁通过 |
| `npm test --prefix contract`（宿主 Node22.19.0） | 159 passed | 契约套件 |
| `npm test --prefix agent`（Linux Node22.23.2） | 1915 passed / 1 failed（1916 total） | 实际插件 boot/stdio MCP 已通过；失败见下文 |
| `npm test --prefix api-server`（Node22.23.2） | 297 passed | 最后依赖503/空 config修正后重新 build + 全套 |
| `npm test --prefix frontend`（Node22.23.2） | 602 passed | 最后 strict config HTTP边界修正后全套 |
| `npx tsc --noEmit -p exec/tsconfig.json` | 通过 | 独立于 npm test |
| `npx tsc --noEmit -p contract/tsconfig.json` | 通过 | 独立于 npm test |
| `npm --prefix agent run typecheck` | 通过 | 主程序与 strict runtime 两道 |
| `npm --prefix api-server run typecheck` | 通过 | 最后修正后重跑 |
| `npm run build --prefix frontend` | 通过 | tsc --noEmit + Vite；有非阻塞大 chunk 提示 |
| `docker compose config -q` | 通过 | 没有放松 Compose 安全配置 |
| `git diff --check`、文档相对链接与路径检查 | 通过 | 新设计/交接/review/evidence 均核对 |

本地原始日志位于 gitignored `.runtime/sso-reservation/`，不作为生产证据仓库：
`test-python-final.log`、`test-exec.log`、`test-contract.log`、`test-agent-linux-fixtures.log`、
`test-api-server-final.log`、`test-frontend-final.log`、`type-*.log`、`frontend-build-final.log`。

Agent 的 Linux 测试使用新镜像里真实代码/依赖，将 docs/scripts/tests/skills/config、
exec/frontend/api-server 和根 Compose/runtime 文件只读挂到原路径，并用 `env -i` 清掉开发栈凭据配置。
生产镜像不带全部根夹具：第一次不挂夹具的测试有 12 个缺文件/目录失败，不能记为通过。
补齐夹具后的完整结果就是表中的 1 个失败，未换 fake plugin 或关闭 HMR。

### 未通过项与 main 对照

- macOS Node22.19.0 Agent 全套 1901/1909，通过数之外 8 项 runtime probe 受 Cordis HMR
  internal module loader 限制；Node22.23.2 的 main/current boot 对照均为 8 pass / 1 fail。
  Linux 完整套件的这些真实 plugin/MCP 用例通过。
- 首次 BFF Node22.19.0 有 2 项既有上传异步夹具 cancelled；main 的对应测试在22.23.2通过，
  当前 BFF22.23.2全套通过。没有修改这些上传测试。
- Linux Agent 剩余失败：`tests/run-services/agent-catalog-service.unit.test.js:449`，
  `options leaked headers`。从 git archive 导出 main 原始 src/tests，挂相同 Skills 后复现相同失败
  （该文件22 pass / 1 fail）。额外投影探针确认匹配的是
  `options.platformConstraints.skills.system.12.description` 中 xlsx 的 “misplaced headers”，
  并非一个 headers 配置字段。原子串断言误报没有在 SSO 范围里顺手改掉。

**本次最终门禁未全绿；不能声明可无条件合并。**

## 真实数据库、schema release 与容器

- 从空隔离数据库执行迁移并生成 manifest：37 migrations / 55 tables / 4 triggers。
  对既有 manifest 的差异仅新增 `tbl_agsvc_browser_auth_sessions` 与迁移序号；旧表无结构漂移。
- 按开发库实际迁移 baseline 生成 SQL release，确认只有
  `0037_20261002000001_browser_auth_sessions.sql` 一个新增段、baseline 没变后应用；没有清空既有业务库。
- 在另一个独立空数据库启用 `TEST_MYSQL_URL`，使用生产镜像+真实 repository/factory 运行
  `tsx --test tests/mysql/browser-auth-session.integration.test.js`：5 pass / 0 fail / 0 skipped。
  四项业务用例证明持久 sid、owner 映射、真实 revoke/CAS、多 sid 与旧 JWT 行为。
  该测试会清身份表，**没有指向开发业务库**。新增隔离测试/影子库保留，未删除历史数据。

重建并更新：

```bash
docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend
docker compose up -d --no-build agent agent-worker api-server sandbox sandbox-mcp frontend
# 最后 BFF/frontend 修正后单独 build 并用 --no-deps 更新对应消费者
```

逐服务确认容器 Image 等于当前镜像 Id、实际运行 uid：

| 服务 | 最终 imageId（SHA256 前缀） | uid | Node | 状态 |
|------|--------------------------|-----|------|------|
| agent / agent-worker | 7928b9f71ce1 | 1000 | 22.23.2 | healthy |
| api-server | 94ab11ae2254 | 1000 | 22.23.2 | healthy |
| sandbox | 8f6a9c2fa8a0 | 10001 | 22.23.3 | healthy |
| sandbox-mcp | 93bc9819ad9f | 1000 | 22.23.3 | healthy |
| frontend | 288667e7ffa1 | 1000 | — | running（未配置 healthcheck） |

frontend 更新后宿主端口短暂拒绝连接，容器内 nginx 正常；重新创建 frontend 后127.0.0.1:3000恢复200。
浏览器旧错误 tab 不能恢复，新建同一 in-app browser 的 tab 后访问正常；没有换控制方式或放松 URL/TLS 规则。

## 真实 HTTP / 工具链与故障对照

最终镜像完整链 `live-auth-delivery.log`：40/40检查。
主要步骤：

1. 注册/登录、config local + SSO disabled + no-store、sid、真实 owner、profile 来源/修改。
2. 正常 Cookie/Bearer 成功与跨站写403对照；同 JWT 的角色授予/撤销下一请求生效。
3. 逐项临时停用 user/org/Membership，同 JWT 被拒；finally 恢复 active 后成功。
4. 建不同真实 org/外部映射、凭据组织，另一租户合法登录；Run/会话/工具/进程日志跨租户404。
5. 一轮实际 bash echo Run 到 `SUCCEEDED`，持久工具账本含标准输出；后台进程 logs/signal 成功。
6. 撤销当前 sid、Cookie清除；旧Cookie/Bearer401、第二sid200、重复退出幂等。
   已打开 SSE 在约13.8秒后关闭。关订阅不取消 Run。

最初验收脚本误用 `COMPLETED` 作为成功状态，造成假失败；纠正为当前 `SUCCEEDED` 后完整重跑。
进一步的 `live-sse.log` 专项对照 8/8：先确认真实工具账本含前台 `sleep 60`，
订阅确实仍开着，再撤销 sid；13.811 秒后关闭，此时另一 sid 读取 Run 仍为 `RUNNING`。
Run ID：`01M3VPH1V5HTK6P9QT2MBB2YMC`。这排除了已完成 Run 自然关流的误证。

`live-fault.log`：10/10。真实停止/恢复 Agent，验证 me/profile `503 AUTH_DEPENDENCY_UNAVAILABLE`，
config `503 AUTH_CONFIG_UNAVAILABLE`，退出 `503 AUTH_REVOCATION_UNCONFIRMED` + Max-Age=0；
恢复后旧凭据仍有效，证明未误称撤销；显式再次退出后旧凭据401。
使用当前签名配置生成合法未到期无sid旧格式JWT，me401、退出409 `LEGACY_SESSION_NOT_REVOCABLE`并清Cookie。
第一次旧格式探针没采用部署 issuer/audience，退出不匹配；改用同部署声明后重跑通过。
测试结束 Agent 已恢复 healthy，没有留下停用状态。

## 浏览器实际操作

通过 Computer Use 驱动最终部署版前端 `http://127.0.0.1:3000`，没有 API mock/注入组件状态：

- 登录成功；账户页显示“账号密码/本平台账号”，资料修改真实保存成功。
- 依赖失败时，账户修改出现错误、编辑草稿保留，原聊天草稿与身份没有被清。
- 手动退出遇到故障，显示“已退出本机，服务端未确认撤销”，身份/模型目录/聊天草稿清空。
- 最终 BFF/frontend：持有有效 Cookie 时停止 Agent，重载看到错误与重试；输入新草稿，
  故障期间重试保留草稿；恢复 Agent 后重试确认原账号并加载目录，草稿仍在。
- 普通退出成功后恢复匿名入口，聊天草稿与账号目录清空。

[浏览器截图](../reviews/2026-10-01-sso-reservation/ui-retry.jpg) 展示恢复后同账号与保留草稿。
迟到响应/互斥闸门等并发保护有单测与静态接线 review；没有声称做完多标签/多副本/OIDC回调浏览器验收。

## 本轮未覆盖与派发事件

公司端 code/PKCE、issuer/JWKS、claims、绑定/JIT、禁用传播、global logout 未验证，P2–P4关闭。
HTTPS/Secure Cookie 与公司登记权限尚待后续阶段；本轮只测现有本地 HTTP 入口。
没有邮件发送、上传下载/审批或所有 exec 真库条件门禁的新增全链验收；没有用本次通过项关闭原 STATUS 缺口。

DSH BFF 首轮读取 `.env` 的已确认密钥事件、已处理日志与未确认历史/未轮换边界，
见 [review 的事件记录](../reviews/2026-10-01-sso-reservation/README.md#派发期间的密钥事件)。
