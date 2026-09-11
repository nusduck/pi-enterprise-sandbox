# 内网部署拓扑：K8s 双集群 + 裸装虚拟机

| 字段 | 值 |
|---|---|
| 日期 | 2026-09-08 起草，2026-09-09 定稿，**2026-09-10 按新环境事实重写** |
| 状态 | **拓扑与决策已定**；**VM 侧按「bwrap 可行」的假设推进**（2026-09-11 起，见 §4.0）；装机清单待体检回填（§4.3），另见 §8 待确认 |
| 环境 | 公司 K8s 容器平台**双集群**（CI/CD 打镜像 → 面板配参，跨集群一律经 LB）+ 一台独立虚拟机（**裸装，不用 Docker**） |
| 关联 | [数据库改造方案](./migration-plan.md)、[ADR 0011](../../adr/0011-updrdb-upredis-dbpm-migration.md)、[`probe/vm_preflight.sh`](./probe/vm_preflight.sh) |

> **2026-09-10 相对 09-09 版的四处推翻**，逐条见对应小节：
> ① 内网环境不考虑抓包，TLS 与明文重放相关结论整体简化（§2 D3）；
> ② 双集群，服务间通信走 LB，不是单集群 Service 短名（§3.3）；
> ③ VM **不装 Docker**，执行面裸装在宿主机（§4）；
> ④ `sandbox-mcp` **回到 K8s** 做容器隔离，不再与执行面同机（§2.1）。

---

## 1. 部署形态

```
              浏览器              外部 MCP (UPAgent)         外部 A2A
                 │                       │                     │
            LB(frontend)           LB(sandbox-mcp)          LB(agent)
                 │                       │                     │
     ┌───────────┴───────────────────────┴─────────────────────┴──────┐
     │   每条 LB 的后端同时挂 集群A / 集群B 的同名 Service（跨集群靠它）  │
     └────────┬────────────────────────────────────────┬──────────────┘
              │                                        │
  ┌─ K8s 集群 A ──────────────┐            ┌─ K8s 集群 B ──────────────┐
  │  frontend      :80         │            │  frontend      :80         │
  │  api-server    :4000       │            │  api-server    :4000       │
  │  agent         :4100       │            │  agent         :4100       │
  │  agent-worker  （无 HTTP）  │            │  agent-worker  （无 HTTP）  │
  │  sandbox-mcp   :8082 slim  │            │  sandbox-mcp   :8082 slim  │
  └────────────┬───────────────┘            └───────────────┬──────────┘
               │            LB(sandbox) → 10.201.37.39:8081 │
               └──────────────────────┬─────────────────────┘
                                      ▼
  ┌─ 虚拟机 vm-10-201-37-39（银河麒麟 V11 / x86_64 / 裸装，无容器）──────┐
  │                                                                    │
  │  sandbox = node dist/main.js  :8081   systemd 托管，非 root 账号     │
  │  bubblewrap 直接装在宿主机；工作区 / tmp / 产物字节落本地盘           │
  │  **全栈唯一有状态的服务**                                            │
  └────────────────────────────────────────────────────────────────────┘
        │                    │              │
        ▼                    ▼              ▼
   UPDRDB(×2 proxy)   UPRedis(×2 实例)    DBPM(×2)
```

### 部署单元

| 位置 | 单元 | 副本 | 交付物 | 入口 |
|---|---|---|---|---|
| K8s ×2 集群 | `frontend` | 2 | `pi-enterprise-frontend`（69MB） | 镜像默认 |
| K8s ×2 集群 | `api-server` | 2 | `pi-enterprise-api`（403MB） | 镜像默认 |
| K8s ×2 集群 | `agent` | 2 | `pi-enterprise-agent`（965MB） | `["node","dist/server.js"]` |
| K8s ×2 集群 | `agent-worker` | 2 | **同上** | `["node","dist/worker.js"]` |
| K8s ×2 集群 | **`sandbox-mcp`** | 2 | **`pi-enterprise-mcp`（新增 slim 目标，~300MB）** | `["node","dist/mcp-main.js"]` |
| **VM** | **`sandbox`** | 1 | **无镜像 —— 裸装 `dist/` + `node_modules`** | `node dist/main.js` |

