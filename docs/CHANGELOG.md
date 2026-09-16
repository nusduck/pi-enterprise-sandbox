# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed（破坏性：Worker 容量语义）

- **Run 队列按子任务深度分层，每层保留消费槽**（审查 R3，[ADR 0012](adr/0012-depth-layered-run-queues.md)）：
  父 Run 发起子 Run 后前台等待、不让出 BullMQ 槽位；父子共用一个队列时，N 个
  父 Run 占满 N 个槽之后子 Run 永远排不上，父 Run 又在等子 Run——整条队列停住。
  提高并发不解决（任何有限 N 都有同样的饱和条件）。现在深度 0 是 `agent-runs`、
  深度 n 是 `agent-runs-d{n}`，每个允许的深度一个队列、一个消费者、至少一个
  保留槽；投递路由只看 MySQL 里的权威 `subagent_depth`。
  - **`AGENT_WORKER_CONCURRENCY` 的含义变了**：它现在是**总预算**，按「每个
    深度 ≥ 1 的层保留 1 个槽、其余给深度 0」切分。默认 `4` + `maxDepth=2` →
    **2 / 1 / 1**，根任务的同时执行量从 4 降到 2。提到 `6` 恢复的是根任务槽数 4，
    吞吐是否相同以压测为准。
    预算 < `maxDepth + 1` 时**拒绝启动**。
  - **升级不需要排空**（深度 0 沿用旧队列名）；**缩深 / 回滚必须先收敛**——
    Worker 在恢复扫描与消费者启动之前检查「本配置不服务的深度」在 Redis 队列与
    MySQL `runs` 账本（非终态 Run）里是否还有存量，有就拒绝启动并点名；**读不到
    也拒启**。换回分层前的旧镜像没有这道闸门，须按 deployment.md 在外部确认分层
    队列为空。
  - 就绪判定收紧：任何一个必需层的消费者不在跑，`/ready` 即不就绪；依赖守卫的
    暂停 / 恢复对全部层生效。

### Fixed

- **沙箱资源限额与子进程磁盘配额真的接线了**（审查 R1）：`SANDBOX_MAX_PROCESS_COUNT`
  / `SANDBOX_MAX_OPEN_FILES` / `SANDBOX_MAX_CPU_TIME_SECONDS` / `SANDBOX_MAX_FILE_SIZE_MB`
  / `SANDBOX_EXECUTION_TIMEOUT_SECONDS` / `SANDBOX_MAX_OUTPUT_CHARS` 此前在 `exec/src`
  里没有任何消费者——声明了 20 个进程上限，最终 profile 里那一项恒为 0（不限制）。
  现在逐条落到命名空间内部的 `ulimit` 包装器；配置越界直接拒绝启动。
  `evaluateChildQuota` / `ChildWorkspaceQuotaWatch` / `assertProductionQuotaBackend`
  同样从「只存在于定义链里」变成 spawn 前准入 + 执行中采样 + 生产启动闸门。
  控制面配额账本的默认额度不再写死 1024 MB，改取 `SANDBOX_WORKSPACE_QUOTA_MB`。
  新增 `SANDBOX_MAX_ADDRESS_SPACE_MB`（默认关）；`SANDBOX_MAX_MEMORY_MB` 明确为
  容器兜底声明，不再被当作逐任务额度。
- **超过 15 秒的前台命令不再「客户端放弃、沙箱继续跑」**（审查 R2）：`ExecRpcClient`
  的传输截止改为「执行预算 + 15 秒有界回传余量」，并与调用方的 `AbortSignal` 融合；
  exec 的监听器把客户端提前断开转成请求的 `AbortSignal`，路由接到执行面，
  bwrap 进程树随之终止。`signal` 不再被序列化成一个没人读的布尔值。
- **`workdir` / `stdin` / `env` / `stdoutMaxBytes` 不再被跨服务静默丢弃**（审查 R4）：
  两侧共用 `@pi/contract` 的 shell payload 解析器，越界路径与非法字段在执行前
  拒绝（400），合法字段一路传到 bwrap 的 `--chdir` 与子进程环境。
  `stdoutMaxBytes` 按**字节**解释，截断落在字符边界上。
- **子任务轮询不再积累 abort 监听器、也不再定频打数据库**（审查 R5）：每一轮等待
  退出时摘监听器（`{ once: true }` 只在 abort 真的发生时才摘，正常轮询不会）；
  轮询从 50 ms 定频改为 200 ms 起、最多 2 s 的有界退避，取消立刻唤醒。
- **后台命令的输出不再在 Agent 侧无限累积**（审查 R6）：`RemoteShellProcess` 未被
  读取的缓冲有上限（保留尾部，截断置 `lossy`）。
- **外部 MCP 的命令执行不再绕过资源限额与配额**（修复后复核 F1）：R1/R2 的修复只接到
  了 Agent 走的 `/internal/v1/shell/run`，MCP 窄桥的 `shell/execute` 与 `python/execute`
  仍然是裸执行器——没有 nproc/NOFILE/CPU/FSIZE rlimit、没有子进程配额准入与采样、
  请求断开也停不掉命令。现在两个入口共用 `exec/src/shell/guarded-execution.ts`；
  超额时 MCP 返回 `failed`（exit 126，原因在 stderr），`timeout_seconds` 超过
  `SANDBOX_EXECUTION_TIMEOUT_SECONDS` 回 400。
- **Worker 缩深闸门不再把「读不到」当成「已排空」，也不再漏掉等待审批的子 Run**
  （修复后复核 F2 / F3）：Redis 读失败曾按 0 放行，之后无人重做检查；只查 Redis 时，
  停在 `WAITING_APPROVAL` / `WAITING_INPUT` 的超深子 Run 队列里没有作业，缩深后恢复
  入队会被越界拒绝。闸门现在同时查 MySQL 账本、读失败即拒启，并前移到任何副作用之前。
- **`SANDBOX_MAX_MEMORY_MB` 的文档不再暗示它是生效的内存上限**：它只进启动日志；
  生产硬限额是 `SANDBOX_MEM_LIMIT`，开发 Compose 没有容器内存限制。

### Changed

- **模型目录改为 `deepseek-flash`（默认）与 `qwen3.8-27b`**：LLMIO 网关实测
  `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` 返回 500
  `balancer pop err: no provide items or all items are disabled`，选中即整轮失败。
  目录、DSH `llm-deepseek` 路由、`MODEL_ID` 默认值与 seed 同步只保留网关 `/models`
  里能 200 的这两个 id。`deepseek-v4-flash` 在网关上仍能通，但 wire 名已是
  `deepseek-flash`，本仓跟网关 id。`deepseek-flash` 是多模态（`text`+`image`）；
  `qwen3.8-27b` 只接受文本。
- **BFF 不再从 `env_file` 继承 MySQL/Redis 口令 DSN**：`api-server` 与 Agent 一样
  把 `AGENT_DATABASE_URL` / `AGENT_REDIS_URL` / `MYSQL_PASSWORD` / `REDIS_PASSWORD`
  等置空。BFF 源码本来就不读这些变量。
- **`skills/README.md` 对齐 ADR 0009 D7**：三层根 + 人工启用；不再描述已退役的
  `skill_install/create/edit/uninstall`。

### Changed（入口形态）

- **边缘 nginx 支持 HTTP / TLS 双模式，生产会话 Cookie 不再带 `Secure`**：新增 `TLS_ENABLED`
  （默认 `true`，保持既有 TLS 行为）。`false` 时边缘 nginx 只监听 80 明文，不生成证书、不做 301 跳转、
  **不声明 HSTS**（对没有加密端口的站点声明 HSTS 会把浏览器锁死在打不开的地址上）。取值不是
  `true` / `false` 时容器拒绝启动，渲染后还会跑一次 `nginx -t`。两套 server 模板共用
  `nginx/templates/locations.conf`，SSE 免缓冲、55MB 上传上限等代理语义不随模式漂移；
  `X-Forwarded-Port` 由写死的 `443` 改为 `$server_port`。原 `nginx/conf.d/sandbox.conf` 拆成
  `nginx/templates/{locations,sandbox-http,sandbox-tls}.conf`，由 entrypoint 按模式渲染进 `conf.d`。
  **破坏性**：BFF 的 `pi_enterprise_session` Cookie 不再在 `DEPLOYMENT_ENV=production` 下附加
  `Secure`（内网 HTTP 入口下浏览器不会回传 `Secure` Cookie，登录会直接失效）；`HttpOnly` 与
  `SameSite=Lax` 保留。**若把入口改回 HTTPS，必须同时恢复 `Secure`**。

### Removed

- **退役 replay Redis 与同族无消费方变量**：`sandbox-replay-redis` 服务（开发 Compose、生产 overlay、
  CI cross-service smoke）、它的数据卷与独立口令，连同 `SANDBOX_INTERNAL_PLANE_ENABLED`、
  `SANDBOX_INTERNAL_REDIS_URL`、`SANDBOX_INTERNAL_REDIS_PASSWORD`、`SANDBOX_INTERNAL_MAX_CONCURRENCY`、
  `SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS` 一并删除。ADR 0008 D8 去掉 jti 防重放后，这五个变量在
  `exec/src` 与 `agent/src` 中都**没有任何读取方**——其中 `SANDBOX_INTERNAL_PLANE_ENABLED` 还被文档和
  生产校验写成「生产必须 true 的 fail-closed 开关」，实际不接任何闸门，属于假的安全感。内部面
  （`/internal/v1/*`）的真实闸门未变：HMAC keyring（缺 keyring / active kid 时 exec 拒绝启动）加
  `EXEC_INTERNAL_ALLOW_CIDR` 来源白名单。`verify_compose_prod_config.py` 相应改为要求 keyring 与
  active kid 非空，并在这些退役变量重新出现时拒绝渲染结果。**升级时**：从 `.env` 与编排配置里删掉上述
  变量，停掉并删除 `sandbox-replay-redis` 容器与 `sandbox_replay_redis5_*` 卷（其中只有过期的 jti key，
  无数据需要保留）。

### Changed

- **破坏性：exec 内部面来源白名单空值改为拒绝全部**：`EXEC_INTERNAL_ALLOW_CIDR` 为空（或取不到对端地址）时，
  `/internal/v1/*` 一律 403 `AUTH_FAILED`，启动日志告警；非法 CIDR 条目让 exec 拒绝启动；放行全部必须显式写
  `0.0.0.0/0,::/0`。此前空值直接放行，而开发 / 生产 Compose 从未传入这个变量（传的是 TS exec 不读取的 Python 时代变量
  `SANDBOX_ALLOWED_CLIENT_CIDRS` / `SANDBOX_TRUSTED_PROXY_CIDRS`），内部面实际只靠 HMAC。现在开发 Compose 默认
  `127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`，**生产 overlay 必填**，`verify_compose_prod_config.py`
  拒绝缺失与 `/0`。**升级时自建部署需要设置该变量**，否则 Agent / Worker 调不通执行面。同时：IPv4-mapped IPv6 对端
  （`::ffff:10.0.0.1`）按 IPv4 匹配；含点分段等畸形 IPv6 不再被当成十六进制段解析；`createExecAppFromEnv(env)` 改从
  传入的 `env` 读白名单（此前读 `process.env`）。

- **破坏性：用户 Skill 以启用账本为发现依据，已发布字节按摘要分版本，exec 按清单挂载**（design §3.3 S1）：
  启用时 Agent 在一个 MySQL 事务里锁住 owner 的 membership 行，把草稿复制到暂存目录并**按暂存字节**算摘要，
  发布到 `<owner>/<name>/.v/<digest>/<name>/`（侧车 `.v/<digest>.json`），再写 `user_skill_enablements`。
  **停用只删账本行，不删字节**；不再被账本引用且超过新配置 `SKILL_VERSION_GC_GRACE_MS`（默认 24 小时）的旧版本
  在同名包下次启停时回收。Worker 在 Run 开始时按账本逐条核对版本，模型看到的 Skill 路径改为 exec 的挂载路径
  `/home/sandbox/skill-user/<name>`（此前是 Agent 本地 `<base>/<org>/<user>/<name>`，`read` 资源文件被
  `FS_SANDBOX_DENIED`）。清单随每个内部请求进入签名覆盖的请求体，exec 不再扫目录，只挂清单点名且侧车一致的版本；
  缺版本或侧车不符返回新错误码 `SKILL_PACKAGE_UNAVAILABLE`，存储不可读返回 `SKILL_STORE_UNAVAILABLE`（此前一律当作
  「没有 Skill」）。能力页 My Skills 同样按账本列出。2026-09-14 之前平铺发布的已启用包不再被识别，需要重新启用。
- **内部面 GET 请求的签名覆盖规范化 query**：`GET /internal/v1/fs/stream-text` 的 `body_sha256` 此前是空串摘要，
  query 里的信封与读取目标不受签名覆盖，同一枚令牌可以换目标读取。现在签发与验签共用 `canonicalQueryBytes`，
  同名参数重复直接 401。Agent 与 exec 必须同时升级。

