# Dynamic capability registration and introspection

## Goal

Make every Agent capability authoritative, dynamically registered, profile-scoped, and discoverable by both the model and operators. A request such as “list all skills/tools/extensions” must be answered from live registry data rather than model memory.

## Requirements

- Maintain one session-scoped capability registry covering at least `skill`, `tool`, `extension`, `mcp_server`, and `mcp_tool` entries. The contract must be extensible to additional kinds without another parallel registry.
- Register the effective runtime state, not only configured allowlists:
  - tools actually active in the Pi session;
  - skills actually accepted by the resource loader;
  - extensions successfully loaded or failed;
  - MCP servers and dynamically injected MCP tools, including discovery failures.
- Apply Agent Profile policy before capabilities become model-visible. `profile.skills` must control package skills and support explicit shared-skill policy; tool/MCP allowlists remain fail-closed.
- Expose a safe model-facing capability introspection tool with `list`, `search`, and `describe` actions. It must support capability-kind filtering, deterministic ordering, bounded output, and no secret-bearing/internal credential data.
- Ensure the prompt tells the model to use the introspection tool for inventory questions and to read a matching `SKILL.md` before specialized work.
- Refresh registry state when runtime resources change, including session startup, extension binding, MCP injection, and `skill_reload`/session reload.
- Publish a process-local latest runtime snapshot for management diagnostics while preserving a truthful configured-only fallback before any session has started.
- Preserve backward compatibility for existing `/internal/extensions/diagnostics`, BFF `/api/extensions/diagnostics`, and `/api/capabilities/{skills,mcp,tools,models}` consumers; new fields may be additive.
- Surface actual state in the capability management UI, including configured versus active/failed status and registry version/scope where available.
- Emit auditable capability-registry change/discovery events without logging secrets, full skill bodies, or unbounded tool schemas.
- Keep registries isolated between concurrent runs/sessions; no capability from one profile or session may leak into another.
- Grok Build writes the implementation and tests. The primary agent owns requirements, review, integration fixes, and final verification.

## Constraints

- Production extension installation remains disabled; “dynamic registration” means runtime registration/reconciliation of allowed code and resources, not arbitrary extension download.
- Sandbox workspace/path, approval, MCP credential, and profile governance boundaries must not be weakened.
- No database migration is required for the first version; durable run events remain the recovery/audit evidence.
- Model registry implementation is not replaced. Models may remain a read-only management capability source.

## Acceptance Criteria

- [x] A live session registry returns every effective skill, active tool, loaded/failed extension, configured MCP server, and injected MCP tool with stable identity, kind, source, status, and safe summary metadata.
- [x] Asking the model to list all skills invokes the capability introspection tool and returns the complete registry skill set rather than a hand-selected summary.
- [x] `list`, `search`, and `describe` are deterministic, kind-filterable, bounded, and redact or omit credentials, secret references, full schemas/bodies, and unsafe host paths.
- [x] A profile that allows only a subset of skills/tools/MCP capabilities exposes only that subset to the model and registry.
- [x] MCP discovery registers injected `mcp_*` tools and records failure/empty states; refresh replaces stale dynamic MCP entries.
- [x] Skill/session reload reconciles additions, updates, and removals without duplicating entries.
- [x] Two concurrent registries with different profiles/resources remain isolated in tests.
- [x] Diagnostics distinguish `configured`, `active`, `disabled`, and `failed` (where applicable), and retain the legacy response fields consumed by the BFF/frontend.
- [x] Capability UI renders live status and falls back cleanly when no runtime snapshot exists.
- [x] Focused Agent/BFF/frontend tests pass, Node syntax checks pass, frontend build passes, and a Compose-backed smoke proves live skill plus MCP registration and authoritative inventory.
- [x] Active architecture/API/development documentation no longer claims the populated `skills/` tree is empty and describes the dynamic registry contract.

## Notes

- Initial live evidence on 2026-07-16: each inspected run emitted `resources_discovered` and injected two Exa tools, but the model answered “all skills” with only seven entries and no tool call.
- Existing diagnostics advertised configured allowlists as enabled, which is not proof of live activation.