**不部署**：`enterprise-sandbox-nginx`（§3.4）、`agent-migrate`（[P0-5](./migration-plan.md)）。
**生产不再需要 `enterprise-sandbox` 那个 2.83GB 镜像** —— VM 裸装了，它只在本地 compose 开发时构建。

> `agent` 与 `agent-worker` 仍是同镜像不同入口的两个 Deployment，
> **不是**一个容器里跑两个进程。

---

## 2. 已锁定的决策

| # | 决策 | 依据 |
|---|---|---|
| D1 | **`sandbox` 部署在虚拟机，裸装** | 它是全栈唯一有状态的服务（工作区字节在本地盘），且需要 bubblewrap 建 user/mount namespace。裸装后**不再需要** `cap_add` / 自定义 seccomp / `apparmor=unconfined` / `systempaths=unconfined` —— 那四样本来就是为绕开 Docker 自身的限制而加的 |
| D2 | **`sandbox-mcp` 回到 K8s，容器部署** | **09-09 版的反转**，见 §2.1 |
| D3 | **不做 TLS** | 全部部署在内网，不考虑抓包威胁。原 §5 的明文重放风险表已整体删除 |
| D4 | **入口用 TCP(L4) LB** | L7 常见默认缓冲会卡住 SSE；不做 TLS 时 L7 的主要优势用不上 |
| D5 | **不部署边缘 nginx** | 浏览器只访问 `/api/*`，frontend 内置 nginx 已够（§3.4） |
| D6 | **A2A 对外暴露，整端口 L4** | 不考虑抓包后，无需为隔离 `/internal/*` 而拆双监听端口或上 L7。见 §3.3 注 |

### 2.1 为什么 `sandbox-mcp` 从 VM 挪回 K8s

09-09 版把它放 VM，理由是两条；**这两条在新环境事实下都已失效**：

| 09-09 的理由 | 现在为什么不成立 |
|---|---|
| 与 `sandbox` 共用 2.83GB 镜像，只拉一次 | VM **裸装了，没有镜像可共用** |
| 静态窄桥 token 不跨机、不过网 | **不考虑抓包**（D3），跨机明文不再是待处理项 |

反过来，裸装形态下把它留在 VM 反而**丢掉了它原有的全部隔离**：与执行面同一个
uid、同一个文件系统、同一个进程空间——而它恰恰是**对外入口**，执行面跑的又是
不受信的模型代码。原 compose 里的 `cap_drop: ALL` + `no-new-privileges` +
零 volumes + `user 10001:10001` 在裸装下一条都留不住。

它进 K8s 没有任何技术阻碍（已核代码）：

- `exec/src/mcp/` 六个文件**零 `node:fs`、零 `child_process`**；
  唯一能碰到执行面的通道是 `bridge-client.ts` 的 HTTP 调用
- 指向执行面的地址本来就是环境变量，**零代码改动**：
  `SANDBOX_MCP_SANDBOX_BASE_URL: http://sandbox:8081` → VM 的 LB 地址
- 它依赖的只有服务 Redis 与该 Redis 的 DBPM 口令，K8s 侧都够得到

**代价是要新增一个精简镜像目标**（§7 W4）：现在它与执行面共用的 2.83GB 里
85% 用不到（chromium / LibreOffice / Python venv / bun 都是给模型执行代码用的），
而它运行期只 import `@modelcontextprotocol/sdk`、`hono`、`ioredis`、`zod`。
把这些堆在对外入口上与隔离初衷相悖。

---

## 3. K8s 侧配置

### 3.1 Deployment 与 Service 要分别建

compose 写一个 `services:` 条目，容器与服务名 DNS 一起就有了。
K8s 拆成两个对象：**Deployment** 管跑几个 pod，**Service** 管别人怎么找到它们。
**只建 Deployment 不建 Service，别人寻不到。**