- **破坏性：BullMQ 队列 key 改用带 hash tag 的前缀 `{bull}`，Redis 基线降到 5.0.14**：
  新增 `AGENT_RUN_QUEUE_PREFIX`（空值 = `{bull}`），HTTP 投递与 Worker 消费共用；不含非空 hash tag
  （如旧的默认 `bull`）在建 Queue/Worker 前拒绝启动。原因是 UPRedis Proxy 按 key 路由，BullMQ 的多 key
  脚本必须落在同一节点。旧 `bull:agent-runs:*` 里的作业不会被新消费者看到，升级前按
  [队列 prefix 切换 runbook](runbooks/run-queue-prefix-switch.md) 停准入、drain，由 Worker 启动恢复扫描按
  MySQL 账本重投。开发 / 生产 overlay 的 `redis` 与 `sandbox-replay-redis` 改为 `redis:5.0.14` 并显式
  `maxmemory-policy noeviction`；5.0 读不了 7.x 数据文件，数据卷改名为 `redis5_dev_data` /
  `sandbox_replay_redis5_dev_data`（生产 `redis5_data` / `sandbox_replay_redis5_data`），旧卷保留不挂载，
  本地 `.env` 里的旧卷名需要改掉。CI 服务 Redis 同步 5.0.14。新增开发用 UPRedis 路由模拟代理
  （`scripts/dev/docker-compose.upredis-sim.yml`）与队列放行测试 `agent/tests/redis/upredis-queue.integration.test.js`。

- **破坏性：任何服务启动时都不再迁移，schema 改为执行导出的发布包 + 启动只读核对**：
  开发与生产 Compose 都删除了 `agent-migrate` 服务与 `AGENT_MIGRATE_ON_START`。新增
  `npm run schema:sql|schema:replay|schema:verify|schema:manifest --prefix agent`：在空影子库上
  跑 Knex migrations，导出按迁移分段的 SQL 发布包（每段最后一句才写 `knex_migrations`，首个错误即停），
  可在另一个库重放核对。`contract/schema/schema-manifest.json` 是从真实迁移生成的 schema 清单
  （表/列/索引/外键/四个 append-only 触发器/迁移记录），agent、agent-worker、sandbox 启动时按它核对，
  任何差异以 `SCHEMA_DRIFT` 拒绝启动（Agent 在连 Redis 前、Worker 在消费前、exec 在孤儿回收前）。
  开发空库先 `docker compose up -d mysql` 再 `scripts/dev/schema-apply.sh`；改了迁移要重新生成清单。
  `scripts/restore.sh` 恢复后只核对不迁移；生产配置校验改为拒绝重新出现迁移服务。见
  [统一 design](design/updrdb-dbpm-deployment.md) §6。
- **破坏性：应用口令只从 DBPM 取，连接串带口令会拒绝启动**：agent、agent-worker、
  sandbox（exec）、sandbox-mcp 启动时各自向 DBPM 取所需口令（UPDRDB / 服务 Redis），
  只取一次、只放内存。`AGENT_DATABASE_URL`、`AGENT_REDIS_URL`、`SANDBOX_DATABASE_URL`、
  `SANDBOX_MCP_REDIS_URL` 必须**不带口令**；`DBPM_URL` 缺失、DSN 用户名与 DBPM 条目不一致、
  两台 DBPM 都取不到时进程直接退出，没有环境变量口令回退。开发 Compose 新增默认启用的
  `dbpm-fake`（真协议假服务端，只挂内部网络），并改用 `AGENT_COMPOSE_*` /
  `SANDBOX_MCP_COMPOSE_REDIS_URL` 插值，宿主 `.env` 里旧的带口令连接串不会被带进容器；
  宿主机直接起服务进程时需要自己提供 `DBPM_URL`。生产 overlay 禁用 `dbpm-fake`，
  `DBPM_URL` 等条目必填。`agent-migrate` 作为 DBA 工具改读 `AGENT_MIGRATE_DATABASE_URL`。
  replay Redis 目前无代码消费方，不取密。另附 `scripts/dev/docker-compose.updrdb-sim.yml`
  在本地用两个转发容器演练双 Proxy 故障切换。见 [统一 design](design/updrdb-dbpm-deployment.md) §7。
- **MySQL 建连支持 UPDRDB 两个 Proxy 的故障切换**：新增可选配置 `UPDRDB_ENDPOINTS`
  （恰好两个 `host:port`）。Agent Knex、Agent DSH 会话存储、exec 三处取连接时粘住当前
  主用、网络故障拉黑 180s 换另一个、拉黑过期不主动回切；单次握手 3s、一次取连接总预算
  10s，两个都不可达时有界失败而不是挂到 Knex 默认的 60s。认证失败等非网络错误不换端点。
  **已发出的 SQL 不重试**。会话 UTC 初始化从「连接事件里发出、失败销毁」改为交付连接前
  等待完成，失败即丢弃连接。不设置时行为与此前相同（DSN 单端点）。见
  [统一 design](design/updrdb-dbpm-deployment.md) §4。
- **抢占改用「条件 UPDATE + token 回读」，开发/CI 基线降到 MySQL 5.7**：Outbox 与
  Cron 的批量抢占不再使用 `SELECT … FOR UPDATE SKIP LOCKED`（UPDRDB 的 UPSQL 5.7
  内核没有这个语法），改为一条带 eligibility 条件的 `UPDATE` 打上批次 token、再按
  token 在同一事务内回读。语义变化是**并发调度器从「跳过被锁的行」变成「等待行锁」**，
  由短事务、既有索引和 `innodb_lock_wait_timeout` 约束影响；对外的投递语义、幂等键、
  发布 CAS、misfire/并发策略均不变。`cron_jobs` 新增可空 `claim_token` 列，它只是
  事务内批次标记，claimDue 提交前逐行清空并校验无残留，因此没有新增租约回收器。
  每条 MySQL 物理连接在交付前执行 `SET SESSION time_zone = '+00:00'`，初始化失败
  的连接直接丢弃（此前只有驱动侧 `timezone=Z`，服务端会话时区仍是 `SYSTEM`）。
  Compose 的开发数据库切到 `mysql:5.7` 与**新数据卷** `mysql57_dev_data`；旧的
  `mysql_dev_data` 不可复用（官方不支持 8.0→5.7 降级），已于 2026-09-14 决定作废。
  本地 `.env` 若显式设过 `MYSQL_DATA_VOLUME` 必须同步改名。见
  [ADR 0011](adr/0011-updrdb-upredis-dbpm-migration.md) 与
  [统一 design](design/updrdb-dbpm-deployment.md) §5。

### Changed

- **sandbox-mcp 改用独立 slim 镜像**（design §2.1，S2）：`exec/Dockerfile` 新增 `facade` 阶段，Compose `sandbox-mcp` 以
  `target: facade` 构建为 `enterprise-sandbox-mcp:latest`（新变量 `SANDBOX_MCP_IMAGE`），不再复用 2.84GB 的执行面镜像。
  slim 镜像约 302MB，只含 `mcp-main.js` 的 import 图与所需生产依赖：没有模型工具链、Bubblewrap、Python、curl、执行面代码、
  `mysql2` 与 `@deepseek-ai/dsh-*`，发布文件对 uid 10001 只读。为此把 facade 的 Redis 取密从 `startup-credentials.ts` 拆到
  `mcp/startup-credentials.ts`——此前 facade 入口经它间接加载了 `db/client.ts` 与 `mysql2`；新增 `mcp-import-boundary` 测试核对
  import 图与 Dockerfile 复制清单一致。sandbox-mcp 的 healthcheck 改为 node（镜像无 curl）。**改了 `exec/` 需要同时 build
  `sandbox` 与 `sandbox-mcp`**，自定义过 `SANDBOX_IMAGE` 给 facade 用的部署需改为 `SANDBOX_MCP_IMAGE`。
- **frontend nginx 的 `/api/` 上游改由 `API_UPSTREAM` 渲染**（design §2.2，S2）：`frontend/nginx.conf` 改为
  `frontend/nginx/default.conf.template`，由官方 nginx 镜像的 envsubst 钩子在启动时渲染，过滤器只放行 `API_UPSTREAM`。
  镜像默认值与开发 Compose 均为 `http://api-server:4000`，现有部署无需改动。值只接受 `http://host[:port]`，带路径、query、
  空白、换行、`;`、`$`、`https://` 或端口越界时容器在 nginx 启动前退出；渲染文件缺失、残留占位符或上游不符（例如 `conf.d` 不可写）
  同样拒启，而不是带着空配置或官方欢迎页启动。镜像不再保留官方 `conf.d/default.conf`。

### Fixed

- **沙箱内可读系统字体配置与 RHEL 系 CA 证书**：Bubblewrap 的 `/etc` 白名单此前不含 `/etc/fonts`，沙箱内 soffice / tesseract 报
  `Fontconfig error: Cannot load default config file`；openEuler / 麒麟的 `/etc/ssl/certs` 链到 `/etc/pki`，沙箱内 CA 证书全部不可读，
  放开网络后 HTTPS 校验会失败。现只读挂入 `/etc/fonts` 与 `/etc/pki/tls/certs`、`/etc/pki/tls/cert.pem`、`/etc/pki/tls/openssl.cnf`、
  `/etc/pki/ca-trust/extracted`（不存在即跳过）；**不整体挂 `/etc/pki`**，`tls/private`、`nssdb`、`rpm-gpg` 仍不可见。
- **执行面镜像内 soffice 在沙箱里启动即崩溃**：Debian 打包的 LibreOffice 把配置注册表放在 `/etc/libreoffice/registry`，
  `/usr/lib/libreoffice/share/registry` 是指向它的符号链接；沙箱没有挂这条路径，soffice 抛 `uno::RuntimeException` 后 abort（exit 134），
  docx / xlsx / pptx 转 PDF 全部失败。现只读挂入 `/etc/libreoffice/registry` 与 `/etc/libreoffice/psprint.conf`（VM 上的 TDF 官方包自带注册表，
  不存在即跳过），不整体挂 `/etc/libreoffice`。
- **执行面 `GET /ready` 真正做就绪判定**（design §9.2，S2c）：此前 `/ready`、`/health/ready` 与 `/health` 是同一个恒返回
  `{"status":"ok"}` 的处理器，部署文档所说的预检并不存在。现在 `/ready` 在数据库 `SELECT 1` 失败或超时、workspaces / tmp /
  artifacts / control 任一根不可读写、启动期 Bubblewrap 预检未通过，或进程已进入关停时返回 503，响应只含各项 ok / unavailable。
  **启动顺序新增一步**：schema 核对之后、孤儿回收之前建出四个数据根并真跑一次 bwrap 探针，失败即拒绝启动（此前 bwrap 不可用只在
  第一次执行时暴露）。`/health`、`/health/live` 仍只表示进程存活；Agent 与 BFF 的依赖检查打的是 `/health`，不受影响。

### Added

- **VM 模型工具链安装脚本**（design §9.1，S2f-2）：release 新增 `vm/toolchain/install-toolchain.sh` 与制品清单
  `toolchain-sources.json`，以及脚本读取的 `toolchain/`（`requirements.txt`、三个 wrapper、两套 BaoYu 脚本与锁文件）。面向 dnf 系
  （openEuler / 麒麟）：dnf 装隔离原语、办公 / OCR / 字体与浏览器运行库；Node 22.23.2、uv、ripgrep、fd、pandoc、LibreOffice、Chromium
  按清单钉版本与 SHA256，**先核对再使用**，默认只用离线缓存（`--allow-download` 才下载）。openEuler 24.03 官方源缺的 ripgrep / fd / pandoc /
  LibreOffice / Chromium 使用上游官方包（LibreOffice 先验 GPG 签名、Chromium 为 Playwright 分发的 Chrome for Testing）。全部装到 Bubblewrap
  可见的 `/usr/local` 与 `/opt/pi-python/venv`（官方 LibreOffice RPM 解包后搬离 `/opt`），`baoyu-chromium` 改写为 VM 路径。新增开发用
  `scripts/vm/openeuler-systemd-sim.Dockerfile` 与 `tests/test_vm_toolchain_assets.py`。openEuler 24.03 容器中，当前 unit 下 exec 启动就绪，
  Bubblewrap 内文档 / 转换 / OCR / 检索 / BaoYu / Chromium（CDP）工具 smoke 通过；目标 VM 与 x86_64 未验证。

- **Agent Worker 依赖不可用时暂停取任务**（design §9.2）：新增依赖守卫，每 `AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS`
  （默认 5000，非法值拒绝启动）用与 `/ready` 相同的 ping 探测 MySQL / Redis；连续 2 次失败调用 `worker.pause(true)` 停止从 BullMQ
  取新任务（不等待、不打断在跑任务），连续 2 次成功后 `resume()`，只恢复自己造成的暂停。暂停期间 `/ready` 返回 503、`consumer: paused`。
  由于 `pause(true)` 不打断在途的阻塞取任务，处理器执行前再检查暂停状态，暂停中取到的作业放回 delayed（不计失败），恢复后执行。
  此前依赖故障时 Worker 仍会继续取任务，只靠 lease / fence 兜底。

- **VM exec release 与 systemd 部署资产**（design §9，S2）：`scripts/vm/build-exec-release.sh --arch amd64|arm64` 在目标架构的
  Linux 容器里构建不可变 release 包（`release-manifest.json` 记录提交、架构、构建用 Node 与 glibc、schema 清单哈希、原生模块；
  `SHA256SUMS` 覆盖全部文件；有未提交改动时拒绝构建）。`deploy/vm/` 随包分发：`pi-exec.service`（非 root、ExecStartPre 预检、
  `KillMode=mixed` 清理 bwrap 子进程、`ProtectSystem=strict` 等加固，逐项实测与 bwrap 兼容）、只列 exec 实际读取变量的
  `exec.env.example`、`exec-preflight.sh`（Node 位置与版本、release 完整且只读、必需配置、数据根 0700 等）与
  `install-release.sh`（init / install / activate / list，校验哈希，同 id 不可重装，从不自动重启）。部署步骤见 `deployment.md`
  「VM exec release」。VM 上的系统工具链安装与完整工具 smoke 不在本次范围。

