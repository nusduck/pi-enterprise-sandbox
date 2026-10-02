# 代码质量盘点 —— agent infra / presentation / bootstrap

盘点范围：`agent/src/infrastructure/`、`agent/src/presentation/`、`agent/src/bootstrap/`，
以及 `agent/tests/` 中对应的测试（`bootstrap/`、`http/`、`infrastructure/`、`mysql/`、`redis/`、
`notification/`、`outbox/`、`review/` 中与本范围相关的部分）。
「是否被使用」的判定搜索了整个 `agent/src`、`agent/tests` 与 `agent/package.json` 的脚本。
本机无 `rg`，以下证据命令均为 `grep -rn`（仓库根 `/Users/eddie/Work/app/pi-enterprise-sandbox` 执行）。

方法：先 `ls -R` 列出范围文件；对专属简报点名的每一项逐条 grep 取证；
对 `infrastructure/mysql/repositories/` 的全部公开方法逐个查生产调用方；
对 `redis/`、`mcp/`、`dsh/`、`notification/`、`outbox/` 的导出逐个查引用；
核对 `.env.example` 与 bootstrap 读取的环境变量。

总体结论：共 31 条发现（表内 F01–F30 + 表末补记 F31）。退役机制（Pi、Redis replay、MCP adapter、exec `/agent-runs`、
网络模式）在本范围内**无存活的生产代码残留**（仅历史注释与一条 Pi 命名的持久化常量值，
见 F24、F30）；主要问题是 **MySQL 仓储中 11 个无人调用的方法/整个仓储**、
**热点文件 19 处重复的鉴权空值检查**、**SSE 双路径 + legacy 兼容**、
**测试专属导出**与**未文档化的环境变量别名**。预计可删行数量级：直接可删约 550 行，
另有约 260 行（`TaskStateRepository` 整文件）与约 100 行（SSE fallback/通知消费者等，
只记录不建议动）处于"需确认"状态；合计约 800–900 行。

路径纠偏：专属简报写的 `presentation/http/create-http-server.ts` 实际位于
`agent/src/bootstrap/create-http-server.ts`（1300 行，行数棘轮热点；`presentation/http/`
下无此文件）。下表中的"热点文件"均指该实际路径。

