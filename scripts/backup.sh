#!/usr/bin/env bash
# Production backup for the MySQL control plane and Session-owned runtime files.
set -euo pipefail

umask 077

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="${BACKUP_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_NAME="sandbox-backup-${TIMESTAMP}"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-sandbox-backup.XXXXXX")"

cleanup() {
    rm -rf "$STAGING_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

docker compose ps mysql >/dev/null
docker compose ps sandbox >/dev/null

MYSQL_DUMP="${STAGING_DIR}/${BACKUP_NAME}.mysql.sql"
MYSQL_ARCHIVE="${BACKUP_DIR}/${BACKUP_NAME}.mysql.sql.gz"
RUNTIME_ARCHIVE="${BACKUP_DIR}/${BACKUP_NAME}-runtime-files.tar.gz"
MANIFEST="${BACKUP_DIR}/${BACKUP_NAME}.manifest"

echo "=== Pi Enterprise Sandbox Backup ==="
echo "Backup directory: $BACKUP_DIR"

echo "[1/3] Backing up the MySQL control plane..."
docker compose exec -T mysql sh -c '
    exec mysqldump \
        --single-transaction \
        --quick \
        --routines \
        --triggers \
        --events \
        --hex-blob \
        --set-gtid-purged=OFF \
        -u"$MYSQL_USER" \
        -p"$MYSQL_PASSWORD" \
        "$MYSQL_DATABASE"
' >"$MYSQL_DUMP"
gzip -c "$MYSQL_DUMP" >"${MYSQL_ARCHIVE}.tmp"
mv "${MYSQL_ARCHIVE}.tmp" "$MYSQL_ARCHIVE"

echo "[2/3] Backing up Session runtime files..."
# Use a one-shot Sandbox container so bind mounts and named volumes are handled
# by Compose without assuming host paths. Archive paths stay relative to /.
docker compose run --rm --no-deps -T --entrypoint sh sandbox -c '
    set --
    for path in \
        /var/sandbox/workspaces \
        /var/sandbox/tmp \
        /var/sandbox/artifacts \
        /var/sandbox/control
    do
        if [ -e "$path" ]; then
            set -- "$@" "${path#/}"
        fi
    done
    if [ "$#" -eq 0 ]; then
        exit 64
    fi
    exec tar -C / -czf - "$@"
' >"${RUNTIME_ARCHIVE}.tmp"
mv "${RUNTIME_ARCHIVE}.tmp" "$RUNTIME_ARCHIVE"

echo "[3/3] Writing a non-secret manifest..."
DATABASE_NAME="$(docker compose exec -T mysql sh -c 'printf %s "$MYSQL_DATABASE"')"
GIT_REVISION="$(git rev-parse --verify HEAD 2>/dev/null || printf unknown)"
{
    printf 'format=pi-enterprise-backup-v1\n'
    printf 'created_at=%s\n' "$TIMESTAMP"
    printf 'database=%s\n' "$DATABASE_NAME"
    printf 'git_revision=%s\n' "$GIT_REVISION"
    printf 'mysql_archive=%s\n' "$(basename "$MYSQL_ARCHIVE")"
    printf 'runtime_archive=%s\n' "$(basename "$RUNTIME_ARCHIVE")"
} >"${MANIFEST}.tmp"
mv "${MANIFEST}.tmp" "$MANIFEST"

echo "=== Backup complete ==="
ls -lh "$MYSQL_ARCHIVE" "$RUNTIME_ARCHIVE" "$MANIFEST"
echo "Secrets and .env files are intentionally excluded."
echo "Restore prefix: ${BACKUP_DIR}/${BACKUP_NAME}"
