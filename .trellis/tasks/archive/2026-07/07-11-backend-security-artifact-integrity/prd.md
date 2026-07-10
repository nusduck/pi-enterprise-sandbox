# Backend security and artifact integrity

## Goal

Close the confirmed authentication, path-boundary and binary-integrity defects in the Python Sandbox without weakening existing session isolation or artifact-only delivery.

## Requirements

- JWT auth enabled with `SANDBOX_AUTH_ENABLED=true` must require a valid bearer token on every non-public route. Only exact root and the documented health/docs/auth prefixes are public.
- A valid service API token may bypass user JWT for trusted internal calls; invalid/missing credentials return 401 without revealing secrets.
- Public-route logic is centralized/testable so adding `/` cannot silently expose all paths again.
- Conversation IDs used in physical workspace names are generated server-side by default and validated when client-supplied; they cannot escape `workspaces_root`.
- Artifact register/submit resolves the requested path through the shared workspace boundary, rejects missing paths, directories and escaping symlinks, and records the actual regular-file size.
- Artifact download retrieves by `(session_id, artifact_id)` and rejects an artifact owned by another session even if the artifact ID exists.
- Artifact metadata includes enough internal ownership data to enforce the invariant without trusting the URL session alone.
- Binary upload writes exact bytes, enforces per-file and workspace quotas, and does not decode/re-encode content.
- Existing text read/write API behavior and explicit artifact-only delivery remain compatible.

## Acceptance Criteria

- [x] With auth enabled, unauthenticated `GET /sessions` returns 401; `GET /health`, `/docs`, `/auth/login` remain public.
- [x] A valid JWT reaches a protected endpoint and a valid service API token still supports BFF-to-Sandbox calls.
- [x] Client conversation IDs containing traversal/separators are rejected and no directory is created outside `workspaces_root`.
- [x] Artifact submit rejects `../`, absolute paths, external symlinks, missing files and directories.
- [x] Download using Session B plus an artifact ID from Session A is denied/not found and never reads either workspace unexpectedly.
- [x] A binary fixture containing invalid UTF-8 and NUL bytes round-trips upload/download byte-for-byte.
- [x] Binary writes that exceed file or workspace quota fail without leaving a partial file.
- [x] Existing artifact-only delivery and file/path isolation tests continue to pass.
- [x] Targeted tests and full pytest pass in the supported Python environment.

## Out of Scope

- Full per-user ownership of all persisted resources; handled by child `07-11-user-ownership-auth` after this security foundation.
- Node module-global concurrency; handled by `07-11-request-context-execution-lifecycle`.
- Python Agent production cutover and frontend login UI.

