# 验证记录：exec 内部面来源白名单空值改为拒绝

日期：2026-09-15。用户决定：`EXEC_INTERNAL_ALLOW_CIDR` 空值由「不限制」改为「拒绝全部」。发现过程见
[S2f 证据](s2f-vm-release-2026-09-15.md)「发现」一节。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`958b3332` + 本次未提交改动（随本证据同一 commit） |
| 单测运行时 | **宿主 Node v23.11.0**；`uv run pytest` Python 3.11 |
| 运行栈 | 开发 Compose + `updrdb-sim` + `upredis-sim`；backend 网络 `192.168.148.0/24`（OrbStack） |
| 镜像 | `enterprise-sandbox` `b86358491b2a`（重建，sandbox 容器已换新）；`enterprise-sandbox-mcp` 重建后镜像 id 与运行中容器一致（facade import 图不含 `cidr.ts`），未换新 |

## 修改前的事实

| 项 | 证据 |
|---|---|
| 空白名单放行 | `exec/src/security/cidr.ts` `isIpAllowed`：`if (cidrs.length === 0) return true`；`router.ts` 注释写明取不到对端地址时空白名单照样放行 |
| 部署从未传入该变量 | 开发 / 生产 Compose、CI、`smoke-cross-service.mjs` 均未设置 `EXEC_INTERNAL_ALLOW_CIDR`；Compose 传入的 `SANDBOX_ALLOWED_CLIENT_CIDRS` / `SANDBOX_TRUSTED_PROXY_CIDRS` 在 `exec/src`、`contract/src` 中无读取方 |
| `createExecAppFromEnv(env)` 忽略 env | 未把白名单传给 router，router 回退读 `process.env` |
| 非法条目静默跳过 | `isIpAllowed` 遇到解析失败的 CIDR `continue` |
| 畸形 IPv6 被接受 | `parseInt('172.18.0.5', 16)` 得 0x172，含点分段的地址被当成合法十六进制段 |
| 监听地址 | `listenHono` 默认 `0.0.0.0`（IPv4），当前对端不会是 `::ffff:` 形态；映射归一化是防御性修改 |

## 改动要点

- `cidr.ts`：空列表与空对端地址拒绝；`::ffff:a.b.c.d` 按 IPv4 匹配；IPv6 段必须是 1–4 位十六进制、拒绝含 `.` / `%`；新增 `assertValidAllowCidrList`（前缀必须是 1–3 位数字）。
- `app.ts`：`createExecAppFromEnv` 从传入 env 读取并校验白名单、显式传给 router，`ExecRuntime.internalAllowCidr` 暴露生效值；`main.ts` 配置非法时 `exec configuration invalid, refusing to start`，空白名单时启动告警。
- 配置：开发 Compose 以 `EXEC_INTERNAL_ALLOW_CIDR` 默认私网段取代两个无读取方的变量；生产 overlay `:?` 必填；CI prod overlay 渲染给占位值；`verify_compose_prod_config.py` 拒绝缺失 / 空 / `/0`；`smoke-cross-service.mjs` 给回环。
- 文档：`deployment.md`（变量表、「入站网络」按 TS exec 现状重写、VM 小节）、`architecture.md`、`development.md`、`.env.example`、`deploy/vm/exec.env.example`、design §9、CHANGELOG。

## 验证结果

| 项 | 环境 / 命令 | 结果 |
|---|---|---|
| CIDR 与路由单测 | 宿主 `npx tsx --test test/http-internal.test.ts test/main.test.ts` | 44/44：空列表拒绝、空对端拒绝、显式 `/0` 放行、IPv4-mapped 匹配、畸形 IPv6 拒绝、非法条目校验；路由层空白名单即使签名正确也 403、伪造 XFF 不采信、映射对端通过对照；`createExecAppFromEnv` 读传入 env 而非 `process.env`、非法条目拒绝装配 |
| 修改前失败 | 同批用例在实施中首轮运行：`main.test` 中未带对端地址的 `fs/list` 请求得到 `403 ip not allowed`（补上对端头后通过）；空白名单放行的旧断言已按新语义改写，未在修改前代码上单独运行 |
| exec | 宿主 `npm test` + `tsc --noEmit` | 399 / 398 pass / 0 fail / 1 skip（宿主无 bwrap）；tsc 通过 |
| 仓库卫生 | 宿主 `uv run pytest -q` | 171 passed（生产配置校验器新增缺失 / 空 / `/0` 负对照 5 例） |
| 生产 overlay | 以 CI 占位环境渲染 + `verify_compose_prod_config.py` | `10.20.0.0/16` 通过；未设置时 compose 报 `required variable EXEC_INTERNAL_ALLOW_CIDR is missing a value`；`0.0.0.0/0` 被校验器拒绝 |
| 开发 Compose | `docker compose config` | 通过；sandbox 环境 `EXEC_INTERNAL_ALLOW_CIDR=127.0.0.1/32,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`（本地 `.env` 里的旧变量仍经 `env_file` 进入容器，无读取方） |

## 运行栈

| 场景 | 结果 |
|---|---|
| 换新 sandbox（开发默认白名单） | healthy，`/ready` 200，无空白名单告警 |
| agent 容器（192.168.148.x）经 `ExecRpcClient` 调 `sessions/ensure` | 成功 |
| 重建 sandbox 为 `EXEC_INTERNAL_ALLOW_CIDR=10.255.255.0/24` | 同一调用 `AUTH_FAILED: ip not allowed`；恢复默认后再次成功 |
| 一次性 exec，`EXEC_INTERNAL_ALLOW_CIDR=`（库指向演练库 `pi_vm_sim`，不碰开发账本） | 启动日志 `exec WARNING: EXEC_INTERNAL_ALLOW_CIDR is empty; every /internal/v1 request will be rejected with 403`，仍监听；调用 `AUTH_FAILED: ip not allowed` |
| 一次性 exec，`EXEC_INTERNAL_ALLOW_CIDR=10.0.0.0/33` | 退出码 1：`exec configuration invalid, refusing to start: EXEC_INTERNAL_ALLOW_CIDR contains invalid CIDR entries: 10.0.0.0/33` |

## 真实链路（经 `api-server:4000`，Worker 经内部面调 exec）

| 步骤 | 结果 |
|---|---|
| 注册 / 登录 | 200 / 200 |
| 带工具 Run | `SUCCEEDED`，`bash:succeeded` |
| 后台进程 | logs 200，`TICK-1…TICK-6`；`SIGTERM` 200，最终 `cancelled` |
| 跨租户 | B 访问 A 的 run / conversation / tools / process 全 404；A 全 200 |

## 未做 / 边界

- 单测在宿主 Node v23.11.0 上运行，未在容器内复跑；agent、api-server、contract、frontend 本次无改动，未重跑。
- `smoke-cross-service.mjs` 与 CI 的 cross-service smoke 未实跑（宿主为 macOS，脚本需 Linux bwrap）；CI prod overlay 渲染只在本机以相同环境复现。
- 本地 `.env` 里的 `SANDBOX_ALLOWED_CLIENT_CIDRS` 等旧变量需开发者自行清理（无读取方，不影响行为）。
- 生产与 VM 上的实际来源地址段（LB SNAT / 源地址保留）未测。
