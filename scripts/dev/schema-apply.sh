#!/usr/bin/env bash
# 开发环境建表：导出 schema 发布包并逐段执行到开发库（ADR 0011 D6）。
#
# 开发与生产走同一流程——任何服务启动时都不迁移；agent / agent-worker / sandbox
# 只按随包清单只读核对，结构不对即拒绝启动。本脚本扮演「DBA」：
#   1. 在 mysql 容器里重建空影子库 pi_schema_shadow；
#   2. 用 agent 镜像在影子库上跑迁移，导出分段 SQL 发布包到 .runtime/schema-release；
#   3. 目标库为空时，用 mysql 客户端按文件顺序逐段执行，首个错误即停（不使用 --force）；
#      目标库非空时不执行，只做第 4 步；
#   4. 用 agent 镜像按清单只读核对目标库。
#
# 用法：
#   scripts/dev/schema-apply.sh [database]        # 默认 mysql 容器的 MYSQL_DATABASE
# 叠加 overlay 时用 docker compose 自带的 COMPOSE_FILE 环境变量。
# 前提：agent 镜像是当前代码构建的（docker compose build agent），mysql 服务已 healthy。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RELEASE_DIR="$ROOT/.runtime/schema-release"
SHADOW_DB="pi_schema_shadow"
CLI="dist/src/infrastructure/mysql/cli-schema.js"

cd "$ROOT"

container_env() {
    docker compose exec -T mysql printenv "$1"
}

DB="${1:-$(container_env MYSQL_DATABASE)}"
if ! [[ "$DB" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "Refusing unsafe database name: $DB" >&2
    exit 64
fi
APP_USER="$(container_env MYSQL_USER)"

root_sql() {
    docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot -N --default-character-set=utf8mb4 -e "$1"' _ "$1"
}

schema_cli() {
    # 以宿主用户身份运行，避免在 bind mount 上写出属主不对的文件。
    docker compose run --rm --no-deps -T --user "$(id -u):$(id -g)" --entrypoint node "$@"
}

echo "[1/4] Recreating empty shadow database ${SHADOW_DB}..."
root_sql "DROP DATABASE IF EXISTS ${SHADOW_DB}; CREATE DATABASE ${SHADOW_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "[2/4] Exporting the schema release from migrations..."
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
ROOT_PASSWORD="$(container_env MYSQL_ROOT_PASSWORD)"
schema_cli \
    -v "$RELEASE_DIR:/release" \
    -e "SCHEMA_SHADOW_DATABASE_URL=mysql://root@mysql:3306/${SHADOW_DB}" \
    -e "SCHEMA_SHADOW_PASSWORD=${ROOT_PASSWORD}" \
    agent "$CLI" sql --out /release
unset ROOT_PASSWORD

TABLES="$(root_sql "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${DB}'")"
if [ "$TABLES" = "0" ]; then
    echo "[3/4] Applying the release to empty database ${DB} (stops at the first error)..."
    for file in "$RELEASE_DIR"/*.sql; do
        echo "  -> $(basename "$file")"
        docker compose exec -T mysql sh -c \
            'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot --default-character-set=utf8mb4 "$1"' _ "$DB" < "$file"
    done
else
    echo "[3/4] Database ${DB} is not empty (${TABLES} tables); not applying a first-install release."
    echo "      If verification below fails, follow docs/runbooks/mysql-partial-migration-recovery.md."
fi

echo "[4/4] Verifying ${DB} against the bundled manifest (read-only)..."
APP_PASSWORD="$(container_env MYSQL_PASSWORD)"
schema_cli \
    -e "SCHEMA_VERIFY_DATABASE_URL=mysql://${APP_USER}@mysql:3306/${DB}" \
    -e "SCHEMA_VERIFY_PASSWORD=${APP_PASSWORD}" \
    agent "$CLI" verify
unset APP_PASSWORD

echo "Schema ready. Services that were waiting will pass their startup check on the next restart:"
echo "  docker compose up -d"