- **Agent Worker 探针 listener**（design §9.2，S2）：Worker 新增只含 `GET /health`（事件循环活性，不查依赖）与
  `GET /ready`（启动完成、BullMQ 消费者在跑、未关停，且 MySQL `SELECT 1` / Redis `PING` 在 2s 内成功）的内部 listener，
  端口 `AGENT_WORKER_PROBE_PORT`（默认 `4101`，非法值拒绝启动），其余路径 404。listener 先于容器启动，SIGTERM 时先摘除就绪
  再停消费。开发 Compose 的 `agent-worker` 增加基于 `/health` 的 healthcheck，端口只 `expose` 不发布。
- **sandbox-mcp 新增 `GET /ready`**（design §9.2，S2）：服务 Redis `PING` 与执行面 `GET /ready` 都在 2s 内成功才 200，
  否则 503，只回各项 ok/unavailable。探针不带窄桥 token。`/health` 仍只表示进程存活。

- **一个 org 可以有多个可选的智能体**：新增 Agent 目录写入面（`POST /api/agents`
  建智能体、`POST /api/agents/{id}/versions` 改配置、`POST /api/agents/{id}/active-version`
  切活跃版本 / 回滚，均要求 admin），并把 `agent_id` 接到建会话的三个入口
  （`POST /api/runs` 首轮、`POST /api/conversations`、`POST /api/sessions/ensure`）。
  前端在**新会话**且 org 内多于一个智能体时出现 Agent 选择器，会话头部显示当前
  会话绑定的智能体。一个会话绑定一个智能体，绑定在建会话时完成、此后不可变——
  换智能体要新建会话。org 只有一个智能体时 UI 与行为与本次改动前完全一致。
  改配置是建新版本而非原地改写，切换活跃版本只影响**新建**的会话；正在跑的 Run
  与已存在的会话继续用它们钉住的版本。非法配置在建版本时即被拒。

- **AgentVersion 配置真正接到运行时**：管理员在版本里配的东西现在**实际生效**，
  不再是写进去不报错却没有执行路径。`toolPolicy` 的显式 `deny` 拦在真实工具体之前；
  `mcpServers` 的引用成为执行授权（未引用的 server/tool 一律拒绝，空引用 = 零 MCP 权限）；
  风险策略平台层与版本层各自解析后取更严，租户只能收紧；`systemPrompt` 作为字面量
  persona 注入（`{{...}}`、代码块、中文原样送达），企业条款恰好一份、不可覆盖；
  `modelPolicy.maxOutputTokens` 与 `thinkingLevel` 出现在真实主对话请求上，辅助请求
  各自策略不变；prompt 里的路径用服务端解析的逻辑根，不泄漏宿主物理根。
- **新增只解析、不落库的配置面**：`GET /api/agents/config/options`（能力 schema 与
  平台约束）与 `POST /api/agents/config/validate`（字段级校验，200+`valid:false`），
  均为 admin。管理页拆出结构化编辑器与校验面板：表单与 JSON 共用一份草稿、字段级错误
  可定位、能力目录不可达与"空清单"区分开、不支持字段不提供假开关。
- **激活加乐观并发**：发布/激活可带 `expected_active_version_id`，与当前指针不一致返回
  409 并回传当前指针，防止两位管理员互相覆盖。不传该字段保持旧客户端兼容。

### Changed

- **全面清理 Pi SDK 遗留命名与测试残留**：将 `agent/src/application/` 下的 6 个 `pi-run-*` 模块重命名为 `dsh-run-*`，核心执行器规范为 `DshRunExecutor`；`pi-session-journal-repository.ts` 重命名为 `session-journal-repository.ts`；测试目录 `agent/tests/pi/` 统一迁移规范为 `agent/tests/executor/`；清理废弃的 `agent/tests/sdk-compat/` 目录；彻底移除历史 `Pi*` 兼容别名导出，全仓内部调用统一切换至 DSH 执行器与预算。
- **BFF 服务从 JS 全面迁移至 TypeScript**：`api-server` 源码完成 TypeScript 化，统一编译至 `dist/server.js`。
- **`/internal/auth/me` 不再每次调用都补建 org/user**：它挂在 BFF 每请求的 `resolveTrustedAuth()` 上，不做记忆等于每个请求 3~4 次 MySQL 往返。改成每进程每 credential 记一次；register / login 仍强制重新对账。
- **沙箱环境隔离由 `spawnLaunch` 代码强制**：`envMode: 'inherited'` 不发 `--clearenv`，"沙箱不继承宿主 env" 这条不变量因此只剩调用方一处在守。`spawnLaunch` 的选项类型排除 `env` 并在运行时剥掉，沙箱内环境只能来自 `OUTER_PROCESS_ENV` + 已校验的 `EnvPlan`。
- **启用后的 Skill 草稿不再重复列在 Drafts**：启用是复制字节、草稿不删，所以 `skill_drafts` 里会一直有它。Agent 给这类条目打 `published: true` / `status: 'published'`，UI 的 Drafts 区只列待启用的。三层 Skill 卡片统一结构，操作按钮收进卡片底部的动作行，不再被拉成整行宽的色块。
### Fixed

- **用户启用的 Skill 终于对模型可见**：`createDshRunExecutorFactory` 逐项转发依赖时漏掉了
  `skillRootsForRun`，每个 Run 都退回进程级默认的系统根，UI 上「启用」成功的用户 Skill 在
  `skill` 工具里一律报 `unknown or no longer available`（exec 侧挂载正常）。补上转发并加回归测试。
- **exec 的文件系统错误码不再被抹成 `INTERNAL_ERROR`**：exec / agent 与 contract 各装一份
  `@deepseek-ai/dsh-fs`，`toWireError` 对调用方抛出的 `FsError` 做 `instanceof` 为假，
  `FS_NOT_FOUND`、`FS_SANDBOX_DENIED` 等一律以 `INTERNAL_ERROR` 返回给模型（sandbox 日志
  `exec fs-error … INTERNAL_ERROR`）。改为按 dsh-fs 声明的错误码做结构判断，任意 `code` 不透传。
- **模型推理档位对齐真实适配器**：模型目录的 `thinking_levels` 曾沿用已退役的 pi-ai
  枚举（含 `medium`），而当前 `deepseek-official` 适配器只接受 `off|low|high|max`。
  改为按路由适配器投影可选 effort，保存不支持的档位时报错、起 Run 时 fail-closed，
  不再静默降级到别的档位。

- **`/api/files/download` 与 `/api/files/upload` 走错了工作区**：exec 公共面
  `/sessions/{id}/files/*` 里的 `{id}` 是 `workspace_id`，这两条代理却直接把浏览器
  的 `sandbox_session_id` 塞进 URL（两者是各自独立的 ULID）。结果是下载恒 404、
  上传静默写进一个按 session id 派生出来的幽灵工作区，Agent 的工具永远看不见那个
  文件。两条路径改为与 artifacts / datasets / processes 一样，先经 Agent 换成
  `workspace_id`；换不出来 fail-closed 返回 503 `SESSION_WORKSPACE_UNAVAILABLE`，
  不再拿 session id 顶替。四处重复的换算收口成
  `run-access-service.requireSessionWorkspaceId()`。

- **删掉的生产代码不再继续进镜像**：`.dockerignore` 的 `dist/` / `node_modules/`
  不带 `**/`，而 Docker 只把它们当作上下文根下的那一个目录——每个包各自的
  `agent/dist`、`exec/dist` 照样被 `COPY agent ./agent` 整个塞进镜像，而
  `npm run build` 的 tsc 只覆盖自己编译出的文件、不清理别人留下的。结果是当天
  刚删掉的 `internal-hmac.js`（980 行）与 `memory.js` 仍躺在**运行中的** agent
  镜像的 dist 里。模式改成 `**/dist/` / `**/node_modules/` 后重建，两个文件消失。
  新增 `tests/test_dockerignore_excludes_host_build_output.py` 守住这条。
- **内部面的令牌现在真的绑定方法与能力**：`htm` 以前在 contract 里钉死 `'POST'`，
  而 `GET /internal/v1/fs/stream-text` 也要签，于是 exec 侧写了一条「htm 是 POST
  但方法是 GET 就放行」的例外——任何一枚 POST 令牌都能拿去打 GET 端点。现在
  `htm` 允许 `'GET'`，例外删除，方法逐字相等。`scope` / `tool_name` 从来没人校验
  （`ExecRpcClient` 对所有 RPC 都写死 `fs` / `internal:fs`，一枚「文件」令牌可以
  拿去起进程），现在按路由族校验，绑定表 `internalBindingForHtu()` 放在
  `@pi/contract`，签发与校验共用一张表；**未登记的内部路径一律拒**，新端点不会
  默认免检。
- **产物与数据集的配额账本落库，并且共用同一本账**：`workspace_quota_reservations`
  只有 DDL、没有迁移，两个服务各自在构造函数里默认装配一个 `InMemoryQuotaStore`
  ——既重启即忘（配额计数归零 = 多放行），又互相看不见（同一个工作区的产物与
  数据集各算各的，1024MB 的额度实际能被用掉两份）。现在建表、生产装配用
  `MySqlQuotaStore`，两个服务共用一个 `WorkspaceQuotaLedger`。
- **exec 内部面的 IP 判定不再采信 `X-Forwarded-For`**：CIDR 白名单的唯一输入以前
  是 `X-Forwarded-For` / `X-Real-IP`（谁都能伪造），两个都取不到还兜底成
  `127.0.0.1`——等于给任何拿不到对端地址的路径发通行证。现在对端地址由监听器从
  TCP socket 注入（同名头先剥后写），取不到即空串：白名单为空时照常放行，配了
  白名单就一律拒。
- **`memory_write` / `memory_search` 的实现随工具一起退役**：ADR 0009 D10 已把这
  两个工具标成 `TOOL_RETIRED`，但 `runtime/providers/memory.ts` 与它的单测还在，
  并且仍从 `runtime/index.ts` 对外导出。已删除。
- **exec 重启后不再留下永远 `running` 的僵尸作业行（§32 G7）**：
  `MySqlJobRegistry.recoverOrphans()` 的注释从第一天就写着「启动期调用（用户路由
  挂载之前）」，但**从来没有任何调用点**——只有一条单测在调。exec 每重启一次，
  上一轮 `running`/`stopping` 的行就永远留在那个状态；开发栈上实测到 6 条僵尸行
  （最老的两天前），而容器里一个对应进程都没有。这不只是脏数据：
  `countActiveForOwner` 把 `running`/`stopping` 都算进每 owner 的并发上限（默认 20），
  僵尸行攒够就再也起不了新作业，随重启次数单调恶化。现在 `exec/src/main.ts` 在
  `listen` 之前 `await` 回收（顺序是硬要求：回收扫描不带租户过滤，不能和用户请求
  并发），回收失败即拒绝启动。
- **内部 HMAC 只剩一份实现**：`agent/src/infrastructure/sandbox/internal-hmac.ts`（980 行）
  与 `contract/src/hmac.ts`（816 行）长期并存，两个生产模块还在用前者。收口到
  `@pi/contract/hmac.js` 之前先补齐了 contract 少的两条校验，**没有靠放宽来"统一"**：
  keyring 的值必须是可枚举的字符串**数据属性**（getter 可以在校验与取用之间返回
  不同字节，也会在校验期间跑任意代码），`scope` 数组不得携带额外自有属性
  （`['x']` 上挂个 `.extra` 仍然 `length === 1`，但它已不是那个被约束住的一元 scope）。
  补齐后，agent 那套 599 行严格性套件（含跨语言 golden fixture）对着 contract 实现
  21/21 通过，该套件已随实现移到 `contract/test/hmac-strict.test.ts`。
  `normalizeBaseUrl` 与签名无关，抽到 `agent/src/infrastructure/sandbox/transport-base-url.ts`。
- **exec 公共会话面现在真的校验 `SANDBOX_API_TOKEN`**：compose、`.env.example`
  与 `deployment.md` 三处都要求这枚服务令牌，BFF 与 agent 也一直在发
  `X-API-Key`——但 exec 换成 TS 之后公共面从来没有校验过它，`/sessions/*` 只看
  `X-Acting-*` 两个头存不存在。现在按常量时间比较，不匹配 401；`ExecAppDeps`
  的 `publicApiToken` 是**必填**字段（`null` 表示显式关闭，仅单测/本地直连），
  `createExecAppFromEnv` 缺这枚令牌直接拒绝启动。健康探针不受影响。
- **后台作业不再无限空转，流式读取不再永久挂起**：`RemoteShellProcess.monitor`
  过去以固定 200ms 轮询、把所有错误都当成"网络抖动，下一轮继续"，于是 exec 说
  "这个作业不存在"时它会 5 次/秒地永远问下去，`done` 永不 resolve。现在
  `WORKSPACE_NOT_FOUND` 立刻结算，其余错误指数退避（200ms→2s）并有 60s 的失败
  截止。`ExecRpcClient.getStream` 的超时定时器过去在拿到响应头时就被清掉，之后
  逐 chunk 读流完全没有截止——现在每块另有一个空闲超时，传输中途挂起会 abort
  连接并抛错，而不是把 Worker 协程永久挂住。
- **exec 的作业登记表不再只增不减**：`MySqlJobRegistry.lives` 里每个条目挂着一个
  子进程句柄和一个最大 500KB 的环形缓冲，结算路径的 `finally` 只写了一句"活句柄
  用完即丢"的注释，实际什么都没丢——长跑的 exec 每执行一条命令就多占一份。现在
  结算时打上时间戳，由 `pruneSettled()` 在保留窗口（默认 5 分钟）之后回收，并有
  512 条的硬上限；仍在运行的作业永不回收，窗口内的已结算作业仍能读到缓冲的尾部输出。
