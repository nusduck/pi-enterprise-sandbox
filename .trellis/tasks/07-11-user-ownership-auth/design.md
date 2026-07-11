# Design: user ownership and authentication

## Feature gate

- `SANDBOX_AUTH_ENABLED=false` (default): open single-user mode for local/dev; no ownership enforcement.
- `SANDBOX_AUTH_ENABLED=true`: enforce user identity + ownership on business resources.

## Identity

### Browser → BFF

- Login/register against Sandbox `/auth/*` (or BFF proxy).
- Browser holds Bearer JWT only; never service API token.

### BFF → Sandbox

- Always send service `X-API-Key` when configured.
- After validating browser JWT, BFF attaches trusted acting context:
  - `X-Acting-User-Id`
  - `X-Acting-Organization-Id`
  - `X-Acting-Role`
  - optionally `Authorization: Bearer <user jwt>` for double-check
- Client-supplied acting headers on browser requests are ignored by BFF (stripped).

### Sandbox actor resolution (auth enabled)

Priority:

1. Valid user JWT on request → `user_id` / `organization_id` / `role` from token (+ DB user if present).
2. Valid service token **and** `X-Acting-User-Id` + `X-Acting-Organization-Id` from BFF.
3. Service token alone → **not** an end-user actor; reject user-owned routes with 401.

Admin role may list all org resources; regular users only own resources.

## Data model

- `organizations(id, name, created_at)`
- `users` gains `organization_id` (default bootstrap org)
- `conversations` gains non-null `owner_user_id`, `organization_id` after migration
- Sessions already have `user_id`; set from actor on create
- Artifacts inherit session ownership via session lookup for cross-user checks where needed

## Migration

1. Ensure bootstrap org `org_bootstrap` and user `user_bootstrap` (or first registered).
2. Backfill null conversation owners to bootstrap.
3. New creates always stamp actor ownership.
4. Orphan report helper for rows still missing owner when auth is on.

## Authorization pattern

```
get resource
if auth off: allow
if resource.organization_id != actor.org: 404
if actor.role != admin and resource.owner_user_id != actor.user_id: 404
```

No existence leak (404 not 403 for cross-user).

## BFF surface

- Optional `AUTH_ENABLED` aligned with sandbox (or derive from env).
- Proxy `/api/auth/login|register|me`
- Require Authorization on `/api/conversations`, `/api/chat`, file/artifact user routes when enabled
- Forward acting headers on sandbox client

## Rollback

Keep columns; set `SANDBOX_AUTH_ENABLED=false` to open mode. Do not drop ownership data.
