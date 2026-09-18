# OrbStack K8s 本地演练：多 Worker 副本与编排行为（2026-09-18）

目的：部署到目标环境之前，先在本地把「多副本 + K8s 编排」层面的问题暴露出来。这是**本地演练**，
不是 design/updrdb-dbpm-deployment.md §12 的目标环境验收，不关闭任何 T1–T8 门槛。

## 一、对象与环境

| 项 | 值 |
|---|---|
| 代码 | `3d6e0420`（分支 `refactor/updrdb-dbpm`），本次只新增 `scripts/dev/k8s-sim/` 与文档，无生产代码改动 |
| 镜像 | 在 HEAD 上 `docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend`（BUILD_EXIT=0）。agent / api / frontend 命中缓存、镜像 ID 不变（即已是 HEAD 内容）：agent `sha256:1630dab6…`、api `sha256:8f582eb9…`、frontend `sha256:397f51f3…`；sandbox 出新层 `sha256:10746b07…` |
| K8s | OrbStack 2.2.3 自带单节点 K8s `v1.35.6+orb1`，容器运行时 docker（本地镜像 `imagePullPolicy: Never` 直接用） |
| 拓扑 | 命名空间 `pi-sim`：agent ×2、agent-worker ×2、api-server ×2、frontend ×1、fake-llm ×1。集群外：开发栈 MySQL 5.7 与 dbpm-fake、专用 Redis 5.0.14、专用 exec 容器（代替 VM，隔离配置照搬开发栈 sandbox），以无 selector Service + EndpointSlice 接入 |
| 数据 | 专用库 `pi_k8s_sim`（`schema-apply.sh` 按发布 DDL 建表，服务不迁移）、数据根 `.runtime/k8s-sim/`；skill-user / skill-draft 用宿主目录 hostPath 模拟共享存储（本轮未测 Skill） |
| 配置 | 各服务环境取自开发栈容器（Compose 渲染值），只改库名、`LLMIO_BASE_URL`（→ fake-llm）、`MCP_SERVERS_JSON=[]` |
| 模型 | `scripts/dev/k8s-sim/fake-llm.mjs`：按消息标记回 bash 工具调用或文本，可挂住 / 放行，记录每次请求的来源 Pod IP |
| 驱动 | `scripts/dev/k8s-sim/scenarios.mjs`，宿主 Node 22；经 `kubectl port-forward svc/frontend` 走 frontend → BFF → Agent 真实入口 |

两套时长：

- **缩短时长**（up.sh 默认，与 release gate 同一做法）：run 租约 10s / 续约 2s、session 锁 10s / 2s、BullMQ 锁 12s、
  stalled 检查 3s、恢复扫描 3s。
- **生产默认**：`kubectl patch secret` 改回 Compose 值（租约 30s / 续约 10s、恢复 60s），删除 session 锁与 BullMQ
  覆盖（用代码默认值），`rollout restart` 后核对 Pod 内环境变量。

## 二、结果

生产默认时长，一次完整运行（tag `mu6dq3a3`，13/15），之后拆分 `redis-outage` 断言单独重跑（tag `mu6duh8m`，3/4）：

| 场景 | 结果 | 关键观测 |
|---|---|---|
| exactly-once | 4/4 | 8 个 Run 同时提交，全部 SUCCEEDED；每个 Run 模型首轮 1 次、工具账本 1 行 `bash:SUCCEEDED:fence1`、工作区副作用 1 行；两个副本各消费 4 个 |
| capacity | 2/2 | 6 个挂住的 Run：同时在模型里的正好 4 个、每副本 2 个（2/1/1 分层的深度 0 槽），其余 2 个 `QUEUED`；放行后全部 SUCCEEDED |
| cancel | 2/2 | Run 在副本 A 上挂住时经 BFF 取消（请求落在任一 Agent HTTP 副本）：HTTP 200 → `CANCELLED`，A 的模型请求被中断；放行后不再有新轮次、无工具行 |
| kill-takeover | 2/2（另单独 3/3） | 模型调用中 `kubectl delete pod --grace-period=0 --force`：由另一副本接管，耗时 46.7–62.8s（5 次）；模型首轮重放 1 次、`attempt=2`、工具 1 行 `fence2`、副作用 1 行 |
| rolling-restart | 1/1 | 在途 Run 时 `rollout restart`：原副本收到 SIGTERM 后自己跑完（首轮 1 次、`attempt=1`、`fence1`），无重放；rollout 正常完成 |
| redis-outage | 3/4 | `docker pause` 专用 Redis：两个 Worker 都转 NotReady；**Agent HTTP 两个副本一直 Ready**（见发现 3）；恢复后全部 Ready，新 Run 成功 |
| same-session | 0/1 | 第一个 Run 挂住时发 follow-up：202 接收，随即 `FAILED / session lock busy`（见发现 2） |