| ID | 类别(1–6) | 位置(file:line) | 现状 | 证据(命令→结果) | 建议(删除/合并/改写/需确认/不动) | 风险 | 预计行数变化 |
|----|-----------|-----------------|------|------------------|----------------------------------|------|--------------|
| F01 | 3 | `agent/src/bootstrap/create-http-server.ts`（19 处：258、300、347、382、420、481、510、542、587、633、694、728、761、811、837、1077、1141、1211、1258 行） | 19 次重复 `const auth = authSubjectsFromRequest(req); if (!auth) { json(res, 400, …AUTH_CONTEXT_REQUIRED) }`；`presentation/http/` 各路由还有 6 处同构检查（`admin/cron/agents/identity/member/review/skill-routes`），`cron-routes.ts` 另有 4 处 `if (!auth) return true` | `grep -c "if (!auth)" agent/src/bootstrap/create-http-server.ts`→19；`grep -n "authSubjectsFromRequest" …`→19 处调用行；`grep -n "authSubjectsFromRequest\|if (!auth)" agent/src/presentation/http/*.ts`→各路由各 1 处 + cron 4 处 | 需确认（鉴权相关，按硬规则不直接删；建议抽 `requireAuth(req,res)` helper，行为不变） | 低（纯合并；任一改错即鉴权旁路，须逐路由回归） | 合并后约 -80 |
| F02 | 3/4 | 同上（633–641、694–699、761–767、811–817、837–844、1141–1147 行） | 同一鉴权失败有两种文案（633 行多出 `(trusted BFF subjects)` 后缀）且 `code` 字段不一致：`GET /internal/agent-runs`（694）、`GET :id`（761）、`GET tools`（811）、`GET events`（837）、`POST cancel`（1141）缺 `code`，其余 14 处有 `AUTH_CONTEXT_REQUIRED` | `grep -c "AUTH_CONTEXT_REQUIRED" agent/src/bootstrap/create-http-server.ts`→14（少于 19 处检查）；`sed -n 694,699p…` 逐段核对 | 需确认（随 F01 同一批合并，统一文案+补 `code`；对外 400 body 变化，需确认 BFF/前端是否断言旧文案） | 低 | 约 -10（合并进 helper） |
| F03 | 2 | `agent/src/infrastructure/notification/notification-publisher.ts`（178 行）与 `review-notification-publisher.ts`（178 行） | 两个 outbox 消费者结构几乎相同：`publishOnce→claimBatch→#handle→#settle`，`disabled/not_found/no_email/already_settled/sent/retry/failed` 与"永久错误→failed、瞬时→markPendingForRetry"分支完全同构；差异仅为聚合类型与载荷组装。**按专属简报要求本项只记录，不做设计、不建议合并** | 并读两文件全文；`review-notification-publisher.ts:1-14` 注释明确写了"必须用独立聚合类型"的历史坑 | 不动（只记录） | 无（不改） | 0 |
| F04 | 2 | `agent/src/bootstrap/create-http-server.ts:979-1049` | SSE 双路径：`eventSseService.openStream`（Redis live）与 `else` 分支 MySQL 轮询 fallback（含 `writeWithBackpressure`、`formatSse*Frame`）；另有 `?format=json` 非 SSE 逃生口（872–893）。生产容器必注 `RunEventSseService`（`container.ts:814`），fallback 仅在 `eventSseService` 为空的测试/精简装配走 | `grep -rn "openStream\|eventSseService" agent/src/bootstrap agent/src/infrastructure --include="*.ts"`→装配点仅 `container.ts:814/http-main.ts:805`；fallback 分支行号 1004–1049 | 需确认（fallback 是韧性设计，不建议删；最多收敛注释说明何时走 fallback） | 中（删 fallback 会让无 Redis 装配失声） | 0（不动）~-45（若执意删） |
| F05 | 2 | `agent/src/bootstrap/create-http-server.ts:866-869` | 数字 `Last-Event-ID` 仍被当 sequence 接受，注释自标 `(legacy)` | 同文件 861–869 行；`grep -rn "Last-Event-ID\|lastEventId" agent/src --include="*.ts"`→仅本文件 + `run-event-sse-service.ts` 的 ULID 语义 | 需确认（删 4 行；须确认线上客户端是否还有数字游标） | 低-中（老客户端断流重连回退到 0 会重放） | -4 |
| F06 | 3 | `agent/src/bootstrap/create-http-server.ts:848-860, 874-886, 1014` | 游标三拼写 `after/after_sequence/afterSequence` 取 max；`?limit=` 上限 500 默认 500，而 fallback 轮询写死 `limit: 100`（1014 行） | 同文件对应行；`grep -rn "afterSequence" agent/src --include="*.ts"`→仅本文件 | 需确认（收敛到一处解析函数；分页语义变化需回归 SSE 测试） | 低 | 约 -10 |
| F07 | 1 | `agent/src/infrastructure/mysql/repositories/agent-session-snapshot-repository.ts:305,321,402`（`getById`/`requireById`/`loadVersion`） | 三个读方法在 `agent/src`+`agent/tests` 中零调用；生产只用 `loadLatest`（`session-recovery-service.ts:243`）与 `appendAndAdvance`（同文件:512） | `grep -rn "sessionSnapshots\.\(getById\|requireById\|loadVersion\|loadLatest\|appendAndAdvance\)" agent/src agent/tests`→仅 `loadLatest`、`appendAndAdvance` 有生产调用；`grep -rn "snapshots\.getById\|snapshots\.requireById\|snapshots\.loadVersion"`→0 命中 | 删除（先确认无外部包引用；纯读方法，删后跑 `agent/tests/mysql`） | 低 | 约 -100 |
| F08 | 1 | `agent/src/infrastructure/mysql/repositories/agent-session-repository.ts:301-380`（`transitionIf`，80 行） | 生产中无人调用（状态机改由 `markRecoveryRequiredIfFence`/`updateLastRunIdIfFence` 推进）；仅 `agent/tests/mysql/agent-session-fencing.unit.test.js:95-114` 调用 | `grep -rn "transitionIf" agent/src agent/tests`→定义 + 注释提及 + 测试文件，其余 0 | 需确认后删除（若状态机确已不再需要通用转移边； fencing 测试同步删） | 中（删错则未来状态扩展无路；但当前零调用） | -80（含测试约 -30） |
| F09 | 1 | 同上文件 `:464-500`（`acquireNextExecutionFence`，37 行） | 生产用 `acquireExecutionFenceForRun`（`dsh-run-executor.ts:373`）；无 fence 递增语义需求的调用方只剩测试（`:177-188`） | `grep -rn "acquireNextExecutionFence" agent/src agent/tests`→定义 + 测试，其余 0 | 需确认后删除 | 低-中（fence 机制核心文件，审稿需 fencing 上下文） | -37（+测试 -12） |
| F10 | 1 | `agent/src/infrastructure/mysql/repositories/run-repository.ts:615-662`（`updateStatus`，48 行） | 生产一律用 `updateStatusIf`（`run-transition.ts:88` 等 3 处）；`updateStatus` 仅 `agent/tests/redis/redis-restart.release-gate.test.js:442` 调用 | `grep -rn "runs\.updateStatus\b" agent/src agent/tests`→仅测试 1 处；`grep -rn "runs\.updateStatusIf"`→生产 3 处 | 需确认后删除（非受检转移入口正是要封堵的，删它符合"只能走状态机"的纪律） | 低 | -48（+测试适配） |
| F11 | 1 | `agent/src/infrastructure/mysql/repositories/a2a-task-repository.ts:240-248`（`getByIdUnderOwner`，9 行） | 定义后零引用（A2A 面用 `getById`/`getByRunId`/`listForClient`/`listForOrgAdmin`） | `grep -rn "getByIdUnderOwner" agent/src agent/tests -l`→仅定义文件 | 删除 | 低 | -9 |
| F12 | 1 | `agent/src/infrastructure/mysql/repositories/approval-repository.ts:184-219`（`listByToolExecutionId`，36 行） | 生产零调用；仅 `agent/tests/executor/tool-governance-b2-restart.unit.test.js:687,695` 调用 | `grep -rn "listByToolExecutionId" agent/src agent/tests`→定义 + 该测试，其余 0 | 需确认后删除（审批面可能未来需要按 tool 查；当前无调用） | 低 | -36（+测试 -15） |
| F13 | 1 | `agent/src/infrastructure/mysql/repositories/cron-job-repository.ts:126-141`（`getById`，约 16 行） | 生产一律用 `requireById`（`cron-job-service.ts:285,311,434`）；`getById` 零调用 | `grep -rn "cronJobs\.getById\|cronJobs\.requireById" agent/src agent/tests`→仅 3 处 `requireById` | 删除 | 低 | -16 |
| F14 | 1 | `agent/src/infrastructure/mysql/repositories/task-state-repository.ts`（整文件 261 行；`replaceTodos/getTodos/appendMemory/searchMemory`） | 整仓储无生产调用方：`createRepositoryBundle` 装配（`container-env.ts:287`）后无人读取 `repos.taskState`；`grep -rn "taskState\." agent/src` 仅 bundle 行；方法名 `getTodos/replaceTodos/appendMemory/searchMemory` 在 `agent/src`（除定义）零命中 | `grep -rn "taskState" agent/src --include="*.ts"`→仅 `container-env.ts:287` 装配 + `container-run-executor.ts:101` 的无关 `taskStateStore?`；方法名 grep→0 生产命中 | 需确认（整文件删除 or 标注"待接入的工作记忆账本"；迁移文件不动） | 中（若 DSH 工具侧将接入则删错；已确认运行时无引用） | -261（+bundle 5 行） |
| F15 | 1 | `agent/src/infrastructure/mysql/repositories/process-execution-repository.ts`（整文件 79 行；`getById/list`） | bundle 装配（`container-env.ts:298`）后无生产调用；仅 `agent/tests/http/process-access-http.unit.test.js` 直接 `new` 做 owner-scope 断言 | `grep -rn "processExecutions\|ProcessExecutionRepository" agent/src agent/tests`→装配行 + 定义 + 该单测 | 需确认（无路由消费它：`presentation/http` 无 process 路由；删文件 + bundle 行 + 单测改测 `admin-run-routes` 的 tools 面） | 低-中 | -79（+bundle 1 行，测试改写） |
| F16 | 1 | `agent/src/infrastructure/mysql/repositories/sandbox-audit-event-repository.ts:136-150`（`listByOwner`，约 15 行） | `append` 被 `fenced-tool-governance-recorder.ts:405` 调用；`listByOwner` 零调用、无路由暴露 | `grep -rn "listByOwner" agent/src agent/tests`→审计仓储定义 1 处（其余 `listByOwner` 命中均为 skill/cron 等其他仓储） | 删除 | 低 | -15 |
| F17 | 1 | `agent/src/infrastructure/mysql/repositories/skill-share-request-repository.ts:340-365`（`withdrawAllForRequester`，约 25 行） | 生产用 `withdraw`（`skill-share-service.ts:265`）；`withdrawAllForRequester` 仅其单测 `describe` 调用 | `grep -rn "withdrawAllForRequester" agent/src agent/tests`→定义 + `skill-share-request-repository.unit.test.js:168,177` | 删除（含对应 `describe` 块） | 低 | -25（+测试 -20） |
| F18 | 1 | `agent/src/infrastructure/mysql/repositories/agent-version-skill-ref-repository.ts:130-147`（`isReferenced`，约 17 行） | 生产 GC/吊销走 `listVersionsForSkill`（`http-main.ts:506`）与 `listReferencedDigests`；`isReferenced` 仅单测 + `fake-run-world.js` 替身 | `grep -rn "isReferenced" agent/src agent/tests -l`→定义文件 + 单测 + fake；`agent/src` 生产 0 调用 | 需确认后删除（GC 判定语义，审稿需 ADR 0015 上下文） | 低 | -17（+测试 -10） |
| F19 | 1 | `agent/src/infrastructure/redis/cancel-signal.ts:77-81`（`clear`，5 行） | 生产用 `request`（`cancel-run-service.ts:392,407`）与 `isRequested`（`execute-run-service.ts:872`）；`clear` 零调用 | `grep -rn "cancelSignal\.clear\|CancelSignal" agent/src agent/tests`→`clear` 0 命中 | 删除 | 低 | -5 |
| F20 | 1 | `agent/src/infrastructure/redis/constants.ts:29` + `index.ts:35`（`OUTBOX_WAKEUP_KEY`） | 定义 + 转导出 + 仅 `agent/tests/redis/redis.unit.test.js` 引用；生产无 `outbox:wakeup` 读写 | `grep -rn "OUTBOX_WAKEUP_KEY" agent/src --include="*.ts"`→定义 + index 两行 | 删除（常量 + 转导出 + 单测引用） | 低 | -3 |
| F21 | 1 | `agent/src/infrastructure/outbox/outbox-status.ts:14,20` + `index.ts:13-14`（`OUTBOX_STATUSES`/`isOutboxStatus`） | 仅定义 + 转导出；生产与测试均无调用（同文件其他常量均有调用） | `grep -rn "OUTBOX_STATUSES\|isOutboxStatus" agent/src agent/tests`→除定义外仅 `index.ts` | 删除 | 低 | -4 |
| F22 | 1 | `agent/src/infrastructure/dsh/agent-config-key-vocabulary.ts:63-81`（`LEGACY_RECORD_TOP_LEVEL_KEYS`，约 19 行） | 零代码引用：同文件仅 `V1_KEY_SET` 用 `V1_TOP_LEVEL_KEYS` 做白名单；注释（29 行）自述 legacy 记录不走白名单 | `grep -rn "LEGACY_RECORD_TOP_LEVEL_KEYS" agent/src agent/tests`→定义 + 注释提及 | 删除（Pi→DSH 兼容期的死词汇表） | 低 | -19 |
| F23 | 1 | `agent/src/infrastructure/dsh/event-projector.ts:316-318`（`projectAgentEvent` 便捷包装，3 行） | 生产用 `PlatformEventProjector` 类（`container.ts`、`dsh-run-executor.ts` 等 4 处）；包装函数仅 `agent/tests/executor/platform-event-projector.unit.test.js` 用 | `grep -rn "projectAgentEvent" agent/src agent/tests -l`→定义 + 单测；`PlatformEventProjector`→生产 4 处 | 删除（测试改 `new PlatformEventProjector().project(…)`） | 低 | -3 |
| F24 | 4 | `agent/src/infrastructure/mysql/repositories/session-journal-repository.ts:50`（`JOURNAL_HEADER_ENTRY_ID = '__pi_session_header__'`） | 值里的 `pi` 是 Pi Runtime 时代的命名残留，已写入持久化行（迁移 `20260923000002_dsh_naming.js:16` 明确"有意不改写"）；代码侧可改名常量但值必须保留 | `grep -rn "__pi_session_header__\|JOURNAL_HEADER_ENTRY_ID" agent/src agent/tests`→仓储定义 + 迁移注释 + 2 处测试 | 不动（只记录；改值需数据迁移，禁止） | 高（若改值） | 0 |
| F25 | 1 | `agent/src/infrastructure/notification/run-completion-email.ts:30-38`（`formatDuration`，约 9 行） | 同文件 `buildRunCompletionEmail` 未使用它；仅 `agent/tests/notification/email-notification.unit.test.ts` 直接断言 | `grep -n "formatDuration" agent/src/infrastructure/notification/run-completion-email.ts`→仅定义行；`grep -rn`→+单测 | 删除（或注明测试专属；邮件内时长 currently 直接透传 `durationMs`） | 低 | -9（+测试 -15） |
| F26 | 1/2 | `agent/src/presentation/http/review-routes.ts:33`（`REVIEW_REVISION_MAX_BYTES` 别名） | 对 `@dsh/contract/delivery-policy.js` 的 `REVIEW_TRANSFER_MAX_BYTES` 的同值别名；除本文件 236 行自用外零引用，注释却称"上限"（实为转手） | `grep -rn "REVIEW_REVISION_MAX_BYTES\|REVIEW_TRANSFER_MAX_BYTES" agent/src agent/tests`→别名仅定义+自用；真值来自 contract，被 `review-service.ts:41,106` 直接用 | 合并（删别名，236 行直引 contract 常量） | 低 | -3 |
| F27 | 1 | `agent/src/bootstrap/create-http-server.ts:57-72`（16 个重导出） | 该重导出块的生产消费者为 0：`agent/src` 内无人从它 import；真实消费者是单测（`agent-http-factory.unit.test.js:13-18` 取 `resolveRequestTraceId/Context/parseTraceparent…`，`get-run-pending-input.unit.test.js:9` 取 `presentGetRunResponse`） | `grep -rn "from.*create-http-server" agent/src agent/tests`→生产仅 `http-main.ts:47` 取 `createAgentHttpServer`；其余 15+ 均为测试 import | 需确认（删重导出，测试改直引源模块；注意 `tests/test_repository_layout.py` 行数棘轮：删 16 行释放预算） | 低 | -16（+测试 import 改动） |
| F28 | 5 | bootstrap 读取但 `.env.example`/文档无记载的环境变量：`SYSTEM_SKILL_ROOT`（`http-main.ts:733`，注释自承"config 上没有这个键"）、`AGENT_SKILLS_ROOT`/`AGENT_SKILLS_USER_ROOT`（`container-env.ts:99,119,148` 等）、`AGENT_RUNS_QUEUE_NAME`（`container-run-queue.ts:129`） | 均为"有文档的主名 + 无文档的别名/覆盖"模式；`.env.example` 只记载 `SKILLS_ROOT`/`SKILLS_USER_ROOT`，无上述四项 | `grep -n "AGENT_\|SANDBOX_\|SKILLS\|A2A_" .env.example`→无四项；`grep -n "env\.[A-Z_]*" agent/src/bootstrap/container.ts agent/src/bootstrap/http-main.ts`→读取点 | 需确认（二选一：删别名统一语义，或补 `.env.example`+`deployment.md`；`AGENT_RUNS_QUEUE_NAME` 覆盖队列名影响升级，动前确认） | 中（别名漂移会导致"发布到 A、运行读 B"类故障，见 `publishedSkillBase` 注释） | 0（补文档）或 -6（删别名） |
| F29 | 2/4 | `agent/src/presentation/http/run-presenters.ts` 双写（`session_id`+`sandbox_session_id`、`completed_at`+`finished_at`、`usage`+`token_usage`、`error`+`error_code`）与 `create-http-server.ts` 双写（cancel 响应 `runId`+`run_id` 等 1172–1188、`runs`+`items` 709–712） | 文件头注释（9–12 行）自述"刻意保留的同义名"；`GET approvals` 曾做过同类收敛（ create-http-server:490 "原来的同值 `items` 已删除"），说明收敛方向可行但需逐个来 | 并读 `run-presenters.ts` 全文 + 1172–1188/709–712 行；`grep -rn "finished_at\|token_usage" agent/src --include="*.ts"`→presenters + 消费注释 | 不动（已文档化的对外兼容；收敛是破坏性变更，另开 API 版本议题） | 高（若删：破坏已文档化字段） | 0 |
| F30 | 4 | `agent/src/bootstrap/run-worker.ts:11`、`worker-main.ts:12`（"Does not depend on agent/server.js…"）与 `create-http-server.ts:5`（"legacy process-local Run manager"）等注释 | `agent/server.js` 已不存在（`ls agent/server.js`→No such file）；"not process Map"（832/1005 行）所指的进程内 Map 同样已无代码对应，注释指向的"被删除之物"对新读者无锚点 | `ls agent/server.js`→不存在；`grep -rn "process-local\|process Map" agent/src/bootstrap`→5 处注释，0 处代码 | 改写（把"不依赖 X"改写为"状态唯一来源是 MySQL+Redis"，删对不存在文件的引用） | 无 | 0（注释行） |

