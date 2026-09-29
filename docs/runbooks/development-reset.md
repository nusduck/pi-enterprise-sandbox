# 研发环境重建（不可逆）

清空本地开发栈的应用库与运行态，用当前代码从空库重新起。研发阶段不升级、不回填旧库：迁移或 schema
清单变了，就按本文重建。**不备份、不迁移、不恢复**旧数据；不要为此先跑 `scripts/backup.sh` 或做快照。

只适用于本机开发栈（Compose 提供 MySQL 5.7、Redis 5.0.14、dbpm-fake 与 exec；应用层在 OrbStack K8s 的
`dsh-dev` 命名空间，或纯 Compose 方式，见 [development.md](../development.md)「运行」）。不要对生产或任何共享库执行。

## 范围：只重建应用库，不用 `docker compose down -v`

`down -v` 会删掉本项目的全部命名卷。同一个 MySQL 卷里还有别的库（`dsh_k8s_sim`、release gate 与演示用的库等），
已启用 Skill 也在命名卷 `agent_user_skills` 里；这些都不该随一次清库消失。本文只动下表第一栏：

| 清掉 | 保留 |
|---|---|
| 应用库（`MYSQL_DATABASE`，默认 `sandbox`）：会话、Run、账号、审批、产物账等全部事实 | MySQL 里的其他库与账号授权 |
| Redis db0：两套运行方式的队列（`{bull}:*`、`{compose-ds}:*` 等）、Run 流、取消信号 | `agent_user_skills` 卷、`.runtime/sandbox/skill-draft`（按旧用户 id 分目录，清库后成为无主数据，不影响运行） |
| `.runtime/sandbox/` 下的 `workspaces`、`tmp`、`artifacts`、`control` | `dsh-sim` 多副本演练的专用库、Redis 与数据根（用 `scripts/dev/k8s/down.sh sim` 单独清） |

清库后账号全部失效，需要重新注册；首个管理员仍由 `SANDBOX_AUTH_ADMIN_USERNAMES` 里的用户名注册产生。

## 步骤

以下命令都在仓库根执行。

**1. 构建目标版本镜像。** 镜像不挂载源码；重建后的库只认同版本镜像随包的 schema 清单。

```bash
docker compose build
```

**2. 停掉应用层，拦住新请求。** 清库时不能有进程还在读写这个库或队列。

```bash
kubectl --context orbstack -n dsh-dev scale deploy --all --replicas=0   # K8s 方式；没起 dsh-dev 可跳过
docker compose stop frontend api-server agent-worker agent sandbox-mcp sandbox
```

**3. 重建应用库。** 库名取 mysql 容器的 `MYSQL_DATABASE`；先打印出来核对，确认是开发库再执行。

```bash
docker compose exec -T mysql printenv MYSQL_DATABASE
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "DROP DATABASE \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
```

应用账号对该库的授权在删库后仍然保留，不需要重新 `GRANT`。

**4. 清掉协调态与执行面数据。** Redis db0 只放这两套运行方式的协调数据；MySQL 才是事实权威，队列里残留的
旧作业会指向已不存在的 Run。

```bash
docker compose exec -T redis sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHDB'
for d in workspaces tmp artifacts control; do
  find ".runtime/sandbox/$d" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
done
```

`find` 的 `-mindepth 1` 保证不删目录本身（它们是 bind mount 的挂载点）。文件由容器里的 uid 10001 写出，宿主删不掉时
改在容器里删：`docker run --rm -v "$PWD/.runtime/sandbox:/data" --entrypoint sh enterprise-sandbox:latest -c 'rm -rf /data/workspaces/* /data/tmp/* /data/artifacts/* /data/control/*'`。

**5. 建表并核对。** 服务启动时不迁移（ADR 0011 D6）。`schema-apply.sh` 对空库执行全部分段 SQL，再按清单只读核对，
末尾应输出 `"drifts": []`。

```bash
bash scripts/dev/schema-apply.sh
```

**6. 启动应用层。** 两种方式二选一，不要同时跑两组消费者读写同一个库与队列。

```bash
scripts/dev/k8s/up.sh dev     # K8s 方式：停 Compose 应用层、刷新集群外地址、滚动重启 dsh-dev
# 或（纯 Compose 方式）
scripts/dev/k8s/down.sh dev   # 删除 dsh-dev 并 docker compose up -d；从未起过 K8s 时直接 docker compose up -d
```

K8s 方式必须用 `up.sh dev` 起，不要只把副本数改回去：Compose 容器重建后 IP 可能变化，`up.sh` 会按新地址重写
EndpointSlice；清单用 `:latest` + `imagePullPolicy: Never`，它也负责 `rollout restart` 让 Pod 换上新镜像。

**7. 验证。**

- agent / agent-worker / sandbox 的日志里没有 `SCHEMA_DRIFT`；worker 打出 `BullMQ consumers started … recovery=ok`。
- K8s 方式：`kubectl --context orbstack -n dsh-dev get pods` 全部 `Running`，Pod 的镜像 ID 与刚构建的本地镜像一致。
- 浏览器 `http://127.0.0.1:3000` 注册、建会话，跑一轮带工具的 Run，确认到达 `SUCCEEDED`。

任何一步失败：保持应用层停止，修正原因后从第 3 步重来。本流程没有回滚到旧数据的路径。