| 工作负载 | Deployment | Service | LB | 谁调用它 |
|---|---|---|---|---|
| `frontend` | ✅ | ✅ | ✅ | 浏览器 |
| `api-server` | ✅ | ✅ `api-server:4000` | ✅ | frontend 的 nginx |
| `agent` | ✅ | ✅ `agent:4100` | ✅ | api-server；外部 A2A |
| `agent-worker` | ✅ | ❌ **不需要** | ❌ | 没人调用它 —— 只消费 Redis 队列，无 HTTP 面 |
| `sandbox-mcp` | ✅ | ✅ `sandbox-mcp:8082` | ✅ | 外部 MCP 客户端（UPAgent） |
| `sandbox`（VM） | ❌ 不在 K8s | — | ✅ 指向 `10.201.37.39:8081` | agent / agent-worker / api-server / sandbox-mcp |

> 09-09 版给 VM 上的 `sandbox` 设计了「无 selector Service + 手工 EndpointSlice」，
> **现已不需要** —— 既然跨集群一律走 LB，直接给它一条 LB 条目，
> 两个集群把 `SANDBOX_BASE_URL` 指向同一个 LB 地址即可，配置对称。

### 3.2 Service 命名与 frontend 的写死上游

> ⚠️ `frontend/nginx.conf:14` 的 `proxy_pass http://api-server:4000` **烤在镜像里**，
> 不是环境变量。双集群下若要求它指向 LB VIP，**必须改镜像**。

| 名字来源 | 服务名 | 可改性 |
|---|---|---|
| `frontend/nginx.conf`（**烤进镜像**） | **`api-server`** | ❌ 需参数化，见 §7 W3 |
| `AGENT_BASE_URL` | `agent` | ✅ 环境变量 |
| `SANDBOX_BASE_URL` | `sandbox` | ✅ 环境变量 |
| `SANDBOX_MCP_SANDBOX_BASE_URL` | `sandbox` | ✅ 环境变量 |

处理办法（W3）：`nginx:alpine` 自带 `/etc/nginx/templates/*.template` 的 envsubst
入口，把上游改成 `${API_UPSTREAM}`、默认值保持 `http://api-server:4000`，
两种模式都能跑。**务必同时设 `NGINX_ENVSUBST_FILTER`**，否则配置里的
`$host`、`$remote_addr`、`$proxy_add_x_forwarded_for` 会被一起替换成空。

- **同 namespace 才能用短名**；跨 namespace 要写 `api-server.<namespace>`。
- **端口要对上**：Service 的 `port` = 4000，`targetPort` 指向 pod 的 4000。

### 3.3 LB 条目：每个被跨集群调用的服务各一条

09-09 版按单集群写，结论是「最少 1 条」；**双集群下作废**。集群内 Service 通信可用，
**跨集群不可用**，因此凡是会被另一集群或集群外调用的，都要有 LB 条目：

| 服务 | LB 条目 | 说明 |
|---|---|---|
| `frontend` | ✅ 配域名 | 浏览器入口 |
| `api-server` | ✅ | 东西向也经 LB |
| `agent` | ✅ | 兼作 A2A 对外入口（D6） |
| `sandbox-mcp` | ✅ | 对外 MCP 入口，8082 |
| `sandbox`（VM） | ✅ | 后端 `10.201.37.39:8081` |
| `agent-worker` | ❌ | 无 HTTP 面 |

**共 5 条。** LB 指向 Service 不指向 pod；每条 LB 的后端同时挂两个集群的同名 Service。

> **A2A 整端口暴露的含义**：`agent:4100` 是单端口混合面
> （`agent/src/bootstrap/create-http-server.ts:145-172`）——`/.well-known/agent-card.json`
> 与 `/a2a/*` 是公开面自带凭据鉴权，`/internal/*` 是控制面，由静态
> `X-Internal-Token` 守（`internal-auth.ts:61-72`，常量时间比较，空 token fail-closed）。
> 暴露 4100 等于把 `/internal/*` 一并放到 LB 可达面上。按 D3 内网前提接受，
> **但 LB 的来源白名单仍应收窄到实际的 A2A 调用方**。

### 3.4 入口为什么不需要额外的 nginx