未发现残留（已排查，凭证据排除，不占上述 30 条）：
- Redis replay 服务：`grep -rni "replay" agent/src/infrastructure/redis agent/src/bootstrap`→仅 outbox 退避注释与 `idempotency replay` 业务语义，无 replay 服务代码。
- MCP adapter：`grep -rn "adapter" agent/src/infrastructure/mcp agent/src/bootstrap`→`container.ts` 的 `RunQueueAdapter`/`sessionAdapter`（命名巧合的通用"适配器"，非 MCP）与两处"旧 adapter 已退役"的历史注释（`mcp-policy-bindings.ts:6`、`container-mcp.ts:6`）；连接面已是出厂 `dsh-mcp-client`。
- 网络模式：`grep -rn "NETWORK_MODE\|networkMode" agent/src agent/tests`→0 命中，已删干净。
- exec `/agent-runs` 账本：范围内 `agent-runs` 命中均为 agent 自身现行 API 路由 `/internal/agent-runs`（`create-http-server.ts`）与 BullMQ 队列名常量（`redis/constants.ts:26`），无 exec 侧账本引用。
- Pi：除 F24 的持久化值与 `JOURNAL_HEADER_ENTRY_ID` 导出名外，`grep -rni "pi_session\|PiSession" agent/src/bootstrap agent/src/infrastructure agent/src/presentation`→0；`agent/tests` 同范围 `grep -rln "pi_session\|mcp-adapter\|redis-replay\|NETWORK_MODE"`→0。
- `sandbox-client.ts`（`createSandboxClient`）存活：`container.ts:770`、`container-run-executor.ts:194` 等 4 处生产调用，非死代码。

