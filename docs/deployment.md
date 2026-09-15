# Deployment Guide

> 生产部署指南 — Frontend / BFF / Agent / Exec（含 MCP 第二入口）+ Nginx 反向代理 + SSL + 资源限制 + 持久化存储

## 快速启动（开发模式）

```bash
# 1. 配置
cp .env.example .env
vi .env  # 填入 LLMIO_BASE_URL 和 LLMIO_API_KEY

# 2. 构建并启动
docker compose up --build -d

# 3. 验证
curl -f http://localhost:3000/            # Frontend
curl -f http://localhost:4000/health/ready  # BFF + dependencies
curl -f http://localhost:4100/health      # Agent
docker compose exec sandbox node -e "fetch('http://127.0.0.1:8081/health').then(r=>r.text()).then(console.log)"
docker compose exec sandbox node -e "fetch('http://127.0.0.1:8081/ready').then(r=>r.text()).then(console.log)"
```

| 服务 | 端口 | 容器内端口 |
|------|------|-----------|
| Frontend (Nginx) | `3000` | `80` |
| API Server (BFF) | `4000` | `4000` |
| Agent | `4100` | `4100` |
| Sandbox internal execution plane | 无宿主映射（dev 与生产均不发布） | `8081` |
| `sandbox-mcp` facade | `SANDBOX_MCP_HOST_PORT`（默认 `8082`，绑 `127.0.0.1`） | `8082` |

## 生产部署

```bash
# 使用生产 overlay（Nginx + SSL + 资源限制）
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# 验证
curl -sf https://localhost/health/ready
curl -sf https://localhost/nginx/status
```

### Workspace / temp disk quota (production)

Sandbox 的 `/tmp` 不是容器共享目录，也不是每次执行新建的 tmpfs。它是
Agent Session 私有的持久目录，并由 Bubblewrap 按执行上下文绑定；设计取舍见
[ADR 0004](adr/0004-session-persistent-tmp.md)。因此 `SANDBOX_TEMP_ROOT` 必须位于
受监控、可清理且具备生产硬配额的存储上，不能映射到跨 Session 共享的裸目录。

Positive `SANDBOX_WORKSPACE_QUOTA_MB` / `SANDBOX_TEMP_QUOTA_MB` claim multi-tenant
disk isolation. Production validation requires **both**:

1. `SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT=true` — in-process **monitoring**
   (bounded fail-closed tree sample; kills children on over-quota or measure failure).
   This is **not** a hard total: inter-sample races and multi-file writes under
   `RLIMIT_FSIZE` remain.
2. `SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=true` — **operator assertion**
   that workspace/temp roots sit on an external hard quota (XFS project quota,
   volume size, filesystem project, etc.). The process does **not** auto-detect
   this. Keep `false` in compose defaults until a live gate verifies the backend,
   then set explicitly.

Child monitor codes: `workspace_quota_exceeded`,
`workspace_inode_limit_exceeded`, `workspace_quota_enforcement_failed`.

### VM exec release（单 VM 裸装，design §9）

目标拓扑里执行面是单 VM、单实例、systemd 托管。仓库提供不可变 release 包与部署资产（`deploy/vm/`），
**不**提供 VM 上的系统工具链安装（bwrap、Python venv、办公工具、Chromium 等由运维按 design §9.1 装好，
`docs/reviews/2026-09-07-updrdb-dbpm/probe/vm_preflight.sh` 做装机前体检）。

**构建**（在目标架构的 Linux 容器里编译并安装依赖，原生模块不跨平台搬运）：

```bash
scripts/vm/build-exec-release.sh --arch amd64      # 产物：.runtime/vm-release/exec-<sha12>-amd64.tar.gz + .sha256
```

工作区有未提交改动时拒绝构建（`--allow-dirty` 只用于本地验证，id 带 `-dirty-<时间>`）。release 内含
`release-manifest.json`（提交、架构、构建用 Node 与 glibc、schema 清单哈希、原生模块、符号链接）与
`SHA256SUMS`，不含源码与开发依赖。Node 必须是 `/usr/local/bin/node`（满足 `>=22.19.0 <23`）：
Bubblewrap 只暴露 `/usr /bin /sbin /lib /lib64`，装在 `/opt` 的 Node 在沙箱里不可见。

**安装与切换**（root，脚本在 release 的 `vm/` 下）：

```bash
vm/install-release.sh init                              # 建 pi-exec 系统用户、/var/lib/pi-exec/*（0700）、/etc/pi-exec
vm/install-release.sh install exec-<id>.tar.gz          # 校验 .sha256 与 SHA256SUMS，解包为 root 所有的只读目录
install -m 0640 -o root -g pi-exec exec.env /etc/pi-exec/exec.env   # 由 vm/exec.env.example 填写
vm/install-release.sh activate exec-<id>                # 原子切换 /opt/pi-exec/current，安装 unit，daemon-reload
systemctl enable pi-exec                                # 首次
systemctl restart pi-exec                               # 在维护窗口内：先停准入、drain 或停止执行
```

脚本从不自动重启服务；同一 release id 不能重复安装。回滚 = `activate <旧 id>` 后在维护窗口内重启。

**`exec.env`**：只列 exec 实际读取的变量（开发 Compose 里的大量 `SANDBOX_*` 是 Python 执行面时代的，TS 执行面不读）。
`EXEC_INTERNAL_ALLOW_CIDR` 为空时 exec 拒绝全部内部面请求；VM 上启动前检查另外要求它非空，避免服务起来却全部 403，按实测的 LB SNAT / 源地址填写。

**启动链**：`ExecStartPre=vm/exec-preflight.sh`（非 root；Node 位置与版本；release 完整、架构匹配且对运行用户只读；
必需配置非空且不是模板占位符；四个数据根属主为运行用户且 0700；系统 Skill 根可读；bwrap 存在且非 setuid）→
exec 自身按 取密 → schema 核对 → 存储与 bwrap 预检 → 孤儿回收 → listen 启动。任一步失败服务不监听。

**停止**：`KillMode=mixed`——SIGTERM 只发给主进程（先置未就绪、关 listener），主进程退出或 `TimeoutStopSec` 到期后，
cgroup 里剩余的 bwrap 子进程一律 SIGKILL；被中断作业的账本由下次启动的孤儿回收收口。

**启动失败的重试**：`Restart=on-failure` 同样作用于 ExecStartPre 与 exec 启动期检查失败——每 5 秒重试，300 秒内 5 次后
unit 进入 failed。修好配置后需 `systemctl reset-failed pi-exec` 再启动。

**加固项**：unit 启用 `NoNewPrivileges`、空 capability、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`、
`ProtectProc=invisible` 等，`ReadWritePaths` 只放 `/var/lib/pi-exec` 与共享草稿根。兼容性以 exec 启动期 bwrap 预检为准，
2026-09-15 在 Debian bookworm（systemd 252）与 openEuler 24.03 LTS（systemd 255）容器中逐项实测：

| 指令 | 结果 | unit |
|---|---|---|
| `ProtectProc=invisible` | 两个环境均可启动，`/ready` 隔离 ok | 启用 |
| `ProtectKernelTunables=yes` / `ProtectKernelLogs=yes` | systemd 252 可启动；**systemd 255 上任一项单独开启**，bwrap `Can't mount proc on /newroot/proc: Operation not permitted`，exec 拒启 | 不启用 |
| `RestrictNamespaces=yes` | bwrap `No permissions to create new namespace`，exec 拒启 | 不启用 |
| `ProcSubset=pid` | bwrap 读不到 `/proc/sys/kernel/overflowuid`，exec 拒启 | 不启用 |
| `PrivateUsers=yes` | 可启动，但改变服务所见 uid 映射，与共享存储属主 / ACL 的影响未评估 | 不启用 |
| `SystemCallFilter` / `MemoryDenyWriteExecute` | 未测；前者需审计 bwrap 系统调用，后者与 Node JIT 冲突 | 不启用 |