- **产物与数据集的元数据现在真的落库，重启不再整片消失**：`exec_artifacts` /
  `exec_datasets` 的仓储类和 DDL 常量早就写好了，却既没有迁移、也没有在
  `createExecAppFromEnv` 里接上——`ArtifactService` / `DatasetService` 一直跑在
  构造函数默认的 `InMemory*Store` 上。六套单测全绿，但 sandbox 容器一重启，
  `GET /api/artifacts` 就返回空列表、已有产物的下载全部 404。现在两张表随
  `20260904000001_exec_artifacts_datasets` 迁移建出，两个 Store 与 `MySqlJobStore`
  共用同一个池和同一次 fail-closed 判定（production 缺库直接拒绝启动）。
  新增 `tests/test_exec_schema_migrations.py`：exec 生产装配里接的每一个
  `MySql*Store`，它的表都必须有 agent 侧迁移，堵住"定义了表却没落地"这条路。
- **AgentVersion 里配的 `systemPrompt` 现在真的会送到模型**：`DshRunExecutor` 过去
  只把整个 `agentVersion` 对象交给运行时工厂，而工厂读的是 `input.systemPrompt`，
  于是它永远是 `undefined`——Agent 选对了、版本也钉对了，配置的人格一个字也到不了
  模型。现在经 `bindAgentVersionConfig()` 取出后传入。企业条款仍由
  `assembleSystemPrompt` 追加在租户提示词之后，且不可被租户覆盖。
- **绑定在非默认智能体上的会话，后续 Run 不再报 "Conversation is bound to a
  different agent"**：不带 `agent_id` 的 follow-up 过去会先解析成租户默认智能体，
  再与会话已绑定的那个比对而失败。现在没有显式选择时由**会话自己**决定智能体
  （A2A 建出来的会话在浏览器里追问即属此列）。
- **修复 Run 完成时 Agent 消息截断回退问题**：
  - 修复 `agent/src/lib/event-redaction.ts` 中 `redactPayload` 遍历属性时 `text_truncated` 标志位被原对象 `false` 覆盖的问题，并将 `text`/`thinking` 正文字段的脱敏长度上限提升至 `DEFAULT_MAX_RESULT_CHARS` (2048)；
  - 加固前端 `frontend/src/shared/state/runReducer.ts` 与 `platformEventNormalize.ts`：当消息内部标记截断或已有的流式缓冲区长度大于带省略号的预览时，严禁覆盖前端实时累积的正文，彻底解决运行完成时气泡回退截断为 512 字符的现象。
- **BFF smoke 脚本前置构建**：`api-server/package.json` 的 `smoke` 脚本前置追加 `npm run build`，并在 `tests/listen-smoke.test.js` 中直接断言 `dist/server.js`，移除对已删除 `server.js` 的失效回退，确保干净检出可用。
- **DshRunExecutor 构造器 sessionLockManager.acquire 校验强化**：恢复构造函数中对 `sessionLockManager.acquire` 方法存在性的严格校验，防止空对象绕过前置检查并在后续执行时抛出 TypeError。
- **保留自建 A2A 服务端协议面并撤销 ADR 0007 D8（ADR 0010）**：经架构实测评估（工单 `docs/design/a2a-sdk-server.md`），`@a2a-js/sdk/server` 的 `ExecutionEventBus` 与终态 `resubscribe` 报错行为无法支持多进程异步架构（`server.js` + `worker.js`）与断线重连补发。正式保留自建的 13 个 A2A 协议与应用模块，继续使用 `@a2a-js/sdk` 编码 SSE 帧，并建立反向完整性测试棘轮（`a2a-custom-protocol-integrity.unit.test.ts`）。
- **用户 Skill 改为草稿 → 人工启用 → 只读发布**：Capabilities 页可启用/停用 owner-scoped Skill；Agent 同步发布副本与 MySQL 启用账本，exec 只把当前 owner 的已发布包逐个只读挂载。旧 `skill_install/create/edit/uninstall` 工具退役。
- **CI 纳入 `contract/` 与 `exec/`**：两包都执行独立 typecheck 与测试；Python 仓库卫生环境显式声明零 setuptools package，`uv sync` 不再因平铺目录自动发现失败。
- **长进程事实权威迁到 exec**：DSH 后台 `bash` 预留并透传唯一 process id，exec 在 `exec_jobs` 登记和控制；BFF 先由 Agent 授权 Sandbox Session 并解析 Workspace，再直接查询 exec。Agent 的旧 `/internal/processes*` 生产路径已删除。
- **DSH 会话走原生 MySQL persistence**：`ctx.sessionPersistence` 接到 `dsh_sessions` / `dsh_session_events`；同一会话后续 Run 调用 `agents.resume`，不再每次 `create`。出厂 JSONL 后端保持关闭。配置读 `AGENT_DATABASE_URL`；mysql2 JSON 列按字符串读取，避免 resume 时把已解析对象再次 `JSON.parse`。Worker 进程被 SIGKILL 后，新 Worker 仍能 resume 并把上一轮用户口令送回模型上下文。

- **Agent 引擎从 Pi 换成 DeepSeek Harness（`@deepseek-ai/dsh-*` `0.1.1-rc.2`）**：`@earendil-works/pi-coding-agent` 不再是直接依赖。工具走 DSH 的 `ctx.fs` / `ctx.shell` / `ctx.jobs` 远程 provider（HMAC RPC 到 exec），企业策略挂在 DSH 四个既有挂载点上，不再装 Pi Extension 包。SSE 契约按 `tests/fixtures/sse_events.json` 保持逐字节不变，BFF / 前端零改动。
- **执行面从 Python FastAPI 换成 TypeScript `exec/`**：compose 服务名仍叫 `sandbox` / `sandbox-mcp`（同一镜像两个入口），对 BFF 的会话面契约不变。搜索、产物（控制面快照）、数据集（三段式流式）按语义实现，不是占位。
- **`agent/` 源码从 JS 迁到 TypeScript**，DSH 组合层并进 `agent/src/runtime/`。容器跑 `dist/server.js` / `dist/worker.js`。`strict` 仍关着，是已知待办。

### Removed

- **Python `sandbox/` 服务源码**（执行面 + MCP facade）。模型在沙箱里跑代码用的 Python 解释器还在，装在 exec 镜像里（`exec/requirements.txt`）。
- **`/app/pi-agent-home` 与 `AGENT_PI_AGENT_DIR` / `PI_CODING_AGENT_DIR`**：Pi 资源根随引擎一起失效，配置与镜像目录一并删掉。

### Fixed

- **产物列表/下载按 workspace 判定，MCP facade 提交的产物不再消失**：`exec_artifacts.session_id` 取决于是谁写的——内部面的 `submit_artifact` 写 sandbox session id，MCP facade 写 workspace id。公共面用它当列表键与下载门禁，于是总有一半写入方的产物在 UI 上凭空消失。列表与下载改按 `workspace_id`（两个写入方唯一一致的键），BFF 的 `GET /api/artifacts` 与 artifact 下载也先把 sandbox session id 换成 `workspace_id` 再跳 Sandbox，换不出来 503 fail-closed。
- **导入不再凭空创建工作区**：`importToWorkspace` 里那条 `mkdir -p` 会让任何形状合法的 id 把工作区造出来，也掩盖了"路径参数传错"这类 bug。改成工作区根不存在即 404。
- **`ask_user_question` 停泊判定改成结构化**：此前靠在工具结果里搜 `user interaction pending` 这句话来决定要不要写账本终态，任何回显了这串字的失败结果都会被误判，那条工具就永远停在 RUNNING。改成由 executor 在铸 PENDING 的同一刻登记 toolCallId，策略层按 id 询问（`InstallPolicyOptions.isInteractionPending`）。
- **续跑提示词里的用户回答做转义与截断**：原文里的引号/换行会把提示撕成两半，超长回答会在每轮提示里再复制一遍。
- **定时任务历史刷新**：Schedules 页刷新任务列表后同步重拉当前选中任务的 execution history，避免旧的 `QUEUED`/`RUNNING` 投影停留在页面；选中项被别处删掉时详情面板自动关闭。拉列表与拉历史拆成两个 effect——把历史塞进 `refresh` 会让它的身份随选中项变化，于是"选中一条"就整表重拉一遍。
- **`ask_user_question` 选项无法点选（409 CONFLICT）**：停泊时故意抛 `user interaction pending` 防止 DSH 伪造答案，但 `tools/execute` 环绕把它记成 FAILED。人点选项时 CAS 要求工具仍是 RUNNING，于是 409。停泊抛错现在不再关账本。
- **助手气泡有时把 reasoning 当正文**：`message.completed` 把 `reasoning` 块和 `text` 拼在一起；短 CoT 不超过截断阈值时会盖住已流式的中文回复。正文只取 `text` 块，reasoning 仍走 Thought Process。

- **前台 durable 子 Agent 不再被单 Worker 并发自阻塞**：DSH 直接 content block prompt
  现在正确转换为 durable task；Compose/Worker 默认并发提升为 4，父 Run 等待子 Run
  时仍有可用槽位，避免子 Run 永远停在队列中。
- **系统 Skill 在 DSH 中不再误报 unknown**：运行时为每个 Agent 安装本地只读 Skill provider，并在 setup 完成后发布能力；不再让远程 workspace FS 覆盖 Agent 容器内的 `/home/sandbox/skill*` 挂载。
- **MCP 工具在 Docker 部署里对模型不可见**：`MCP_SERVERS_JSON` 原先在 `npm run gen:patch` 时写进提交的 YAML，镜像构建环境是空数组，compose `.env` 里的 Exa 等服务器永远装不进插件树。现在 boot 时按进程环境叠 `dsh-mcp-client`，改配置只需重启 Agent。
- **多轮对话气泡重复上轮文本、刷新后助手回复消失**：DSH 的 `turn/end` 被当成 `message_end`，并且每一轮把整份 session log（含历史）再投影一遍。现在只映射 `assistant/chunk` / `assistant/message`，并且只在直播订阅没推事件时 dump **本轮新增** 的 log。
- **`read /home/sandbox/skill/...` 被拒 path escape**：bash 能 ls 系统 skill，FS 围栏却不认这个逻辑前缀，resolve 还拿可写根做 containment。系统 skill 与已启用包现在是只读根。
- **`submit_artifact` 成功但前端看不到产物**：submit 把 workspaceId 当成 sessionId 落账，UI 按 sandbox_session_id 列表；工具结果又是 DSH `{value}` 包装，账本抽不出 `artifact.ready`。现在带上 sandbox session id、自铸 ULID，并认识 DSH 结果形状。

- **Python exec 迁移后登录全 404**：BFF 仍把 `/api/auth/register|login|me` 转发到已删除的 exec `/auth/*`。认证凭据本来就在 Agent-owned MySQL `auth_credentials`；现在签发、校验、管理员角色收口全部由 Agent `/internal/auth/*` 承担，BFF 继续只管理 HttpOnly Cookie，并删除两侧指向 exec 的死认证客户端。生产缺少或使用弱 `SANDBOX_JWT_SECRET` 时 Agent fail-closed。
- **跨服务 smoke 不再启动已删除的 Python 服务**：CI 脚本从 `uvicorn sandbox.main` 和不存在的 `agent/server.js`/`worker.js` 切到已构建的 exec/Agent `dist` 入口，cross-service job 显式安装并构建 contract、exec、agent。
- Exec 镜像不再用尾部 `|| true` 吞掉 `apt-get install` 失败；隔离原语或模型工具链缺失时构建立即 fail-closed。
- **审批停泊不再留下永久 RUNNING 的并行工具账本**：同一轮其它在飞 ToolExecution 收敛为 `UNKNOWN`，错误码为 `RUN_PARKED_PARALLEL_TOOL_UNKNOWN`。
- **同一 DSH 会话后续 Run 不再发生 journal header 冲突或多根**：runtime 重建保留恢复出的 header，空 checkpoint manifest 接到 journal 的真实 leaf。
- **MySQL 进程/产物/数据集列表不再因 `LIMIT ?` 返回 500**：分页值先做整数上限校验，再作为 SQL 常量插入；用户数据仍使用参数绑定。

- **Skill 入口脚本允许嵌套在 `scripts/` 子目录下**: 守卫要求脚本路径匹配 `/scripts/<单个文件>$`，于是仓库自带的首方包**当场就跑不了**——`xlsx/scripts/office/pack.py`、`skill-creator/scripts/` 之外的 `eval-viewer/generate_review.py` 都被 `SKILL_SCRIPT_COMMAND_DENIED` 拒绝，而这是唯一被放行的执行入口。现在 `scripts/` 下任意深度都接受；同时补上 `..` 拒绝——旧的扁平正则顺带挡住了 `…/scripts/../hidden.py` 这类「读起来像 scripts/」的路径，放开嵌套后必须显式挡。

### Removed

- **删掉从未进入模型的 `PLATFORM_SYSTEM_PROMPT_LAYER` / `composeSystemPrompt`**: 注释写着「平台安全层总会 append、env 关不掉」，运行时却走 `resolveEnterpriseSystemPrompt`，这两个符号只在单测里互相调用。路径边界、审批、artifact 交付、密钥不进回复已经在企业契约和代码护栏里；再接线只会把写死的 `submit_artifact` 清单带回基座。`AGENT_SYSTEM_PROMPT` 仍然只做人设 lead。

### Changed