已核实**浏览器只访问 `/api/*`**（`frontend/src` 里出现的路径只有 `/api/`、
`/api/runs`、`/api/cron-jobs`），frontend 镜像内置的 nginx 已经代理了它，
且该有的配置都有：

| 配置 | 值 | 为什么要 |
|---|---|---|
| `proxy_buffering off` | — | **SSE 生死线**；开着会让 Run 事件流卡住 |
| `proxy_request_buffering off` | — | 大文件流式上传不落缓冲 |
| `client_max_body_size 55m` | 对齐 BFF 上限 | 否则正常附件 413 |
| `proxy_read/send_timeout 300s` | — | **SSE 心跳 15 秒**（`DEFAULT_SSE_HEARTBEAT_MS`），300s 远够 |

**TCP(L4) vs HTTP(L7) LB**：L4 只转发字节流、不解析 HTTP，**不会缓冲、不干扰 SSE**，
但不能按路径分流；L7 认识 Host/路径、可终止 TLS，但常见默认缓冲会卡住 SSE。
不做 TLS 时选 L4。

### 3.5 健康探针

| 服务 | 端点 | 探针 |
|---|---|---|
| `frontend` | 无（镜像未配） | `httpGet :80/` |
| `api-server` | `/health/live`、`/health/ready` | live / ready 分别指 |
| `agent` | `/health` | `httpGet :4100/health` |
| `sandbox-mcp` | `/health` | `httpGet :8082/health`。**slim 镜像里没有 `curl`**，若沿用容器 HEALTHCHECK 需改 `node -e "fetch(...)"`（照抄 compose 里 sandbox 那条） |
| **`agent-worker`** | **无任何 HTTP 面** | ❌ **见 §7 W1** |
| `sandbox`（VM） | `/health` | 不在 K8s；由 systemd + LB 健康检查兜 |

### 3.6 `api-server` 需要可写的 `/tmp`

`api-server/src/routes/files.ts:227` 的 `spillRequestToTempFile()` 会把上传体
**流式落到 pod 本地临时文件**（`mkdtemp(tmpdir())`，上限 60MB），避免大文件进 Node 堆。
这是请求级临时文件，不破坏无状态性，但要求：

| 配置 | 要求 |
|---|---|
| `readOnlyRootFilesystem` | 若开启，**必须给 `/tmp` 挂 `emptyDir`** |
| `emptyDir` 容量 | 按 **并发上传数 × 60MB** 估算 |

**配错的症状是上传报错而非启动失败**，较难排查。

### 3.7 无状态核查（全部通过）

| 服务 | 无状态 | 依据 |
|---|---|---|
| `frontend` | ✅ | 纯静态 |
| `api-server` | ✅ | 认证委托给 agent `/internal/auth/*`，自身不存会话 |
| `agent` | ✅ | SSE 服务注释明写 **"No process-local event buffer as state source"**；事件源是 MySQL `run_events`（权威）+ Redis `run:stream`（加速），断线用 `Last-Event-ID` / `afterSequence` 游标续传 |
| `agent-worker` | ✅ | Worker Lease 在 Redis（TTL 30s／续约 10s，本就为多 worker 设计）；outbox 用 `claim_token` 抢占，多 publisher 并发安全 |
| `sandbox-mcp` | ✅ | context 创建用 Redis `SET NX EX` 锁 + CAS 释放，并发安全；零 volumes |
| **`sandbox`** | ❌ **有状态** | 工作区 / tmp / 产物字节在 VM 本地盘 |

**唯一有状态的服务正是上 VM 的那个 —— 拆分从状态角度看是正确的。**
另核查过：全仓模块级 `new Map()/new Set()` **都是常量**（状态枚举、denylist），无可变跨请求缓存；
DSH 会话状态已外置（`mysql-session-store.ts` 落 MySQL，会话锁在 Redis）。

- **SSE 不需要会话粘滞**（有游标续传，重连到任意 pod、任意集群都能接上）
- **双集群下 `agent-worker` 共抢同一个 Redis 队列**是设计内的，无需额外协调
- **`sandbox` 将来若要多台 VM**，workspace 在本地盘，需改共享存储或按
  `workspace_id` 亲和路由。**当前单 VM 无此问题，但别顺手加副本数**

