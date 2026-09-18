# 追问排队、共享 Skill 跨 Pod 演练与第三轮多副本回归（2026-09-18）

## 一、对象与环境

| 项 | 值 |
|---|---|
| 代码 | `fabf606a` + 本次改动（`agent/src/application/session-turn-gate.ts`、`run-queue.ts`、`worker-main.ts`、测试、`scripts/dev/k8s/`、文档） |
| 镜像 | agent 按工作树重建 `sha256:40a3736d…`；sim 与 dev 的 Pod 均核对为该镜像 |
| K8s | OrbStack 2.2.3 单节点 `v1.35.6+orb1`；Node 22 |

## 二、追问排队（plan §12）

**缺陷**：Run 执行期间 `POST /api/conversations/{id}/follow-ups` 返回 202，新 Run 进 Worker 后拿不到 session 锁，
`dsh-run-executor.ts` 立即返回 `FAILED / session lock busy`；单副本同样复现。前端「排队追问」走这条路径。

**修复**：新增 `session-turn-gate.ts`；作业处理外壳 `createRunJobHandler` 增加 `shouldWait`——执行前判定为需等待
（session 锁被占，或同会话有更早、仍在 `ACCEPTED` / `QUEUED` / `RETRYING` 的顶层 Run）时放回 delayed（2s，
不消耗 attempts），判定出错同样放回；`worker-main.ts` 为每层消费者接上。不等 `WAITING_*` 与失去锁的孤儿 `RUNNING`，
子代理 Run 不参与。`execute-run-service.ts` / `dsh-run-executor.ts` 行数预算已满，未改；执行器的锁忙即失败保留为兜底。

| 验证 | 结果 |
|---|---|
| `run-job-handler.unit.test.js` 新增 3 条，修复前 | 2 失败（放回 delayed、判定出错仍排队） |
| 修复后 | 全文件通过；worker-main / drain-gate 替身补会话锁接口，新增断言生产接线带 `shouldWait` |
| `session-turn-gate.integration.test.js`（真 MySQL，release-gate 运行器、专用库） | 6/6：锁被占等待、锁释放放行、排队按提交顺序、不等挂起与无锁孤儿、别的会话不影响、子代理与执行中 Run 不拦、跨 org 不匹配 |
| sim 修复前对照（旧镜像 Pod，tag `mu6j87gf`） | 两个 follow-up 在第一个 Run 执行期间即 `FAILED` |
| sim 修复后（tag `mu6jh3s0`） | 两个 follow-up 在第一个 Run 执行期间保持 `QUEUED`、无模型请求；放行后 1.3s 第一个开始，按提交顺序在两个副本上依次 `SUCCEEDED` |
| dev 真实模型 | 第一个 Run `sleep 25`；期间 follow-up 202，状态 `RUNNING/QUEUED → SUCCEEDED/QUEUED → SUCCEEDED/RUNNING → SUCCEEDED/SUCCEEDED`；追问回答 `FIRST_DONE`（看到上一轮上下文） |

第一次修复后回归（tag `mu6jb5h9`）追问卡在 `RUNNING`：fake-llm 在带历史的请求里匹配到**第一个**标记（上一 Run 的
`hold-text`）把追问也挂住，属演练工具缺陷；改为取最后一个标记后通过。

观察：会话消息按提交顺序持久化，所以列表显示为「用户、用户、助手、助手」，是追问既有的持久化方式，本次未改。

## 三、默认 Agent 并发 409

见 `fabf606a`：两处撞键重读改为加锁读；`default-agent-race.integration.test.js` 修复前 8 并发 7 个 `ConflictError`，
修复后连跑 4 次 3/3。两份集成测试文件同时跑会因并行迁移同一库互相干扰（既有测试隔离问题），分开跑均通过。

## 四、共享 Skill 跨 Pod（sim 模式，hostPath 模拟共享存储）

`scenarios.mjs shared-skill`（tag `mu6jt9v5` 单跑 6/6，最终全量见第五节）：

1. A 上传草稿（201）并启用（200）：两个 Agent Pod 都能看到 `.v/<digest>/sim-probe/SKILL.md`。
2. A 同时提交 4 个 Run，分布在两个 Worker；exec 沙箱里 `cat /home/sandbox/skill-user/sim-probe/SKILL.md` 均读到 v1。
3. B 的 Run 读不到（No such file）、B 的列表不含该 Skill；B 调 disable 返回 200（对自己无此 Skill 是空操作），A 仍可见。
4. A 发布 v2：新摘要新目录，新 Run 读到 v2。
5. 在 Agent Pod 内以属主身份把 v2 侧车改为 `{}`：下一个 Run 不挂载该 Skill，Worker 日志
   `enabled skill "sim-probe" is mismatch in the published store; excluded from this Run`；恢复内容与 0444 权限后再次可见。
6. 停用（200）后新 Run 读不到。

边界：hostPath 不是 NFS / CSI，跨机可见性延迟、属性缓存、root_squash 与存储断开仍需目标环境。

## 五、第三轮多副本全量回归（新镜像，从零 `up.sh sim`，缩短时长）

tag `mu6jw7rb`：**24/24**。exactly-once 4/4、capacity 2/2、kill-takeover 2/2（13.2s）、freeze-fence 2/2、cancel 2/2、
rolling-restart 1/1、redis-outage 4/4、shared-skill 6/6、same-session 1/1。

## 六、离线测试、类型检查与真实链路（Node 22）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 214 passed |
| `npm test --prefix exec` | 421 项：419 pass / 0 fail（2 跳过） |
| `npm test --prefix contract` | 118 / 118 |
| `npm test --prefix agent` | 首跑 3 失败（worker-main / drain-gate 替身缺 `createSessionLockManager`）；补替身后 1389 / 1389 |
| `npm test --prefix api-server` | 首跑 158 + 2 cancelled（`file proxy id domain`，`Promise resolution is still pending`）；重跑一次 160/160、再一次 158 + 2 cancelled。本次未改 api-server，属偶发，**不记为通过** |
| `npm test --prefix frontend` / `npm run build --prefix frontend` | 367 / 367；通过 |
| 类型检查 | exec / contract / api-server / agent 全部通过 |
| dev 真实链路（经前端 3000，真实模型，当前镜像） | 11/11 |
