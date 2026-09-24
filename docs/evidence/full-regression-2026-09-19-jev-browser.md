# 2026-09-19 全功能回归实测证据（Jev Browser）

## 结论

本文件记录 2026-09-19 在当前 Compose 栈、当前合成普通用户会话上的新一轮真实浏览器操作结果。它对应 `docs/reviews/2026-09-01-full-regression/test-cases.md` 的 95 条当前案例，但不改写测试设计文件及其中的历史结果。

结论不是“全量通过”。本轮确实完成了服务启动、浏览器页面导航、真实 `deepseek-flash` 对话、文件工具链、后台 job、todo、subagent、错误处理、取消/恢复、合成图片和合成 Artifact 等安全探针；依赖管理员、真实附件 R/W、第二身份/组织、外部 MCP 客户端、故障注入、Worker/exec 重启、目标 K8s/VM 的案例仍为部分通过、阻塞或未执行。

## 判定与边界

- `PASS` 只用于所有适用子断言均有本轮证据的案例。本轮没有把任何一个完整的 P0/P1 全量案例标为 PASS。
- `PARTIAL` 表示有真实浏览器或运行账本证据，但至少一个适用子断言未覆盖。
- `BLOCKED` 表示已有明确前置缺口（例如管理员、第二身份、附件授权、外部客户端或专用故障环境），不是把未操作误写成失败。
- `NOT EXECUTED` 表示本轮没有实际操作该案例；旧报告、源码、mock、历史证据和本轮单元测试均不替代浏览器执行。
- 所有本轮模型探针只使用已配置的 `deepseek-flash`。UI Runs 表的 MODEL 列显示 `—`，不作为模型证据；本轮另以 DSH session event 的 `model=deepseek-flash` / `provider=deepseek-official` 做确认。
- 没有上传 R/W 私有资料、创建账号、修改管理员/Agent 配置、执行危险命令、重启 Worker、hard-kill exec、清空数据库或删除会话。浏览器删除、上传私有资料和账户/权限操作没有在没有更具体的操作时确认下执行。

## 基线与部署证据

- 仓库：`/Users/eddie/Work/app/pi-enterprise-sandbox`。
- 分支：`refactor/updrdb-dbpm`；开始时 HEAD：`480bf65d5bae8bf674599755e7469991c2ac0c38`。
- 开始时工作树已有大量未提交改动，包含 agent、api-server、frontend、Compose、部署脚本、测试及文档；本轮没有回退、覆盖或把这些在途改动重新归类为本任务改动。
- 本轮实际执行 `docker compose up --build -d`，重建并启动 `agent`、`agent-worker`、`api-server`、`sandbox`、`sandbox-mcp`、`frontend` 及依赖。健康结果：frontend `:3000`、BFF `/health/live` 和 `/health/ready`、Agent `/health`、sandbox-mcp `/health` 均返回预期成功；`/health/ready` 的 Agent 与 Sandbox 均为 ready。
- 当前 compose 运行时版本依据 `runtime-versions.json`：Node 22、Python 3.11、DSH `0.1.1-rc.2`、Cordis 4.0.1；本轮没有把宿主机版本当成容器验收版本。
- 当前运行容器只读核对：`agent`/`agent-worker`/`api-server`/`frontend`/`sandbox-mcp` uid 1000；`sandbox` uid 10001；sandbox PID 1 `CapEff=0`；sandbox-mcp 没有容器挂载；sandbox 使用了 seccomp 配置。bwrap、quota、目标 K8s/VM 的完整隔离矩阵仍未执行。
- Agent 日志显示 Exa server 已连接且注册 2 个工具；Capabilities 页面显示 `exa / Connected / Tools 2 / host-injected`，Tools 页面显示 17 个工具，Models 页面显示 `deepseek-flash` 和 `qwen3.8-27b`。测试硬约束仍只允许本轮实际请求使用 `deepseek-flash`；不能由注册表显示推导多模型兼容已验收。
- 本轮容器开发配置仍显示 `ALLOW_UNAUTHENTICATED_INTERNAL=true`，这是开发逃生配置，不是目标部署安全结论；应作为 ENV/SEC 的边界记录。