---

## 4. VM 侧部署（裸装，无容器）

### 4.0 当前前提：bwrap 可行是**假设**，不是结论

| 项 | 值 |
|---|---|
| 设定日期 | **2026-09-11** |
| 假设内容 | 银河麒麟 V11 上 bubblewrap 可用——`user.max_user_namespaces > 0`，且 KySec / SELinux 不拦 namespace 与 mount |
| 为什么是假设 | **机器尚未到手**，[`probe/vm_preflight.sh`](./probe/vm_preflight.sh) 一次都没在目标环境跑过 |
| 验证时点 | 预计 2026-09 第 3 周提供体检结果 |
| 假设不成立的后果 | **VM 方案整体重谈**，不是调参数——`exec/src/isolation/` 只实现了 bubblewrap 一个后端，`SANDBOX_ISOLATION_REQUIRED=true` + preflight fail-closed，bwrap 起不来即执行面拒绝服务，无降级路径 |

> 按 AGENTS.md §3／§5：本节以下内容是**在该假设下的设计**，不是已验证事实。
> 体检结果到手后，无论通过与否都必须回来更新本节与 §4.3、§4.4，
> 并把输出归档到 `docs/evidence/`。**在那之前不要在别处把 VM 形态写成既定事实。**

### 4.1 机器档案

| 项 | 值 |
|---|---|
| 主机名 / 地址 | `vm-10-201-37-39` / `10.201.37.39` |
| 登录账号 | `tlmoflas`（**无 root**） |
| 系统 | 银河麒麟高级服务器操作系统 V11（Swan25，构建档 v2505），**RPM 系，用 `dnf`** |
| 内核 | `6.6.0-32.13.v2505.ky11.x86_64`，社区 LTS 6.6 + 麒麟补丁，`PREEMPT_DYNAMIC` |
| 架构 | x86_64（bun / uv / chromium 预编译二进制均有现成版本） |

### 4.2 裸装形态的三个关键结论

**(a) Docker 那四样特权配置全部不需要了。** `cap_add`(CHOWN/FOWNER/SETUID/SETGID/KILL)、
自定义 seccomp、`apparmor=unconfined`、`systempaths=unconfined` —— 全是为绕开 Docker
默认 seccomp 挡 namespace 系统调用、docker-default AppArmor 挡 mount 而加的。
裸机上没有那一层，普通账号 + 内核 unprivileged user namespace 就够 bwrap 跑。

**(b) `setpriv` 不是硬依赖。** `exec/src/isolation/bubblewrap.ts:99-105` 先读
`/proc/self/status`，进程确实带 capabilities 才去找 `setpriv`；裸机上普通账号跑 node，
`CapInh`/`CapAmb` 为空，直接返回空前缀。装上无害，缺了不会 fail-closed。

**(c) 两个宿主机绝对路径是硬编码的，必须原样建。**

```
exec/src/isolation/profile.ts:178   AGENT_PYTHON_VENV   = '/opt/pi-python/venv'
exec/src/shell/safe-env.ts:48       BAOYU_CHROME_PATH   = '/usr/local/bin/baoyu-chromium'
```

`build.ts:146-147` 是 `source` 与 `target` **同路径** bind 进沙箱的，装到别处不生效。
（`/home/sandbox/workspace`、`/home/sandbox/skill` 那些是 bwrap **沙箱内**的逻辑路径，
宿主机不用建。）

### 4.3 装机清单 —— 待体检回填

> **先跑体检再提工单。** [`probe/vm_preflight.sh`](./probe/vm_preflight.sh) 是纯 bash、
> 零依赖、只读、不需要 root，在 VM 上以 `tlmoflas` 直接跑：
>
> ```bash
> bash vm_preflight.sh > preflight-vm-10-201-37-39.txt 2>&1
> ```
>
> 它的第 4 节用 `exec/src/isolation/render.ts` 生产路径下发的**同一组 flag** 实测
> bubblewrap，分三步（user namespace + uid 映射 → 私有 `/proc` → 完整全集），
> 失败时能指出卡在哪一层。
>
> **回填位**：结果出来后，把下表的「源里有无 / 版本 / 备注」列补齐，
> 并把体检输出归档到 `docs/evidence/`（AGENTS.md §6：只新增，不改写）。