目标 VM 内核（麒麟、KySec）上的结果可能不同，上线前按同一方式复测；不兼容时 exec 拒绝启动而不是降级运行。

**模型工具链**（dnf 系：openEuler / 麒麟，root 运行，脚本随 release 在 `vm/toolchain/`）：

```bash
vm/toolchain/install-toolchain.sh --cache /srv/pi-toolchain-cache            # 离线：缓存里必须已有全部制品
vm/toolchain/install-toolchain.sh --cache /srv/pi-toolchain-cache --allow-download   # 缺的按清单 URL 下载
```

- 制品清单 `vm/toolchain/toolchain-sources.json` 钉住 Node、uv、ripgrep、fd、pandoc、LibreOffice、Chromium 两种架构的文件名 / URL / SHA256，并写明哈希来源（发布方摘要、签名验证后记录、首次下载记录）。脚本**先核对 SHA256 再使用**，不匹配或未钉版即失败，从不 `curl | sh`。
- openEuler 24.03 LTS 官方源（OS / everything / EPOL / update）不提供 ripgrep、fd、pandoc、LibreOffice、Chromium，按决定使用上游官方包：ripgrep / fd / pandoc 为 GitHub release（musl 静态版 / 官方 tar 包），LibreOffice 为 TDF 官方 RPM（GPG 签名验证后钉 SHA256），Chromium 为 Playwright 1.63.0 分发的 Chrome for Testing 构建（发布方无摘要，按下载记录）。是否允许在目标 VM 使用这些第三方二进制需另行确认。
- 其余来自 dnf 源（清单 `dnf_packages`，包名按 openEuler 24.03 核对，麒麟上需复核）、PyPI（`requirements.txt`，未钉版本，安装后把实际版本写入 `/usr/local/share/pi-toolchain/python-freeze.txt`）与 npm（bun / docx / pptxgenjs 与 BaoYu 锁文件，版本同 `runtime-versions.json`）；可用 `UV_INDEX_URL`、`npm_config_registry` 指向内网镜像。
- 沙箱另外只读挂入 `/etc/fonts` 与 CA 信任库（Debian 的 `/etc/ssl`、`/etc/ca-certificates`；RHEL 系的 `/etc/pki/tls/certs`、`/etc/pki/tls/cert.pem`、`/etc/pki/tls/openssl.cnf`、`/etc/pki/ca-trust/extracted`，不含 `/etc/pki/tls/private` 等），系统自带的字体配置与 CA 包无需复制到 `/usr/local`。
- 安装位置全部在 Bubblewrap 可见的 `/usr/local` 与 `/opt/pi-python/venv`：官方 LibreOffice RPM 默认装到 `/opt`，脚本解包后搬到 `/usr/local/lib/libreofficeX.Y`；`baoyu-chromium` 改写为指向 `/usr/local/lib/pi-chromium/chrome/chrome`。
- 结束时核对各工具版本、Python / Node 文档库可导入、`soffice.bin` 与 `chrome` 无缺失共享库，失败即非零退出。重复运行跳过已装的同版本组件。

**本仓库的演练范围**：release 在带 systemd 的 Debian 容器中验证过安装、负对照、启动、停止清理、孤儿回收与回滚；
在 openEuler 24.03（systemd 255）特权容器中验证过工具链离线安装、当前 unit 下启动就绪，以及 Bubblewrap 内的工具 smoke
（文档生成与读回、soffice 转换、pdftotext / qpdf、pandoc、OCR、rg / fd、BaoYu wrapper、Chromium 经 CDP 渲染 mermaid）。
Chrome for Testing 的一次性 `--screenshot` 模式在该环境挂起，产品内 Chromium 只经 CDP 使用。
同一容器接替开发栈执行面后，Agent / Worker / BFF / sandbox-mcp 经它跑通了登录 → 带工具 Run → 进程 logs/signal → 跨租户 404。
麒麟 VM、KySec / SELinux、真实 user namespace 限制、x86_64 与目标 VM 上的工具链 smoke 仍需在目标环境做（design §12 T6）。



### 生产架构

```
                           ┌───────────────────────┐
                           │   Nginx (443/80)        │
                           │   TLS + Rate Limit     │
                           └──────┬────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   frontend (Nginx:80)         │
                  │   Static SPA + /api/* proxy   │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   api-server BFF (Node:4000)  │
                  │   Auth · Files · SSE relay    │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   agent (Node:4100)           │
                  │   DeepSeek Harness · LLM      │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   exec (Node/TS:8081)          │
                  │   Execution · Files · Isolation│
                  │   MySQL (formal topology)      │
                  └──────────────────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   redis:7.2 (Agent-only)      │
                  │   Queue · Lease · Stream      │
                  │   (not fact authority)        │
                  └──────────────────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │ External MCP Gateway/Servers │
                  └──────────────────────────────┘
```

图中 Redis 连接属于 Agent 的队列/lease/stream 协调；Sandbox 只使用独立
的 replay Redis 保存 internal HMAC jti。外部 MCP 由 Agent 的
`@deepseek-ai/dsh-mcp-client` 直连，不经过 Sandbox，也不与 Sandbox replay Redis 共用凭据。
若部署独立的 `sandbox-mcp`，它同样不经过 Agent：只使用服务 Redis 的专用
key 前缀保存 `context_id` 映射，并通过 Sandbox 私有桥接执行。见
[`sandbox-mcp.md`](./sandbox-mcp.md)。

## 环境变量

