# G7：exec 硬杀后的孤儿回收（2026-09-04）

**Location:** `docs/evidence/`（带日期的验收证据，不是进度看板）。
**验收状态:** [`../STATUS.md`](../STATUS.md) 的 G7 行本次由 `unknown` 改为 `done`。

## 根因：`recoverOrphans()` 从来没有被调用过

`MySqlJobRegistry.recoverOrphans()` 的注释从第一天就写着「启动期调用（用户路由
挂载之前）」。全仓搜索它的调用点，**只有一条单测**（`exec/test/shell-job-registry.test.ts`）。
`exec/src/main.ts` 里没有。

后果不是脏数据而已。在开发栈上直接查（修复前）：

```
mysql> SELECT status, COUNT(*) FROM exec_jobs GROUP BY status;
completed  11
killed      5
running     5      ← 最老一条 2026-09-02 18:52，两天前
stopping    1

mysql> SELECT process_id, label, pid, status FROM exec_jobs WHERE status IN ('running','stopping');
bash-e052063396f842039bd9607ce9a3563b  sleep 60 && echo REC02_ORPHAN_MARKER  1053  running
bash-0463c81b450e4b75be82a72b73b84ff5  sleep 300                               56  running
bash-3eb8dc9fca2e4a6d8cdf4833684d6337  sleep 300                               56  running
bash-a905234f455b46b2a99ae4cdd6d372fb  sleep 300                               44  running
bash-f6ee5a0821904f279caaf4e795128ef0  sleep 300                               29  stopping

# 容器里对应的进程一个都没有：
$ docker compose exec -T sandbox sh -c 'ps -eo pid,args | grep -c "[s]leep 300"'
0
```

`MySqlJobStore.countActiveForOwner` 统计的正是 `status IN ('running','stopping')`，
而它是每 owner 并发上限（默认 20）的依据——僵尸行攒够 20 条，这个 owner 就再也
起不了新作业。这是会随重启次数单调恶化的故障。

## 修复

`exec/src/main.ts` 在 `listenHono()` **之前** `await runtime.recoverOrphans()`，
失败即 `process.exit(1)`（AGENTS.md §2 fail-closed：宁可起不来，也不要带着一批
永远躺在 running 的行对外服务）。顺序是硬要求——`listActiveForRecovery` 是
**无租户过滤**的全表扫描，只有在还没有任何用户请求进来时才是安全的。

重建镜像后第一次启动的日志：

```
pi-enterprise-sandbox  | exec recovered 6 orphaned job(s) at startup

mysql> SELECT status, COUNT(*) FROM exec_jobs GROUP BY status;
completed  11
killed     11
running     1      ← 这一条是重启后 agent-worker 新起的，不是残留
```

## 旧门禁为什么不是「修一修」

`scripts/release-gates/sandbox-live-gate.mjs`（932 行）`node` 加载即
`ERR_MODULE_NOT_FOUND`。第一层原因是它 import 的
`internal-execution-http` / `internal-process-http` / `internal-artifact-submit-http`
三个 agent 模块在 DSH 重建里已删除；但更深的一层是整个 harness 针对的是
**Python 执行面**：

```js
// 找服务 PID 的方式
grep -Fq "uvicorn sandbox.main:app"
// RSS 采样参数
'SANDBOX_GATE_RSS_ARG=sandbox.main:app'
```

它还依赖旧 `/internal/v1/*` 的 claim 模型（`insertToolRow` 往 agent 账本写一行
再把 `toolExecutionId`/`requestHash` 塞进 payload），而现在的 exec 内部面只做
CIDR + HMAC + htu 绑定，不查 claim。所以这是**重写**，不是修复。已删除。

## 新门禁

`scripts/release-gates/exec-orphan-recovery-gate.mjs`。宿主机上跑，需要一个起着的
compose 栈；驱动 exec 内部面的那几步在 agent 容器里执行（sandbox 不发布端口，
而 agent 容器里同时有 `@pi/contract` 与到 sandbox 的网络）。

```
$ docker compose up -d
$ node scripts/release-gates/exec-orphan-recovery-gate.mjs

PASS  后台作业已在 exec 上起来  — job=bash-01g7gate00mtmy0hrmrecove
PASS  作业初始状态为 running  — status=running
PASS  exec 已被 SIGKILL  — sandbox exited
PASS  硬杀后账本仍停留在 running（回收前的样子）  — status=running
PASS  重启后作业被收成终态  — status=killed detail=orphaned: worker restarted
PASS  终态注明是孤儿回收  — detail=orphaned: worker restarted
PASS  全表不再有 running/stopping 僵尸行  — n=0
PASS  容器内没有残留的被托管进程  — n=0

8/8 PASS
```

## 为什么门禁只查账本，不查残留进程

当前 compose 拓扑里 exec 是 `init: true` 下 docker-init 唯一监管的子进程。实测：

```
$ docker compose exec -T sandbox sh -c 'ps -eo pid,ppid,args'
    1     0 /sbin/docker-init -- docker-entrypoint.sh node dist/main.js
    6     1 node dist/main.js

$ docker compose exec -T -u root sandbox sh -c 'kill -9 6'
$ docker compose ps -a   # → sandbox restarting
```

杀掉 exec，容器跟着退出/重启。也就是说「容器还活着、但 bwrap 子进程成了孤儿」
这个场景在当前拓扑下**不成立**——孤儿问题是纯粹的账本问题。旧门禁测的是
Python 时代那种「容器内 uvicorn 被单独杀掉、容器仍在」的形态。这一条写进了新
门禁的文件头注释，免得下一个人以为漏测了。

## 六套单测 + 类型检查

```
uv run pytest -q                    102 passed
npm test --prefix contract           50 pass / 0 fail
npm test --prefix exec              339 pass / 0 fail / 1 skipped
npm test --prefix api-server        154 pass / 0 fail
npm test --prefix agent            1219 pass / 0 fail
npm test --prefix frontend          350 pass / 0 fail
```
