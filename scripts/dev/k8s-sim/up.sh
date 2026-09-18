#!/usr/bin/env bash
# 在 OrbStack 单节点 K8s 里起一套本地演练栈（多副本、探针、滚动更新、共享 Skill 目录）。
# 不是生产部署脚本：目标环境的清单归平台团队，这里只用来在本地先暴露编排层问题。
#
# 步骤：
#   1. 重建专用库 pi_k8s_sim，按发布 DDL 建表（与生产同一流程，服务启动不迁移）；
#   2. 重建专用数据根 .runtime/k8s-sim/（exec 数据根 + 模拟共享存储的 skill-user / skill-draft）；
#   3. 起专用 Redis 与专用 exec 容器（模拟 VM），exec 的隔离配置照搬开发栈 sandbox 容器；
#   4. 各服务的环境变量取自开发栈容器（即 Compose 渲染后的值），只改库名与模型地址，写成 Secret；
#   5. 渲染 manifests.yaml 并 apply，等待全部 Deployment 就绪。
#
# 前提：开发栈 mysql、dbpm-fake、agent、agent-worker、api-server、sandbox 在运行（借它们的渲染环境）；
#       镜像是当前代码构建的；kubectl context `orbstack` 可用。
# 用法：scripts/dev/k8s-sim/up.sh      清理：scripts/dev/k8s-sim/down.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
K() { kubectl --context orbstack "$@"; }

SIM_DB="pi_k8s_sim"
REDIS_CONTAINER="pi-k8s-sim-redis"
SANDBOX_CONTAINER="pi-k8s-sim-sandbox"
DATA_ROOT="$ROOT/.runtime/k8s-sim"
NS="pi-sim"

mysql_root() {
    docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -e "$1"' _ "$1"
}
ip_on() { docker inspect "$1" -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}"; }

# 容器的运行环境减去镜像自带的 ENV，即 Compose 渲染出的服务配置；输出 KEY=VALUE 行。
service_env() {
    docker inspect "$1" | python3 -c '
import json, sys
c = json.load(sys.stdin)[0]
img = set(json.loads(sys.argv[1]))
for kv in c["Config"]["Env"]:
    if kv in img:
        continue
    if "\n" in kv:
        sys.exit("multi-line env value: " + kv.split("=", 1)[0])
    print(kv)
' "$(docker image inspect "$(docker inspect "$1" -f '{{.Config.Image}}')" -f '{{json .Config.Env}}')"
}

# 按 KEY 覆盖（没有则追加）。
override() {
    local file="$1"; shift
    python3 - "$file" "$@" <<'PY'
import sys
path, pairs = sys.argv[1], sys.argv[2:]
lines = open(path).read().splitlines()
for pair in pairs:
    key = pair.split("=", 1)[0]
    lines = [l for l in lines if not l.startswith(key + "=")] + [pair]
open(path, "w").write("\n".join(lines) + "\n")
PY
}

for svc in mysql dbpm-fake agent agent-worker api-server sandbox; do
    if [ -z "$(docker compose ps -q "$svc")" ]; then
        echo "development service $svc is not running; start the development stack first" >&2
        exit 64
    fi
done
K get nodes >/dev/null

NETWORK="$(docker inspect "$(docker compose ps -q mysql)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | grep backend-internal)"
APP_USER="$(docker compose exec -T mysql printenv MYSQL_USER)"
REDIS_PASSWORD="$(docker compose exec -T redis printenv REDIS_PASSWORD)"

echo "[0/5] Removing a previous simulation..."
"$ROOT/scripts/dev/k8s-sim/down.sh" >/dev/null 2>&1 || true

echo "[1/5] Recreating ${SIM_DB} and applying the release DDL..."
mysql_root "CREATE DATABASE ${SIM_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON ${SIM_DB}.* TO '${APP_USER}'@'%';"
scripts/dev/schema-apply.sh "$SIM_DB" >/dev/null

echo "[2/5] Recreating data roots under ${DATA_ROOT}..."
mkdir -p "$DATA_ROOT"/{workspaces,tmp,artifacts,control,skill-user,skill-draft}
# Agent（uid 1000）写 skill-user / skill-draft，exec（uid 10001）读 skill-user、写 skill-draft。
chmod 0777 "$DATA_ROOT/skill-user" "$DATA_ROOT/skill-draft"

echo "[3/5] Starting dedicated Redis and exec (VM stand-in) on ${NETWORK}..."
docker run -d --name "$REDIS_CONTAINER" --network "$NETWORK" redis:5.0.14 \
    redis-server --appendonly yes --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD" >/dev/null