- **Wave 6 checkJs 收口**: `agent/tsconfig.json` 不再 `exclude` 存活 JS；去掉 44 个 Wave 6 占位 `@ts-nocheck` 横幅，checkJs 仍为 0。布局棘轮收回 W2-D 为 `@ts-expect-error` 抬过的四条预算（`execute-run-service` / `fenced-tool-governance-recorder` / `create-http-server` / `trace-span-repository`），`internal-files-read-http.js` 已低于 1000 行退出 hotspot。
- **Compose 构建上下文改为仓库根**: `agent` / `exec` 镜像需要 `file:../runtime` 与 `file:../contract`，因此 `docker-compose.yml` 的 build context 从包目录改为 `.`，Dockerfile 分别为 `agent/Dockerfile` 与 `exec/Dockerfile`。Agent 增加精确钉 `jiti@2.6.1` 以加载 `pi-mcp-adapter` 的 TypeScript 源。Exec 健康检查改为 Node `fetch`（`node:22-slim` 没有 curl），并去掉已删除的 Python `seccomp-bubblewrap.json`。

- **System prompt 补上 Doing work 工作纪律**: 基座仍是 Pi 风格的短契约，但补了「本轮把请求做完并验证、不擅自缩放范围、进度写在用户可见回复、密钥不进回复、有交付工具就走交付工具」。todo / memory / `ask_user` / `spawn_subagent` / `submit_artifact` / `bash` 的用法加强写在各自 `promptGuidelines` 上，只有绑了这些工具的 run 才看得到——基座故意不点名，避免重复「没启某个 extension 却读到它的工具名」那类漂移。

- **`skill_edit` 一次提交一组文件**: 参数从单个 `path` + `content` 改为 `files: [{path, content}]`（同一个 package，最多 32 个文件；旧形参仍然接受，这样部署前记录的审批仍能重放）。每次 Skill 变更都要花一次审批，而按文件拆分让「改一个 Skill」= N 次横幅——用户点到第三次就变成机械同意，审批疲劳本身就在削弱这道闸门；更糟的是用户可能批准一个只改了一半的 package。批次是全成或全败：先对整批做完校验（路径、包归属、`.git`、体积、`SKILL.md` 名字），再全部写进临时文件，最后统一换入，中途失败会把已换入的文件回滚。
- **拒绝信息和 system prompt 现在都写明可执行形态**: 旧的拒绝理由只说「必须是 python *.py / bash *.sh 且无 shell 操作符」，**完全没提 `scripts/` 这条**，而 system prompt 的 Skills 段只讲了只读和 `ls`/`find` 的差别、一个字没讲怎么执行。模型撞墙后既读不到规则也猜不出缺了什么，只能反复试。两处现在都给出完整形态与被排除的写法（`cd &&`、管道、重定向、`$(...)`、glob、`python -m`、换解释器、`cat`）。

- **千行棘轮扩到 `frontend/src` 与 `api-server/src`**: AGENTS.md §3 的「生产文件 ≤1000 行」对四个服务都成立，但 `tests/test_repository_layout.py` 只扫 `agent/` 与 `sandbox/`，于是前端三个文件在没人发现的情况下越了线（`runReducer.ts` 1492、`ChatContext.tsx` 1456、`InlineRuntimeSteps.tsx` 1011），`api-server` 则完全没被钉住（`agent-client.js` 已 944 行且在长）。两个目录现在都在扫描范围内；越线的四个前端文件按既有做法**钉在当前行数**记为显式债务——只能减不能增，加一行就在加它的那个 PR 里失败。`api-server` 无需任何预算即通过。

- **System prompt 不再自称 pi / coding assistant**: 默认身份改为「风控通用智能体」——一个通用企业智能体，风控/合规/运营是它当前的部署场景而不是能力边界；同时明确「用用户的语言回复」。原先挂在“For risk work:”下面的那条纪律（交代查了什么、没查什么、结论有多确定，并区分观察与推断）改为无条件生效，否则模型对任何它不归类为风控的任务都可以跳过。非空的 AgentVersion / `AGENT_SYSTEM_PROMPT` lead 会**替换**默认身份句而不是叠加，所以两个 lead 槽位都必须写完整人设，不能只写一条补充规则——`.env.example` 已写明。

- **`## Available tools` 那份写死的 13 项闭合清单改为按 run 渲染**: 旧清单和内部 extension 包名一起去掉了，但没有换成一份“if present”的散文清单——那只是保真度更低的同一个错误：没启 `skill-lifecycle` 的 run 照样会读到 `skill_list`，而 `spawn_subagent` 谁都没提。工具的 name/description/parameters 本来就在本轮请求的 tools 数组里，prompt 里再抄一遍必然漂移。现在 `## Tools` 的正文由 `renderToolSurface` 从**本 run 实际绑定的工具**生成，数据源是每个工具定义上早就写好的 `promptSnippet` / `promptGuidelines`（sandbox-bridge、skill-lifecycle、subagent-spawn、user-interaction，以及 `mcp__<server>__<tool>` 包装器都有），由 Pi 按活的 registry 聚合；sandbox-bridge 在 `before_agent_start` 上把它拼进去。**顺带补回了此前完全丢失的 `promptGuidelines`**（仅 sandbox-bridge 的 13 个工具就有 31 条）——那是跨调用的工作流规则（例如 read 的“沿着 nextOffset 读完，不要重复同一页”），放在单个工具的 description 里天然错位，此前因为走 customPrompt 分支而哪儿都没去。没有拼接时 prompt 依然成立：`## Tools` 只说各工具自己的 schema 为准，外加 MCP 命名、审批会等待、缺能力就直说这三条静态跨工具规则。

### Added

- **`ls` 现在可以列 Skill 目录（`find` / `grep` 仍然不行）**: 此前三个搜索工具一律拒绝 Skill 路径，模型只能 `read`——于是一个 Skill 除非在 `SKILL.md` 里自己写明，它随包发的 `reference/`、`scripts/` 就无从发现，渐进披露反而变成了看不见。这从来不是安全边界：只有调用者自己的目录会被绑进来，跨租户在构造上就搜不到。现在按工具区分：`ls` 放行，`find` / `grep` 保持关闭（全树内容检索恰好会把渐进披露想挡住的东西一次性拉进上下文，而模型总可以先 `ls` 再 `read` 那一个文件）。实现没有新开内部面——`ls` 沿用既有 search 面：`InternalSearchCommand` 本来就带着与签名绑定的 `org_id`/`user_id`，`_resolve_search_root` 是唯一的根解析接缝，它返回的 `public_prefix` 本来就负责把物理路径写回逻辑路径。用户层的裸根 `/home/sandbox/skill-user` **解析为调用者自己的 `<org>/<user>` 目录**（`ls` 的意义就是“不知道有什么才来看”，要求先写全自己的 org/user 等于把这次改动的收益退回去）；返回的每一项都带完整逻辑前缀，所以 `ls` 的结果可以直接喂给 `read`。`<root>/<其他租户>` 与只写到 `<root>/<org>` 的裸 org 段都拒绝——后者会枚举该 org 下的用户——并与格式错误的路径共用同一个不透明错误码，避免探测。物理目录由 `user_skill_dir_for()` 唯一决定，与执行时 bwrap 绑定走的是同一个函数。

- **模型可以自己搭一个 Skill 并直接安装**: `skill_install` 新增 `source="sandbox"`——模型用普通 `write` / `bash` 在 workspace 或 `/tmp` 里搭好包、跑通脚本、打成 `.zip` / `.skill`，然后把归档路径交给它。此前只有两条路：把 `SKILL.md` 拆成 `skill_create` 的结构化字段（连 frontmatter 都控制不了），或者打完包让用户下载再上传一遍——bundled `skill-creator` 教的正是后者，所以模型会一路做对最后一步卡住。归档路径先过 `normalizeLogicalPath`（Skill 根显式拒绝：只读挂载不能既是源又是目标），再由 Sandbox 的 `parse_sandbox_path` 二次限定在该 session 的 workspace/temp 内；取字节走已有的 owner-scoped `files/download`，然后与上传路径汇流到**同一个** `installSkillArchive`。Sandbox 侧零改动，特权写入仍然只有那一处。审批语义不变（high risk，一次 tool call），但用户批的是一个已经落盘、可被检视的包。

- **bundled `skill-creator` 改写为本平台的流程**: 原版是上游 Claude Skills 的说明书，教的是“复制到可写位置编辑 → `package_skill.py` 打包 → 让用户去装”，还依赖 `claude` CLI 和 subagent 跑 eval——这里两者都不存在。现在按实际可用的两条路径重写（小包 `skill_create`，其余在沙盒里搭完 `skill_install(source="sandbox")`），写明 Skill 树只读、可 `ls` 可 `read` 但不可 `find`/`grep`、名字/描述的校验口径与各项上限，并点名哪些自带脚本在这里不可用。文中给出的打包命令是实测过的（`PYTHONPATH` 与输出目录两个参数都必需，否则脚本要么 import 失败、要么试图写进只读的 Skill 根）。

- **Capabilities → Skills 区分系统与用户两层**: 此前该页只列内置 Skill——`extensions/diagnostics` 拿的是进程级 skill 根，而用户 Skill 装在 `<base>/<orgId>/<userId>` 下，扫描基目录一个也匹配不到（那一级没有 `SKILL.md`），于是"装没装上"在界面上完全看不出来。请求里其实早就带着身份（BFF 发 `X-Acting-*`，Agent 路由也已解出），只是投影时被丢掉了。现在 diagnostics 用**与 Run 相同的解析器**（`resolveSkillScopeForIdentity`）取该调用者的 skill 根，每项按 `source` 标 `shared-skill-root` / `user-skill-root`，前端分成 "My Skills" 与 "System Skills" 两栏。无身份的请求仍只投影系统层——用户层基目录不整根扫描，否则会列出其他租户已安装的 Skill。

- **read 工具支持图片（模型可以直接看工作区里的图）**: `read` 命中图片时返回 Pi `ImageContent` 而不是 `{binary:true}` 空壳——对齐 Pi 原生 read 的做法（Pi 没有独立 vision 工具，图片能力就做在 read 里）。此前一轮 Run 渲染出来的图表、截图、PDF 转页对模型完全不可见，唯一出路是 OCR。Sandbox 侧按**内容**嗅探类型（`image_sniff.py`，png/jpeg/gif/webp/bmp；工作区路径是模型自己写的，扩展名不作数），在 2MiB 预算内随响应回传 base64；超预算返回 `imageOmitted: IMAGE_TOO_LARGE` 并告诉模型先降采样再读，而不是静默给空。Agent 侧复用 SDK 导出的 `convertToPng` / `resizeImage` / `formatDimensionNote` 归一化并压到 Pi 的内联预算，且对到达的字段独立复核（base64 形状、类型白名单、解码后长度）——Sandbox 是跨网络的另一个服务，不能只凭它说了算。

- **Ctrl+V 粘贴图片为附件（前端）**: 输入框支持从剪贴板粘贴图片/文件。剪贴板图片没有文件名，按嗅探到的 MIME 命名为 `pasted-image-<时间戳>-<序号>.<ext>`——附件白名单按扩展名判定，不改名会被当作禁止类型拒收。与上传按钮、Ctrl+U 共用同一道「Run 运行中不可附加」门禁；剪贴板只有文本时不拦截事件，正常落进输入框。

- **Sandbox MCP bash 执行工具**: `sandbox-mcp` 新增 `sandbox_shell_execute`，在与 `sandbox_python_execute` 相同的 Bubblewrap 隔离工作区里执行 bash 命令（`execution_manager.run_command` 既有路径：网络黑名单预检 + `--unshare-net`、非 root、ulimit/seccomp 全套生效）。安全增量接近零——Python 本就能等价 spawn shell。命令长度上限 `SANDBOX_MCP_MAX_COMMAND_LENGTH`（默认 20000，Sandbox 桥侧同名上限 200000）；返回字段与 python 工具对齐（status/exit_code/stdout_preview/stderr_preview/duration_ms/truncated）。`sandbox/config.py` 热点预算 1488→1491（新增一个配置项的三行）。

- **消息气泡操作与滚动体验（前端）**: 助手气泡 hover 后出现 Copy（复制全文纯文本）与 Regenerate（仅最后一条助手气泡、且无活跃 Run 时显示，取前一条用户回合文本重发为新 Run——语义是追加一轮而非原地改写）；距底部超过 120px 时右下角出现「回到最新」浮标（sticky 定位，smooth 滚动）。流式渲染性能：`MessageBubble` 改为 `React.memo` + 内容指纹比较（投影层每个 SSE tick 都重建气泡对象，身份比较永远失效；气泡内不再订阅 chat context，否则 memo 被穿透），流式中的气泡照常更新，已完成气泡不再随每个 token 重新解析 markdown。

