#!/usr/bin/env bash
# Restore a backup produced by scripts/backup.sh into the configured MySQL DB.
set -euo pipefail

umask 077

if [ "$#" -ne 1 ]; then
    echo "Usage: RESTORE_CONFIRM=restore $0 <backup_prefix>" >&2
    exit 64
fi

if [ "${RESTORE_CONFIRM:-}" != "restore" ]; then
    echo "Refusing destructive restore: set RESTORE_CONFIRM=restore" >&2
    exit 64
fi

BACKUP_PATH="$1"
MYSQL_ARCHIVE="${BACKUP_PATH}.mysql.sql.gz"
RUNTIME_ARCHIVE="${BACKUP_PATH}-runtime-files.tar.gz"
MANIFEST="${BACKUP_PATH}.manifest"

for required in "$MYSQL_ARCHIVE" "$RUNTIME_ARCHIVE" "$MANIFEST"; do
    if [ ! -f "$required" ]; then
        echo "Missing backup component: $required" >&2
        exit 66
    fi
done

if ! grep -qx 'format=pi-enterprise-backup-v1' "$MANIFEST"; then
    echo "Unsupported or invalid backup manifest" >&2
    exit 65
fi

gzip -t "$MYSQL_ARCHIVE"
tar -tzf "$RUNTIME_ARCHIVE" | while IFS= read -r entry; do
    case "$entry" in
        var/sandbox/workspaces/*|var/sandbox/tmp/*|var/sandbox/artifacts/*|var/sandbox/control/*|var/sandbox/workspaces|var/sandbox/tmp|var/sandbox/artifacts|var/sandbox/control)
            ;;
        *)
            echo "Unsafe runtime archive entry: $entry" >&2
            exit 65
            ;;
    esac
done

docker compose ps mysql >/dev/null

echo "=== Pi Enterprise Sandbox Restore ==="
echo "Restore prefix: $BACKUP_PATH"
echo "Stopping data-plane writers..."
docker compose stop api-server agent agent-worker sandbox

restart_data_plane() {
    docker compose up -d sandbox agent agent-worker api-server frontend >/dev/null
}
trap restart_data_plane EXIT INT TERM

echo "[1/3] Restoring the MySQL control plane..."
gzip -dc "$MYSQL_ARCHIVE" | docker compose exec -T mysql sh -c '
    exec mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"
'

echo "[2/3] Restoring Session runtime files..."
gzip -dc "$RUNTIME_ARCHIVE" | docker compose run \
    --rm \
    --no-deps \
    -T \
    --entrypoint sh \
    sandbox \
    -c 'exec tar -C / -xzf - --no-same-owner --no-same-permissions'

echo "[3/3] Applying any forward-compatible Agent migrations..."
docker compose run --rm --no-deps -T agent-migrate

trap - EXIT INT TERM
restart_data_plane

echo "=== Restore complete ==="
echo "Verify readiness before returning traffic: docker compose ps"