## 浏览器与账本证据

操作面是 Codex in-app Browser；Jev 用于页面导航和机械点击，输入与每次终态由 CUA AX 状态独立核对。当前会话显示 `root@admin.comrt-20260919-a`、角色 `User`，不是管理员。

主要资源：

- 初始合成会话：conversation `01M2WRFCMR6Z70WC3CKAFWJYZA`，agent session `01M2WRFCN2ZDEZ71XDZA6KE9PF`。
- Artifact 合成会话：conversation `01M2WSG44DQ1B15Y72MNTTAY80`，agent session `01M2WSG44GT1766H12GX0WZQQA`。
- 取消 Run：`01M2WS6ZMBJHVQS0QHWF9SYSXD`，状态 `CANCELLED`，trace 前缀 `508e1f67`；取消后的恢复 Run：`01M2WS7DKA7Q8BNMP4NF84YFCQ`，状态 `SUCCEEDED`，trace 前缀 `ed6d04a9`。
- 后台 job：`bash-b96959b23d914aa2a87c45261f8c8c97`；实际经过 `bash`（后台）、`job_list`、`job_output`、`job_kill`，观察到 `JOB_PROBE_1`、随后 `JOB_PROBE_2 [status:killed]`，没有等自然结束。
- 文件工具链 Run：trace 前缀 `5c83fcdb`；6 个真实工具依次成功：`write`、`read`、`edit`、`glob`、`grep`、`bash`。
- 图片探针 Run：trace 前缀 `7a8eac53`；`bash` 写入合成 PNG，`read_image` 实际返回 `image/png`、1×1 px。工具报告的 91 bytes 与同一 Run 中报告的磁盘 `wc -c=68` 不一致，按观察记录，不推测原因。
- Artifact：真实调用 `write`、`read`、`submit_artifact`；工具回显 `Submitted artifact jev-regression-artifact-20260919.md (28 bytes)`，UI 显示 1 个 28 B deliverable，并显示下载链接中的 artifact id `01M2WSG83Z2ZEK9YNRZ61TWW5A`。工具原始返回没有 hash，未把 UI 可见链接夸大为独立下载 hash/重启不变性证明。
- DSH 事件中已核对实际模型来源为 `deepseek-flash` / `deepseek-official`；Runs UI 的模型列为空，故 UI 空值没有被当作通过。

## 95 条案例矩阵