- **子 Run 不再注册 `ask_user`**: 子 Run 的对话被刻意排除在会话列表外，任务提示按契约自包含，也没有任何路径把子 Run 的提问送到发起父 Run 的人面前——注册这个工具只会让它停在 WAITING_INPUT 等一个没人看得见的问题。现在直接不注册，模型自行决定或失败，而不是挂死。extension 本身仍然装载（registry 对 AgentVersion 的 extension 列表是精确校验）。
- **停泊 Run 的取消回收对齐**: `run-recovery-service` 处理 WAITING_APPROVAL 的 cancel intent 已久，但 WAITING_INPUT 分支从不检查它——interaction 还是 PENDING 就直接跳过。带 cancel intent 的停泊 Run 因此可能永远卡住。两条分支现在共用一条路径（`run-recovery-parked-cancel.js`），WAITING_INPUT 的就地了结逻辑也从 `CancelRunService` 抽到 `parked-interaction-cancel.js`，与既有的 `parked-approval-cancel.js` 对称，由直接取消与恢复共用。
- **子 Run 级联取消**: 取消父 Run 会为其所有存活后代写入持久 cancel intent（沿 `parent_run_id` 深度有界遍历）并发出 Redis 取消信号（子 Run id 列表随取消响应返回）。这里只写 intent：`execute-run-service` 在进入 runtime 前及每步前后都会检查它（先读 MySQL，Redis 仅为加速），所以排队中的子 Run 在被捡起时就地终止、运行中的子 Run 走它自己那条已有的取消路径——无需为每个子 Run 复刻 WAITING_INPUT/WAITING_APPROVAL 的停泊终结逻辑。已终态的父 Run 同样会回收其存活子 Run（父 Run 失败后子 Run 仍在烧预算）。子 Run 自己更早的取消原因不会被父级覆盖（first-writer-wins）。`spawn_subagent` 现在拒绝在已终态或已请求取消的父 Run 下创建新子 Run——父行的 `FOR UPDATE` 让取消与创建串行，两种先后顺序都安全。
- **子 Conversation 不再进入会话列表**: `conversations.parent_run_id`（migration `20260822000003`）标记子 Run 自己的 Conversation，`listForOwner` 默认过滤掉它们（`includeSubagent: true` 可取回）。`getById` 不过滤——子任务的 transcript 仍可按 id 读取，这正是当初否掉"创建即 archive"方案的理由。
- **子 Run（sub-agent）**: 新增可选 extension `subagent-spawn`，注册 `spawn_subagent` / `check_subagent`。子 Run 是普通 Run——同一张 `runs` 表、同一个 `agent-runs` 队列、同一套 worker 与恢复路径，只多了 `source='subagent'` / `parent_run_id` / `subagent_depth` 血缘（migration `20260822000001`）。每个子 Run 有自己的 Conversation 与 AgentSession（父 Run 整个生命周期持有其执行 fence，共用会话必然死锁），继承父 Run 的 AgentVersion、`trace_id` 与父 span。`toolCallId` 作幂等键保证一次 tool call 只产生一个子 Run；深度与并发上限在父行加锁后于事务内复查，可用 `AGENT_SUBAGENT_MAX_DEPTH` / `AGENT_SUBAGENT_MAX_CONCURRENT` 或 AgentVersion `configJson.subagent` 收紧。
- **持久任务状态**: 新增可选 extension `task-state`，注册 `todo_write` / `todo_read`（按 AgentSession 整体替换的计划清单）与 `memory_write` / `memory_search`（owner 级、跨对话的追加式备忘）。两张表 `task_todos` / `task_memories`（migration `20260822000002`）全程 org+user 作用域。
- **Provider 并发闸门与 429 冷却**: 每个 Agent 进程一个闸门（不是每个 Run 一个——那样只会限制本已串行的单个 prompt 循环），在 `before_provider_request` 取号、`after_provider_response` 归还；等待有界，超时后降级直通并交回**空操作**的 release，所以降级调用方不会释放别人的名额。连续 429 按 key 指数延长冷却窗口，非 429 响应立即清除。`AGENT_PROVIDER_MAX_CONCURRENT` / `AGENT_PROVIDER_COOLDOWN_MS` 可调。
- **OTel 工具 span**: 配置了 OTLP endpoint 时，每次工具执行产生一个 CLIENT span（`agent.tool.<name>`），挂在当前 Run span 下；失败只记录结果的稳定 code，绝不把工具输出带进链路。Run 中断遗留的 span 与 provider 名额都在 `session_shutdown` 收口。
- **A2A v0.3 对齐**: Agent Card 发布 skills；streaming status 事件符合 SDK schema；发出官方 task-lifecycle 流。
- **用户 Skill 生命周期**: 新增可选第一方 extension `skill-lifecycle`，支持上传安装、Agent 生成、编辑与卸载，全部限制在 per-user Skill 根内并走审批。Sandbox 执行侧的 read/bind 认可用户 Skill 路径。
- **模型能力**: 模型选择、视觉输入与 thinking UI；MCP 发现到的 schema 投射给模型。
- **工作区搜索工具**: 新增 `ls` / `find` / `grep` 三个 sandbox-bridge 工具，走 `/internal/v1/files/{ls,find,grep}` HMAC 内部平面。此前 SDK 同名工具因会读 Agent 容器文件系统而被永久排除，却没有替代品——模型只能用 `bash` 探索工作区（串行、无结构、无预算）。三者只读、可与 `read` 并行、有默认与上限预算，并把截断和跳过的目录如实报给模型。`SANDBOX_TOOL_NAMES` 由 10 增至 13。
- **Run 收敛保护**: 为每个 Pi Run 增加模型回合、总工具调用和相同工具/参数调用上限；达到上限后禁止继续调用工具，并要求模型依据已有结果作答。三个上限均可通过 `AGENT_RUN_MAX_*` 配置。
- **MCP 启动发现**: Agent 启动时连接每个启用的 MCP Server 并执行 `tools/list`；发现到的工具以 `mcp__{serverId}__{toolName}` 注册，对应的连接与工具数量会出现在 readiness/diagnostics。

### Security

- **`skill_install(source="sandbox")` 的审批现在绑定字节，而不只是路径**: 该分支的参数只有 `{ source, path }`，没有任何摘要；`archive_sha256` 是**批准之后**下载时才算的，只写进审计日志。而 `skill_install` 是 high risk——参数先入账本、用户批准后**重放**执行——这期间 workspace 一直可写。于是模型可以先递一个人畜无害的归档、等批准、覆写该路径、让重放去装另一份。现在 `source="sandbox"` **必须**带 `source_digest`（64 位小写十六进制 sha256）：下载完成后按字节重算，不等就拒绝安装，错误里同时给出两个摘要并写明什么都没装。模型自己算摘要不削弱这一点——想装别的包它本来就可以直接提议，那正是审批要挡的；digest 挡住的是**批准之后掉包**。Attachment 分支不受影响：它由用户本回合上传的 attachment id 锚定，Sandbox 给了 `x-dataset-sha256` 时还会再校一次。校验在工具与 SkillManager 两处各做一遍——manager 是独立的 API 面，“没有 digest 的沙盒安装”在哪一面都不该存在。

### Fixed

- **A2A 官方流式调用现在会收到终态事件**: `message/stream` 与 `tasks/resubscribe` 在 `submitted` / `working` 之后就断流——没有 `status-update(final=true)`，也没有 Agent 最终正文；而 `tasks/get` 同时报 `completed` 并能读到完整回复。只依赖流式事件的官方客户端因此永远等不到终态，只能额外轮询 `tasks/get`。根因不在 SSE 传输层，而在事件词表对不上：A2A 投影器的 `RUN_STATUS_EVENT_TYPES` 列的是 `run.succeeded` / `run.status` / `run.terminal`，**这三个名字全仓没有任何一处发出过**；Run 服务实际写进账本的是 `plan.md` §事件词表里那一套——`applyRunTransitionInTxn` 默认 `run.status.changed`，成功终态是 `run.completed`。于是终态事件在投影时被整条丢掉，流跑到 Run 终态后静默返回。现有单测没能挡住，因为它们自己也用 `run.succeeded` 造数据。修复三处：投影器认下真实词表（`run.status.changed` / `run.completed`）；`run.status.changed` 这类**名字不含目标状态**的事件只认账本 payload 里的 `status`，绝不回落到「当前 Run 行状态」——那是分页时读到的，可能已经终态，会投出过早的 `final: true`；治理面写的 `{ context, data }` 形状 payload 也纳入状态提取。**同一根因还吞掉了 Agent 的最终正文**：`message.completed` 由 observability 投影器写成 `{ context, data }` 形状，`role` / `message` / `messageId` 都在 `data` 下面一层，而投影只看 `event.*` 与 `event.payload.*`——于是**没有任何一条 message.completed 投影得出来**，官方客户端从流里拿不到回复文本。这一条是重建容器后拿真实 Run 的事件日志回放才暴露的（单测 fixture 恰好用的是扁平形状）。现在两种形状都读，`user` / `toolResult` 回合仍然不投影为 agent 消息。另外，流在 Run 终态收尾时如果一个 `final: true` 帧都没发过，现在会按权威 Run 状态补发一帧终态 `status-update`（A2A 0.3 §3.1.2 要求任务生命周期流以 final 帧收尾），并且只有在事件页确实排空后才相信「Run 行已终态」这个信号——一整页事件可能还压着后续的终态事件。回归测试 `agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js` 用真实词表复现，并加了一条棘轮：`src/application` 里任何 `eventType: 'run.*'` 字面量若不在投影器词表内即失败。

- **Sandbox 出站调用全部有超时了**: AGENTS.md §2 要求「所有出站调用有超时」，但两侧 Sandbox 公共面客户端都漏了。Agent 侧 `sandbox-client.js` 的 `sbFetch` 默认 `timeoutMs = null`，公开面**没有一个方法**传超时——会话删除时的工作区 GC（`conversation-service`）、当时仍在 Agent 的运维进程面（现已迁到 BFF→exec）、文件与 artifact 读取，全都能被一个挂起的 Sandbox 无限期钉住；`checkHealth()` 连 AbortSignal 都没有。BFF 侧同样：`routes/files.js` 三处字节代理（文件下载、artifact 下载、上传）与 `routes/datasets.js` 两处（上传、列表）都是裸 `fetch`，而同仓 `agent-client.js` 早有 `AbortSignal.timeout` 先例，config 注释也只豁免 SSE 流。现在两侧都有默认 deadline：控制面 30s（BFF 用既有的 `SANDBOX_REQUEST_TIMEOUT_MS`），字节流只约束「到响应头」这一段，拿到 header 后清掉定时器，大文件不会被拦腰截断；上传因为要先把 body 送上去，单独给一个宽松但有界的 10 分钟上限。BFF 超时映射为 504 `SANDBOX_TIMEOUT`，浏览器自己断开仍走调用方原本的错误，不会被误报成 Sandbox 超时。未新增环境变量。

- **流式 Run 不再被 trace 投影的乐观锁判失败**: 带 thinking/message delta 的长回答（数百到数千条事件）在工具和模型都成功后仍可能 `FAILED: trace span optimistic upsert did not converge`。根因是 append 事务在 InnoDB REPEATABLE READ 下用非锁定 `SELECT` 读 Run 根 span，再对 `attributes_json` + `updated_at` 做 CAS；`GET /runs/{id}/trace` 的 `materializeRunFacts` 不持有 `runs` 行锁，提交更新后 append 的 16 次重试仍读到同一份快照，几毫秒内耗尽。表现就是 8 月 23 日真实用户场景和 Run `01M0YZ6C0HZAQX1GGZ8CHAA9K5`：工具完成、回答写完，终态却是失败。事务内改为 `SELECT … FOR UPDATE`（锁定读看到最新行并串行化该 span 的写者）。投影 CAS 若仍 livelock，append **提交事件、不回滚**——事件是账本，trace 可由 `GET /trace` 重建；其它投影错误仍然随事务失败。

- **标题式 artifact 名不再丢后缀**: 上一条修好了「名字怎么送到浏览器」，但 `submit_artifact` 的 `name` 是模型给的**标题**——`随机 Markdown 文档` 本身就没有扩展名，后缀只活在 `relative_path`（`random-markdown.md`）里，于是三层都忠实地把一个没后缀的名字保留了下来，Markdown 存下来仍然打不开。顺带一提，注册时 `mimetypes.guess_type(display)` 同样猜不出类型，这条 artifact 的 `mime_type` 被记成 `application/octet-stream`。现在名字没有扩展名时从 stored path 借一个（`with_path_extension()`），public / internal / MCP 三个下载出口都传入 path；注册时的 mime 在 display 猜不出时回落到 `stored_path`。前端 `downloadAttrName(name, path)` 同样要改——`download` 属性一旦有值就**完全覆盖** `Content-Disposition`，只修服务端在走链接下载时看不到效果。名字自带的扩展名优先，两边都没有则保持原样。

- **`submit_artifact` 下载下来带原文件名和后缀**: 交付物点下载，保存成没有扩展名的 `artifact-download`，中文名（如 `季度报告.pptx`）尤其明显。两处叠在一起：前端所有下载链接写了空的 `download=""`，Chrome 因此忽略 `Content-Disposition`，改用 URL 最后一段 `/api/files/artifact-download`；BFF 在沙箱没带 disposition 时又退回 `filename="<artifactId>"`（ULID，同样没后缀），ASCII `filename=` 兜底也不保留 `.pptx` / `.md`。现在链接带真实 basename；`filename=` 对纯 CJK 名是 `download.pptx`（后缀还在），完整原名走 `filename*` 与 `X-Artifact-Filename`；BFF 转发沙箱 header，不再用 ULID 顶替。

- **模型选择按对话记住，不再全局串台**: Composer 的模型选择器是一份 `pi.selectedModelId`，切到另一个会话 picker 还停在上一个会话的模型，发出去的 `model_id` 也是那一个。现在按 `conversationId` 分槽（未保存的新对话单独一份 draft）；切会话时恢复该对话上次的选择，没有手动选过则用该对话最近一次 run 的 `model_id`。旧的全局 key 只迁到新对话 draft，不会覆盖已有会话。