| # | 事项 | 需 root | 源里有无 | 备注 |
|---|---|---|---|---|
| 1 | Node **22.x**（版本以 `runtime-versions.json` 为准） | 视方式 | _待填_ | 麒麟源大概率只有 18/20。**官方 tarball 解到 `/opt` 不需要 root**，可自助 |
| 2 | `bubblewrap` | ✅ | _待填_ | bwrap 本体 |
| 3 | `util-linux`（提供 `setpriv`） | ✅ | _待填_ | 见 4.2(b)，非硬依赖 |
| 4 | `git` / `curl` / `tar` | ✅ | _待填_ | |
| 5 | Python 3 + **`/opt/pi-python/venv`**（uv 装 `exec/requirements.txt`） | ✅ | _待填_ | 路径硬编码，见 4.2(c) |
| 6 | chromium + **`/usr/local/bin/baoyu-chromium`** 包装脚本 | ✅ | _待填_ | 麒麟包名可能是 `chromium-browser`，也可能没有 |
| 7 | LibreOffice（转换用） | ✅ | _待填_ | |
| 8 | `tesseract` + **中文包 `chi_sim`** | ✅ | _待填_ | |
| 9 | `pandoc` | ✅ | _待填_ | **麒麟源大概率没有**，可能要离线搬 |
| 10 | `poppler-utils`（`pdftotext`） | ✅ | _待填_ | |
| 11 | CJK 字体 | ✅ | _待填_ | 不是 `fonts-noto-cjk`，RPM 系叫 `google-noto-*-cjk-fonts` 或文泉驿 |
| 12 | 全局 npm 包：`bun`、`docx`、`pptxgenjs`、`autocorrect` | 视方式 | _待填_ | 对应 `exec/Dockerfile:30` |
| 13 | sysctl 开 unprivileged user namespace 并持久化 | ✅ | _待填_ | **麒麟基于主线内核，参数名是 `user.max_user_namespaces`**，不是 Debian 补丁特有的 `kernel.unprivileged_userns_clone`——工单写错名字会被打回 |
| 14 | 数据目录（workspaces / tmp / artifacts / control / skill-draft）并 chown 给 `tlmoflas` | ✅ | _待填_ | 裸装下运行账号就是 `tlmoflas`，不再是 uid 10001 |
| 15 | systemd unit（`node dist/main.js`）；或 `loginctl enable-linger tlmoflas` 后用 user unit | ✅ | _待填_ | 体检第 9 节会报 linger 状态。**若已开 linger 可自助托管，省一轮工单** |
| 16 | 防火墙：8081 只对两个集群的出口网段 | ✅ | _待填_ | VM 不再有 8082（`sandbox-mcp` 已挪走） |

### 4.4 未决风险：麒麟的强制访问控制

麒麟服务器版带**自己的强制访问控制（KySec）**，可能还开着 SELinux。这两个都可能
拦掉 bwrap 的 mount / namespace 操作——与 Docker 那层 seccomp/AppArmor 是同类问题，
只是换了实现。**必须实测，不能推断**；体检脚本第 3、4 节就是为此设计的。

另一项待实测：`SANDBOX_BWRAP_UID` / `SANDBOX_BWRAP_GID` 默认值是 **10001**，
而裸装运行账号 `tlmoflas` 的 uid 不是。`render.ts:48` 下发的是
`--unshare-user --uid 10001 --gid 10001`；非特权 user namespace 里只能映射当前 uid，
理论上映射到 10001 可行，但**必须实测**（体检第 4.1 步直接回答这个问题）。

### 4.5 产物怎么上机

没有镜像了，两条路，**先定哪条**（§8）：