| ID | 本轮状态 | 本轮证据与缺口 |
|---|---|---|
| ENV-01 | PARTIAL | Compose 镜像重建、服务 ready、模型/MCP 注册和容器身份有证据；未跑 K8s 滚动 imageID、目标 UPDRDB/DBPM/UPRedis 与依赖故障分支。 |
| ENV-02 | PARTIAL | 登录后 Chat/Schedules/Settings/Capabilities/Approvals/Runs 可导航，刷新后的会话可恢复；未做未登录首次打开、浏览器离线和后端不可达恢复。 |
| AUTH-01 | BLOCKED | 当前已有登录会话；未建立 admin/普通用户的完整登录、错误密码、登出后旧直链和 Cookie 矩阵。 |
| AUTH-02 | BLOCKED | 未在独立空库注册账号，也未执行角色/组织字段伪造、关闭注册或名单升降级。 |
| AUTH-03 | BLOCKED | 未创建新用户，未用 R 服务说明完成“上传失败先查哪个服务”的首用任务。 |
| NAV-01 | PARTIAL | 普通用户可切换 Chat、Schedules、Capabilities、Approvals、Runs；Agents/A2A 页面明确显示 `Administrator role is required`，Composer 未见退役拼图入口；旧 `/runs`、`/approvals` 和完整 admin 入口未全测。 |
| CHAT-01 | PARTIAL | 合成无工具对话真实返回 `flash 链路可用`，且模型由 DSH 事件确认；未读取 R 的真实服务边界说明。 |
| CHAT-02 | PARTIAL | 同一会话合成 follow-up、刷新和 Regenerate 均有新 Run/正文；未用 R 做技术说明→五点纠错清单，也未核对资料引用。 |
| CHAT-03 | PARTIAL | 当前会话固定使用 flash 的账本证据成立；未创建两个管理员助手、旧/新 Agent 版本或测试请求覆盖固定模型。 |
| CHAT-04 | NOT EXECUTED | 未点击删除会话，也未执行取消删除/确认删除/旧直链复查。 |
| CHAT-05 | NOT EXECUTED | 未同时启动两个独立工作并在运行中切换会话。 |
| CHAT-06 | PARTIAL | 已验证完成会话刷新后内容、工具结果与终态保留；未验证运行中关页、断网 SSE 重连和三分支独立 catch-up。 |
| TOOL-01 | PARTIAL | 合成文件真实完成 `write/read/edit/glob/grep/bash` 六工具链；未用 R、多级中文路径、负关键词和交接说明产出。 |
| TOOL-02 | BLOCKED | 未上传 R/W/X 附件；文件上传需要具体 fixture/确认，故没有把 Ready 卡片当读取成功。 |
| TOOL-03 | BLOCKED | 未生成/下载/渲染 xlsx、docx、pdf、pptx 四类办公件，也未把 bash fallback 冒充 Skill 全矩阵。 |
| TOOL-04 | PARTIAL | 合成 PNG 经 bash 写入并由 `read_image` 解码为 1×1；未做 Python W、真实 UI 截图、模糊/损坏副本及附件视觉链路。 |
| DATA-01 | BLOCKED | 未上传 W/X 官方数据，未执行独立 oracle、行数/单位/异常行和 GDP/人口计算。 |
| DATA-02 | BLOCKED | 未建立两个会话 Dataset，也未重启 sandbox 后按 API/模型真实读取附件。 |
| DOC-01 | BLOCKED | 未把 R 长文档交给模型做可定位引用和事实/推测/未知冲突核对。 |
| ART-01 | PARTIAL | 合成文件真实 `write/read/submit_artifact` 成功，UI 有 28 B deliverable/link；未做独立下载字节/hash、修改源文件后旧快照不变、失败输入矩阵。 |
| ART-02 | BLOCKED | 未做跨会话 Artifact 导入、同名冲突和新版本重新提交。 |
| ART-03 | BLOCKED | 未重启 sandbox 后列出/下载源 Artifact；当前没有把页面卡片当重启证据。 |
| RUN-01 | PARTIAL | 前台 `sleep 20` 实际被 Stop 取消，随后同会话恢复 Run 成功；未重复提交取消、取消排队 Run。 |
| RUN-02 | NOT EXECUTED | 未做运行中 Steer、Follow-up 排队和关联 Resume。 |
| FAIL-01 | NOT EXECUTED | 未注入 flash 超时、认证失败、429/5xx 或流中断；没有偷偷切换模型的故障证据。 |
| FAIL-02 | PARTIAL | `read` 不存在路径和 `bash exit 7` 均返回真实错误且 Run 正常收敛；未上传损坏 Office、空文件和错误 MIME。 |
| INPUT-01 | PARTIAL | 真实 `ask_user_question` 结构化选项出现，错误的自由文本响应被 400 拒绝，选择合法选项后 todo Run 成功；未完成 W 受众/年份选择后的分析输出。 |
| INPUT-02 | NOT EXECUTED | 未开启两标签同一待答问题、重复回答、取消竞态。 |
| APPROVAL-01 | BLOCKED | Approval Center 当前 `No approvals found`；默认用户 Agent 未绑定 Exa 工具，无法制造本轮真实需审批 MCP 调用。 |
| PROC-01 | PARTIAL | 后台 bash job 的输出、kill 和终态已在 job 工具账本验证；未打开 Process Console 做 stdout/stderr 游标、stdin/EOF、signal/cancel 矩阵。 |
| JOB-01 | PARTIAL | 同一 job 真实经过 `job_list/job_output/job_kill`，终态为 killed；未在 Console 对同一 ID 交叉核对。 |
| TODO-01 | PARTIAL | 真实 `todo_write` 卡片显示 1 completed、2 pending；未按五项 W 汇报推进，也未用刷新后持久化事件完成全断言。 |
| SUB-01 | PARTIAL | `subagent` 真实委派并返回 `SUBAGENT_PROBE_OK`；未做两个子 Agent 的路径核查、结构化父子 ID 全链和父 Run 取消级联。 |
| MGMT-01 | PARTIAL | Runs 页面真实显示 Succeeded/Cancelled/工具步数/Open/Logs/Trace 入口；未逐个状态筛选、打开日志并从 Runs 页执行取消。 |
| MGMT-02 | BLOCKED | 没有 APPROVAL-01 产生的多状态审批，不能用空态代替集中处理。 |
| TRACE-01 | PARTIAL | 当前 Run 有可追踪 trace 前缀和 UI Details；未打开 TOOL-03 成功办公 Run 与 Office 失败 Run 的完整 Trace 对照。 |
| CAP-01 | PARTIAL | Capabilities 的 Skills/MCP/Tools/Models/Diagnostics 正常加载，看到 13 skills、17 tools、Exa 2 tools 和模型注册；未验证空配置、连接错误和重载变化。 |
| SKILL-02 | BLOCKED | 未创建用户 Skill 草稿或执行真实 W 自测。 |
| SKILL-03 | BLOCKED | 未上传 zip/skill 包，也未测试损坏/越界包。 |
| SKILL-01 | BLOCKED | 未 Enable/Disable 用户草稿，未实际用 Skill provider 完成 W 子集。 |
| SKILL-04 | BLOCKED | 未测试已发布版本、非法包、symlink/.git/同名 owner 隔离。 |
| SKILL-05 | BLOCKED | 未逐包调用系统 Skill；Capabilities 清单本身不等于逐包任务通过。 |
| MCP-01 | BLOCKED | 平台 Exa 连接和目录可见，但当前默认用户会话没有任何 `mcp__*` 绑定，模型明确拒绝伪造搜索；因此没有真实 Exa 回包/官方来源。 |
| MCP-02 | BLOCKED | 未用外部 Streamable HTTP 客户端执行六工具 sandbox 文件/Python/shell/Artifact 闭环。 |
| MCP-03 | BLOCKED | 未建立两个外部 context、非法 context 和签名下载篡改/过期分支。 |
| MCP-04 | BLOCKED | 未做真实 MCP 故障恢复、业务只读数据源越界或 Agent enabledTools 收窄验证。 |
| CRON-01 | PARTIAL | 用无害表单提交了非法 cron，UI 返回 `Invalid day of week cron field` 且未创建调度；未创建有效一次性任务、Run now、History、Pause/Resume/Delete。 |
| CRON-02 | BLOCKED | 未创建有效周期任务，未测时区、misfire、重叠策略。 |
| CRON-03 | BLOCKED | 未制造调度失败、修复后重跑或重启 Worker 保留 History。 |
| AGENT-01 | BLOCKED | 当前浏览器角色为 User，Agents 页面禁用并显示管理员要求；未创建团队助手或非法配置样本。 |
| AGENT-02 | BLOCKED | 未创建/发布/激活/回滚 Agent 版本。 |
| AGENT-03 | BLOCKED | 未进入多 Agent 组织和新会话 Agent 选择分支。 |
| AGENT-04 | BLOCKED | 未验证 systemPrompt、固定 max output、toolPolicy、MCP 授权及跨 org 404。 |
| A2A-01 | BLOCKED | A2A 页面可达但明确要求 Administrator；未签发、轮换、撤销或测试最小 scope 凭据。 |
| A2A-02 | BLOCKED | 没有本轮 A2A 凭据，未执行 authenticated JSON-RPC/SSE、tasks/get/resubscribe。 |
| A2A-03 | BLOCKED | 未执行 A2A cancel、跨客户端隔离或畸形 JSON-RPC。 |
| USER-01 | BLOCKED | 只有一个现有普通用户浏览器会话，未创建 A/B 独立身份、上传并发办公任务。 |
| USER-02 | BLOCKED | 未建立同人多会话、同组织 B 或第二组织 C 的资源隔离矩阵。 |
| CTX-01 | BLOCKED | 未把 262144 context 推到真实 compaction 阈值；不能用口令回显或配置项冒充 compaction。 |
| BUDGET-01 | BLOCKED | Runs/UI tokens 显示为空，未配置并触发 normal/near-limit/exceeded 预算边界。 |
| BUDGET-02 | BLOCKED | 未临时改动三种硬限制并分别让真实任务达到边界。 |
| UI-01 | PARTIAL | 真实 Chat、Run、Details、刷新、侧栏和页面状态已观察；未完成长内容所有 tab、窄屏、Copy/Jump、主题/输入法完整矩阵。 |
| UI-02 | NOT EXECUTED | 未做键盘登录/审批/下载、IME 候选、拖放/粘贴图片和附件草稿矩阵。 |
| SEC-01 | PARTIAL | 未认证 BFF 受保护请求曾返回 401；普通用户 Agents/A2A 直链显示 ADMIN_REQUIRED；未完成所有受保护入口、伪造 acting header 和 Card 约定矩阵。 |
| SEC-02 | BLOCKED | 没有第二用户/组织和真实资源全集，不能验证统一 404 或列表不泄漏。 |
| SEC-03 | NOT EXECUTED | 未执行越界路径、软/硬链接、恶意资料指令和危险命令矩阵。 |
| SEC-03B | NOT EXECUTED | 本轮未做 canary 环境变量与 bwrap argv 实测；历史证据不继承为当前结果。 |
| SEC-04 | NOT EXECUTED | 未用受控协议客户端测试内部 token、HMAC、fence、幂等冲突和 facade 窄桥。 |
| ISO-01 | PARTIAL | 当前 Compose uid、CapEff、seccomp 和 facade 无挂载有只读证据；未完成 bwrap namespace、网络模式、setpriv 缺失 fail-closed 和目标部署验证。 |
| ISO-02 | BLOCKED | 未在有硬上限专用环境执行 CPU/memory/pids/workspace/tmp/文件 quota 边界。 |
| LOAD-01 | BLOCKED | 未上传小/近限/超限/放大 CSV，未采样流式 RSS 或中断重试。 |
| LOAD-02 | BLOCKED | 未做 20 owner 并发、同 Idempotency-Key 竞争和 SSE Last-Event-ID 重连。 |
| REC-01 | BLOCKED | 未重启 Worker，也未执行模型中途、工具中途、WAITING_INPUT/APPROVAL 的恢复矩阵。 |
| REC-02 | BLOCKED | 未 hard-kill sandbox/exec 或核对 orphaned recovery、并发额度释放。 |
| REC-03 | BLOCKED | 未重启 BFF、断服务 Redis 或验证 outbox/SSE 补齐。 |
| AUTH-04 | BLOCKED | 未在独立新组织做重复用户名、字段校验、并发首建和首轮 R/W。 |
| CHAT-07 | NOT EXECUTED | 未在真实文件任务运行中连续追加两个 follow-up，也未做单/多 Worker 排队矩阵。 |
| BIZ-01 | BLOCKED | 未使用 S 合成订单退款包和独立答案，也未生成含公式 Excel/Word。 |
| BIZ-02 | BLOCKED | 未使用 S 会议包、交互澄清负责人/日期或生成 Word/PPT/待办一致性结果。 |
| AGENT-05 | BLOCKED | 当前为 User；未在管理员配置页调用 validate/preview，也未验证 flash thinking/temperature/unknown field 诊断。 |
| AGENT-06 | BLOCKED | 未进入管理员草稿、陈旧响应、并发发布或 expected-active-version 冲突分支。 |
| AGENT-07 | BLOCKED | 未准备旧 schema 隔离副本，也未执行迁移/回滚/历史会话绑定。 |
| SKILL-06 | BLOCKED | 未使用两应用副本、共享账本和滚动换 Pod 验证 Skill 摘要/挂载一致性。 |
| SUB-02 | BLOCKED | 未做父任务饱和、深度上限、父取消/Worker 重启或降低深度的队列验证。 |
| MCP-05 | PARTIAL | 已观察正常 Exa 注册和“平台可知但用户会话未绑定”的状态差异；未启动无配置/禁用/断连/恢复四环境或 tools/list_changed。 |
| DEPLOY-01 | PARTIAL | 只验证当前依赖正常时 live/ready 和 Agent ready；未逐一断 DB/Redis/exec/MCP、伪 200 ready、慢启动并观察 guard 停止接活。 |
| DEPLOY-02 | BLOCKED | 未在目标 DBPM 做正常取密、缺配置、坏响应、超时和凭据滚动更新。 |
| DEPLOY-03 | BLOCKED | 未使用两个数据库 Proxy 做切换、半帧、认证错误和不确定 commit。 |
| DEPLOY-04 | BLOCKED | 未在空库/副本应用 schema release、最小权限和中断重放。 |
| DEPLOY-05 | BLOCKED | 未做真实 Redis 多副本 claim/lease/fence、SIGSTOP 接管和取消。 |
| DEPLOY-06 | BLOCKED | 未在在途 Run 上执行 Worker SIGTERM/drain 超时/接管。 |
| DEPLOY-07 | BLOCKED | 未使用目标 VM/systemd 和 K8s frontend→BFF→Agent→VM 做四格式办公任务。 |
| DEPLOY-08 | BLOCKED | 未执行环境切换/回退、队列/卷/EndpointSlice 边界。 |
| SEC-05 | NOT EXECUTED | 未按 TLS_ENABLED 模式做 Origin/forwarded header/CSRF/过期 Cookie/上传防护矩阵。 |
| CLEAN-01 | NOT EXECUTED | 本轮合成会话、workspace 文件和 Artifact 仍保留；未在没有删除动作时确认下删除，未把未清理状态写成通过。 |