- **`write` / `edit` 接受中文（及任何 Unicode）文件名**: `write` 到 `workspace/专项汇报.md` 返回 `FILES_WRITE_PAYLOAD_INVALID: path must be bounded visible ASCII`，`fetchCalls: 0`——请求根本没离开 Agent。根因在 Agent→Sandbox 的 HTTP transport：`normalizePath()` 复用了给协议标识符准备的 `requireVisibleAscii()`（`[\x21-\x7e]`），于是中日韩文件名、连带空格一起被拒。Sandbox 侧的 `_path()` 契约、request hash、Python 写入器、文件系统全都本来就接受 Unicode——只有这一层不接受。路径改为**按结构 + 字符黑名单**校验：仍然拒绝 NUL/控制字符、C1、零宽与 bidi 覆盖字符（`U+200B–200F`/`U+202A–202E`/`U+2066–2069`/`U+FEFF`，文件名伪装）、孤立代理对、反斜杠、`//`、`.`/`..`、workspace 前缀之外的路径，以及首尾带空白的路径段；长度同时按码元与 UTF-8 字节双向封顶 512（对齐 Sandbox 契约）。`toolCallId` / `expectedVersion` 继续走 ASCII——它们是协议标识符，不是用户数据。

- **长参数的工具在审批放行后不再让整个 Run FAILED**: 带审批的工具调用只要有任一参数字符串超过 512 字符，审批通过后的重放就抛 `tool_call_id replay conflicts with existing args integrity`，Run 直接 FAILED。根因不在完整性校验本身，而在**重放读错了地方**：ToolExecution 账本存的是完整性信封，`$integrity` 承诺的是**原始** args，`$payload` 却是 `redactPayload()` 脱敏后的视图——超过 `DEFAULT_MAX_STRING`（512）的字符串会被截断并补上 `_bytes`/`_sha256`/`_truncated` 兄弟字段。`resumeApprovedToolCall` 拿 `argumentsJson`（即 `$payload`）去重放，指纹自然对不上；更糟的是——**即使指纹对得上，被批准的工具也会用截断后的参数执行**（一个 600 字符的 `write` 会写出被截断的文件）。现在重放的权威来源是 Pi 会话里那条发出调用的 assistant 消息（`findToolCallArgumentsInSession`）；只有当账本视图的指纹可证明等于 `$integrity`（即短参数、脱敏无损）时才回退到账本；两者都不可用时以 `APPROVED_TOOL_ARGS_UNRECOVERABLE` 明确失败，而不是拿脱敏视图去执行。另外 `packJsonWithIntegrity` 超限时改抛稳定的 `ARGUMENT_TOO_LARGE`，让"存不下"与"脱敏截断导致的重放冲突"在日志里可区分。

- **官方 A2A 客户端可以建立流式连接**: 官方 a2a-python / a2a-js 客户端能取到 Agent Card 与 skill 列表，但 `message/stream` 报 `Expected response header Content-Type to contain 'text/event-stream', got 'application/json'`。根因是内容协商过严：`assertSendConfiguration()` 把**空的** `acceptedOutputModes` 判成 `CONTENT_TYPE_NOT_SUPPORTED`，而 a2a-python 的 `ClientConfig.accepted_output_modes` 默认就是空列表，且 `ClientFactory` 总会附上 `MessageSendConfiguration`；流式方法上的 JSON-RPC 错误以 `application/json` 返回，客户端便报成 SSE 协议错误。空列表现在按"无偏好"处理；同时接受 A2A 规范样例与 SDK 常用的短别名 `text` 与 `*/*`、`text/*` 通配。真正不支持的集合（如只要 `image/png`）与 push notification 配置仍然拒绝。仓库自带的 `StandardA2aClient` 模拟器此前从不发送 `configuration`，所以 110 条 A2A 用例全绿却漏掉了真实线格式——模拟器已改为按官方客户端的形状发送。

- **Run 进行中刷新不再丢失 assistant 正文**: Run 还在跑时刷新页面，气泡只剩 `Agent Execution Steps`，正文消失，且 Run 结束后也不会自己回来——要等用户再发一条消息，旧回答才重新出现并重新排序。根因在 `rehydrateConversation()`：Run 状态为 running/pending/queued 时**跳过**持久事件回放，完全依赖 SSE 重连；而工具账本无论如何都会回放，于是"有步骤、没回答"。刷新期间 Run 恰好结束（或 SSE 没及时恢复）时，重连已无增量可送，正文就永久缺席。现在**总是先回放 durable events，再连 SSE 取增量**——reducer 按 event id 去重，重复投递是安全的；`runtime_available === false` 分支里那次补偿性回放随之删除（不再需要，也避免二次回放）。

- **Skill 目录的 `ls`/`find`/`grep` 给出可操作的错误**: Agent 侧路径规范化放行 Skill 只读路径并把请求转给 Sandbox，但 Sandbox 的 `parse_sandbox_path()` 只认 workspace 与 `/tmp`，于是模型拿到的是 `PATH_INVALID` / "search request failed" 这种不知所云的结果。三层口径就此统一：注定被拒的请求不再发给 Sandbox，`ls`/`find`/`grep` 在 Agent 层就返回 `PATH_SKILL_SEARCH_UNSUPPORTED` 并点名该用哪个工具；`bash` 的既有拒绝理由也补上了同一句指引。企业系统提示此前写着「没有 skills 段时用 `ls` 看 `${skillRoot}`」——那正是第四层不一致。（本条最初把三层统一在“Skill 目录一律不可搜索”上；同一未发布区间内 `ls` 已被放开，最终口径见上面 Added 中的 `ls` 一条。）

- **图片分析不再让 Run FAILED（`Out of sort memory`）**: 上传图片做分析时 Run 失败，前端弹出 `select * from messages where agent_session_id = … order by sequence_no asc limit 500 - Out of sort memory…`。根因是 Pi journal 读取会 filesort：优化器为这条查询选了 `idx_messages_session_pi_kind (agent_session_id, pi_entry_kind, sequence_no)`，而查询过滤的是 `message_type`、从不约束中间那列 `pi_entry_kind`，索引因此给不出 `sequence_no` 顺序 → MySQL 退化成对整行（含 `content_json`）排序。平时无害（journal 行 1–3KB），但 `read` 内联图片上限是 `MAX_READ_IMAGE_BYTES = 2MiB`，base64 后单条 entry ≈ 2.7MB，一条就超过默认 256KB 的 `sort_buffer_size`，直接 ER_OUT_OF_SORTMEMORY。触发面很宽：`recover()` 在**每次 Run 启动**都读一遍，`persist()` 更是在写入那条图片 entry 之后**立刻回读**——失败即回滚，所以事后查库根本看不到那条大行（这一点很容易把排查带偏）。改为 `FORCE INDEX (idx_messages_session)`：`(agent_session_id, sequence_no)` 天生按 `sequence_no` 有序，排序整个消失，`LIMIT` 也能提前停止。同一份真实数据 A/B：旧查询 `ERROR 1038`，新查询正常返回 22 行；真机重跑此前失败的那轮图片分析，SUCCEEDED，且 journal 里确实留下了一条 2.015MB 的 entry。

- **依赖 `~/.config` 的应用可以在 Session 内保留配置**: Bubblewrap 的根是**每次执行新建的 tmpfs**，而持久绑定只有 workspace 与 `/tmp`，所以 `$HOME` 可写但每次工具调用都被重建为空——LibreOffice 之类的应用每次重建用户 profile，写进 `~/.config/libreoffice/4/user/basic/Standard/Module1.xba` 的宏在下一次调用中消失（已用真实 bwrap 复现：第一次写入、第二次读回得到 `GONE`）。现在 `~/.config`、`~/.cache`、`~/.local/share` 显式绑定到 `<session tmp>/.home/` 下的对应目录，并同步设置 `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME`。放在 Session 自己的持久 `/tmp` 树里是刻意的：保留策略、配额与清理全部沿用 `/tmp` 既有的那一套（随 Session 私有、随 Session 清理），不新增第四个存储根，也天然不跨租户共享。用真实 bwrap 验证：同一 Session 两次独立执行之间配置 `PERSISTED`，workspace 与 `/tmp` 行为不变。

- **上传 Skill 后 bash / python 全部失效（P1）**: 通过前端按钮上传 `skill.zip` 后，同一会话里 `bash`、`python` 连 `pwd` 都失败，报 `bwrap: Can't find source path /home/sandbox/skill-user/<org>/<user>`；只有 `read`/`write`/`ls`/`find`/`grep` 还能用（它们不经过 bwrap）。根因是 **Node 的 `fs.mkdir` 会把 `mode` 施加到递归创建的每一级目录**：安装流程第一步是 `mkdir('<base>/<org>/<user>/.tmp-install-<token>', { recursive: true, mode: 0o700 })`，首次为某用户安装时 `<org>` 与 `<user>` 尚不存在，于是这两级也被打成 `0700`、属主是 Agent 的 `node`(uid 1000)。而这两级正是 Bubblewrap 用户 Skill 层的 **bind source**，Sandbox 以 uid 10001 解析它 → `realpath()` 返回 **EACCES**；`--ro-bind-try` 只宽容 `ENOENT`，不宽容 `EACCES`，于是 bwrap 直接死掉，把该用户的每一次沙盒启动一起带走，且**持续到目录权限被修复为止**。现在安装与生成两条路径都先 `ensureTraversableUserSkillRoot()` 建好 `0755` 的身份目录再建私有 staging，并顺带修复已被打坏的目录（用户下一次安装即自愈）。`0755` 不是放松：这条路径上其它目录本来就是 `0755`，租户隔离靠的是"只把调用者自己的 `<org>/<user>` bind 进命名空间"，从来不是这两位权限位。

- **一个用户的 Skill 根坏掉不再连累 bash/python**: 承上，Sandbox 侧加了纵深防御——bind 之前先 `stat()` 探测 user skill 源，`ENOENT`（没装过）与其它 `OSError`（不可遍历）都降级为"只挂系统层"并记一条 warning，而不是把一个注定失败的路径交给 bwrap。丢掉一个用户的 Skill 永远不应该等于丢掉他的全部工具。

- **缺失的系统 Skill 根不再表现为「bash 坏了」**: 系统 Skill 层是硬 `--ro-bind`（有意为之：缺失即部署故障，应当大声失败），但 `skills_root.resolve()` 不做存在性检查，缺失时要等 bwrap 启动才报 `bwrap: can't find source path …`——表现是 `pwd`、`bash`、`python` 一起失败、Run FAILED，完全看不出是挂载问题。改为启动前检查并抛出点名路径与 `SKILLS_ROOT` 挂载的错误。用户 Skill 层本就是 `--ro-bind-try`（没装过 Skill 是正常状态），保持不变。

### Removed

- **两侧死代码清理（2026-08-26 专项审查落地）**: 都经过全仓 grep 逐条确认后才删，运行路径为零。Agent：`sandbox-client.js` 余下 16 个模块级封装（`authRegister`/`authLogin`/`authMe`/`readFile`/`writeFile`/`listFiles`/`lsFiles`/`findFiles`/`grepFiles`/`downloadFileStream`/`downloadArtifactStream`/`submitArtifact`/`listArtifacts`/`removeSessionWorkspace`/`artifactDownloadPath`/`ensureTraceId`）——全仓唯一的静态 import 只取 `createSandboxClient`，`checkHealth` 是唯一还有调用方的模块级导出（`http-main.js` 动态 import 作 `/health` 探针），其余指向已退役路由，`ensureTraceId` 更是引用了本文件根本没 import 的 `randomUUID`（调用即 `ReferenceError`）；`skills/install.js` 的 `_testHelpers`（连测试都不用）。Frontend：`api/client.ts` 的 `createConversation`（零调用）与两条转出口 `readSSEStream` / `isAllowedApiUrl,safeApiUrl`（生产与测试一律直接从 `sse/parser`、`security/url` 导入）、`entities/store.ts` 的 `getRun` 选择器（外部一律用 `api/runs.ts` 的同名函数）、`Composer.tsx` 末尾那条「for tests」的转出口（测试实际从 `shared/state` 导入）；`schemas/api.ts` 的转出口桶只留下生产真正经它导入的 `ConversationEventsResponseSchema` 及其类型。Sandbox：14 处未用 import，以及 `safe_env.py` 的 `sanitize_for_log`——它只把「password」「token」这类**键名**替换成 `***`，对真实值不做任何事，唯一的引用是 `audit_logger.py` 一条同样没用上的 import，留着比删掉更危险。`artifact/infrastructure/manager.py` 的四个 disposition 名与 `formal_artifact_runtime.py` 的 `workspace_manager` 看着也像未用 import，但前者经 `services/artifact_manager.py` 星号垫片被测试消费、后者被测试按字符串路径 monkeypatch，两处都补了注释说明为何保留。
- **`config/agent/settings.json`**: 与已删的 `models.json` 同类的遗留文件。pi SDK 确实会自动发现 `settings.json`，但它找的是 agent home（`AGENT_PI_AGENT_DIR`，容器里是 `/app/pi-agent-home`），而 `config/agent` 挂在 `/app/config/agent`——那个目录里只有 `TOOL_RISK_POLICY_PATH` 指向的 `tool-risk.json` 和 `model-registry.json` 被真正读取。文件里声明的扩展名 `enterprise-sandbox` 在 agent 扩展注册表里也不存在。
- **Agent `sandbox-client.js`里指向已下线路由的死方法**: 该 client 是 owner-scoped 公共面封装（模型自己的工具调用不走这里，走签名内部面 `sandbox-bridge-http-transport.js`）。Sandbox 早已撤掉自己的 session 创建、conversation、临时执行与审批面，但对应方法一直留着——调用即 404：`createSession` / `getSession`（`POST /sessions`、`GET /sessions/{id}`）、整个 `/conversations/*` 六个方法、`executeCommand`（`/sessions/{id}/executions/command`）、`getExecutionLogs` / `listExecutionEvents`、以及 `createApproval` / `approvalCheck` / `getApproval` / `decideApproval`（`/approvals`、`/approve`）。更糟的是一批模块级封装：`startProcess` / `getProcess` / `waitProcess` / `cancelExecution` / `cancelActiveExecution` / `cancelSessionProcesses` / `readFileWithRange` 委托的 client 方法**根本不存在**（`TypeError`），而 `getProcessLogs` / `writeProcessStdin` / `signalProcess` / `cancelProcess` 四个模块级封装**参数错位**——把 `processId` 当成 `sessionId` 传进去。全部删除，共 -223 行；随之删掉只为 `executeCommand` 存在的 `timeoutForSeconds` / `REQUEST_GRACE_MS` 及其单测。留下的每个方法都对得上 `/openapi.json` 里仍在服务的路由，文件头补上了这条规则。`api-server` 那份同名 client 已经是干净的，未改动。
- **`config/agent/models.json`**: 与 `model-registry.json` 重复的第二份模型目录，全仓库零引用——不被任何代码读取，也不在 pi SDK 查找 `models.json` 的 `AGENT_PI_AGENT_DIR` 下（容器里 `/app/pi-agent-home/` 是空的）。留着只会继续和真实目录漂移。
- **`disabled-test-model` 与 `ZERO_PRICING`**: 前者是只为测试存在却出货在生产 seed 里的假模型，已移进测试自己的 fixture；后者随之失去全部引用（`normalizeModelEntry` 本就把各价格字段内联默认为 0）。

