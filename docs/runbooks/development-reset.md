# Development reset and empty PostgreSQL cutover

This runbook is intentionally destructive. It is only for the current development-stage full reset. It does not back up, migrate, snapshot, or restore existing users, conversations, sessions, events, audits, workspaces, or attachments.

## Preconditions

1. Stop Frontend, BFF, Agent, and Sandbox. Block new requests.
2. Confirm the target is the `pi-enterprise-sandbox` development environment.
3. Set `RESET_ALLOWED_ROOT` to the narrow project-owned state root. It must not be `/` and every file target must resolve below it.
4. Set `RESET_DATABASE_NAME` to the exact PostgreSQL database name. The reset rejects a different database in the DSN.
5. Do not run `scripts/backup.sh` or create a snapshot for this cutover.

Required environment:

```bash
export DEPLOYMENT_ENV=development
export PROJECT_ID=pi-enterprise-sandbox
export RESET_ALLOWED_ROOT=/absolute/project-owned/state
export RESET_DATABASE_NAME=sandbox
export SANDBOX_DATABASE_URL=sqlite:////absolute/project-owned/state/data/sandbox.db
export SANDBOX_WORKSPACES_ROOT=/absolute/project-owned/state/workspaces
export SANDBOX_ATTACHMENTS_ROOT=/absolute/project-owned/state/workspaces
```

Attachments currently live inside each workspace, so the last two roots may be the same. Both are still listed in the preflight output.

## Preflight and reset

The command defaults to dry-run and prints only the target paths; it never prints the DSN or credentials.

```bash
.venv/bin/python scripts/reset-development.py \
  --confirm 'RESET pi-enterprise-sandbox DEVELOPMENT DATA'
```

Review every listed target. Then execute:

```bash
.venv/bin/python scripts/reset-development.py \
  --confirm 'RESET pi-enterprise-sandbox DEVELOPMENT DATA' \
  --execute
```

SQLite removes the database, WAL, SHM, and contents of the declared state roots. PostgreSQL transactionally recreates the `public` schema in the explicitly named database, then clears the declared filesystem roots. Skill packages are cleared by the R8 zero-Skill cutover, not by this command.

## Redeploy from empty state

1. Deploy the complete new version; do not start a mixed-version stack.
2. Set a strong `POSTGRES_PASSWORD` and start the production overlay. PostgreSQL is mandatory there; SQLite remains development/test only.
3. Sandbox startup applies immutable `schema_migrations`. A repeated initialization must make no schema changes; a checksum mismatch is a release-blocking error.
4. Provision the first administrator through the R6 admin flow.
5. Run database, zero-Skill, relative-workspace, event ordering, authorization, and cross-service smoke checks before reopening traffic.

If any step fails, keep traffic stopped, fix the cause, and restart from an empty environment. There is no old-data rollback path for this development cutover.
