# exec 产物持久化与四项稳健性修复的真实链路验证（2026-09-04）

**Location:** `docs/evidence/`（带日期的验收证据，不是进度看板）。
**验收状态:** 见 [`../STATUS.md`](../STATUS.md)。本次**没有**关闭任何 §32 行——
E1/E2 仍是 `unknown`/`partial`，G7 仍是 `unknown`（门禁脚本本身跑不起来，见 STATUS 该行）。

本记录只覆盖当天在运行中的开发栈上跑通的链路。

## 起因

对全仓做了一次外部 review，逐条复核后确认了若干缺陷。本批修的是其中四条，
外加一条纵深防御缺失：

1. **exec 生产装配没有接 MySQL 产物/数据集仓储**（用户可见的数据丢失）。
2. `MySqlJobRegistry.lives` 只增不减。
3. `RemoteShellProcess.monitor` 无退避、无截止，作业查不到时永远空转。
4. `ExecRpcClient.getStream` 的超时只覆盖到响应头，流式读取无截止。
5. exec 公共会话面从不校验 `SANDBOX_API_TOKEN`。

## 环境

- 宿主日期/时区：2026-09-04，Asia/Shanghai。Docker Engine `29.4.0`，macOS。
- 分支 `refactor/dsh-rebuild`，基线提交 `f23099f0`。
- 按 AGENTS.md §4 重建后启动：
  `docker compose build agent api-server sandbox sandbox-mcp && docker compose up -d`。
- `agent-migrate` 本轮应用了一个迁移：`20260904000001_exec_artifacts_datasets.js`（batch 2）。
- 凭据只存在于验证脚本的进程内，未写入本文件或任何输出。

## schema

```
mysql> SHOW TABLES LIKE 'exec_%';
exec_artifacts
exec_datasets
exec_jobs
```

`exec_artifacts.created_at` 为 `datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`
（`DEFAULT_GENERATED`）——`MySqlArtifactStore.insert` 的 INSERT 列表里没有这一列，
没有列默认值的话第一次提交就会 1364 失败。

## 真实链路（AGENTS.md §4 最小集 + 本批次的针对性断言）

登录 → 建会话 → 一轮带工具的 run（写文件 + `submit_artifact` + 起后台进程）→
产物列表 → **重启 sandbox 容器** → 产物仍在 → 下载字节一致 → 会话继续跑 run →
进程 logs/signal → 跨租户 404。

| # | 断言 | 结果 |
|---|------|------|
| 1 | 登录拿到会话 cookie | PASS |
| 2 | 建会话 201 | PASS |
| 3 | `POST /api/runs` 202 | PASS |
| 4 | run 到达终态 `SUCCEEDED` | PASS |
| 5 | 拿到 sandbox session id | PASS |
| 6 | 重启前 `GET /api/artifacts` 列出 1 个产物 | PASS |
| 7 | **`docker compose restart sandbox` 之后产物仍是 1 个** | PASS |
| 8 | 重启后 `GET /api/files/artifact-download` 200，字节为 `GATE_OK`（7 字节） | PASS |
| 9 | 重启后同一会话继续跑 run 仍 `SUCCEEDED` | PASS |
| 10 | `GET /api/processes` 200 | PASS |
| 11 | `GET /api/processes/{id}/logs` 200 | PASS |
| 12 | `POST /api/processes/{id}/signal` 200 | PASS |
| 13 | 换 `session_id` 读同一进程 → 404 | PASS |
| 14 | 另一个租户读产物列表 → 404 | PASS |
| 15 | 另一个租户下载该产物 → 404 | PASS |

15/15 PASS。

第 7/8 条是本批次的核心：修复前 `ArtifactService` 跑在 `InMemoryArtifactStore` 上，
容器一重启这两条必然变成 `n=0` 与 404。落库后 MySQL 里能直接查到：

```
mysql> SELECT artifact_id, name, sha256, size_bytes FROM exec_artifacts ORDER BY created_at DESC LIMIT 1;
01M1P58WRE35060V34SBX6PW84  gate.txt  20c2057c…3326b  7
```

第 12 条特意在**重启之后**新起一个后台进程再发信号：重启前起的那个已经没有活
句柄（`recoverOrphans` 会把它标成终态），对它发信号本来就该失败，验不出运维面是否可用。

## 公共面服务令牌（容器内直连 exec，绕过 BFF）

| 请求 | 结果 |
|------|------|
| 不带 `X-API-Key` 读 `/sessions/{id}/artifacts` | 401 |
| 带错误的 `X-API-Key` | 401 |
| 带容器自身的 `SANDBOX_API_TOKEN` | 200 |
| `/ready` 健康探针（不带任何头） | 200 |

## 六套单测 + 类型检查

同日在宿主机上全绿：

```
uv run pytest -q                    100 passed
npm test --prefix contract           29 pass / 0 fail
npm test --prefix exec              337 pass / 0 fail / 1 skipped
npm test --prefix api-server        154 pass / 0 fail
npm test --prefix agent            1240 pass / 0 fail
npm test --prefix frontend          350 pass / 0 fail
```

类型检查：`exec` / `contract` / `api-server` / `agent`（主程序 + runtime strict）/
`frontend` 全部通过。

## 本批次新增的回归测试（修复前失败、修复后通过）

- `exec/test/main.test.ts`：把库指向一个没人监听的端口，产物/数据集列表必须因为
  连不上 MySQL 而 5xx——修复前它们安静地返回 200 空列表。同文件另有服务令牌的
  401/200 与 `createExecAppFromEnv` 缺令牌拒绝启动。
- `exec/test/shell-job-registry.test.ts`：已结算作业必须被回收、运行中的作业永不
  被回收、保留窗口内仍能读到缓冲尾部、上限生效。去掉 `pruneSettled()` 调用后
  4 条中的 3 条失败（第 4 条是防过度回收的护栏，两边都该通过）。
- `agent/tests/runtime/remote-providers.test.ts`：作业不存在时立刻结算、传输持续
  失败时退避并在截止后结算、`getStream` 在响应头之后卡住会超时。去掉这三处保护
  后，测试进程直接**永不退出**——这正是缺陷本身。
- `tests/test_exec_schema_migrations.py`：exec 生产装配里接的每一个 `MySql*Store`，
  它的表都必须有 agent 侧迁移。删掉本次新增的迁移文件即失败。
