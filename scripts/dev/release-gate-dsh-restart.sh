#!/usr/bin/env bash
# 在 Docker 里跑 agent-worker-dsh-restart release gate（STATUS G2）：真实 DSH 运行时 +
# 生产 Worker 组合 + 独立 sandbox，四个中断场景（模型调用中 SIGKILL、ask_user 停泊后
# Worker 重启、工具派发边界 SIGKILL、命令执行中重启 sandbox）。
#
# 与 release-gates.sh 分开：它要一个连专用库的 sandbox 容器，耗时也更长。
#
# 步骤：
#   1. 按当前工作树构建运行器镜像（与 release-gates.sh 同一个 Dockerfile）；
#   2. 重建专用库 pi_gate_dsh，按发布 DDL 建表（schema-apply.sh，与生产同一流程）——
#      sandbox 启动时核对清单，测试里不能再迁移或回滚；
#   3. 起专用 Redis 5.0.14 与专用 sandbox（`docker compose run` 沿用 sandbox 服务的
#      隔离配置、HMAC 与 DBPM，只把库换成 pi_gate_dsh）；
#   4. 在运行器里跑 gate；
#   5. 不论成败，删除专用容器与专用库；gate 失败则脚本非零退出。
#
# 用法：scripts/dev/release-gate-dsh-restart.sh
# 前提：开发栈 mysql、dbpm-fake 服务 healthy；agent 与 sandbox 镜像是当前代码构建的。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GATE_DB="pi_gate_dsh"
REDIS_CONTAINER="pi-release-gate-redis-dsh"
SANDBOX_CONTAINER="pi-release-gate-sandbox-dsh"
RUNNER_IMAGE="pi-release-gate-runner:local"
GATE_REDIS_PASSWORD="gate_dev_only"

mysql_root() {
    docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -e "$1"' _ "$1"
}

MYSQL_CONTAINER="$(docker compose ps -q mysql)"
if [ -z "$MYSQL_CONTAINER" ]; then
    echo "mysql service is not running; start the development stack first" >&2
    exit 64
fi
NETWORK="$(docker inspect "$MYSQL_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -1)"
APP_USER="$(docker compose exec -T mysql printenv MYSQL_USER)"

cleanup() {
    docker rm -f "$SANDBOX_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
    mysql_root "DROP DATABASE IF EXISTS ${GATE_DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

echo "[1/5] Building runner image ${RUNNER_IMAGE} from the working tree..."
docker build -q -t "$RUNNER_IMAGE" -f scripts/dev/release-gate-runner.Dockerfile . >/dev/null

echo "[2/5] Recreating ${GATE_DB} and applying the release DDL..."
mysql_root "CREATE DATABASE ${GATE_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON ${GATE_DB}.* TO '${APP_USER}'@'%';"
scripts/dev/schema-apply.sh "$GATE_DB" >/dev/null

echo "[3/5] Starting dedicated Redis and Sandbox on ${NETWORK}..."
docker run -d --name "$REDIS_CONTAINER" --network "$NETWORK" redis:5.0.14 \
    redis-server --appendonly yes --maxmemory-policy noeviction --requirepass "$GATE_REDIS_PASSWORD" >/dev/null
# 口令不进 URL：exec 启动时向 DBPM 取（与 compose 默认一致）。
docker compose run -d --no-deps --name "$SANDBOX_CONTAINER" \
    -e SANDBOX_DATABASE_URL="mysql+pymysql://${APP_USER}@mysql:3306/${GATE_DB}" \
    sandbox >/dev/null
for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$SANDBOX_CONTAINER")" = healthy ] && break
    sleep 2
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$SANDBOX_CONTAINER")" != healthy ]; then
    docker logs "$SANDBOX_CONTAINER" 2>&1 | tail -20 >&2
    echo "dedicated sandbox did not become healthy" >&2
    exit 1
fi

echo "[4/5] Running the DSH restart gate in ${RUNNER_IMAGE}..."
GATE_MYSQL_USER="$APP_USER" \
GATE_MYSQL_PASSWORD="$(docker compose exec -T mysql printenv MYSQL_PASSWORD)" \
TEST_SANDBOX_INTERNAL_HMAC_KEYRING="$(docker exec "$SANDBOX_CONTAINER" printenv SANDBOX_INTERNAL_HMAC_KEYRING)" \
TEST_SANDBOX_INTERNAL_HMAC_ACTIVE_KID="$(docker exec "$SANDBOX_CONTAINER" printenv SANDBOX_INTERNAL_HMAC_ACTIVE_KID)" \
TEST_SANDBOX_API_TOKEN="$(docker exec "$SANDBOX_CONTAINER" printenv SANDBOX_API_TOKEN)" \
docker run --rm -i --network "$NETWORK" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e GATE_MYSQL_USER -e GATE_MYSQL_PASSWORD -e GATE_DB="$GATE_DB" \
    -e GATE_REDIS_PASSWORD="$GATE_REDIS_PASSWORD" \
    -e TEST_REDIS_CONTAINER="$REDIS_CONTAINER" \
    -e TEST_SANDBOX_CONTAINER="$SANDBOX_CONTAINER" \
    -e TEST_SANDBOX_URL="http://${SANDBOX_CONTAINER}:8081" \
    -e TEST_SANDBOX_INTERNAL_HMAC_KEYRING -e TEST_SANDBOX_INTERNAL_HMAC_ACTIVE_KID \
    -e TEST_SANDBOX_API_TOKEN \
    -e RUN_AGENT_PI_RESTART_GATE=1 \
    "$RUNNER_IMAGE" bash -s <<'INNER'
set -euo pipefail
cd /repo/agent
enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
export TEST_MYSQL_URL="mysql://$(enc "$GATE_MYSQL_USER"):$(enc "$GATE_MYSQL_PASSWORD")@mysql:3306/${GATE_DB}"
export TEST_SANDBOX_MYSQL_URL="$TEST_MYSQL_URL"
export TEST_REDIS_URL="redis://:$(enc "$GATE_REDIS_PASSWORD")@${TEST_REDIS_CONTAINER}:6379/0"
echo "node $(node -v)"
npx tsx --test tests/redis/agent-worker-dsh-restart.release-gate.test.js
INNER

echo "[5/5] Gate passed; removing dedicated resources."
