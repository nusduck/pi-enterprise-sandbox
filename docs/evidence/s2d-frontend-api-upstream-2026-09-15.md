# 验证记录：S2d frontend nginx 上游 `API_UPSTREAM` 模板化

日期：2026-09-15。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §2.2、§7 配置表与 §11 S2。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`72fdf5bd` + 本次未提交改动（随本证据同一 commit） |
| 卫生测试 | 宿主 `uv run pytest`（Python 3.11）；钩子脚本经宿主 `sh` 真实执行 |
| 运行栈 | 开发 Compose + `updrdb-sim` + `upredis-sim`（同 S2c 证据）；链路客户端 `node:22-slim` |
| 镜像（重建，容器已换新） | `pi-enterprise-frontend` `397f51f3c415`（`nginx:alpine`，构建时 nginx/1.31.5）；其余服务未改动 |

## 改动要点

- `frontend/nginx.conf` → `frontend/nginx/default.conf.template`，`proxy_pass ${API_UPSTREAM};`，其余指令（55MB、300s、SSE 与上传不缓冲、SPA fallback）不变。
- `frontend/Dockerfile`：模板放进 `/etc/nginx/templates/`；`ENV API_UPSTREAM=http://api-server:4000`、`NGINX_ENVSUBST_FILTER=^API_UPSTREAM$`；删除官方 `conf.d/default.conf`；以 0755 放入两个钩子。
- `05-validate-api-upstream.sh`：只接受 `http://host[:port]`，拒绝空值、多行、路径、query、空白、`;`、`$`、`https://`、端口越界。
- `25-verify-rendered-config.sh`：渲染文件必须存在、无 `${API_UPSTREAM}` 残留、且含 `proxy_pass <本次值>;`。
- 开发 Compose `frontend` 传入 `API_UPSTREAM`（默认同镜像）；`.env.example`、`deployment.md`（新增小节，并删除不存在的 exec Prometheus 指标描述）、`architecture.md`、`webui.md`、README、design §2.2、CHANGELOG。

## 验证结果

| 项 | 环境 / 命令 | 结果 |
|---|---|---|
| 模板与钩子测试 | 宿主 `uv run pytest -q tests/test_frontend_nginx_template.py` | 通过（首轮 1 例失败：模板注释含变量名导致核对误报，改为只匹配 `${API_UPSTREAM}` 字面量后通过） |
| 仓库卫生 | 宿主 `uv run pytest -q` | 150 passed（含新增 27 例） |
| frontend 构建 | `docker compose build frontend`（镜像内 `npm ci` + `npm run build`） | 通过；本次无前端源码改动，未重跑 frontend 单测 |

## 镜像行为（一次性容器）

| 场景 | 结果 |
|---|---|
| `API_UPSTREAM=http://api-server:4000/api` | 退出码 1，`05-validate`：must be http://host[:port] … |
| `API_UPSTREAM=https://api-server:4000` | 退出码 1，同上 |
| `API_UPSTREAM='http://api-server:4000; return 200 x'` | 退出码 1，同上 |
| `--user 101:101`（`conf.d` 不可写） | 官方钩子打 `ERROR … not writable` 后继续；`25-verify`：`default.conf was not rendered from the template`，退出码 1 |
| `--read-only`（root） | 官方钩子写文件失败，`set -e` 退出码 1（本场景由官方脚本自身拦下，未走到 `25-verify`） |
| `API_UPSTREAM=http://bff-lb.internal:8080` | 正常启动；`nginx -T`：`proxy_pass http://bff-lb.internal:8080;`，`$host` / `$remote_addr` / `$proxy_add_x_forwarded_for` / `$uri` 原样保留 |

## 运行栈（新镜像）

| 检查 | 结果 |
|---|---|
| 容器日志 | `25-verify-rendered-config.sh: rendered config verified`；`nginx -T` 为 `proxy_pass http://api-server:4000;` |
| `GET 127.0.0.1:3000/`、`/settings` | 200 / 200（SPA fallback） |
| `GET /api/auth/me`（未登录） | 经 frontend 与直连 BFF 均为 401 `INVALID_TOKEN` |

## 真实链路（客户端经 `frontend:80`，全部 `/api/*` 走 frontend nginx）

| 步骤 | 结果 |
|---|---|
| 注册 / 登录、建会话 | 200 / 200、200 |
| 带工具 Run | `SUCCEEDED`，`bash:succeeded` |
| SSE `/api/runs/:id/events` | 200，`text/event-stream; charset=utf-8`，首块立即返回（8003 字节，含事件字段） |
| 后台进程 | logs 200，`TICK-1…TICK-5`；`SIGTERM` 200，最终 `cancelled` |
| 跨租户 | B 访问 A 的 run / conversation / tools / process 全 404；A 全 200 |

## 未做 / 边界

- SSE 读取发生在 Run 结束之后（事件回放），未测进行中 Run 的逐条推送延迟；缓冲指令未改动，由模板测试断言保留。
- 未做浏览器实际操作；本次无 UI 行为变化，经 frontend 的 API / SSE 由脚本覆盖。
- 大文件上传经 frontend 的 55MB 与流式转发未实测（指令未改）。
- `nginx:alpine` 未钉版本（既有状态），构建时拉到 1.31.5；只读根文件系统下的 nginx 临时目录、K8s 中的实际 LB 地址与 HTTPS 入口均未验证。
- 生产 Compose 的边缘 `nginx/` 未改。
