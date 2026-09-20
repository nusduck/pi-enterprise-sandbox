#!/usr/bin/env bash
# 在 OrbStack 单节点 K8s 里跑应用服务。不是生产部署脚本：目标环境的清单归平台团队。
#
#   scripts/dev/k8s/up.sh dev   日常本地运行（默认）。命名空间 pi-dev，各 1 副本，真实模型；
#                               MySQL / Redis / dbpm-fake / exec（代替 VM）用 Compose 开发栈，库为 sandbox，
#                               Compose 里的 agent / agent-worker / api-server / frontend / sandbox-mcp 会被停掉
#                               （同一队列不能有两组消费者）。浏览器仍是 http://127.0.0.1:3000。
#   scripts/dev/k8s/up.sh sim   多副本演练。命名空间 pi-sim，各 2 副本，可控假模型 fake-llm；
#                               专用库 pi_k8s_sim、专用 Redis、专用 exec 容器、数据根 .runtime/k8s-sim/，
#                               缩短租约 / 锁 / 恢复间隔。场景驱动：scenarios.mjs。与开发栈互不影响。
#
# 两种模式的服务环境变量都取自 `docker compose config`（即 Compose 渲染值），只按模式改少数几项。
# 清理：scripts/dev/k8s/down.sh <dev|sim>
set -euo pipefail

MODE="${1:-dev}"
case "$MODE" in dev | sim) ;; *) echo "usage: $0 [dev|sim]" >&2; exit 64 ;; esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
HERE="scripts/dev/k8s"
K() { kubectl --context orbstack "$@"; }
dc() { docker compose --project-directory "$ROOT" "$@"; }

mysql_root() {
    dc exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -e "$1"' _ "$1"
}
ip_on() { docker inspect "$1" -f "{{(index .NetworkSettings.Networks \"$2\").IPAddress}}"; }
wait_healthy() {
    for _ in $(seq 1 90); do
        [ "$(docker inspect -f '{{.State.Health.Status}}' "$1")" = healthy ] && return 0
        sleep 2
    done
    docker logs "$1" 2>&1 | tail -20 >&2
    echo "$1 did not become healthy" >&2
    exit 1
}

CONFIG="$(mktemp)"
ENV_DIR="$(mktemp -d)"
trap 'rm -rf "$CONFIG" "$ENV_DIR"' EXIT
dc config --format json > "$CONFIG"

# Compose 渲染后的服务环境 → KEY=VALUE 行；其后的参数按 KEY 覆盖（没有则追加）。
render_env() {
    python3 - "$CONFIG" "$@" <<'PY'
import json, sys
config, service, overrides = sys.argv[1], sys.argv[2], sys.argv[3:]
env = dict(json.load(open(config))["services"][service].get("environment") or {})
for pair in overrides:
    key, _, value = pair.partition("=")
    env[key] = value
for key, value in env.items():
    value = "" if value is None else str(value)
    if "\n" in value:
        sys.exit(f"multi-line env value: {key}")
    print(f"{key}={value}")
PY
}
published_port() {
    python3 - "$CONFIG" "$1" "$2" <<'PY'
import json, sys
ports = json.load(open(sys.argv[1]))["services"][sys.argv[2]].get("ports") or []
print(next((p["published"] for p in ports if int(p["target"]) == int(sys.argv[3])), ""))
PY
}

K get nodes >/dev/null
dc up -d mysql redis dbpm-fake >/dev/null
wait_healthy "$(dc ps -q mysql)"
NETWORK="$(docker inspect "$(dc ps -q mysql)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | grep backend-internal)"
APP_USER="$(dc exec -T mysql printenv MYSQL_USER)"