### Auth

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_API_TOKEN` | — | exec 公共会话面（`/sessions/*`、`/conversations/*`、`/datasets`）的 service key，BFF 与 agent 都以 `X-API-Key` 发送；**exec 启动时必填**，缺失即拒绝启动（fail-closed，否则会话面完全无鉴权）。它不是正式 Agent execution authorization，也不能代表终端用户 |
| `SANDBOX_INTERNAL_HMAC_KEYRING` | — | 正式 Agent→Sandbox `/internal/v1/*` HMAC keyring；生产必填，密钥不得写入日志 |
| `SANDBOX_INTERNAL_HMAC_ACTIVE_KID` | — | 当前签名 key id；必须存在于 keyring |
| `EXEC_INTERNAL_ALLOW_CIDR` | 开发 Compose：`127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`；生产 overlay：必填 | exec 内部面（`/internal/v1/*`）的来源 CIDR 白名单（逗号分隔）。**空值 = 拒绝全部内部面请求**（启动日志告警），非法 CIDR = 拒绝启动，放行全部须显式写 `0.0.0.0/0,::/0`。判定用的对端地址取自 TCP socket（IPv4-mapped IPv6 按 IPv4 匹配），**不采信 `X-Forwarded-For` / `X-Real-IP`**，取不到对端地址一律拒绝 |
| `EXEC_HTTP_LOG` | 空 | 设为 `1` 打开 exec 内部面的请求行日志（JSON 一行：方法/路径/状态码，不含 query）|
| `SANDBOX_INTERNAL_REDIS_URL` | — | 独立 replay Redis，用于 HMAC jti 防重放；不得复用 Agent Redis 凭据 |
| `SANDBOX_JWT_SECRET` | — | **Agent HTTP 进程**签发/校验浏览器 JWT 的 HMAC 密钥；变量名为迁移兼容保留，生产必须是强密钥且不会传给 exec |
| `SANDBOX_JWT_TTL_SECONDS` / `SANDBOX_JWT_ISSUER` / `SANDBOX_JWT_AUDIENCE` | `86400` / `pi-enterprise-sandbox` | Agent 浏览器会话 token 的有效期与签发约束 |
| `SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER` | `true` | Agent 注册入口开关；生产 compose 强制 `false` |
| `SANDBOX_AUTH_ADMIN_USERNAMES` | — | 注册即晋升 admin 的用户名列表（逗号分隔）。注册始终忽略客户端提供的 role/organization_id，这是真实部署上创建首个管理员的唯一途径 |
| `AGENT_REQUEST_TIMEOUT_MS` | `15000` | BFF → Agent 出站调用超时（SSE 长连接除外）；防止挂起的依赖拖垮无关路由 |
| `SANDBOX_REQUEST_TIMEOUT_MS` | `15000` | BFF → Sandbox 出站调用超时（SSE 长连接除外） |
| `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL` | dev `true` / 生产禁止 | Agent `/internal/*` 平面的鉴权开关。token 未配置且未显式设为 true 时启动即失败（fail-closed）；生产配置校验拒绝 true |
| `MCP_SERVERS_JSON` | `[]` | Agent Runtime 外部 MCP Server registry；凭据仅通过 `authTokenRef`/`envRefs`/`headerRefs` 引用环境变量 |

### MCP 启动与可见性（一期）

`MCP_SERVERS_JSON` 是一期 MCP 的唯一运维清单：其中 `enabled=true` 的每个
Server 在 Agent 进程启动时都会由 `@deepseek-ai/dsh-mcp-client` 连接并执行 `tools/list`。
发现到的工具会自动对全部 Agent 可见，名称固定为
`mcp__{serverId}__{toolName}`；不需要修改 AgentVersion。

启动发现结果在该进程内固定，修改配置必须重启 Agent（boot 时读取 `MCP_SERVERS_JSON`，不必重跑 `npm run gen:patch`），不支持热加载。每个
MCP 工具默认走 approval；一期不提供按 AgentVersion 的 MCP server/tool
allowlist。`GET /ready` 返回每个 Server 的连接状态及总 Server/tool 数量；
任何启用的 Server 不可达会使 readiness 返回 `503`，并打印
`[agent-mcp] MCP readiness error`，不会静默退化为 `tools=[]`。

### Execution policy profile

| 变量 | 开发 Compose 默认值 | 生产值 | 说明 |
|------|-------------------|--------|------|
| `SANDBOX_POLICY_PROFILE` | `balanced` | `strict` | `balanced` 只在 required Bubblewrap 生效时放行常见包管理器命令的审批前置门；网络仍由 `SANDBOX_NETWORK_MODE` 决定 |
| `SANDBOX_ISOLATION_BACKEND` | `bubblewrap` | `bubblewrap` | `balanced` 的必要隔离后端 |
| `SANDBOX_ISOLATION_REQUIRED` | `true` | `true` | 隔离 preflight 失败即不 Ready |

`strict` 是代码默认值，也是生产唯一允许的 profile。`balanced` 不放宽 session/path
归属、Skill 根只读、最小环境、能力丢弃、设备/namespace hard-deny 或审批开关；它只
减少 `pip/npm/yarn/pnpm install` 等常见开发命令的重复审批。若 `network_mode=disabled`
（生产唯一允许值），进程启动器拒绝网络类命令，且 Bubblewrap 子进程使用
`--unshare-net`（空 netns）。`allowlist` / `unrestricted` 仅可在研发显式开启，且
**不得**当作生产隔离：当前没有 per-child 受控 egress proxy，生产校验 fail-closed。
metadata/link-local 目的地阻断始终开启。

迁移与回滚：开发环境可先设置 `SANDBOX_POLICY_PROFILE=strict`，验证 `/ready` 和审批
流后再切换到 `balanced`。出现异常时把该变量改回 `strict` 并重启 Agent/Sandbox；不需要
迁移 workspace 或数据库。生产 overlay 固定为 `strict`，不能通过 `.env` 覆盖。

### 入站网络（监听 vs 来源白名单）

| 变量 | 默认值 | 说明 |
|------|--------|------|
exec 固定监听 `0.0.0.0:${EXEC_PORT|SANDBOX_PORT}`（IPv4），没有监听地址开关，也不支持「可信代理」解析转发头。
三个面各自鉴权，互不替代：

| 面 | 来源限制 | 鉴权 |
|----|----------|------|
| 内部面 `/internal/v1/*`（Agent / Worker） | `EXEC_INTERNAL_ALLOW_CIDR`：空值拒绝全部，非法值拒启 | HMAC（`SANDBOX_INTERNAL_HMAC_*`） |
| 公共会话面 `/sessions/*` 等（BFF / Agent） | 无 | `SANDBOX_API_TOKEN`（`X-API-Key`） |
| MCP 窄桥 `/internal/mcp/v1/*`（sandbox-mcp） | 无 | `SANDBOX_MCP_INTERNAL_TOKEN` |

**本机非 Docker 示例（Agent 在同机）：**
```env
EXEC_INTERNAL_ALLOW_CIDR=127.0.0.1/32
```

**VM / 负载均衡示例：** 按实测的 LB SNAT 或源地址保留方式填写 Agent / Worker 实际到达 exec 的源地址段，不要照抄 Pod CIDR：
```env
EXEC_INTERNAL_ALLOW_CIDR=10.20.30.0/24
```

`SANDBOX_BIND_HOST`、`SANDBOX_ALLOWED_CLIENT_CIDRS`、`SANDBOX_TRUSTED_PROXY_CIDRS` 属于已删除的 Python 执行面，TS exec 不读取。

外部 MCP 由 Agent Runtime 直接连接，不经过 Sandbox。凭据由 `authTokenRef` 指向的环境变量注入。

**命名分离：** `EXEC_INTERNAL_ALLOW_CIDR` 只约束 **入站** 内部面来源；
`SANDBOX_NETWORK_MODE` 只约束 **出站执行** 策略。已移除 container-wide iptables
与 `SANDBOX_ALLOWED_CIDRS` / 端口 union allowlist 作为隔离权威的设计。

### 出站执行网络（与入站 CIDR 无关）

| 变量 | 开发 | 生产 | 说明 |
|------|------|------|------|
| `SANDBOX_NETWORK_MODE` | 可显式 `unrestricted` | 固定 `disabled` | 生产禁止 `allowlist`/`unrestricted` |

Compose 拓扑：`backend_internal`（`internal: true`）供 mysql/redis/sandbox/api/frontend；
开发 Compose 另外给 Sandbox 接入 `service_egress`，仅当显式设置
`SANDBOX_NETWORK_MODE=unrestricted` 时，沙箱子进程才可访问通过
`SANDBOX_EXEC_ENV_*` 注入的远程业务库；这些显式 allowlist 值通过受控 spawn 环境
进入子进程，不拼入 Bubblewrap 命令行。生产 overlay 用 `!override` 移除该网络，
并固定 `SANDBOX_NETWORK_MODE=disabled`；`agent`/`agent-worker` 始终接入
`service_egress` 以访问 LLM。

### LLM Provider

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLMIO_BASE_URL` | — | **必需** — LLM API 基地址 |
| `LLMIO_API_KEY` | — | **必需** — LLM API 密钥 |
| `MODEL_ID` | `deepseek-v4-flash` | 模型 ID |

### Domain & SSL

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DOMAIN` | `localhost` | 生产 Nginx SSL 域名 |
| `NGINX_HTTP_PORT` | `80` | HTTP 端口 |
| `NGINX_HTTPS_PORT` | `443` | HTTPS 端口 |

### Frontend nginx 上游

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_UPSTREAM` | `http://api-server:4000`（镜像 `ENV` 与开发 Compose） | frontend 容器 `/api/` 的转发目标；K8s 中填 api-server 内部 LB。只接受 `http://host[:port]`：带路径、query、空白、换行、`;`、`$`、`https://` 或端口越界时容器在 nginx 启动前退出 |

frontend 镜像把 `nginx/default.conf.template` 放进官方镜像的 `/etc/nginx/templates/`，启动时由 `20-envsubst-on-templates.sh` 渲染到 `conf.d/default.conf`，`NGINX_ENVSUBST_FILTER=^API_UPSTREAM$` 保证 `$host`、`$remote_addr` 等 nginx 变量不被替换。镜像删除了官方自带的 `conf.d/default.conf`，并在渲染前后各跑一个校验钩子：`05-validate-api-upstream.sh` 拒绝不安全的值；`25-verify-rendered-config.sh` 要求渲染文件存在、无残留占位符且确实指向本次上游——官方渲染脚本在 `conf.d` 不可写（如只读根文件系统）时只打日志继续启动，这里改为拒启。若平台要求只读根文件系统，需给 `/etc/nginx/conf.d`、`/var/cache/nginx`、`/var/run` 挂可写 `emptyDir`（design §2.1 的 nginx 临时目录，尚未在目标环境验证）。

### Database（开发 MySQL 5.7 / 生产 overlay MySQL 8）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_DATABASE` | `sandbox` | MySQL database name |
| `MYSQL_USER` | `sandbox` | MySQL application user |
| `MYSQL_PASSWORD` | 开发占位 `sandbox_dev_only`；生产无默认 | 应用用户密码（生产必填强 secret） |
| `MYSQL_ROOT_PASSWORD` | 开发占位；生产无默认 | root 密码（生产必填强 secret） |
| `AGENT_DATABASE_URL` | `mysql://…@mysql:3306/sandbox` | Agent 事实库（仅 `mysql://` / `mysql2://`） |
| `SANDBOX_DATABASE_URL` | `mysql+pymysql://…@mysql:3306/sandbox` | Sandbox 持久化（`mysql+pymysql://` 或 `mysql://`） |
| `SANDBOX_COMPOSE_DATABASE_URL` | 未设置（默认 MySQL compose DSN） | 仅开发 Compose 的显式 Sandbox DSN override；旧 `.env` 中的 `SANDBOX_DATABASE_URL` 不参与默认插值 |
| `UPDRDB_ENDPOINTS` | 未设置（使用 DSN 的 host:port 单端点） | UPDRDB 两个 Proxy，恰好两个 `host:port` 逗号分隔。Agent / Agent Worker（Knex 与 DSH 会话存储）和 Sandbox 执行面读取；设置后按端点故障切换，DSN 只提供 user/database/参数。格式错误拒绝启动 |

**开发:** `docker compose up` 启动 `mysql:5.7`（对齐 UPDRDB 的 UPSQL 5.7 内核，见 [ADR 0011](adr/0011-updrdb-upredis-dbpm-migration.md)）；DSN 默认指向 compose 网络内 `mysql` 服务。占位密码仅用于本地，勿用于共享/生产环境。

5.7 使用独立数据卷 `mysql57_dev_data`。MySQL 官方[不支持 8.0 降级到 5.7](https://dev.mysql.com/doc/refman/8.0/en/downgrading.html)：把旧的 `mysql_dev_data` 挂给 5.7 会在 InnoDB 数据字典校验处崩溃退出。旧 8.0 卷**已于 2026-09-14 决定作废**，不再作为回退点，也不要挂给 5.7；需要回收磁盘时手工删除该卷。若本地 `.env` 显式设过 `MYSQL_DATA_VOLUME`，必须同步改成新卷名。

**UPDRDB 双 Proxy 建连**（ADR 0011 D5，design §4.2/§4.3）：设置 `UPDRDB_ENDPOINTS` 后，三个 MySQL 接入点（Agent Knex、Agent DSH 会话存储、exec 裸池）每次取连接时按「粘住当前主用 → 网络故障拉黑 180s 并试另一个 → 拉黑过期不主动回切」选择端点；单次握手 3s，一次取连接（含会话初始化）总预算 10s。认证失败、库不存在、会话初始化失败不换端点，直接报错。**已发出的 SQL 一律不重试**（包括 commit 响应丢失），由既有幂等键与回读判定。每条物理连接交付前执行 `SET SESSION time_zone = '+00:00'`，失败的连接丢弃。

官方 `mysql:5.7` 镜像只有 amd64；Apple Silicon 上通过 `MYSQL_PLATFORM`（默认 `linux/amd64`）模拟运行，可用但比原生慢。

**生产:** `docker-compose.prod.yml` 内置 MySQL 8、healthcheck、持久 volume，以及 Sandbox/Agent 对 MySQL 的健康依赖。启动前必须设置强 `MYSQL_PASSWORD` 与 `MYSQL_ROOT_PASSWORD`；production overlay **不**回退 SQLite 或 PostgreSQL。Sandbox 生产配置校验拒绝非 MySQL DSN。

### Bundled Skill runtime dependencies

The Sandbox image packages the runtime dependencies used by the bundled office
Skills; they are not installed by a user command at execution time:

- LibreOffice Writer/Calc/Impress for DOCX/PPTX conversion, rendering, and XLSX formula recalculation.
- Poppler, `qpdf`, Tesseract, `reportlab`, `pdf2image`, and `pytesseract` for PDF workflows.
- Chromium plus CJK fonts for Mermaid rendering in `baoyu-markdown-to-html`.
  The child environment points `BAOYU_CHROME_PATH` at an image-provided
  launcher that invokes Chromium's real binary directly; this avoids relying
  on Debian's `/etc/chromium.d` launcher files, which are outside the minimal
  Bubblewrap `/etc` view. Bubblewrap remains the outer no-network isolation
  boundary.
- Bun and the locked BaoYu script dependencies. The image exposes
  `/usr/local/bin/baoyu-format-markdown` and
  `/usr/local/bin/baoyu-markdown-to-html`; these wrappers do not invoke
  `npx`, `npm install`, or another network download at runtime.
- `docx` and `pptxgenjs` are installed in the image's global Node module tree;
  the child execution environment exposes that tree through `NODE_PATH`.

The production overlay keeps execution networking disabled. Therefore image
builds must be performed in CI or an internal mirror with access to the
configured Debian, PyPI, and npm registries; deployed containers do not need
those registries for the bundled Skills themselves.

**Schema 发布（ADR 0011 D6）：任何服务启动时都不迁移，开发与生产同一流程。**
Knex migrations 仍是唯一 schema 权威，但生产账号没有 DDL 权限，建表改为执行导出的发布包：

1. 在**空的专用影子库**上导出：`SCHEMA_SHADOW_DATABASE_URL=… npm run schema:sql --prefix agent -- --out DIR`
   （增量加 `--from <已上线的最后一个迁移>`）。发布包包含 `0000_knex_bookkeeping.sql`（仅首装）、
   按迁移分段的 `NNNN_<migration>.sql`、`schema-manifest.json` 与 `release.json`（起止迁移、迁移文件
   与每段 SQL 的 sha256、执行说明）。导出时影子库结构必须与随包清单一致，否则拒绝产出。
2. 交付前在第二个空库/基线库重放核对：`SCHEMA_REPLAY_DATABASE_URL=… npm run schema:replay --prefix agent -- --dir DIR`。
3. DBA 用 mysql 客户端**按顺序逐段**执行，首个错误即停，禁止 `--force`；每段最后一句才写
   `knex_migrations`，失败段不会被记成已完成。失败处理见
   [部分迁移恢复 runbook](runbooks/mysql-partial-migration-recovery.md)。
4. 执行后只读核对：`SCHEMA_VERIFY_DATABASE_URL=… npm run schema:verify --prefix agent`。

`agent`、`agent-worker`、`sandbox` 启动时都会按随镜像分发的 `contract/schema/schema-manifest.json`
核对真实元数据（表、列类型/可空/默认值、索引、外键动作、四个 append-only 触发器正文、迁移记录），
任何差异都以 `SCHEMA_DRIFT` 拒绝启动——Agent 在连 Redis 之前，Worker 在消费任务之前，exec 在孤儿回收之前。
应用账号必须能读 `information_schema` 中这些对象（含 `TRIGGERS`）；读不到按「缺失」处理，不视为无差异，
生产最小权限需要 DBA 确认。开发环境：`docker compose up -d mysql` 后执行 `scripts/dev/schema-apply.sh`；
空库上直接 `up` 时三个服务会重启等待，建表完成后自动通过核对。备份恢复（`scripts/restore.sh`）同样只做核对，不迁移。

**Triggers / binary log (migration gate):** Agent migrations issue `CREATE TRIGGER`
as the non-SUPER application user. Compose-managed `mysql` services set
`--log-bin-trust-function-creators=1` (dev + prod overlay). Do **not** grant
`SUPER` to `MYSQL_USER`. If `AGENT_DATABASE_URL` points at **external/managed**
MySQL, operators must enable the equivalent platform flag before applying the
schema release (the DBA account creates the triggers); migration tooling
fail-closes with `MYSQL_TRIGGER_BINLOG_BLOCKED` and will **not**
`SET GLOBAL` on remote hosts. See
[mysql-partial-migration-recovery.md § Triggers and binary logging](runbooks/mysql-partial-migration-recovery.md#triggers-and-binary-logging).

研发阶段不可逆的空环境切换见 [Development reset runbook](runbooks/development-reset.md)。该流程明确不备份、不迁移、不恢复旧数据。

### DBPM 取密（ADR 0011 D10）

应用进程的数据库 / Redis 口令**只来自 DBPM**，启动时取一次、只放内存，不写进程环境、不打印。连接串**不带口令**；带口令、`DBPM_URL` 缺失、DSN 用户名与 DBPM 条目不一致、两台 DBPM 都取不到，都直接拒绝启动——没有环境变量口令回退。

启动顺序：校验配置 → 按角色取密 → 建连（含 UTC 会话初始化、Proxy 故障切换）→ 预检 → 就绪。

| 进程 | UPDRDB 条目 | 服务 Redis 条目 |
|------|-------------|-----------------|
| agent / agent-worker | ✔ | ✔ |
| sandbox（exec） | ✔ | — |
| sandbox-mcp | — | ✔（对外 facade，拿不到 UPDRDB 口令） |

replay Redis（`SANDBOX_INTERNAL_REDIS_URL`）目前没有代码消费方，不取密；该实例与配置的去留另行处理。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DBPM_URL` | 开发：`dbpm-fake:7000,dbpm-fake:7001`；生产无默认 | 恰好两个 `host:port`。连接 3s、每台 5s、两台总预算 10s；第一台任何失败都切第二台 |
| `DBPM_DB_NAME` / `DBPM_DB_USER_NAME` | 开发：`sandbox` / `MYSQL_USER` | UPDRDB 条目；用户名必须与 DSN 用户名一致 |
| `DBPM_REDIS_DB_NAME` / `DBPM_REDIS_DB_USER_NAME` | 开发：`redis` / `default` | 服务 Redis 条目 |
| `AGENT_COMPOSE_DATABASE_URL` / `AGENT_COMPOSE_REDIS_URL` / `SANDBOX_MCP_COMPOSE_REDIS_URL` | 无口令的 compose 内默认 | 仅开发 Compose 插值用；宿主 `.env` 里旧的带口令 `AGENT_DATABASE_URL` 等不会被带进容器 |
| `SCHEMA_SHADOW_DATABASE_URL` / `SCHEMA_REPLAY_DATABASE_URL` / `SCHEMA_VERIFY_DATABASE_URL` | 未设置 | 仅 schema 工具（开发/DBA）：带口令的完整 DSN，口令也可用对应 `SCHEMA_*_PASSWORD` 单独传入；不走 DBPM，不进应用容器 |
| `FAKE_DBPM_FAIL_PORTS` | 未设置 | 仅开发：让假 DBPM 的某个端口返回错误，演练主备切换 |

**开发:** `docker compose up` 启动 `dbpm-fake`（`scripts/dev/fake-dbpm.mjs`，真协议假服务端，只挂 `backend_internal`、不发布端口），口令即 `MYSQL_PASSWORD` / `REDIS_PASSWORD` 的开发占位值；应用服务等它 healthy 后启动。宿主机直接起服务进程时，同样需要一个 DBPM 地址（可 `node scripts/dev/fake-dbpm.mjs` 起本机假服务端）。

**生产:** `docker-compose.prod.yml` 把 `dbpm-fake` 放进永不启用的 profile（并强制 production，脚本会拒绝运行），四个应用服务的 `depends_on` 用 `!override` 去掉它；`DBPM_URL`、`DBPM_DB_NAME`、`DBPM_REDIS_DB_NAME`、`DBPM_REDIS_DB_USER_NAME` 必填（`:?`，无默认）。`MYSQL_PASSWORD` / `REDIS_PASSWORD` 只用于数据库 / Redis 服务端自身。口令变更需要重启取密进程；没有双口令重叠窗口时安排维护窗口。

### Redis 5.0.14（Agent-only 运行态协调，UPRedis 基线）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_PASSWORD` | 开发占位 `redis_dev_only`；生产无默认 | Redis 服务端 `requirepass`（生产必填强 secret，fail-fast）；应用口令经 DBPM 下发 |
| `REDIS_URL` | `redis://redis:6379/0`（不带口令） | 通用 / plan 别名 DSN |
| `AGENT_REDIS_URL` | 同 `REDIS_URL` 形 | Agent 客户端主 DSN（仅 `redis://` / `rediss://`；带口令拒绝启动） |
| `TEST_REDIS_URL` | _(可选)_ | 集成测试 DSN |
| `AGENT_RUNS_QUEUE_NAME` | `agent-runs` | BullMQ Run Queue |
| `AGENT_RUN_QUEUE_PREFIX` | 空 = `{bull}` | BullMQ key 前缀，HTTP 与 Worker 必须一致；必须含非空 hash tag，否则拒绝启动。Redis 被多环境复用时用环境独立值（如 `{pi-test-bull}`）。改值前按 [队列 prefix 切换 runbook](runbooks/run-queue-prefix-switch.md) 停准入、drain |
| `AGENT_RUN_LEASE_TTL_MS` | `30000` | Worker lease TTL（ms） |
| `AGENT_RUN_LEASE_RENEW_INTERVAL_MS` | `10000` | Lease 续约间隔（ms） |
| `AGENT_RUN_STREAM_MAXLEN` | `10000` | Run stream 近似 `MAXLEN` |
| `AGENT_WORKER_CONCURRENCY` | `4` | BullMQ Worker 并发；前台 durable 子 Agent 至少需要 `2`，默认值为文档深度 2 链路预留槽位 |
| `AGENT_WORKER_PROBE_PORT` | `4101` | Worker 探针 listener 端口（`/health`、`/ready`，见 [Health Checks](#health-checks)）；非 1–65535 整数拒绝启动 |
| `AGENT_WORKER_PROBE_HOST` | `0.0.0.0` | Worker 探针监听地址；K8s 探针打 Pod IP，不要改成 loopback |
| `AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS` | `5000` | Worker 依赖守卫探测间隔（500–600000，非法值拒绝启动）；连续 2 次失败暂停取任务、连续 2 次成功恢复，见 [Health Checks](#health-checks) |
| `AGENT_RUN_MAX_TOOL_CALLS` | `200` | 单个 Run 最多执行的工具调用数；达到后下一轮只能基于已有结果作答 |
| `AGENT_RUN_MAX_IDENTICAL_TOOL_CALLS` | `6` | 同一工具与规范化参数组合的最多执行次数 |
| `AGENT_RUN_MAX_MODEL_TURNS` | `120` | 单个 Run 最多模型回合数；达到后下一轮禁用工具并要求作答 |

**开发:** `docker compose up` 启动 `redis:5.0.14`（AOF + `maxmemory-policy noeviction` + `redis5_dev_data` volume；7.2 写出的旧卷 5.0 读不了，不复用）。Agent 依赖 Redis health；默认 DSN 指向 compose 网络内 `redis` 服务。占位密码仅用于本地。要在本地复现 UPRedis Proxy 的路由限制（零 key `EVAL` 被拒、同一命令/事务的 key 必须同一节点），再叠加 `scripts/dev/docker-compose.upredis-sim.yml`，服务 Redis 的三个消费者会改连模拟代理。

**UPRedis 放行:** 目标 Redis 的全部后端节点与切换候选须持久配置 `noeviction`（两套 Redis 分别核验）。上线前用生产 prefix 跑 `agent/tests/redis/upredis-queue.integration.test.js`（`TEST_UPREDIS_URL` / `TEST_UPREDIS_PASSWORD` / `TEST_UPREDIS_PREFIX`，代理目标加 `TEST_UPREDIS_EXPECT_ROUTING=1`）：立即/延迟/重试/stalled/取消与状态查询、单 key CAS，逐 key 核对无遗留。

**生产:** `docker-compose.prod.yml` 要求 `REDIS_PASSWORD` 已设置（`${REDIS_PASSWORD:?…}` fail-fast），启用 `requirepass`、healthcheck、持久 `redis5_data` volume（旧 `redis_data` 为 7.2 数据，按[队列 prefix 切换 runbook](runbooks/run-queue-prefix-switch.md) drain 后保留，不挂载）、`noeviction`，Agent 对 Redis `service_healthy` 依赖；**不**对外发布 Redis 端口。BFF **不**获得 Redis 权威环境变量。

**Sandbox internal plane（PR-07 replay-only）:**

| 变量 | 说明 |
| --- | --- |
| `SANDBOX_INTERNAL_PLANE_ENABLED` | 开发默认 `false`；**生产必须 `true`**（启动 fail-closed） |
| `SANDBOX_INTERNAL_REDIS_PASSWORD` | **独立** replay 密码；**禁止**等于 `REDIS_PASSWORD` |
| `SANDBOX_INTERNAL_REDIS_URL` | 指向专用服务 `sandbox-replay-redis:6379/0`（固定 DB0）；仅 jti `SET NX` |
| `SANDBOX_INTERNAL_HMAC_KEYRING` / `ACTIVE_KID` | Agent→Sandbox HMAC；生产必填 |
| `SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS` | 必须 **>0**；超时后先 UNKNOWN reconcile，再关 MySQL |

- Compose 使用 **独立** `sandbox-replay-redis` 服务 + 独立 volume/密码；**不是** Agent `redis` 换 DB 索引。
- 最小权限：键 `sandbox:internal:replay:v1:*`；命令 SET/PING（及握手）；固定 DB0；不授 SELECT。
- Sandbox **不得**获得 Agent Redis 凭据；Agent **不得**获得 replay secret。
- 真实 Redis ACL / 连通性为本仓库最终 gate，离线测试只覆盖配置语义。

**清空 Redis 与恢复:**

- Redis 清空 / 丢失只影响运行态协调（queue、lease、live stream、短期 cache）以及 Sandbox internal jti 防重放窗口，**不**删除 MySQL 中的 Conversation / Run / 审计事实。
- 未成功发布到 Redis Stream 的事件保留在 MySQL `domain_outbox`，Outbox publisher 可在 Redis 恢复后重试。
- 完整事件历史与 SSE 重放以 MySQL `run_events` 为准；Redis Stream 可按长度裁剪。

已提交文档中的应用 DSN 示例一律不带口令（口令经 DBPM 下发）；测试用 `TEST_*` 连接串只使用开发占位口令。勿把真实生产密码写进仓库。

### 资源限制

配置于 `docker-compose.prod.yml`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_CPU_LIMIT` | `2` | Sandbox 最大 CPU |
| `SANDBOX_MEM_LIMIT` | `1g` | Sandbox 最大内存 |
| `AGENT_CPU_LIMIT` | `1` | API Server 最大 CPU |
| `AGENT_MEM_LIMIT` | `512m` | API Server 最大内存 |

### Logging

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_LOG_LEVEL` | `INFO` | 日志级别 (DEBUG, INFO, WARNING) |

生产日志配置 (docker-compose.prod.yml):
- Driver: `json-file`
- Max size: `10m` per file
- Max files: `3`

## Sandbox internal authentication

正式 Agent 工具调用只使用 `/internal/v1/*` HMAC 平面。每个请求都携带
短期 claim、scope、owner/run/session identity、body digest 和 jti；Sandbox
通过独立 replay Redis 拒绝重放。一个永不过期的 `SANDBOX_API_TOKEN` 不能
替代该授权。

Agent 自身的 `/internal/*` HTTP 面（conversations、runs、A2A admin 等）由
`AGENT_INTERNAL_TOKEN` 保护，比较为常量时间；**token 缺失时平面直接关闭**
（fail-closed），除非显式设置 `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true`
（仅限开发，生产配置校验会拒绝）。启动日志会明示当前处于哪种模式。

`SANDBOX_API_TOKEN` 只保护仍由 BFF 使用的兼容文件/Dataset/Artifact adapters：

```
X-API-Key: ***
```

**边界:**
1. Browser → Nginx → BFF `/api/*`；浏览器不获取 service key，也不直连 Sandbox。
2. Agent → Sandbox `/internal/v1/*` 使用 HMAC identity，而不是 `X-API-Key`。
3. BFF 的兼容代理必须同时执行用户 ownership 校验；service key alone 不是用户身份。

**豁免端点:** `/health`, `/ready`, `/metrics`, `/docs`, `/openapi`, `/redoc`

```bash
# 只验证健康与 BFF 边界；不要用宿主 curl 模拟 internal HMAC 请求
docker compose exec sandbox curl -fsS http://localhost:8081/health
docker compose exec sandbox curl -fsS http://localhost:8081/ready
curl -f http://localhost:4000/health/ready
```

## Volumes

| Volume | 路径 | 说明 |
|--------|------|------|
| `nginx_ssl` | `/etc/nginx/ssl` | SSL 证书（生产） |
| `nginx_certbot` | `/var/www/certbot` | Let's Encrypt ACME challenge（生产） |
| `./skills` | Agent `/home/sandbox/skill:ro` + Sandbox `:ro` | 共享系统 Skill，始终只读 |
| `./.runtime/sandbox/workspaces` | `/var/sandbox/workspaces` | Agent Session 物理工作区 |
| `./.runtime/sandbox/tmp` | `/var/sandbox/tmp` | Agent Session 私有持久化 `/tmp`（`tmp_{workspace_id}`） |
| `./.runtime/sandbox/artifacts` | `/var/sandbox/artifacts` | 显式提交的 Artifact blob |
| `./.runtime/sandbox/control` | `/var/sandbox/control` | Dataset staging 与控制面状态 |
| `./.runtime/sandbox/skill-draft` | Agent `/home/sandbox/skill-draft` + exec `/var/sandbox/skill-draft` | owner-scoped Skill 草稿；Compose 显式打开 |
| `agent_user_skills` | Agent `/home/sandbox/skill-user` + exec `:ro` | 已启用 Skill 的只读发布版本（按摘要分目录） |

### Skill 挂载与用户生命周期

> **存量部署迁移注意**：api-server 与 agent 容器自 2026-08-23 起以非 root
> （`node` 用户）运行。此前创建的 `agent_user_skills` 卷属主为 root，需重建
> 该卷或手动 chown 一次，否则用户 Skill 上传会因权限失败。

Skill 分三层：

| 层 | 路径 | 来源 | 可见范围 | 卷 |
|----|------|------|----------|----|
| 系统 | `/home/sandbox/skill` | 仓库 `./skills` | 所有人 | `:ro` |
| 草稿 | `/home/sandbox/skill-draft/<orgId>/<userId>`（exec 物理根 `/var/sandbox/skill-draft`） | 模型 `write` / `bash` 或上传 | 仅该用户；不进 prompt | host bind |
| 已启用 | `/home/sandbox/skill-user/<orgId>/<userId>/<package>/.v/<digest>/<package>`（侧车 `.v/<digest>.json`）；模型侧路径 `/home/sandbox/skill-user/<package>` | 启用时从草稿复制 | 仅该用户；按启用清单逐包 `ro_bind` | named volume `agent_user_skills` |

Compose 通过 `SANDBOX_SKILL_DRAFT_ROOT=/var/sandbox/skill-draft` 显式打开草稿写面；直接启动 exec 时变量缺失则能力关闭。模型不再拥有 Skill 变更工具，只能在自己的草稿根写文件。用户在 Capabilities 页点击启用后，Agent 在一个事务里锁住该 owner 的 membership 行，校验结构与系统同名遮蔽，按复制后字节的摘要发布只读版本并写 `user_skill_enablements`；停用只删账本行，字节保留给仍在运行的 Run。旧版本在同名包下次启停时回收：既不被事务前后的账本引用、又超过 `SKILL_VERSION_GC_GRACE_MS`（Agent HTTP 读取，非负整数毫秒，默认 `86400000` 即 24 小时）才删除。

Worker 在 Run 开始时按账本逐条核对版本目录与侧车，核对不过的包不进该 Run 并记告警。exec **不扫描目录**：只挂载内部请求清单点名、且版本目录与侧车一致的包；缺版本或侧车不符返回 `SKILL_PACKAGE_UNAVAILABLE`，用户 Skill 存储不可读或未配置返回 `SKILL_STORE_UNAVAILABLE`。2026-09-14 之前按 `<package>/SKILL.md` 平铺发布的已启用包不再被识别，需要重新启用（开发数据已按用户决定清理）。

`validateProductionConfig` 仍然拒绝任何非 canonical 的
`SKILLS_ROOT` / `SKILLS_USER_ROOT`（这些是 Bubblewrap profile 认识的挂载点）。

### 工具风险等级与审批

审批由风险等级驱动。平台风险表默认从 `config/agent/tool-risk.json` 读取
（`TOOL_RISK_POLICY_PATH` 可改路径，`TOOL_RISK_POLICY_JSON` 可整表内联覆盖）；
Compose 已把 `./config/agent` 以 `:ro` 挂进 Agent 与 Worker。
AgentVersion 的 `configJson.toolPolicy` 是下层，**只能收紧**。
配置无效时进程启动即失败，不会静默退回默认值。格式见
[`docs/development.md`](./development.md#配置工具风险等级与审批)。

## Health Checks

区分 **liveness**（进程存活）与 **readiness**（依赖就绪）：

| 探针 | 端点 | 成功 | 失败含义 |
|------|------|------|----------|
| Sandbox liveness | `GET /health` | 200 | 进程无响应 |
| Sandbox readiness | `GET /ready`（同 `/health/ready`） | 200 | **503** = 已进入关停；数据库 `SELECT 1` 失败或 2s 超时；workspaces / tmp / artifacts / control 任一根不是可读写目录；或启动期 Bubblewrap 预检未通过（`isolation: unchecked / unavailable`）。响应只含 `database`、`storage.<名>`、`isolation` 的 ok / unavailable，不含路径与错误文本。bwrap 不在每次请求中重跑，只读启动期结果 |
| Agent readiness | `GET /ready`（Agent port） | 200 | **503** = Agent data plane、Sandbox，或任一 `enabled` MCP Server 不可用；响应含 MCP Server/tool 数量与状态 |
| Agent Worker liveness | `GET /health`（`AGENT_WORKER_PROBE_PORT`，默认 4101） | 200 | Worker 事件循环无响应；不查依赖 |
| Agent Worker readiness | `GET /ready`（同上） | 200 | **503** = 未完成启动（含 schema 核对、恢复扫描、消费者创建）、已进入关停、BullMQ 消费者未运行或被依赖守卫暂停（`consumer: paused`），或 MySQL `SELECT 1` / Redis `PING` 在 2s 内失败；响应只含各项 ok/unavailable，不含错误详情 |
| sandbox-mcp liveness | `GET /health`（8082） | 200 | facade 进程无响应；不查依赖 |
| sandbox-mcp readiness | `GET /ready`（8082） | 200 | **503** = 未启动或已关停、服务 Redis `PING` 失败，或执行面 `GET /ready` 非 200（各 2s 超时）；探针请求不带桥 token，只证明执行面可达，不证明窄桥 token 被接受 |
| API Server liveness | `GET /health/live` | 200 | BFF 进程不可用 |
| API Server readiness | `GET /health/ready` | 200 | Agent 或 Sandbox 未就绪（503） |
| Frontend | `GET /` | 200 | 静态站/反代不可用 |

```bash
# Frontend
curl -f http://localhost:3000/

# API Server（仅 node-agent；无 Python/双 Runtime）
curl -f http://localhost:4000/health/ready
# {"status":"ok","version":"4.0.0","agent":{"status":"ok"},"sandbox":{"status":"ok"}}

# Sandbox liveness（进程存活；公开路由，无需 API key）
docker compose exec sandbox curl -fsS http://localhost:8081/health
# {"status":"ok"}

# Sandbox readiness（依赖就绪；未就绪时 curl -f 因 503 失败）
docker compose exec sandbox curl -fsS http://localhost:8081/ready
# {"status":"ready","shutting_down":false,"database":"ok","storage":{"workspaces":"ok","tmp":"ok","artifacts":"ok","control":"ok"},"isolation":"ok"}
# 或 HTTP 503 status=not_ready（对应项为 unavailable / unchecked）

# Nginx (生产)
curl -f https://localhost/nginx/status
```

容器 `healthcheck` 当前使用 `/health`（liveness）。编排侧若需“可接流量”语义，应对 Sandbox 使用 `/ready`。

Agent Worker 不发布业务 HTTP 面，探针 listener（`AGENT_WORKER_PROBE_PORT`，默认 `4101`；`AGENT_WORKER_PROBE_HOST` 默认 `0.0.0.0`）只有上表两条路由，其余一律 404，端口不发布到宿主，K8s 中也不应注册到任何 LB。端口值非法时 Worker 拒绝启动。listener 先于容器启动，启动期间 `/ready` 为 503；收到 SIGTERM 后先置为未就绪，再停调度与消费，最后关闭 listener。readiness=false 只会让编排摘流量，因此 Worker 另有依赖守卫：每 `AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS`（默认 5s）用与 `/ready` 相同的 ping 探测 MySQL / Redis，**连续 2 次失败**即 `worker.pause(true)` 停止取新任务（不等待、不打断在跑的任务，在跑的 Run 由既有 lease / fence 兜底），**连续 2 次成功**后 `resume()`，只恢复自己造成的暂停。暂停与恢复各打一行 `[agent-worker]` 日志。`pause(true)` 不会打断 BullMQ 已发出的阻塞取任务，暂停后到达的作业仍可能被取到，因此处理器在执行前再检查一次：消费者暂停中就把作业 `moveToDelayed` 回队列（延后一个探测间隔，不计失败、不消耗 attempts），恢复后再执行。Cron 调度、outbox 发布与恢复扫描不暂停：它们不从队列取任务，依赖故障时单轮失败、下一轮重试。

```bash
docker compose exec agent-worker node -e "fetch('http://127.0.0.1:4101/ready').then(async r=>console.log(r.status, await r.text()))"
```

### Compose smoke path（多轮 / 审批 / 二进制 / 取消 / 产物）

**无真实 LLM key（CI / 本地）：**

```bash
# 启动 deterministic fake OpenAI + Sandbox + Agent + BFF
node scripts/smoke-cross-service.mjs
```

`AGENT_ENABLE_FAKE_LLM` 仅允许 `NODE_ENV`/`DEPLOYMENT_ENV` 非 production；生产启用会在 Agent 配置加载时 fail-closed。

**完整栈（需有效 `LLMIO_*` 或测试用 fake 指向可路由地址）：**

1. `docker compose up --build -d` → 等待 `curl -f localhost:4000/health/ready` 与 `docker compose exec sandbox curl -fsS localhost:8081/ready`
2. 浏览器打开 `http://localhost:3000`，发送多轮消息（同一 conversation）
3. 触发高风险外部副作用 Tool → UI 出现审批 → approve/reject；普通 Sandbox bash 不审批
4. 上传二进制文件 → 下载校验字节一致
5. 生成中点击停止 → 流结束且无悬挂执行
6. Agent `submit_artifact` 后出现可下载交付物（非 `write` 自动下载）
7. 启动后台 `bash` → `/api/processes?session_id=...` 可列出、读日志、发 signal；另一租户访问同一 session/run/process 返回 404

长进程元数据持久化在 MySQL `exec_jobs`，migration 仍由 Agent 启动流程统一执行。
stdout/stderr 增量缓冲和活进程句柄只在当前 exec 进程内：重启后可以看到持久记录，
但不能恢复旧日志字节或重新控制遗留 OS 进程；启动时 orphan recovery 会把未结束记录
收敛为终态。需要跨 exec 重启续读/续控时，应先增加持久日志与可重附着的进程监管，
当前不能把这项写成已支持。

Node / DSH / 模型工具链版本钉以根目录 `runtime-versions.json` 为准：服务镜像与 CI 统一 **Node 22**（`node:22-slim`、`engines >=22.19.0 <23`），Agent 精确钉 DSH **0.1.1-rc.2**；Python 3.11 仅作 pytest 与 exec 镜像内的模型工具链。Pi SDK 已移除，`runtime-versions.json` 只保留其历史钉记录。一致性由 `tests/test_runtime_versions.py` 校验。

## Backup

以下脚本用于常规已上线环境的人工运维，不属于当前研发阶段的全量 reset。执行 [Development reset](runbooks/development-reset.md) 时不得先创建备份或快照。

```bash
# Full backup: MySQL + Session workspaces/tmp + Artifact/control files.
bash scripts/backup.sh
# Output prefix example: ./backups/sandbox-backup-20260719T120000Z
#   .mysql.sql.gz
#   -runtime-files.tar.gz
#   .manifest

# Restore is destructive and temporarily stops data-plane writers.
RESTORE_CONFIRM=restore bash scripts/restore.sh \
  ./backups/sandbox-backup-20260719T120000Z
```

备份脚本只从 Compose 内的 MySQL 服务读取凭据，产物不包含 `.env` 或任何
credential。MySQL 使用 `--single-transaction`；需要数据库与运行文件严格同一
时点的环境，应先在上游入口排空写流量。恢复脚本校验 manifest 和压缩包路径，
停止写服务，恢复 MySQL 与 Session 文件，执行向前 migration，最后重启数据面；
恢复后必须先检查 readiness，再恢复外部流量。

## Monitoring

### 指标

执行面（exec）当前**没有** `/metrics` 端点；旧 Python 执行面的 Prometheus 指标已随其删除。可观测性目前依赖 [Health Checks](#health-checks) 中各进程的 `/ready`、容器日志与下文容器监控。

### 容器监控

```bash
# 资源使用
docker stats pi-enterprise-frontend pi-enterprise-api pi-enterprise-sandbox

# 日志
docker compose logs -f --tail=100 sandbox
docker compose logs -f --tail=100 api-server
docker compose logs -f --tail=100 frontend

# 生产日志（含 Nginx）
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f nginx
```

## Let's Encrypt (Production SSL)

```bash
# 安装 certbot
apt-get install certbot

# 生成证书
certbot certonly --webroot -w /var/www/certbot -d your-domain.com

# 复制到 nginx volume
docker cp /etc/letsencrypt/live/your-domain.com/fullchain.pem nginx:/etc/nginx/ssl/
docker cp /etc/letsencrypt/live/your-domain.com/privkey.pem nginx:/etc/nginx/ssl/

# 重新加载 nginx
docker exec pi-enterprise-nginx nginx -s reload
```

自动续期 cron：
```bash
# /etc/cron.d/certbot-renew
0 3 * * * root certbot renew --quiet && docker exec pi-enterprise-nginx nginx -s reload
```

## Scaling

| 场景 | 推荐方案 |
|------|----------|
| 单实例开发 | MySQL 5.7 + Redis 7 + Docker Compose |
| 生产 | MySQL 8 + Redis 7 + Compose prod overlay（强制 secrets） |
| 多实例 | MySQL + Redis + 共享工作区存储 (NFS/EFS) |
| 高可用 | 负载均衡器 + MySQL 复制 / 托管 MySQL + 托管 Redis |

## Troubleshooting

### Sandbox 容器无法启动

```bash
docker compose logs sandbox
docker compose run --rm sandbox python -c "import fastapi; print('ok')"
```

### API Server 状态异常

```bash
# 检查 API Server 健康
curl http://localhost:4000/health/ready

# 检查 API Server → Sandbox 通信
docker exec pi-enterprise-api curl -f http://sandbox:8081/health

# 重启服务
docker compose restart api-server
```

### Sandbox internal authentication error

```bash
# 仅检查变量名是否存在，不打印值
docker exec pi-enterprise-sandbox sh -c \
  'test -n "$SANDBOX_INTERNAL_HMAC_KEYRING" && test -n "$SANDBOX_INTERNAL_HMAC_ACTIVE_KID"'
docker exec pi-enterprise-agent sh -c \
  'test -n "$SANDBOX_INTERNAL_HMAC_KEYRING" && test -n "$SANDBOX_INTERNAL_HMAC_ACTIVE_KID"'

# 检查独立 replay Redis 与 Sandbox readiness
docker compose ps sandbox-replay-redis sandbox
docker compose exec sandbox curl -fsS http://localhost:8081/ready
```

### 数据库问题

```bash
# 重置数据库（⚠️ 删除所有数据，含 MySQL volume）
docker compose down -v
docker compose up -d

# 备份 MySQL（示例；生产请用受控备份链路）
docker exec pi-enterprise-mysql \
  mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" > backup.sql

# 运行 SQL 查询（交互）
docker exec -it pi-enterprise-mysql \
  mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"
```

## Docker 命令参考

```bash
# 开发
docker compose up --build -d            # 启动所有服务
docker compose logs -f                  # 跟随日志
docker compose down                     # 停止所有服务
docker compose restart                  # 重启所有服务

# 生产
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# 重建单个服务
docker compose build api-server
docker compose up -d api-server

# 清理
docker compose down -v                  # 移除 volumes (⚠️ 删除数据!)
```