冻结接管在**缩短时长**下运行（tag `mu6dckfq`，2/2）：`docker pause` 执行中的 Worker 12.2s 后另一副本接管
（`attempt=2`、`fence2`）；两个挂住的模型调用都放行后 Run 由接管方完成；解冻旧 Worker 并观察 20s：
工具账本仍只有 1 行 `fence2`、副作用 1 行、Run 保持 SUCCEEDED，旧 Worker 无第二轮模型请求、Pod 未重启。
旧 Worker 日志只有 BullMQ `could not renew lock`，从日志分不出挡住它的是租约丢失中止还是 fence 校验。
生产时长下接管要 45–60s，会先触发 liveness（60s）重启，冻结就变成 kill，所以此场景没有用生产时长跑。

## 三、发现

1. **镜像 `USER node` 与 `runAsNonRoot` 不兼容**（部署清单问题）。agent / api-server 镜像的 USER 是名字，K8s
   开 `runAsNonRoot: true` 时无法校验，Pod 停在 `CreateContainerConfigError`。演练清单显式写
   `runAsUser: 1000, runAsGroup: 1000`（镜像内 `id` 为 `uid=1000(node)`）；目标环境清单同样需要，或把镜像改成数字 USER。
2. **Run 执行期间的 follow-up 直接失败，不排队**（功能缺陷，与副本数无关）。plan §12 要求「创建 follow-up message，
   等待当前 Run 完成后自动执行」，`follow-up-service.ts` 注释也写「SessionLock serializes execution behind the
   currently active Run」，但 `dsh-run-executor.ts:340` 拿不到 session 锁时直接返回 `FAILED / session lock busy`。
   Worker 缩到 1 副本复现结果相同。前端的排队追问（`queueConversationFollowUp`）走的就是这条路径。未修改。
3. **Agent HTTP `/ready` 不探活依赖**。`isDataPlaneReady()`（`container.ts:436`）只看 MySQL / Redis 客户端对象
   是否已建，不 ping；deployment.md Health Checks 写的是「Agent data plane 不可用即 503」。行为与文档不一致，
   需要决定改哪一边。未修改。
4. **新组织首次并发建会话可能 409**（与副本数无关）。全新库上第一批 8 个并发 `POST /api/conversations` 有 4 个
   返回 `409 CONFLICT`。租户默认 Agent 在首次建会话时惰性创建，`uk_agent_definitions_org_name` 撞键后
   `ensureTenantDefaultAgent` 在同一事务里重读，推断是 REPEATABLE READ 快照看不到对方已提交的行，于是抛出通用
   ConflictError（不可重试的 409），而不是 `ParentProvisioningRaceError`（可重试）。默认 Agent 存在后连续 4 轮
   各 8 并发均为 201。根因属静态推断，未写回归测试。未修改。
5. **BullMQ 锁续期失败被记成 Redis 连接错误**。冻结场景里旧 Worker 打印
   `redis connection error category=UNKNOWN … could not renew lock` 与 `redis connection restored`，实际是锁已被
   接管，不是连接故障。日志分类问题，不影响正确性。

## 四、边界与未覆盖

- 单节点、单集群：双集群、LB、跨集群代理重连测不了；hostPath 不是 NFS / CSI，不证明共享存储语义。
- MySQL / Redis / DBPM 都是本地替身；exec 是容器，不是麒麟 VM。
- 本轮未测：共享 Skill 跨 Pod 发布一致性、`EXEC_INTERNAL_ALLOW_CIDR` 在 Pod 源地址下的正负对照、sandbox-mcp、
  执行面 SIGKILL / 网络分区、Agent HTTP 在 Redis 中断期间的请求行为。
- 宿主到 ClusterIP 不通（路由走局域网网关），驱动经 `kubectl port-forward`；frontend 到 api-server 仍经 Service 负载均衡。
- 宿主 `127.0.0.1:3306` 被本机 mysqld 占用，驱动经 `docker compose exec mysql` 查账本。

## 五、复现

```bash
orb config set k8s.enable true && orb stop && orb start   # 一次性
scripts/dev/k8s-sim/up.sh
/opt/homebrew/opt/node@22/bin/node scripts/dev/k8s-sim/scenarios.mjs            # 缩短时长，全部场景
scripts/dev/k8s-sim/down.sh
```

改回生产时长的做法见上文「两套时长」。
