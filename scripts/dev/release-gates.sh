#!/usr/bin/env bash
# 在 Docker 里跑 agent 的 Redis / BullMQ / Worker 放行测试与 release gate（ADR 0011 D6/D9）。
#
# 为什么放进容器：宿主机（例如 macOS）的 Node 不一定是 runtime-versions.json 钉的 22，
# 依赖里还有按平台编译的原生模块；gate 需要 Redis 5.0.14、MySQL 5.7 与一个会被重启的专用 Redis。
#
# 步骤：
#   1. 按当前工作树构建运行器镜像（node:22-slim + docker CLI，依赖与源码在镜像内）；
#   2. 在开发栈网络里起专用 Redis 5.0.14 容器（AOF + noeviction）；
#   3. 在开发栈 MySQL 里重建 dsh_gate_dev 与 dsh_gate_dev_side，并授权应用账号；
#   4. 依次跑：UPRedis 放行测试（直连 → 经路由模拟代理）→ Redis 重启 → BullMQ Worker 重启 → Agent Worker 重启；
#   5. 不论成败，删除专用 Redis 容器与两个测试库；任一项失败则脚本以非零退出。
#
# 用法：scripts/dev/release-gates.sh      # 前提：开发栈 mysql 服务已 healthy
# 不包含 agent-worker-dsh-restart gate：它还需要独立的 sandbox 与 HMAC 资源。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

REDIS_CONTAINER="dsh-release-gate-redis-dev"
GATE_DB="dsh_gate_dev"
SIDE_DB="${GATE_DB}_side"
RUNNER_IMAGE="dsh-release-gate-runner:local"
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
    docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
    mysql_root "DROP DATABASE IF EXISTS ${GATE_DB}; DROP DATABASE IF EXISTS ${SIDE_DB};" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[1/4] Building runner image ${RUNNER_IMAGE} from the working tree..."
docker build -q -t "$RUNNER_IMAGE" -f scripts/dev/release-gate-runner.Dockerfile . >/dev/null

echo "[2/4] Starting dedicated Redis 5.0.14 container ${REDIS_CONTAINER} on ${NETWORK}..."
docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$REDIS_CONTAINER" --network "$NETWORK" redis:5.0.14 \
    redis-server --appendonly yes --maxmemory-policy noeviction --requirepass "$GATE_REDIS_PASSWORD" >/dev/null

echo "[3/4] Recreating ${GATE_DB} and ${SIDE_DB}..."
mysql_root "DROP DATABASE IF EXISTS ${GATE_DB}; DROP DATABASE IF EXISTS ${SIDE_DB};
CREATE DATABASE ${GATE_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE ${SIDE_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON ${GATE_DB}.* TO '${APP_USER}'@'%';
GRANT ALL ON ${SIDE_DB}.* TO '${APP_USER}'@'%';"

echo "[4/4] Running release tests in ${RUNNER_IMAGE}..."
GATE_MYSQL_USER="$APP_USER" \
GATE_MYSQL_PASSWORD="$(docker compose exec -T mysql printenv MYSQL_PASSWORD)" \
docker run --rm -i --network "$NETWORK" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e GATE_MYSQL_USER -e GATE_MYSQL_PASSWORD \
    -e GATE_DB="$GATE_DB" \
    -e GATE_REDIS_PASSWORD="$GATE_REDIS_PASSWORD" \
    -e TEST_REDIS_CONTAINER="$REDIS_CONTAINER" \
    "$RUNNER_IMAGE" bash -s <<'INNER'
set -euo pipefail
cd /repo/agent

enc() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"; }
export TEST_MYSQL_URL="mysql://$(enc "$GATE_MYSQL_USER"):$(enc "$GATE_MYSQL_PASSWORD")@mysql:3306/${GATE_DB}"
export TEST_REDIS_URL="redis://:$(enc "$GATE_REDIS_PASSWORD")@${TEST_REDIS_CONTAINER}:6379/0"
export RUN_REDIS_RESTART_GATE=1 RUN_BULLMQ_WORKER_RESTART_GATE=1 RUN_AGENT_WORKER_RESTART_GATE=1

echo "node $(node -v)"
status=0

echo "=== UPRedis queue release test (direct Redis 5.0.14)"
TEST_UPREDIS_URL="redis://${TEST_REDIS_CONTAINER}:6379/0" TEST_UPREDIS_PASSWORD="$GATE_REDIS_PASSWORD" \
    TEST_UPREDIS_REQUIRE_NOEVICTION=1 \
    npx tsx --test tests/redis/upredis-queue.integration.test.js || status=1

echo "=== UPRedis queue release test (routing simulator)"
UPREDIS_SIM_LISTEN=16380 UPREDIS_SIM_TARGET="${TEST_REDIS_CONTAINER}:6379" \
    node ../scripts/dev/upredis-sim-proxy.mjs &
proxy=$!
node -e 'const net=require("net");const t=Date.now();(function f(){net.connect(16380,"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>Date.now()-t>10000?process.exit(1):setTimeout(f,100))})()'
TEST_UPREDIS_URL="redis://127.0.0.1:16380/0" TEST_UPREDIS_PASSWORD="$GATE_REDIS_PASSWORD" \
    TEST_UPREDIS_EXPECT_ROUTING=1 \
    npx tsx --test tests/redis/upredis-queue.integration.test.js || status=1
kill "$proxy" 2>/dev/null || true

for gate in redis-restart bullmq-worker-restart agent-worker-restart; do
    echo "=== ${gate} release gate"
    npx tsx --test "tests/redis/${gate}.release-gate.test.js" || status=1
done

exit "$status"
INNER