if [ "$MODE" = dev ]; then
    NS="pi-dev"
    REPLICAS=1
    echo "[1/4] Handing the application tier over to K8s (stopping its Compose services)..."
    dc stop agent agent-worker api-server frontend sandbox-mcp >/dev/null 2>&1 || true
    dc up -d --no-deps skill-draft-init >/dev/null
    dc up -d --no-deps sandbox >/dev/null
    SANDBOX_CONTAINER="$(dc ps -q sandbox)"
    REDIS_CONTAINER="$(dc ps -q redis)"
    wait_healthy "$SANDBOX_CONTAINER"
    # 已启用 Skill 与 Compose 模式共用同一个命名卷：OrbStack 的 K8s 节点就是 Docker 所在的 VM，
    # 节点路径即卷的 Mountpoint（换到别的 K8s 发行版不成立）。
    SKILL_USER_PATH="$(docker volume inspect "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["volumes"]["agent_user_skills"]["name"])' "$CONFIG")" -f '{{.Mountpoint}}')"
    SKILL_DRAFT_PATH="$ROOT/.runtime/sandbox/skill-draft"

    echo "[2/4] Rendering service environments from docker compose config..."
    render_env agent > "$ENV_DIR/agent.env"
    render_env agent-worker > "$ENV_DIR/agent-worker.env"
else
    NS="pi-sim"
    REPLICAS=2
    SIM_DB="pi_k8s_sim"
    DATA_ROOT="$ROOT/.runtime/k8s-sim"
    REDIS_CONTAINER="pi-k8s-sim-redis"
    SANDBOX_CONTAINER="pi-k8s-sim-sandbox"
    REDIS_PASSWORD="$(dc exec -T redis printenv REDIS_PASSWORD)"
    "$ROOT/$HERE/down.sh" sim >/dev/null 2>&1 || true

    echo "[1/4] Recreating ${SIM_DB}, data roots, dedicated Redis and exec (VM stand-in)..."
    mysql_root "CREATE DATABASE ${SIM_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON ${SIM_DB}.* TO '${APP_USER}'@'%';"
    scripts/dev/schema-apply.sh "$SIM_DB" >/dev/null
    mkdir -p "$DATA_ROOT"/{workspaces,tmp,artifacts,control,skill-user,skill-draft}
    # Agent（uid 1000）写 skill-user / skill-draft，exec（uid 10001）读 skill-user、写 skill-draft。
    chmod 0777 "$DATA_ROOT/skill-user" "$DATA_ROOT/skill-draft"
    docker run -d --name "$REDIS_CONTAINER" --network "$NETWORK" redis:5.0.14 \
        redis-server --appendonly yes --maxmemory-policy noeviction --requirepass "$REDIS_PASSWORD" >/dev/null
    render_env sandbox "SANDBOX_DATABASE_URL=mysql+pymysql://${APP_USER}@mysql:3306/${SIM_DB}" > "$ENV_DIR/sandbox.env"
    # 隔离配置与 Compose 的 sandbox 服务一致（seccomp / apparmor / systempaths / capability）。
    docker run -d --name "$SANDBOX_CONTAINER" --network "$NETWORK" \
        --init --user 10001:10001 \
        --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL \
        --security-opt "seccomp=$ROOT/exec/seccomp-bubblewrap.json" \
        --security-opt apparmor=unconfined --security-opt systempaths=unconfined \
        --env-file "$ENV_DIR/sandbox.env" \
        -v "$ROOT/skills:/home/sandbox/skill:ro" \
        -v "$DATA_ROOT/skill-user:/home/sandbox/skill-user:ro" \
        -v "$DATA_ROOT/workspaces:/var/sandbox/workspaces" \
        -v "$DATA_ROOT/tmp:/var/sandbox/tmp" \
        -v "$DATA_ROOT/artifacts:/var/sandbox/artifacts" \
        -v "$DATA_ROOT/control:/var/sandbox/control" \
        -v "$DATA_ROOT/skill-draft:/var/sandbox/skill-draft" \
        enterprise-sandbox:latest >/dev/null
    wait_healthy "$SANDBOX_CONTAINER"
    SKILL_USER_PATH="$DATA_ROOT/skill-user"
    SKILL_DRAFT_PATH="$DATA_ROOT/skill-draft"

    echo "[2/4] Rendering service environments from docker compose config..."
    # 后四行缩短租约 / 锁 / 恢复间隔，让接管场景在几十秒内发生（与 release gate 同一做法，代码路径不变）。
    for f in agent agent-worker; do
        render_env "$f" \
            "AGENT_DATABASE_URL=mysql://${APP_USER}@mysql:3306/${SIM_DB}" \
            "LLMIO_BASE_URL=http://fake-llm:8080/v1" \
            "LLMIO_API_KEY=k8s-sim-fake-key" \
            "MCP_SERVERS_JSON=[]" \
            "AGENT_RUN_LEASE_TTL_MS=10000" "AGENT_RUN_LEASE_RENEW_INTERVAL_MS=2000" \
            "AGENT_SESSION_LOCK_TTL_MS=10000" "AGENT_SESSION_LOCK_RENEW_INTERVAL_MS=2000" \
            "AGENT_BULLMQ_LOCK_DURATION_MS=12000" "AGENT_BULLMQ_STALLED_INTERVAL_MS=3000" \
            "AGENT_BULLMQ_MAX_STALLED_COUNT=2" "AGENT_RECOVERY_INTERVAL_MS=3000" \
            > "$ENV_DIR/$f.env"
    done