## 当前明确阻塞项

1. 当前浏览器是普通 User；AGENT/A2A 管理操作、版本发布、审批策略和凭据生命周期需要可验证的管理员身份，不能用页面可达替代授权成功。
2. R/W/X 资料、Office 四格式、真实 Dataset/Artifact 导入和损坏附件需要具体 fixture；本轮没有获得“把这些文件上传给当前模型/沙箱”的明确数据目的授权，因此只用合成文件和合成 PNG。
3. Capabilities 中 Exa 已连接，但默认会话没有绑定 `mcp__exa__*` 工具；因此 MCP-01 真实搜索没有执行，不能把注册目录或模型拒绝算作 MCP 通过。
4. Worker/exec 重启、Redis/BFF/DBPM/Proxy 故障、quota/load、目标 K8s/VM 和第二组织都需要隔离演练环境，不能在当前共享 Compose 数据库上用 `down -v` 或直接删表造绿。
5. 为了保留证据，本轮没有清理合成资源；如继续执行 CLEAN-01，应先针对这些明确 ID 逐项做产品支持的删除/停用并重新核验旧直链。

## 验证命令与跳过项

本轮实际使用：

```text
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:3000/
curl -fsS http://127.0.0.1:4000/health/live
curl -fsS http://127.0.0.1:4000/health/ready
docker compose exec ... id / CapEff / mounts / seccomp（只读）
```

本轮未重复运行六套自动化测试、全包 typecheck 和 frontend build；它们不是本轮浏览器证据，且本任务没有修改生产代码。若要关闭代码级验收缺口，应另按仓库 §4 使用 `runtime-versions.json` 执行并记录命令、版本、结果；本文件不把历史 §5–§9 的自动化数字继承为当前结果。

