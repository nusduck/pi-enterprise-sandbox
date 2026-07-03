#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Pi Enterprise Sandbox — Restore Script
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <backup_path>"
    echo "Example: $0 ./backups/sandbox-backup-20260401_120000"
    exit 1
fi

BACKUP_PATH="${1}"
BACKUP_DIR="$(dirname "$BACKUP_PATH")"
BACKUP_NAME="$(basename "$BACKUP_PATH")"

echo "=== Pi Enterprise Sandbox Restore ==="
echo "Restoring from: $BACKUP_PATH"
echo ""

# Check Docker is running
docker compose ps &>/dev/null || {
    echo "ERROR: Docker Compose services not running. Start them first."
    exit 1
}

# ── 1. Restore SQLite database ───────────────────────────────────────
if [ -f "${BACKUP_PATH}.db" ]; then
    echo "[1/4] Restoring SQLite database..."
    docker compose cp "${BACKUP_PATH}.db" sandbox:/tmp/restore.db
    docker compose exec sandbox sh -c '
        cp /sandbox/data/sandbox.db /sandbox/data/sandbox.db.bak
        cp /tmp/restore.db /sandbox/data/sandbox.db
        rm /tmp/restore.db
        echo "      Restored. Backup saved as sandbox.db.bak"
    '
fi

# ── 2. Restore PostgreSQL database ───────────────────────────────────
if [ -f "${BACKUP_PATH}.sql" ] || [ -f "${BACKUP_PATH}.sql.gz" ]; then
    echo "[2/4] Restoring PostgreSQL database..."
    DB_URL=$(docker compose exec -T sandbox env | grep SANDBOX_DATABASE_URL | cut -d= -f2-)
    if [ -n "$DB_URL" ]; then
        if [ -f "${BACKUP_PATH}.sql.gz" ]; then
            gunzip -c "${BACKUP_PATH}.sql.gz" | psql "$DB_URL"
        else
            psql "$DB_URL" < "${BACKUP_PATH}.sql"
        fi
        echo "      Restored"
    fi
fi

# ── 3. Restore workspaces ────────────────────────────────────────────
if [ -f "${BACKUP_PATH}-workspaces.tar.gz" ]; then
    echo "[3/4] Restoring workspaces..."
    tar -xzf "${BACKUP_PATH}-workspaces.tar.gz" -C .
    echo "      Restored"
fi

# ── 4. Restore config ────────────────────────────────────────────────
if [ -f "${BACKUP_PATH}.env" ]; then
    echo "[4/4] Restoring config..."
    cp "${BACKUP_PATH}.env" .env.restored
    echo "      .env.restored created (not overwriting current .env)"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "=== Restore complete ==="
echo "Restart services: docker compose restart"
echo "Or full rebuild:  docker compose up -d --build"
