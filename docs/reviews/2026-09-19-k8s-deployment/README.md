# K8s 部署评审（2026-09-19）

## 结论与范围

存在需要修复的就绪判断、发布更新和生命周期问题。本轮为只读评审，未修改生产代码、部署配置或运行中的资源；只新增本报告。K1–K5 已于同日修复，见[修复记录](#修复记录2026-09-19)。

基线：`refactor/updrdb-dbpm`，`480bf65d5bae8bf674599755e7469991c2ac0c38`。开始时已有 `docs/reviews/2026-09-01-full-regression/` 下两个修改文件和两个未跟踪文件，未触碰。

仓库的 `scripts/dev/k8s/` 明确是 **OrbStack 单节点开发/演练清单**；生产清单由平台团队维护。本报告覆盖该清单、up/down 脚本、镜像入口、frontend → BFF → Agent/Worker → exec 接线、数据库/Redis/Skill 存储依赖，以及本机 `orbstack/pi-dev` 的只读现状。未取得生产清单、双集群及目标 VM 的运行证据，不能据此判断生产部署已通过验收。

优先级：P1 = 影响故障隔离、建议优先修复；P2 = 有明确触发条件的发布/可用性问题。没有证据证明发生了数据丢失或鉴权绕过。

## 发现索引

| ID | 级别 | 问题 | 证据等级 |
|---|---|---|---|
| K1 | P1 | 上游 readiness 使用下游 liveness，执行面未就绪时仍可能接流量 | BFF 源码隔离复现；Agent 接线静态确认 |
| K2 | P2 | MCP 就绪投影遗漏连接失败的已配置服务，且缓存不刷新 | 真插件树 + 不可达 MCP 复现；成功对照通过 |
| K3 | P2 | 重新部署遗漏 frontend，重建镜像不能确保更新页面 | 静态确认；未对开发栈执行重建/滚动 |
| K4 | P2 | Worker 60 秒终止宽限与长任务排空机制不匹配 | 静态确认配置和关停链；未做长任务强杀实验 |
| K5 | P2 | Agent 启动预检在监听前执行，却没有 startup probe 保护 | 静态条件推导；未注入启动延迟 |

## K1：readiness 检查的是下游 `/health`

位置：[BFF 状态路由](../../../api-server/src/routes/status.ts)、[BFF Sandbox client](../../../api-server/src/services/sandbox-client.ts)、[BFF Agent client](../../../api-server/src/services/agent-client.ts)、[Agent Sandbox client](../../../agent/src/infrastructure/sandbox/sandbox-client.ts)。

- BFF `dependencyHealth()`（18、30 行）调用的客户端分别访问 exec `/health`（285 行）和 Agent `/health`（937 行）。
- Agent `/ready` 注入的 `sandboxHealthCheck` 同样访问 exec `/health`（451 行）。
- exec 的 `/health` 固定表示进程存活；数据库、工作区存储与关停状态由 `/ready` 判断（[实现](../../../exec/src/http/readiness.ts)）。

因此执行面磁盘/存储不可用、执行面数据库连接故障或开始关停时，只要 `/health` 仍成功，Agent/BFF 的就绪检查就可能漏报。BFF 经 K8s Service 访问 Agent 时，Agent 自身 readiness 摘除 endpoint 能间接挡住一部分故障，但 exec 是外部 EndpointSlice，不能依赖这种间接保护。不能把「BFF 一定忽略所有 Agent 故障」作为结论。

**复现结果**：在独立 `--network none` 容器中只读挂载当前 BFF 源码，使用真实 `handleReadiness()` 和客户端；仅替换 fetch 响应，令下游 `/health` 为 200、`/ready` 为 503。结果 `bffReady=200`，请求路径为 `[/health,/health]`。这是应用接线的替身实验，不是目标环境故障演练。

最小修复方向：readiness 专用客户端访问 `/ready`，按其 HTTP 状态和 `status=ready` 契约判断；保留 liveness 原有语义。增加下游健康但未就绪的反例和正常成功对照，同步 deployment 文档。

## K2：MCP 缺失被投影成健康空集合

位置：[readMcpReadiness](../../../agent/src/runtime/boot.ts)（276–315 行）、[McpDiscoveryState](../../../agent/src/bootstrap/container-mcp.ts)（34–77 行）、[MCP patch 生成](../../../agent/src/runtime/plugins/mcp-entries.ts)。

`readMcpReadiness()` 只枚举注册成功的工具，未与启用的配置清单核对，最后固定 `ready: true`。连接失败的服务没有工具，因此从结果里消失。`McpDiscoveryState` 又只保存启动期快照；生产调用点只有 HTTP 启动时的 preflight，后续 `/ready` 只读该快照，不能反映连接恢复或工具变化。

**复现结果**：独立无外网容器加载当前源码与真实 DSH 插件树，配置一台 enabled MCP 指向容器内无监听的 `127.0.0.1:9`。结果：

```json
{"enabledConfiguredServers":1,"ready":true,"serverCount":0,"toolCount":0,"servers":[]}
```

成功对照使用仓库真实 stdio MCP fixture，发现 `review-echo` 的 echo 工具并调用成功。没有使用生产 MCP 或模型凭据。

影响是故障诊断与摘流量条件错误，不是工具鉴权绕过。当前 deployment 文档承诺 enabled MCP 不可用时 `/ready` 为 503；实现没有达到这个语义。如果产品要允许部分 MCP 故障下继续接流量，应明确调整 readiness 策略，但仍须呈现失败服务，不能将其当作未配置。

最小修复方向：配置清单与当前插件状态共同生成投影，失败条目保留；从事实源刷新，不重新引入一套独立 MCP 连接管理器。

## K3：frontend 不在重新部署的滚动列表中

位置：[up.sh](../../../scripts/dev/k8s/up.sh) 第 178–187 行、[frontend Deployment](../../../scripts/dev/k8s/manifests.yaml) 第 194–209 行。

frontend 使用固定 `pi-enterprise-frontend:latest` 和 `imagePullPolicy: Never`。重复执行 `up.sh dev` 时，显式 restart 的列表只有 agent、agent-worker、api-server、sandbox-mcp，缺少 frontend。重建相同 tag 的镜像不会改变 Pod template，随后 `rollout status frontend` 可以直接对旧版本报成功。[Kubernetes 的 rollout 触发条件](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#updating-a-deployment)是 Pod template 变化。

这是开发文档「重建镜像后重新 up 即按新镜像滚动」承诺的确定性缺口；本次查询时 frontend 运行镜像与本地 tag 的 ID 相同，并未发现当前页面已经落后。

最小修复方向：开发脚本补齐 frontend restart；生产发布使用明确版本/digest，并核对运行 imageID。

## K4：长任务滚动时无法保证排空

位置：[Worker 清单](../../../scripts/dev/k8s/manifests.yaml) 第 140 行、[shutdown](../../../agent/src/bootstrap/worker-main.ts) 第 351–365 行、[destroyRunWorker](../../../agent/src/infrastructure/redis/run-queue.ts) 第 420–430 行。

关停先等待所有 BullMQ `worker.close()`，其默认行为等待在途任务结束，没有应用层 drain deadline；之后才执行 runtime/container shutdown。清单只给 60 秒宽限，而 [remote-shell](../../../agent/src/runtime/providers/remote-shell.ts) 第 95 行默认工具执行预算已经是 120 秒，一轮 Run 还可能包含多次工具与模型调用。

若收到 SIGTERM 时任务剩余耗时超过宽限，正常发布会走强杀与故障恢复，而非完成排空。涉及在途副作用时需要按既有 claim/fence 与未决工具规则处理；没有证据支持「一定重复执行」或「一定丢数据」。当前演练 `rolling-restart` 仅在发起重启约 5 秒后放行模型，不能证明超过 60 秒的排空路径。

最小修复方向：定义有界 drain 和到期后的安全停止/恢复策略，匹配 terminationGracePeriodSeconds；专项覆盖长工具、前台子 Run、关停期间依赖故障，不仅延长一个固定数字。

## K5：慢启动可能被 liveness 反复杀死

位置：[Agent 清单](../../../scripts/dev/k8s/manifests.yaml) 第 109–110 行、[HTTP 启动链](../../../agent/src/bootstrap/http-main.ts) 第 175、187、552 行。

Agent 在 MCP 插件预检、DBPM 取密、建连、schema 核对、HTTP 服务装配之后才 listen。清单没有 startupProbe 或 initialDelaySeconds，liveness 每 10 秒一次、失败 3 次重启。启动链在依赖变慢时超过约 30 秒就可能被 kubelet 终止，尚未完成预检便重新开始；当前正常启动成功不能排除这一条件。

最小修复方向：设置有上限的 startup probe 预算，覆盖启动链的实际最坏耗时；或将纯 liveness listener 提前，而 readiness 在预检完成前保持失败。[官方 startup probe 语义](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/#protect-slow-starting-containers-with-startup-probes)。

相邻配置风险：所有就绪探针在 live 对象中均为默认 `timeoutSeconds: 1`，Worker/facade 内部依赖预算为 2 秒，Agent 还顺序检查 2 秒 data plane 与 3 秒 sandbox，BFF 顺序检查两个 3 秒请求。应明确总体健康延迟阈值并对齐预算，避免应用能返回成功而 kubelet 先判超时；本次未注入高延迟，未把这一风险记为已发生故障。

## 生产部署仍需提交的验证材料

以下不是把本地演练清单当成生产清单的缺陷，而是生产验收尚不能核验的内容：

- **资源与网络边界**：本地 5 个 Pod 实测均为 BestEffort，没有 LimitRange、ResourceQuota、NetworkPolicy、PDB。生产需核对 requests/limits、上传临时盘上限、对外暴露范围、A2A 路径过滤与 exec 内部面来源限制；不能推断平台没有另外提供这些能力。
- **共享存储**：本地使用 hostPath，单节点共享不能证明两个 K8s 集群和 VM 挂载的是同一 export，也不能证明 ACL、原子发布和故障语义。按设计 S1 验证，不能直接照搬 hostPath。
- **可用性边界**：目标设计仍为单 VM exec，workspace/tmp/artifact/control 是其本地状态；双集群应用层不等于执行面高可用。需给出维护、备份恢复与 RPO/RTO 验收。
- **外部数据服务**：本地 MySQL/Redis/DBPM 替身不能证明 UPDRDB/UPRedis Proxy/DBPM 双端点兼容与切换，仍归目标环境 D2/D4 验收。
- **版本与发布**：生产镜像 digest、VM release、Skill release、schema 和队列配置必须形成一致发布记录。没有查询远端 CI/分支保护，本报告不声称这些检查通过。

已确认的正向接线：所有应用 Pod 使用非 root；enableServiceLinks 已关闭；Worker 未注册业务 Service；frontend 端口与 Service targetPort 匹配且关闭 SSE 缓冲；facade 的 readiness 实际检查 exec `/ready`；Worker 有依赖故障暂停消费者的守卫。没有把这些已实现机制重复列为缺失。

## 验证记录

| 检查 | 命令/对象 | 结果与边界 |
|---|---|---|
| 基线 | `git status --short`、`git branch --show-current`、`git rev-parse HEAD` | 见开头；既有改动保留 |
| Shell 语法 | `bash -n scripts/dev/k8s/up.sh scripts/dev/k8s/down.sh` | 通过 |
| 卫生/用户 | `.venv/bin/python -m pytest -q tests/test_repository_layout.py tests/test_container_users.py` | Python 3.11.15，12 passed |
| 集群只读 | `kubectl --context orbstack --request-timeout=10s -n pi-dev get pods/deployments/events`（分别查询） | 5 Pod 均 Ready、0 重启；查询时无 Warning events |
| 探针请求 | `curl --max-time 6` 访问本地 BFF `/health/ready`、Agent `/ready`、facade `/ready` | 均 200，仅正常状态 |
| 暴露范围 | `orb config get k8s.expose_services` | false；不认定当前 LoadBalancer 对局域网开放 |
| K1 复现 | `docker run --rm -i --network none --entrypoint node -v "$PWD/api-server/src:/app/src:ro" pi-enterprise-api:latest --import tsx --input-type=module` | Node 22.23.2，执行上文真实路由 + fetch 替身，确认错误 200；没有数据库/集群故障注入 |
| K2 复现/正对照 | 同样独立容器，agent 镜像，只读挂当前 `agent/src` 和 stdio fixture；调用 `McpDiscoveryState.preflight()` | 不可达 MCP 仍 ready=true；真实 stdio 发现/调用成功 |
| 运行版本 | `kubectl --context orbstack version -o json` | client 1.33.9 / server 1.35.6+orb1；客户端提示超出支持版本偏差，建议更新本地 kubectl |
| 镜像/真实链路 | 未重建现有服务，未重新部署或停服，未注册用户/创建 Run | 本轮为 review；六套业务测试、浏览器操作、故障注入和目标环境验收未执行，不记为通过 |

复现入口说明：stdin 启动 DSH 插件树时需先设 `process.argv[1]='/app/agent/dist/server.js'`，否则 HMR 插件会因缺少脚本路径失败。首次试验遇到该 harness 问题，修正入口后重跑；不能将该失败作为产品缺陷。宿主默认 Node 为 26.5.0，未用它充当 Node 22 验收；复现均使用现有隔离镜像的 Node 22.23.2 与依赖，源码只读挂载为当前工作区版本。

## 修复记录（2026-09-19）

### 首轮

K1–K5 同日实施，验证见 [首轮证据](../../evidence/k8s-deployment-review-fixes-2026-09-19.md)。

复核后更正首轮状态：**K4 为部分修复**，期限只计 `worker.close()`，信号处理先串行等待守卫 / cron / outbox，outbox 在 MySQL 挂起时
无上限，期限不会生效、消费者也不关闭（实现缺口），且缺多副本 / 子 Run / 依赖故障与默认 150s / 180s 的专项（验证缺口）。
**K2、K5 待专项验收**：K2 只有替换注册表的单测，未证明 SDK 重连链路；K5 只有清单与卫生测试，未注入慢启动。

### 跟进（同日，[跟进证据](../../evidence/k8s-deployment-review-followup-2026-09-19.md)）

| ID | 状态 | 说明 |
|---|---|---|
| K1 | 已修复 | readiness 改看下游 `/ready`（首轮证据含 `pi-dev` 故障注入） |
| K2 | 已修复，本地专项已验收；目标环境待验收 | 就绪投影 = 启用清单 × 当前注册表。真插件树 + 真 MCP 验证了启动不可达→恢复、运行中断开→恢复、stdio 崩溃→恢复；专项发现出厂重连预算耗尽后永不再连，已改为默认不设次数上限并支持按 Server 配置 `reconnect`。已知盲区：断开期间 `/ready` 仍报 connected |
| K3 | 已修复 | `up.sh` 滚动全部本地镜像 Deployment |
| K4 | 已修复，本地 sim 专项已验收；目标环境待验收 | 期限改为从信号起算、覆盖关消费者与后台循环，清理另有上限。sim 默认 150s / 180s 下验证期限内排空、到期退出、前台子 Run、关停期间 Redis / MySQL 故障；专项另发现并修复「Run 执行中 MySQL 故障使 Worker 崩溃」。到期或依赖故障时仍在执行的工具，其 Run 按既有规则需人工核对后取消 |
| K5 | 已修复，本地专项已验收；目标环境待验收 | 50s 慢启动：新清单 0 重启并就绪；旧清单 30s 被 liveness 杀掉（复现）；压缩到 30s 的 startup 预算按预期杀掉。未注入超过 180s 的真实启动延迟 |

仍未完成：「生产部署仍需提交的验证材料」一节全部待目标环境证据，**不能宣布生产部署验收完成**；本分支没有远端 CI 结果，
且 main 的必需检查 `Node BFF (tests + smoke)` 与本分支 job 名 `Node BFF (tests + typecheck)` 不一致，contract / exec 不是必需检查
（见跟进证据第五节）。本报告暂不归档。

## 后续实施与验收去向

以下为评审时的实施建议，K1–K5 的落实情况见上节；不转入非阻塞债务，不关闭任何 STATUS 行：

1. 先修 K1/K2：明确就绪 DTO 和部分 MCP 故障策略，回归先失败后通过，再重建服务验证真实故障/恢复。
2. 修 K3：核对新旧 frontend imageID 与页面构建产物，验证重复 up 确实更新全部消费者。
3. 修 K4/K5：明确 drain/startup 总预算，在独立 sim 栈验证慢启动、超过宽限的工具与副作用恢复，不破坏日常开发栈。
4. 生产放行继续按 [部署设计](../../design/updrdb-dbpm-deployment.md) S0/S1/S2/D2/D4 收集平台清单与目标环境证据；上述只读结果不能替代放行材料。
