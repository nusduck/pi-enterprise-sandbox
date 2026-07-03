#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Pi Enterprise Sandbox — Backup Script
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_NAME="sandbox-backup-${TIMESTAMP}"

mkdir -p "$BACKUP_DIR"

echo "=== Pi Enterprise Sandbox Backup ==="
echo "Backup dir: $BACKUP_DIR"
echo ""

# ── 1. Backup SQLite database ────────────────────────────────────────
if docker compose exec -T sandbox test -f /sandbox/data/sandbox.db 2>/dev/null; then
    echo "[1/3] Backing up SQLite database..."
    docker compose exec -T sandbox sh -c 'sqlite3 /sandbox/data/sandbox.db ".backup /tmp/sandbox-backup.db"'
    docker compose cp sandbox:/tmp/sandbox-backup.db "${BACKUP_DIR}/${BACKUP_NAME}.db"
    docker compose exec -T sandbox rm -f /tmp/sandbox-backup.db
    echo "      → ${BACKUP_NAME}.db"
else
    echo "[1/3] SQLite database not found — skipping"
fi

# ── 2. Backup PostgreSQL database ────────────────────────────────────
if docker compose exec -T sandbox env | grep -q postgresql 2>/dev/null; then
    echo "[2/3] Backing up PostgreSQL database..."
    DB_URL=$(docker compose exec -T sandbox env | grep SANDBOX_DATABASE_URL | cut -d= -f2-)
    if [ -n "$DB_URL" ]; then
        pg_dump "$DB_URL" > "${BACKUP_DIR}/${BACKUP_NAME}.sql"
        gzip "${BACKUP_DIR}/${BACKUP_NAME}.sql"
        echo "      → ${BACKUP_NAME}.sql.gz"
    fi
else
    echo "[2/3] PostgreSQL not configured — skipping"
fi

# ── 3. Backup workspaces (non-empty only) ────────────────────────────
echo "[3/3] Backing up workspaces..."
if [ -d ./workspaces ] && [ "$(ls -A ./workspaces 2>/dev/null)" ]; then
    tar -czf "${BACKUP_DIR}/${BACKUP_NAME}-workspaces.tar.gz" \
        --exclude='*.pyc' \
        --exclude='__pycache__' \
        ./workspaces/
    echo "      → ${BACKUP_NAME}-workspaces.tar.gz"
else
    echo "[3/3] Workspaces empty or missing — skipping"
fi

# ── 4. Backup config ─────────────────────────────────────────────────
echo "[4/4] Backing up config..."
cp .env "${BACKUP_DIR}/${BACKUP_NAME}.env" 2>/dev/null || true
cp docker-compose.yml "${BACKUP_DIR}/${BACKUP_NAME}.docker-compose.yml" 2>/dev/null || true
echo ""

# ── Summary ──────────────────────────────────────────────────────────
echo "=== Backup complete ==="
ls -lh "${BACKUP_DIR}/${BACKUP_NAME}"* 2>/dev/null || echo "(empty backup)"
echo ""
echo "To restore:"
echo "  docs/deployment.md → section 'Restore from Backup'"