| 方式 | 前提 | 说明 |
|---|---|---|
| VM 上构建 | 内网 npm registry + PyPI + 麒麟 dnf 源齐备 | `npm ci` + `tsc`，与 CI 一致性最好 |
| 离线搬运 | 无内网源时唯一选择 | 打包 `exec/dist` + `contract/dist` + `node_modules` 整体搬；注意 `node_modules` 里若有原生模块需在**同架构同 libc** 下编译 |

---

## 5. 网络与端口

### K8s 侧出向

| 从 | 到 | 端口 | 用途 |
|---|---|---|---|
| agent / agent-worker | UPDRDB proxy ×2 | DBAAS 端口 | 账本读写 |
| agent / agent-worker | UPRedis（服务实例） | 6379 | 队列 / 租约 / 事件流 |
| agent / agent-worker / api-server / **sandbox-mcp** | **sandbox VM**（经 LB） | 8081 | 见下 |
| agent / agent-worker | **LLM 网关** | — | §6.1 |
| **sandbox-mcp** | UPRedis（**服务实例**） | 6379 | context / artifact 元数据 |
| agent / agent-worker / **sandbox-mcp** | **DBPM ×2** | 7000 | 取口令（`dbpm_egress` 窄网络） |

### VM 侧出向

| 从 | 到 | 端口 | 用途 |
|---|---|---|---|
| sandbox | UPDRDB proxy ×2 | DBAAS 端口 | `exec_*` 表 |
| sandbox | UPRedis（**replay 实例**） | 6379 | 内部 HMAC jti 防重放 |
| sandbox | DBPM ×2 | 7000 | 取口令，**VM 侧 2 组**：UPDRDB + replay Redis |

> **DBPM 口令总数仍是 3 组，但取密方位置变了**：服务 Redis 那组随 `sandbox-mcp`
> 移到 K8s 侧取。DBPM 的出网白名单要按新位置配。

### VM 侧入向

| 端口 | 来源 | 说明 |
|---|---|---|
| **8081** | 仅两个 K8s 集群的出口网段（经 LB） | sandbox 内部面。**绝不对公网/办公网暴露** |

`SANDBOX_ALLOWED_CLIENT_CIDRS` 要覆盖两个集群的出口网段（当前默认是 RFC1918 全段，生产应收窄）。
**8082 已不在 VM 上** —— `sandbox-mcp` 移入 K8s 后，对外 MCP 入口是它自己的 LB。

### 跨机调用的凭据

不做 TLS（D3，内网不考虑抓包）。各面的凭据强度记录如下，仅供了解，不作为待处理项：

| 调用方 | 面 | 凭据 |
|---|---|---|
| `agent` / `agent-worker` | sandbox `/internal/v1/*` | HS256 JWT，签 `htm`+`htu`+`body_sha256`+`jti`+`exp ≤ 120s`，jti 单次消费 |
| `sandbox-mcp` | sandbox `/internal/mcp/v1/*` 窄桥 | 静态 token（既非 `SANDBOX_API_TOKEN` 也非 HMAC 材料） |
| `api-server` | agent `/internal/*` | 静态 `X-Internal-Token`，常量时间比较 |
| `api-server` | sandbox 公共会话面 | 会话 bearer |

> 将来若要加密：**应用侧零代码改动** —— 全仓没有任何地方校验或写死 `http://`
> （`exec-rpc.ts:296` 直接 `new URL(baseUrl + htu)`）。把相关 `*_BASE_URL` 改成
> `https://`，私有 CA 用 `NODE_EXTRA_CA_CERTS` 即可。

---

## 6. 内网环境的其他事项

### 6.1 LLM 网关：默认值有隐患

`LLMIO_BASE_URL` 已支持指向内部网关（`.env.example:26` 注明"OpenAI 兼容网关"）。
**但代码里有公网兜底值**：

```
agent/src/runtime/boot.ts:62
  LLMIO_BASE_URL ?? DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
```

（`cordis.patch.yml:28`、`plugins/render.ts:54` 各有一份同样的兜底。）

内网环境配置漏了 → **不是启动失败，而是静默尝试连公网**。
按 AGENTS.md §2「配置缺失必须关闭能力」，**建议改成 fail-closed 拒绝启动**（§7 W2）。

