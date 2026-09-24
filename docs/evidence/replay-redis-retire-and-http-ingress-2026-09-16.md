# 退役 replay Redis + 内网 HTTP 入口（2026-09-16）

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线提交 | `refactor/updrdb-dbpm` / `56246536` |
| 未提交改动 | 本次全部改动均未提交（见下「改动清单」） |
| 宿主 runtime | Node v23.11.0（宿主跑测试用）；容器与 CI 钉 Node 22 |
| 重建的镜像 | `pi-enterprise-api:latest`（BFF，Cookie 改动触及运行路径）；边缘 nginx 以 `pi-nginx-modecheck` 标签单独构建验证 |
| **未**重建 | `sandbox` / `sandbox-mcp` / `agent`（`exec/`、`agent/` 源码未改） |
| 替身边界 | 开发栈用 `dbpm-fake` 取密、MySQL 5.7 / Redis 5.0.14 容器；nginx 双模式在独立容器里验证，上游用 `--add-host` 指向不可路由地址（`192.0.2.1`），只验证渲染、启动与配置校验，不验证转发 |

## 一、退役 replay Redis 与同族无消费方变量

**依据**：`SANDBOX_INTERNAL_REDIS_URL`、`SANDBOX_INTERNAL_REDIS_PASSWORD`、
`SANDBOX_INTERNAL_PLANE_ENABLED`、`SANDBOX_INTERNAL_MAX_CONCURRENCY`、
`SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS` 在 `exec/src`、`agent/src`、`contract/src`、
`api-server/src` 中全仓 grep 无任何读取方（ADR 0008 D8 已退役 jti 防重放）。
其中 `SANDBOX_INTERNAL_PLANE_ENABLED` 此前被 `deployment.md` 与
`verify_compose_prod_config.py` 描述为「生产必须 true 的 fail-closed 开关」，实际不接任何闸门。

内部面真实闸门（未改动）：`exec/src/http/app.ts:276-280` 缺 `SANDBOX_INTERNAL_HMAC_KEYRING`
或 `..._ACTIVE_KID` 即拒绝启动；`EXEC_INTERNAL_ALLOW_CIDR` 空值拒绝全部内部面请求。

**渲染后的生产拓扑**（`docker compose -f docker-compose.yml -f docker-compose.prod.yml config`）：

```
services: ['agent', 'agent-worker', 'api-server', 'frontend', 'mysql', 'nginx', 'redis', 'sandbox', 'sandbox-mcp']
volumes:  ['agent_user_skills', 'mysql_data', 'nginx_certbot', 'nginx_ssl', 'redis5_data']
production Compose verification passed
```

`sandbox-replay-redis` 与 `sandbox_replay_redis5_data` 均已不在渲染结果中。

**一处自我修正**：最初在 `verify_compose_prod_config.py` 里加了「退役变量不得出现」的检查，
实测失败——`docker compose config` 会把运维 `.env` 里的历史遗留一并展开，该检查等于拿运维的
旧 `.env` 判编排回归。已改为只校验 keyring / active kid 非空；「不得写回 compose 文件」的棘轮
放在 `tests/test_redis_topology_config.py` 的静态断言上。

## 二、内网 HTTP 入口（`TLS_ENABLED`）+ 会话 Cookie 去掉 `Secure`

### nginx 双模式（独立容器，真实 nginx 1.27-alpine）

TLS 模式（默认）：

```
[entrypoint] Generating self-signed certificate for localhost
[entrypoint] TLS mode — 80 redirects to 443, HSTS enabled
nginx: configuration file /etc/nginx/nginx.conf test is successful
7:    listen 80 default_server;
16:        return 301 https://$host$request_uri;
23:    listen 443 ssl default_server;
24:    http2 on;
27:    ssl_certificate /etc/nginx/ssl/fullchain.pem;
31:    add_header Strict-Transport-Security "max-age=63072000; ..." always;
38:    include /etc/nginx/pi-templates/locations.conf;
证书: fullchain.pem  privkey.pem
```

明文模式（`TLS_ENABLED=false`）：

```
[entrypoint] PLAINTEXT mode (TLS_ENABLED=false) — serving HTTP on 80 only.
[entrypoint] Session cookies and uploads travel unencrypted; use only on a trusted internal network.
nginx: configuration file /etc/nginx/nginx.conf test is successful
8:    listen 80 default_server;
18:    include /etc/nginx/pi-templates/locations.conf;
证书目录: ls: /etc/nginx/ssl: No such file or directory
```

