# K8s 内镜像改为 up_docker（1000:1000）运行（2026-09-18）

目标环境要求容器以 `up_docker` 运行；用户确认 uid / gid 统一为 1000:1000（sandbox-mcp 一起改），VM 上的 exec 不改。

## 一、改动

| 镜像 | 之前 | 之后 |
|---|---|---|
| agent / agent-worker | `USER node`（1000） | 基础镜像 `node` 改名 `up_docker`，`USER 1000:1000` |
| api-server | `USER node`（1000） | 同上 |
| sandbox-mcp（`exec/Dockerfile` facade 阶段） | 自建 `sandbox` 10001，`USER 10001:10001`；Compose `user: "10001:10001"` | `node` 改名 `up_docker`，`USER 1000:1000`；Compose `user: "1000:1000"` |
| frontend（nginx:alpine） | root 主进程，听 80 | 新建 `up_docker` 1000，去掉 nginx.conf 的 `user`、pid 放 `/tmp`，conf.d 与 `/var/cache/nginx` 交给 1000，`USER 1000:1000`，听 **8080** |
| 执行面 `sandbox` / VM exec | 10001 / `pi-exec` | 不变 |

随之修改：Compose 前端映射 `3000:8080`；边缘 nginx `locations.conf` 两处 `proxy_pass http://frontend:8080`；
`scripts/dev/k8s/` 清单（frontend containerPort / 探针 / Service targetPort 8080，frontend 与 sandbox-mcp 加
`runAsUser: 1000`）；AGENTS.md §2 不变量、architecture / deployment / sandbox-mcp / development / design §2.1、CHANGELOG。

## 二、验证

| 项 | 结果 |
|---|---|
| 新增 `tests/test_container_users.py`（7 条）修复前 | 6 失败 / 1 通过（执行面保持 10001 的对照） |
| 修复后 | 7/7；`uv run pytest -q` 214 passed；`docker compose config -q` 通过 |
| `exec/test/mcp-import-boundary.test.ts` 改为断言 `USER 1000:1000` + `up_docker` | `npm test --prefix exec` 419 pass / 0 fail（421 项，2 跳过） |
| 镜像重建（agent / api / sandbox-mcp / frontend，BUILD_EXIT=0）后 `docker run --entrypoint id` | 四个均为 `uid=1000(up_docker) gid=1000(up_docker)`；`enterprise-sandbox` 仍为 `uid=10001(sandbox)` |
| K8s dev 模式（`up.sh dev`，Pod 均开 `runAsNonRoot` + `runAsUser: 1000`） | 5 个 Deployment Running；`kubectl exec … id` 均为 up_docker；前端 3000 200、facade 8082 200；真实链路 11/11（直连 BFF 4000）+ 11/11（经前端 3000 代理） |
| 切回纯 Compose（`down.sh dev`） | 五个应用容器 `id` 为 up_docker、sandbox 为 10001；前端 3000 200、facade 200；经前端的真实链路 11/11 |

真实链路：注册登录、建会话、带工具 Run（真实模型）`SUCCEEDED`、后台进程 logs、SIGTERM → `cancelled`、
四项跨租户 404 含本人 200 对照。

## 三、未覆盖

- 生产 overlay 的边缘 nginx 未起真机，只有 `proxy_pass frontend:8080` 的静态断言。
- 未做浏览器操作（前端代码未改，只改了容器用户与端口；经前端 `/api` 的链路已通过）。
- 目标环境是否对 `/var/cache/nginx`、`/tmp` 另有只读根文件系统要求未知；若开 `readOnlyRootFilesystem`，
  frontend 需给 `/var/cache/nginx`、`/tmp`、`/etc/nginx/conf.d` 挂 emptyDir。