## 建议的 PR 切分

- PR-A（纯删除，低风险，独立验证）：F11、F13、F16、F17、F19、F20、F21、F22、F23、F25、F26。
  涉及文件：`a2a-task/approval/cron/sandbox-audit/skill-share` 仓储各一方法、`cancel-signal.ts`、
  `redis/constants.ts`+`index.ts`、`outbox-status.ts`+`index.ts`、`agent-config-key-vocabulary.ts`、
  `event-projector.ts`、`run-completion-email.ts`、`review-routes.ts` 及对应单测。
  验证：`npm test --prefix agent`（重点 `tests/mysql`、`tests/redis`、`tests/notification`）
  + `npm --prefix agent run typecheck`；确认删的符号无跨包引用（`grep -rn` 复查）。
- PR-B（仓储 dead 方法，需领域确认，可独立审查）：F07、F08、F09、F10、F12、F18。
  涉及文件：`agent-session/snapshot/run/approval/agent-version-skill-ref` 仓储 + fencing/restart 单测。
  验证：同 PR-A，外加 `tests/mysql/agent-session-fencing.unit.test.js` 全绿；
  F08/F10 需 application 侧审稿人确认状态机纪律。
- PR-C（整文件/整仓储，需确认）：F14（`task-state-repository.ts` 261 行 + bundle 行）、
  F15（`process-execution-repository.ts` 79 行 + bundle 行 + `process-access-http` 单测改写）。
  验证：PR-A 验证 + 全仓 `grep -rn "taskState\|processExecutions"` 确认零引用；
  注意 `tests/test_repository_layout.py` 行数棘轮（删文件释放预算，无需加预算）。