fi
render_env api-server > "$ENV_DIR/api-server.env"
render_env sandbox-mcp > "$ENV_DIR/sandbox-mcp.env"

echo "[3/4] Applying manifests to namespace ${NS}..."
EXISTED=false
K get namespace "$NS" >/dev/null 2>&1 && EXISTED=true
K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Namespace
metadata: { name: ${NS} }
EOF
for f in agent agent-worker api-server sandbox-mcp; do
    K -n "$NS" create secret generic "$f-env" --from-env-file="$ENV_DIR/$f.env" \
        --dry-run=client -o yaml | K apply -f - >/dev/null
done
render() {
    sed -e "s#__NS__#${NS}#g" -e "s#__REPO__#${ROOT}#g" -e "s#__REPLICAS__#${REPLICAS}#g" \
        -e "s#__SKILL_USER_PATH__#${SKILL_USER_PATH}#g" -e "s#__SKILL_DRAFT_PATH__#${SKILL_DRAFT_PATH}#g" \
        -e "s#__MYSQL_IP__#$(ip_on "$(dc ps -q mysql)" "$NETWORK")#" \
        -e "s#__DBPM_IP__#$(ip_on "$(dc ps -q dbpm-fake)" "$NETWORK")#" \
        -e "s#__REDIS_IP__#$(ip_on "$REDIS_CONTAINER" "$NETWORK")#" \
        -e "s#__SANDBOX_IP__#$(ip_on "$SANDBOX_CONTAINER" "$NETWORK")#" \
        -e "s#__FRONTEND_PORT__#$(published_port frontend 8080)#" \
        -e "s#__API_PORT__#$(published_port api-server 4000)#" \
        -e "s#__AGENT_PORT__#$(published_port agent 4100)#" \
        -e "s#__MCP_PORT__#$(published_port sandbox-mcp 8082)#" \
        "$1"
}
{
    render "$HERE/manifests.yaml"
    if [ "$MODE" = sim ]; then echo "---"; render "$HERE/fake-llm.yaml"; else echo "---"; render "$HERE/expose.yaml"; fi
} | K apply -f - >/dev/null
# 应用镜像都是固定 :latest + imagePullPolicy: Never：重建同名镜像不改 Pod 模板，apply 不会滚动，
# Secret 变了也一样。再次运行时显式重启**所有**用本地镜像的 Deployment，确保读到新镜像与新环境
# （frontend 曾漏在这张表外，重建后 rollout status 直接对旧 Pod 报成功）。fake-llm 用公共镜像，不在此列。
APP_DEPLOYMENTS="agent agent-worker api-server frontend sandbox-mcp"
if [ "$EXISTED" = true ]; then
    # shellcheck disable=SC2086 # 按空格拆成多个 deployment/<name>
    K -n "$NS" rollout restart $(printf 'deployment/%s ' $APP_DEPLOYMENTS) >/dev/null
fi

echo "[4/4] Waiting for rollouts..."
DEPLOYMENTS="$APP_DEPLOYMENTS"
[ "$MODE" = sim ] && DEPLOYMENTS="fake-llm $DEPLOYMENTS"
for d in $DEPLOYMENTS; do
    K -n "$NS" rollout status "deployment/$d" --timeout=240s
done
K -n "$NS" get pods -o wide
if [ "$MODE" = dev ]; then
    echo "Frontend: http://127.0.0.1:$(published_port frontend 8080)  (back to Compose: scripts/dev/k8s/down.sh dev)"
fi