SANDBOX_ENV="$(mktemp)"
trap 'rm -f "$SANDBOX_ENV" "${ENV_DIR:-/nonexistent}"/*.env' EXIT
service_env "$(docker compose ps -q sandbox)" > "$SANDBOX_ENV"
override "$SANDBOX_ENV" "SANDBOX_DATABASE_URL=mysql+pymysql://${APP_USER}@mysql:3306/${SIM_DB}"
docker run -d --name "$SANDBOX_CONTAINER" --network "$NETWORK" --network-alias "$SANDBOX_CONTAINER" \
    --init --user 10001:10001 \
    --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL \
    --security-opt "seccomp=$ROOT/exec/seccomp-bubblewrap.json" \
    --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
    --env-file "$SANDBOX_ENV" \
    -v "$ROOT/skills:/home/sandbox/skill:ro" \
    -v "$DATA_ROOT/skill-user:/home/sandbox/skill-user:ro" \
    -v "$DATA_ROOT/workspaces:/var/sandbox/workspaces" \
    -v "$DATA_ROOT/tmp:/var/sandbox/tmp" \
    -v "$DATA_ROOT/artifacts:/var/sandbox/artifacts" \
    -v "$DATA_ROOT/control:/var/sandbox/control" \
    -v "$DATA_ROOT/skill-draft:/var/sandbox/skill-draft" \
    "$(docker inspect "$(docker compose ps -q sandbox)" -f '{{.Config.Image}}')" >/dev/null
for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$SANDBOX_CONTAINER")" = healthy ] && break
    sleep 2
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' "$SANDBOX_CONTAINER")" != healthy ]; then
    docker logs "$SANDBOX_CONTAINER" 2>&1 | tail -20 >&2
    echo "dedicated exec did not become healthy" >&2
    exit 1
fi

echo "[4/5] Rendering service environments into Secrets..."
ENV_DIR="$(mktemp -d)"
service_env "$(docker compose ps -q agent)" > "$ENV_DIR/agent.env"
service_env "$(docker compose ps -q agent-worker)" > "$ENV_DIR/agent-worker.env"
service_env "$(docker compose ps -q api-server)" > "$ENV_DIR/api-server.env"
# 后四行缩短租约 / 锁 / 恢复间隔，让接管场景在几十秒内发生（与 release gate 同一做法，代码路径不变）。
for f in agent agent-worker; do
    override "$ENV_DIR/$f.env" \
        "AGENT_DATABASE_URL=mysql://${APP_USER}@mysql:3306/${SIM_DB}" \
        "LLMIO_BASE_URL=http://fake-llm:8080/v1" \
        "LLMIO_API_KEY=k8s-sim-fake-key" \
        "MCP_SERVERS_JSON=[]" \
        "AGENT_RUN_LEASE_TTL_MS=10000" "AGENT_RUN_LEASE_RENEW_INTERVAL_MS=2000" \
        "AGENT_SESSION_LOCK_TTL_MS=10000" "AGENT_SESSION_LOCK_RENEW_INTERVAL_MS=2000" \
        "AGENT_BULLMQ_LOCK_DURATION_MS=12000" "AGENT_BULLMQ_STALLED_INTERVAL_MS=3000" \
        "AGENT_BULLMQ_MAX_STALLED_COUNT=2" "AGENT_RECOVERY_INTERVAL_MS=3000"
done
K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Namespace
metadata: { name: ${NS} }
EOF
for f in agent agent-worker api-server; do
    K -n "$NS" create secret generic "$f-env" --from-env-file="$ENV_DIR/$f.env" \
        --dry-run=client -o yaml | K apply -f - >/dev/null
done

echo "[5/5] Applying manifests..."
sed -e "s#__REPO__#${ROOT}#g" \
    -e "s#__MYSQL_IP__#$(ip_on "$(docker compose ps -q mysql)" "$NETWORK")#" \
    -e "s#__DBPM_IP__#$(ip_on "$(docker compose ps -q dbpm-fake)" "$NETWORK")#" \
    -e "s#__REDIS_IP__#$(ip_on "$REDIS_CONTAINER" "$NETWORK")#" \
    -e "s#__SANDBOX_IP__#$(ip_on "$SANDBOX_CONTAINER" "$NETWORK")#" \
    scripts/dev/k8s-sim/manifests.yaml | K apply -f - >/dev/null
for d in fake-llm agent agent-worker api-server frontend; do
    K -n "$NS" rollout status "deployment/$d" --timeout=180s
done
K -n "$NS" get pods -o wide