### Changed

- **模型目录对齐真实网关**: registry 此前列的 `gpt-5.5` / `mimo-v2.5` / `mimo-v2.5-pro` / `gemini-3.5-flash` 在实际 LLMIO 网关上都不存在——选中即失败（`mimo-v2.5` 报 "supported API model names are…"，`gpt-5.5` 更早地因 `supports_developer_role: true` 报 `unknown variant 'developer'`）。现在只保留网关真正提供的三个：`deepseek-v4-flash`（默认）、`deepseek-v4-pro`、新增的 `deepseek-v4-flash-vision-exp`（唯一支持图片输入的 id，这也是上面 read 图片能力在本部署里唯一可用的模型）。

  两处都要改才生效：`buildRegistry` 是「源码 seed + 文件」合并，文件只增不减，所以只清 `config/agent/model-registry.json` 会让删掉的模型继续从 `SEED_MODELS` 暴露出来。

- **模型注册表测试改用自带 fixture**: 「registry 是数据驱动而非硬编码」这类机制测试原本依赖 `SEED_MODELS` 里恰好存在的 gemini/gpt 作对照，导致改动出货目录就会打断无关测试。现在用测试文件内的 `FIXTURE_MODELS`，出货目录另有一条断言单独覆盖。

- **一轮 Run 合并为一个助手气泡（前端）**: 同一 Run 的相邻 assistant 行在投影末尾合并成一条消息。此前「出文本 → 调工具 → 再出文本」的一轮会摊成一叠各自带头像和「UPRC Agent」抬头的碎片，读起来像好几个人在说话。身份字段取首行（React key 与回合起始时间稳定），存活状态取末行。步骤树随之挂到该 Run 的**第一个**气泡并渲染在正文之前，**默认折叠**——它在回合顶端，展开会把回答本身顶到屏幕外；折叠态摘要行仍显示步骤数与耗时。

- **`task-state` 默认装载**: `defaultAgentConfigJson()` 发的是 `extensions: []`，而空列表只选必需的四个 + `skill-lifecycle`，所以 `todo_write` / `todo_read` 从来没有真正到过模型手上——表现就是「Agent 不会拆解多步任务」，每一轮都从 transcript 重新推导计划，compaction 之后彻底丢失。现在与 `skill-lifecycle` 同规则：store 就绪且 AgentVersion 未显式列出 extensions 时自动装载。显式列表仍然权威（`pi-runtime-factory` 精确校验 factory 列表，静默追加会把合法 AgentVersion 变成 `PI_EXTENSIONS_COUNT` 错误），因此显式列表也是关闭它的方式。

- **纯文本模型收到图片不再让 Run 失败**: 此前给不支持 vision 的模型附图会直接 `FAILED: does not support image input`，把用户打的字连同图片一起丢掉。现在丢弃图片并在 prompt 里告知模型（文件名、原因、附件仍可当文件读），对齐 Pi 原生 read 对非 vision 模型的降级提示。`read` 读到的图片同理：不支持 vision 时只回文本注记，绝不把图片字节送给收不下的 provider。

- **代码与文档整理**: 删除未接入的 TypeScript contracts 包、历史 approval waiter 与 Sandbox 中未使用的 Agent/审批 DTO；跨语言 golden fixture 统一到 `tests/fixtures/contracts/`，开发与 SDK 升级文档按当前 `src/` 布局和持久化模型修订。
- **Run 与对话投影**: Run 列表/详情补充模型、token usage、规范化生命周期时间及最新 durable event ID；对话历史保留 durable message ID、Run ID 与顺序，且只显示当前用户回合而非整个历史 prompt。
- **运行管理界面**: 按 Agent 的权威状态过滤 Run，支持 `WAITING_INPUT`，并兼容 `completed_at` 与历史 `finished_at` 字段。
- **Artifact 下载**: 对非 ASCII 文件名使用 RFC 5987 `filename*`，同时提供 ASCII fallback，避免下载响应因 HTTP header 编码失败。
- **必需 Extension 增至四个**: `user-interaction` 从 `enterprise-policy` 拆出并成为必需，`ask_user` 由它注册；`enterprise-policy` 回归纯拦截器，不再注册任何工具。仅给出旧的三个名字仍可用，隐含启用 `user-interaction`。
- **Sandbox 公共执行路由删除**: `POST /sessions/{id}/executions/*` 及 Sandbox 侧的 `/approvals`、`/conversations` 全部移除。执行只存在于 `/internal/v1/*` HMAC 平面；审批与 Conversation 的唯一权威是 Agent MySQL。
- **Sandbox 网络**: 开发态给出 egress，生产 overlay 明确剥离。
- **Web UI**: 会话恢复与 Run 生命周期同步；模型选择器改版。
- **行数闸门**: `HOTSPOT_LINE_BUDGETS` 改为钉在各文件当前长度——只能缩不能涨。六个超限文件按职责拆分，闸门自 2026-07-31 以来首次转绿。
- **CI**: 修正 Agent syntax-check 指向的失效路径 `agent/testing/fake-openai-provider.js`（实际位于 `agent/tests/support/`），该 job 因此长期失败。

### Removed

- ADR 0002 / 0003（2026-07-19，`7370220d`）——内容已被 `plan.md` 取代，编号不再复用。

### Fixed

- **输入法组合期回车误发送**：Composer 的回车提交未检查 `isComposing`，中文/日文输入法按回车确认候选词会把拼音原文直接发出去。现在组合期间的 Enter 不再触发提交（`isEnterSubmitKey` 纯函数 + 回归测试）。
- **Ctrl+U 上传快捷键空头支票**：上传按钮文案宣称支持 Ctrl+U，但全局 keydown 里该分支只有注释没有实现。现在由 Composer 旁的监听器真正打开文件选择器（与按钮同一运行中禁用门控），且 `Ctrl/Cmd+L`（新建会话）在 macOS 上也能通过 Cmd 触发；快捷键在输入法组合期间同样不触发。
- **消息日志 aria-live 刷屏**：流式输出时每个 SSE token 都进入整段 transcript 的 live region，读屏软件被逐 token 重读。MessageList 改为显式 `aria-live="off"`——`role="log"` 隐式就是 polite live region，只删显式属性并不会让它安静下来。Run 状态播报继续走 FlashZone 的 `role="status"`。

## [4.0.0] — 2026-07-04

### Added

- **三容器架构 (v4)**: 前端 (Nginx + SPA) + API Server (Node.js + pi-coding-agent) + Sandbox (Python FastAPI)，前端零 Agent，LLM Key 仅存服务端

### Changed

- **文档全面重写**: README.md、docs/architecture.md、docs/deployment.md、docs/development.md、docs/api.md、docs/webui.md 全部基于实际代码重写
- **端口规范化**: 统一 host→container 端口标注格式，修正所有文档中的端口不一致问题
- **API 文档**: 补全三层 API（Frontend → API Server → Sandbox），新增 Conversations、Approvals、Traces、MCP 端点文档，补充 SSE 事件协议完整列表
- **部署文档**: 更新架构图和端口，标注 docker-compose.prod.yml 服务名不匹配问题

### Removed

- **旧设计文档移除**: 早期 system-design 草稿不再保留；以 `plan.md` 与活跃 `docs/*` 为准

## [0.2.0] — 2026-07-03

### Added

- **Frontend/Backend Separation**: Modularized monolithic `server.js` into 9 focused modules (`config.js`, `services/sandbox-client.js`, `services/conversation-manager.js`, `services/agent-factory.js`, `routes/status.js`, `routes/conversations.js`, `routes/chat.js`, `routes/static.js`)
- **WebUI Frontend Modules**: Split monolithic `app.js` into ES modules (`js/api.js`, `js/utils.js`, `js/chat.js`, `js/conversations.js`, `js/app.js`)
- **Light Theme**: Added toggleable light theme via `[data-theme="light"]` CSS
- **Code Copy Button**: One-click copy for code blocks in chat messages
- **Collapsible Tool Calls**: Tool execution indicators are now expandable to show arguments
- **Skeleton Loading**: Loading state animations for better UX during initialization
- **Comprehensive Documentation**: Added `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/` directory with architecture, API, deployment, development, and WebUI guides
- **WebUI Test Suite**: Added tests for the WebUI server API (`tests/test_webui_api.py`)
- **Configuration Tests**: Added tests for config defaults and version consistency
- **Entrypoint Tests**: Added tests for the sandbox entrypoint parameter handling

### Changed

- **README.md**: Completely rewritten with detailed architecture, quick start, configuration reference, and project roadmap
- **webui/index.html**: Updated to load ES modules, added theme-color meta tag
- **webui/style.css**: Enhanced with light theme variables, copy button styles, collapsible tool styles, skeleton animations
- **webui/server.js**: Now a thin entry point that delegates to route modules

### Fixed

- **Bubblewrap 环境变量不再泄漏到进程参数**：显式允许的业务 DB 环境仍传入沙箱子进程，但正式 spawn 改为使用受控继承环境，不再把值拼进 `--setenv` argv；外层 bwrap 仍只接收最小环境，未恢复完整宿主环境继承。
- **Artifact 导入按目标 workspace 写入**：BFF 现在先由 Agent 解析目标 Sandbox Session 的 `workspace_id`，再调用 exec 导入；对外仍返回目标 session 标识，避免文件写入一个模型实际不可见的路径。
- **普通用户初始化与能力页回归**：补齐首登 provisioning/刷新竞态、Settings 二级导航、`.zip/.skill` Draft 上传，以及省略 `run_id` 的 Artifact 列表投影兼容。
- **首个管理员无法创建**：注册忽略客户端提供的 role/organization_id（正确），而 `BFF_DEV_ACTING_ROLE` 只在关闭鉴权时生效，导致任何真实部署上 `/api/a2a/config` 等管理员面不可达。新增 `SANDBOX_AUTH_ADMIN_USERNAMES`：名单内用户名注册即晋升 admin。
- **进程控制、取消与上传错误路径**：QA 发现的六处缺陷修复（admin bootstrap、process control、cancel 与 upload 错误处理）。
- **Agent `/internal/*` 平面在 token 未配置时无鉴权**：这些路由直接信任 `X-Acting-*` 头，能触达端口即能冒充任意用户。现在空 token 直接关闭内部平面；无鉴权运行必须显式设置 `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true`，生产配置校验拒绝该选项，启动日志明示当前模式；token 比较改为常量时间。
- **api-server 与 agent 容器以 root 运行**：两个 Dockerfile 现在在移交写入路径后降权到基础镜像的 `node` 用户。存量部署注意：`agent_user_skills` 卷是以 root 创建的，需重建或 chown 一次。
- **BFF 全部出站调用无超时**：上游接受连接但不响应时会无限悬挂并钉死浏览器请求与 socket。Agent 调用现受 `AGENT_REQUEST_TIMEOUT_MS`（默认 15s）约束，Sandbox 调用受 `SANDBOX_REQUEST_TIMEOUT_MS`（默认 15s）约束。
- **Sandbox JWT 密钥 fail-open**：`auth_enabled=true` 但未配置密钥时回退到公开默认值，可伪造任意身份 token。现在缺失即启动失败（fail-closed）。


## [0.1.0] — 2026-06-28

### Added

- Sandbox Service with Session/Workspace/Execution management
- ToolPolicyChecker (low/medium/high risk levels)
- Path escape protection
- Non-root execution + safe_env
- stdout/stderr preview limits
- Serial execution per session
- Resource limits (timeout, output size)
- File API (read/write/list/preview/download)
- Artifact API (register/list/download)
- Audit logging
- Prometheus metrics
- Health / Readiness checks
- MCP Server Adapter
- Docker multi-stage build
- EnterpriseToolAdapter with policy pre-check
- SandboxClient SDK
- Pi Extension (TypeScript)
- Approval workflow for high-risk tools
- Trace ID middleware
- SQLite persistence (WAL mode)
- Session restore via enterprise_session_id
- Built-in Skills (document-parser, data-analysis, sql-query)
- WebUI chat interface with SSE streaming