- PR-D（热点文件合并，需确认+回归）：F01、F02、F06（`create-http-server.ts` 鉴权/游标收敛）、
  F27（删重导出，测试改直引）、F30（注释改写，可顺手带）。
  验证：`tests/http` + `tests/bootstrap` 全绿；`create-http-server` 行数只减不增（棘轮要求）；
  鉴权合并必须保留"缺 auth→400 + 不泄露存在性"的 fail-closed 语义，逐路由正/反例回归。
- PR-E（兼容收敛，需产品确认， timing 自由）：F05（数字 Last-Event-ID）、F28（环境变量别名：删 or 补文档+
  `deployment.md`+`.env.example`）、F29（不动，仅建 issue 跟踪字段收敛）、F31 的反向缺口
  （`NOT_FOUND_NOUNS` 缺 `tool_executions`→现回退为 "Run not found"，见 F30 表外补充——
  本批建议补 `tool_executions: 'Tool execution'` 一行并删 `process_executions/sandbox_sessions/datasets`
  三个无生产者的键，改用户可见文案需 BFF/前端确认）。
  验证：对应单测 + 前端错误文案 grep 确认无硬断言。
- 不动的记录项：F03（双通知消费者）、F04（SSE fallback）、F24（Pi 常量值）、F29（presenters 双写）——
  留档备查，不进 PR。

F31 补记（类别 4，`agent/src/presentation/http/error-mapper.ts:21-34`）：
`NOT_FOUND_NOUNS` 中 `process_executions/sandbox_sessions/datasets` 三键在 `agent/src` 零
`resource:` 生产者（`grep -rn "resource: 'process_executions'\|resource: 'sandbox_sessions'\|resource: 'datasets'" agent/src`→0），
而真实使用的 `tool_executions`（`dsh-run-resume.ts:126,161` 等 4 处）不在表中，回退显示 "Run not found"。
建议改写（删 3 键、加 1 键），归入 PR-E，需确认用户可见文案。约 -2 行。
