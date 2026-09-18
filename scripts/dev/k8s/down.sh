#!/usr/bin/env bash
# 清理 up.sh 起的 K8s 运行栈。
#   down.sh dev   删除命名空间 pi-dev，并把应用服务交还给 Compose（docker compose up -d）。
#   down.sh sim   删除命名空间 pi-sim、专用 Redis / exec 容器、专用库与数据根。
set -euo pipefail

MODE="${1:-dev}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
dc() { docker compose --project-directory "$ROOT" "$@"; }

case "$MODE" in
dev)
    kubectl --context orbstack delete namespace pi-dev --ignore-not-found --wait=true >/dev/null
    dc up -d
    ;;
sim)
    kubectl --context orbstack delete namespace pi-sim --ignore-not-found --wait=true >/dev/null
    docker rm -f pi-k8s-sim-sandbox pi-k8s-sim-redis >/dev/null 2>&1 || true
    dc exec -T mysql sh -c \
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N -e "DROP DATABASE IF EXISTS pi_k8s_sim;"'
    # 文件由容器里的 uid 10001 / 1000 写出；宿主删不掉时退回用容器删。
    DATA_ROOT="$ROOT/.runtime/k8s-sim"
    rm -rf "$DATA_ROOT" 2>/dev/null || docker run --rm -v "$DATA_ROOT:/data" --entrypoint sh \
        enterprise-sandbox:latest -c 'rm -rf /data/* /data/.[!.]*' >/dev/null 2>&1 || true
    rm -rf "$DATA_ROOT" 2>/dev/null || true
    ;;
*)
    echo "usage: $0 [dev|sim]" >&2
    exit 64
    ;;
esac