### 6.2 构建期的内网来源

| 位置 | 拉什么 | 目标形态 |
|---|---|---|
| frontend / api-server / agent Dockerfile | `node:22-slim`、`nginx:alpine` 基础镜像 | K8s，需内网 registry |
| 同上 | `npm ci`（npm registry） | K8s |
| **新增 slim MCP 目标** | 复用 `ts-build` 阶段产物 | K8s，~300MB |
| **VM 裸装** | 见 §4.3 清单 —— **RPM 系，`dnf` 不是 `apt`** | 麒麟源或离线搬运 |

> `runtime-versions.json` 已注明 Skill 工具「构建镜像时安装，执行期不得联网下载」——
> 这条设计对内网有利：**运行期不需要 npm/PyPI**。

### 6.3 MCP server 清单

`MCP_SERVERS_JSON` 默认 `[]`，`.env.example` 的示例指向公网（`mcp.exa.ai` 等）。
内网部署要么留空，要么只配内网 MCP server。清单**只来自进程环境变量**，不进提交的 YAML。

### 6.4 探针脚本依赖

`probe/updrdb_probe.py` 与 `updrdb_recheck.py` 需要 **PyMySQL**，内网无 PyPI 时把
`pymysql` 包目录拷到脚本旁边即可（纯 Python）。其余探针零依赖，
`vm_preflight.sh` 是纯 bash。

---

## 7. 新增工作项

| # | 项 | 说明 |
|---|---|---|
| **W1** | **给 `agent-worker` 加健康端点** | 它没有 HTTP 面，K8s 探针无处可指。建议加一个内部端口的 `/health`，返回 Redis/MySQL 连通性 + 最近队列心跳。用 `exec` 探进程只能判"进程在不在"，**卡死的 worker 会被判为健康** |
| W2 | LLM 网关兜底改 fail-closed | §6.1 |
| **W3** | **frontend nginx 上游参数化** | `proxy_pass` 烤在镜像里（§3.2）。改 `/etc/nginx/templates` + `${API_UPSTREAM}`，默认值不变；**必须设 `NGINX_ENVSUBST_FILTER`**，否则 `$host` 等会被替换成空 |
| **W4** | **`exec/Dockerfile` 加 slim MCP 构建目标** | `ts-build` 阶段产物即全部所需，约 8 行、成品 ~300MB。两个坑：**(a)** 现终态镜像是匿名 stage，需先命名（如 `AS runtime`）再用 `--target` 分别构建，否则默认目标被抢；**(b)** slim 里没有 `curl`，健康检查改 `node -e "fetch(...)"` |
| **W5** | **跑 `probe/vm_preflight.sh` 并回填 §4.3** | **等机器到手**（预计 2026-09 第 3 周），不阻塞其它工作项；回答 KySec 与 `SANDBOX_BWRAP_UID=10001` 两个未决项。在此之前 VM 侧按 §4.0 的假设推进 |

（数据库改造的 P0 项见 [migration-plan.md](./migration-plan.md)，与本文独立。）

---

## 8. 待确认

| # | 事项 | 影响 |
|---|---|---|
| 1 | **VM 体检结果**（W5）——KySec / SELinux 是否拦 bwrap、`--uid 10001` 是否可用、麒麟源缺哪些包 | **机器未到手，预计 2026-09 第 3 周**。阻塞 §4.3 装机工单；在此之前按 §4.0 的假设推进 |
| 2 | **产物上机方式**：VM 上构建 vs 离线搬运（§4.5） | 决定是否需要内网 npm / PyPI / dnf 源 |
| 3 | **副本数 2 的含义**：每集群 2 个 pod，还是两集群合计 2 个 | 容量与故障域规划 |
| 4 | VM 规格：CPU / 内存 / 磁盘配额（要跑用户代码） | 容量规划；体检第 8 节会报当前值 |
| 5 | 内部 LLM 网关地址与鉴权方式 | 模型调用（§6.1 / W2） |
| 6 | A2A 实际调用方范围 | 决定 `agent` LB 的来源白名单收到多窄（§3.3 注） |