明文模式渲染结果中没有 `ssl_certificate`、`listen 443`、`Strict-Transport-Security`、
`return 301 https`；两种模式 include 同一份 `locations.conf`。

非法值 fail-closed：

```
$ docker run --rm -e TLS_ENABLED=yes <image>
[entrypoint] TLS_ENABLED must be exactly 'true' or 'false' (got 'yes')
→ 退出码非 0，容器不启动
```

**过程中的两处自我修正**（记录以免重蹈）：
1. 首次检查把上游 `frontend` 映射到 `127.0.0.1`，nginx 代理到自己形成回环，命令挂起。
2. 之后用 `docker run <image> sh -c '...'`，但镜像有 `ENTRYPOINT ["/entrypoint.sh"]`，
   `sh -c ...` 成了 entrypoint 的参数而非命令，检查脚本从未执行（容器只是正常跑着 nginx）。
   正确形式是 `--entrypoint sh ... -c '...'`。
3. 首轮验证暴露 `listen ... http2` 在 nginx 1.27 的废弃告警（原配置带进来的），已改为
   `listen 443 ssl;` + `http2 on;` 并重建镜像复验，告警消失。

### 会话 Cookie

真实链路实测 `Set-Cookie`：

```
pi_enterprise_session=<jwt>; Path=/; HttpOnly; SameSite=Lax
```

无 `Secure`；仅凭该 Cookie 调 `/api/auth/me` 返回 200（证明 Cookie 真的被接受，
而不是靠 Authorization 头兜底）。

## 三、真实链路（重建 BFF 镜像 + 重建容器后）

经 BFF `http://127.0.0.1:4000`，脚本 `live-chain.mjs`，**17 / 17 通过**：

| 步骤 | 结果 |
|---|---|
| 注册 / 登录两个租户 | Cookie 无 `Secure`，保留 `HttpOnly` + `SameSite=Lax` |
| 仅凭 Cookie 认证 | `/api/auth/me` 200 |
| 建会话 | `conversation=01M2KZVENCXZSMJ23BY202V17T` `session=01M2KZVENM1SVGGFJ90CHZCXMQ` |
| 一轮带工具的 Run（真实模型） | `SUCCEEDED`，工具台账 `["bash:succeeded"]` |
| 后台进程登记 | `bash-ec24d0695b104f14b00224719448f6f4` `running` |
| 进程 logs | 含 `TICK` |
| SIGTERM | 200 → 进程终态 `cancelled` |
| 跨租户 404 | run 详情 / run 工具台账 / 进程详情 / 进程 logs / 进程列表 / `sessions.ensure` 挂他人会话，**6 项全 404** |
| 拒绝对照 | 同一 run A 本人访问 200（排除「全部 404」的假通过） |

## 四、测试与类型检查

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | **206 passed** |
| `npm test --prefix contract` | 109 pass / 0 fail |
| `npm test --prefix exec` | 401 pass / 0 fail / 2 skipped（403 tests） |
| `npm test --prefix agent` | 1325 pass / 0 fail / **3 cancelled** |
| `npm test --prefix api-server` | 158 pass / 0 fail / **2 cancelled** |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npm run build --prefix frontend` | 通过 |
| 类型检查 | contract / exec / api-server / agent（主程序 + `src/runtime` strict）全部通过 |
| Compose | dev `config -q` 通过；prod overlay 渲染 + `verify_compose_prod_config.py` 通过 |

**cancelled 的 5 例不记为通过**：agent 3 例（`tests/runtime/remote-providers.test.ts` 的
remote-shell / exec-rpc）与 api-server 2 例（`tests/file-proxy-workspace-id.test.js`）是宿主
Node v23.11.0 下的已知组（AGENTS.md 与既往记录均有），与本次改动无关，本次未复现新增失败。

## 五、环境限制与未覆盖项

- dev `docker compose config` 需带 `MYSQL_DATA_VOLUME=mysql57_dev_data REDIS_DATA_VOLUME=redis5_dev_data`
  才能通过：本机 `.env` 仍钉着旧卷名（既有问题，非本次引入）。本机 `.env` 里也仍有 5 个退役变量，
  按 CHANGELOG 的升级说明应手工删除。
- nginx 双模式只在独立容器中验证渲染 / 启动 / 配置校验；**未**在生产 overlay 下真实转发，
  也**未**做浏览器实际访问明文入口的端到端验证。
- 真实链路直连 BFF `:4000`，未经过边缘 nginx。
- 目标环境（真实 UPDRDB / UPRedis / DBPM / 双集群 / 麒麟 VM）验收仍未做，与本次改动无关。
