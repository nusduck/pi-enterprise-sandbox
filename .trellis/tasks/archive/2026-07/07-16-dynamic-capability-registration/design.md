# Design — Dynamic capability registration and introspection

## Current Problem

Capability state is split across Agent Profile configuration, Pi extension registration, the resource loader, the MCP manager, skill management, and a static diagnostics projection. The model sees a long `<available_skills>` prompt and tool schemas, but has no authoritative inventory tool. Operators see configured allowlists labeled as enabled, even when no live session proved activation.

## Boundary and Ownership

- `agent/application/capability-registry-service.js` owns the generic registry contract and a bounded process-local latest-snapshot store.
- Each Agent run/session owns a separate mutable registry instance. The store receives immutable, sanitized snapshots keyed by run/session/profile and exposes only bounded recent/latest projections.
- `enterprise-agent-kit` extensions register/reconcile the capabilities they own. The runtime performs a final reconciliation after `bindExtensions`, using Pi's actual active tools and resource-loader results as the authority.
- The Agent diagnostics endpoint merges configured governance data with the latest compatible runtime snapshot. BFF routes remain thin projections.
- The frontend displays the additive live fields; it never becomes the capability source of truth.

## Capability Contract

Each entry has:

```text
id             stable `<kind>:<name>` identity within a registry
kind           skill | tool | extension | mcp_server | mcp_tool | future kind
name           model/operator-facing name
status         configured | active | disabled | failed
source         bounded source label, never credentials
description    bounded plain text
profile_id     active profile
dynamic        whether discovered after static profile construction
metadata       allowlisted, kind-specific safe fields only
updated_at     ISO timestamp
```

The registry exposes `register`, `unregister`, `reconcile`, `list`, `search`, `describe`, and `snapshot`. Mutations increment a monotonic registry version only when effective data changes. `reconcile(kind, entries, scope)` atomically removes stale entries from that owner scope, preventing duplicate/stale skill and MCP records.

## Lifecycle

1. Resolve Agent Profile and create a session-scoped registry with run/conversation/session metadata.
2. Seed configured extension, tool, skill policy, and MCP server entries as `configured`/`disabled` without claiming activation.
3. Pass the registry into the enterprise kit.
4. Extension factories register their owned tool/extension metadata; load diagnostics change extension status to `active` or `failed`.
5. MCP `session_start` discovery atomically reconciles dynamic `mcp_tool` entries and updates server status. Injected Pi tools are captured in the final active-tool reconciliation.
6. Dynamic resources apply profile skill filtering before returning paths/resources. After extension binding, reconcile `resourceLoader.getSkills()` as the effective skill set.
7. Reconcile `session.getAllTools()` plus `getActiveToolNames()` after binding. Tool removals/reloads replace stale entries.
8. `skill_reload` triggers session reload and then a supplied reconciliation callback so added/removed skills appear immediately.
9. Publish an immutable sanitized snapshot and emit a bounded `capability_registry_updated` event.

## Profile Skill Semantics

`profile.skills` is the allowlist for package-bundled skills. Add an explicit profile field for shared skill behavior:

```json
{
  "sharedSkills": { "mode": "all" }
}
```

Supported modes are `all`, `allowlist`, and `none`; `allowlist` requires `names`. The existing coding profile uses `all` to preserve today's shared skills while making the policy explicit. Package skills still require membership in `profile.skills`. Unknown modes fail closed. Skill-name filtering occurs after loader discovery so individual packages—not whole roots—can be selected without copying or rewriting skill directories.

## Model-facing Tool

Register one `capabilities` meta-tool through a dedicated kit extension and profile allowlist.

- `list`: optional `kind`, `status`, `limit`, `cursor`.
- `search`: required `query`, optional `kind`, bounded `limit`.
- `describe`: required `kind` and `name` (or stable `id`).

Results include registry version, total/matched count, next cursor, and sanitized entries. Deterministic order is `kind`, then `name`. Default/max limits prevent context flooding. Search is case-insensitive over name and description with deterministic scoring. The tool never returns full tool schemas, skill bodies, auth references, environment data, or arbitrary metadata.

The prompt explicitly requires `capabilities` for inventory/count/list/available-capability questions. Specialized task routing continues to use the compact skill descriptions, then `read` for the selected `SKILL.md`.

## Diagnostics and UI

The diagnostics service retains existing `profile`, `package`, `extensions`, `tools`, `skills`, `mcp_servers`, and `models` fields. It adds registry metadata and replaces unconditional `enabled: true` claims with status derived from a compatible latest snapshot. Before a snapshot exists, items are `configured` and `enabled` reflects policy, not runtime proof.

The UI schemas accept additive `status`, `dynamic`, `registry_version`, and scope fields. Capability cards show status and source; diagnostics show registry version, run/profile scope, and whether data is configured-only or live.

## Failure and Security Behavior

- Extension and MCP discovery errors become `failed` entries and bounded events; they do not crash unrelated base capabilities.
- Registry callbacks are best-effort observers, but final post-bind reconciliation is authoritative.
- Registry metadata uses explicit per-kind allowlists and text/collection bounds.
- Per-session instances prevent cross-run mutation. The latest store keys snapshots and never merges entries across profiles.
- Runtime install of arbitrary extensions remains prohibited by package governance.

## Compatibility and Rollback

- Existing API fields and routes remain; consumers ignoring additive fields continue working.
- The new `capabilities` tool is additive and profile-controlled.
- Rollback is removal of the tool/registry wiring; existing Pi resource/tool loading remains intact.
- No database rollback is necessary.
