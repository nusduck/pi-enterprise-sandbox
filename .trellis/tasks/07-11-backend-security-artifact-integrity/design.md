# Design

## Public route policy

Define a small pure helper that treats exact paths and prefixes separately. Root `/` is exact-only; `/auth/` and documentation subpaths are prefixes. Both API-token and JWT middleware consume an explicit policy rather than ad hoc tuples. Tests call the app and the helper boundary.

## Conversation workspace IDs

Default IDs remain UUIDs. If API compatibility requires accepting `ConversationCreate.id`, validate it against a conservative identifier pattern and resolve the resulting `conv_<id>` path under `settings.workspaces_path` before creating it. Do not silently sanitize two distinct IDs to one path.

## Artifact ownership and paths

- Resolve artifact input with `enforce_path_within_workspace(workspace, body.path)`.
- Require `is_file()` after resolution. External symlink targets fail during resolution.
- Repository adds a session-scoped getter or returns an internal record containing `session_id`; route uses the scoped getter.
- `ArtifactResponse` may add `session_id` as an additive field if exposing it is useful, but authorization must not depend on a client-provided field.
- File serving uses the already-resolved safe physical path, never `workspace / persisted_untrusted_path` without revalidation.

## Binary upload

Add a binary write path in `FileManager` sharing path and quota logic with text writes. Write to a temporary file in the target directory and atomically replace the destination only after size/quota checks succeed, so failures do not leave partial data. Upload reads bounded chunks instead of an unbounded `await file.read()` where practical. Text `write_file` stays unchanged at the API boundary.

## Compatibility

Security fixes intentionally change unsafe success cases to 400/403/404. Successful text and binary response shapes remain compatible. No artifact is emitted automatically by upload/write.

