# Development reset (MySQL-only formal topology)

This runbook irreversibly clears the disposable development stack. It is for
the formal development topology, which uses MySQL 8 for durable state and
Redis 7 for coordination. It does not migrate, back up, snapshot, or restore
user data.

SQLite and PostgreSQL are not reset targets. The old SQLite reset helper was
removed with the compatibility persistence layer; this runbook only resets the
Compose project's MySQL/Redis volumes and project-owned filesystem roots.

## Preconditions

1. Stop Frontend, BFF, Agent, Agent Worker, and Sandbox. Block new requests.
2. Confirm the target is the disposable `pi-enterprise-sandbox` development
   project. Do not run this procedure against production or a shared MySQL.
3. Set `RESET_ALLOWED_ROOT` to a narrow, project-owned state root. It must
   not be `/`, `$HOME`, or a shared parent directory.
4. Set workspace and attachment roots below that allowed root. The shell guard
   below refuses to continue when either path escapes it.
5. Do not run `scripts/backup.sh` or create a snapshot for this empty-state
   reset unless a separate retention requirement explicitly calls for it.

Required environment (use absolute paths):

```bash
export DEPLOYMENT_ENV=development
export PROJECT_ID=pi-enterprise-sandbox
export RESET_ALLOWED_ROOT=/absolute/project-owned/state
export SANDBOX_WORKSPACES_ROOT=/absolute/project-owned/state/workspaces
export SANDBOX_ATTACHMENTS_ROOT=/absolute/project-owned/state/workspaces
export MYSQL_DATABASE=sandbox
export MYSQL_USER=sandbox
```

`AGENT_DATABASE_URL` and `SANDBOX_DATABASE_URL` must both resolve to the
development MySQL service (for example, `mysql://...@mysql:3306/sandbox` and
`mysql+pymysql://...@mysql:3306/sandbox`). Do not put a SQLite or PostgreSQL
DSN in `.env` to make this procedure pass.

## Preflight and reset

Review the paths before deleting anything:

```bash
test "$DEPLOYMENT_ENV" = development
test "$PROJECT_ID" = pi-enterprise-sandbox
test -d "$RESET_ALLOWED_ROOT"
case "$SANDBOX_WORKSPACES_ROOT" in
  "$RESET_ALLOWED_ROOT"/*) ;;
  *) echo 'workspace root escapes RESET_ALLOWED_ROOT' >&2; exit 1 ;;
esac
case "$SANDBOX_ATTACHMENTS_ROOT" in
  "$RESET_ALLOWED_ROOT"/*) ;;
  *) echo 'attachment root escapes RESET_ALLOWED_ROOT' >&2; exit 1 ;;
esac
printf 'Resetting MySQL database %s and filesystem roots:\n' "$MYSQL_DATABASE"
printf '  %s\n  %s\n' "$SANDBOX_WORKSPACES_ROOT" "$SANDBOX_ATTACHMENTS_ROOT"
```

Stop the stack and remove only this Compose project's named volumes. This
clears MySQL facts and Redis coordination state together; no old Run or
Conversation state is retained:

```bash
docker compose down -v --remove-orphans
```

Clear the project-owned workspace roots after the stack is stopped. The
`mindepth` guard prevents deleting the allowed root itself:

```bash
mkdir -p "$SANDBOX_WORKSPACES_ROOT" "$SANDBOX_ATTACHMENTS_ROOT"
find "$SANDBOX_WORKSPACES_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
if [ "$SANDBOX_ATTACHMENTS_ROOT" != "$SANDBOX_WORKSPACES_ROOT" ]; then
  find "$SANDBOX_ATTACHMENTS_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
fi
```

## Redeploy from empty state

1. Start a complete, same-version stack; do not mix old Agent, Worker, BFF,
   or Sandbox images:

   ```bash
   docker compose build agent agent-worker api-server sandbox
   docker compose up -d
   ```

2. Agent startup applies the immutable MySQL migrations. Verify the migration
   table and checksums before accepting traffic; a checksum mismatch is a
   release-blocking error.
3. Verify `/health/ready`, Agent/Sandbox readiness, and the formal internal
   HMAC plane before opening traffic.
4. Run the zero-Skill, workspace isolation, event ordering, authorization,
   dataset, artifact, and cross-service smoke gates.
5. Provision the first administrator through the current admin flow.

If a migration or readiness check fails, keep traffic stopped, fix the cause,
and repeat from an empty MySQL/Redis volume. There is no old-data rollback
path for this destructive development reset.
