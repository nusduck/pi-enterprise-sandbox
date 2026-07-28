# Artifact module

Artifact is an in-process Sandbox domain module. It is not a separate service
and it does not share Dataset business semantics.

## Layout and dependency boundary

```text
sandbox/artifact/
  domain/          # submit/download/import contracts
  application/     # ArtifactFacade and formal submit runtime
  infrastructure/  # manager, formal store/repository, immutable snapshots
  api/             # public BFF adapter and internal HMAC adapter
```

New callers use `sandbox.artifact.application.facade.ArtifactFacade`:

- `submit(...)`
- `list(...)`
- `resolve_download(...)`
- `import_to_workspace(...)`

The former `sandbox.services.artifact_*`, `sandbox.routers.artifacts`, and
`sandbox.app.*artifact*` paths are compatibility imports only. They must not
receive new business logic.

## Frozen delivery contract

The phase-one module migration does not change formal delivery:

```text
workspace file
  → submit_artifact
  → immutable {artifacts_root}/{org_id}/{artifact_id}/blob
  → owner/run metadata
  → artifact.ready / file_ready
  → artifact_id download
```

- `submit_artifact` remains the only formal-delivery operation.
- Workspace paths are never Artifact download fallbacks.
- Existing Artifact bytes are immutable.
- Dataset remains an input/staging concept.
- Existing submit/download event and table shapes are unchanged.

## Cross-conversation Import MVP

Public BFF operation:

```http
POST /api/conversations/{target_conversation_id}/artifact-imports
Content-Type: application/json

{
  "artifact_id": "01...",
  "target_filename": "report.pdf"
}
```

Sandbox compatibility upstream:

```http
POST /sessions/{target_session_id}/artifacts/imports
```

Successful response:

```json
{
  "import_id": "01...",
  "artifact_id": "01...",
  "target_session_id": "01...",
  "target_conversation_id": "01...",
  "workspace_file": {
    "name": "report.pdf",
    "path": "imports/01.../report.pdf",
    "mime_type": "application/pdf",
    "size": 1234,
    "sha256": "..."
  }
}
```

Import semantics:

1. Agent resolves and authorizes the target session for the caller.
2. Sandbox requires the source Artifact to match the target session's
   `org_id + user_id`.
3. Sandbox reads only the immutable control-plane snapshot.
4. Bytes are atomically published with no-follow directory traversal to
   `imports/{import_id}/{sanitized_filename}` in the target workspace.
5. File-size and workspace quota limits are enforced.
6. The operation writes an owner-scoped audit event. If authoritative audit
   persistence fails, the published file is rolled back.

Import does **not**:

- modify the source Artifact;
- bind its `artifact_id` to the target conversation;
- insert a second Artifact metadata row;
- emit `artifact.ready` or `file_ready`;
- make the imported file a formal deliverable.

The frontend opens the target conversation and puts the imported workspace file
in the composer as an uploaded attachment. If the user later wants it delivered
from the target conversation, the Agent must call `submit_artifact`, which
creates a new immutable Artifact and new `artifact_id`.

## Deferred scope

Phase one does not include a global user Library, shared Artifact links,
cross-user sharing, blob deduplication, retention/deletion policy, or an
independent Artifact microservice.
