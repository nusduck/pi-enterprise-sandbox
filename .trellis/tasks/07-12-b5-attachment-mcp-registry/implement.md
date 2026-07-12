# Implement — B5

## Checklist

- [x] Message schema attachments
- [x] Prompt injection of current-turn attachment list
- [x] ToolRegistry skeleton + MCP manager
- [x] Discovery + schema adapt + allowlist + approval
- [x] Tests: multi-attachment binding, MCP discovery/exec/approval

## Validation

```bash
uv run pytest tests/ -q --tb=short -k 'attach or mcp or registry'
node --test agent/tests/*.test.js
```

## Agent Run Notes

### What landed

1. **Attachment context (ADR §4.5 / §12.4)**
   - Upload response + meta now include `upload_time` and `filename`.
   - `normalize_attachment_context` / `format_attachment_prompt_block` (Python)
     and `agent/attachment-context.js` (Node) produce a structured current-turn
     list: `attachment_id`, `filename`, `path`/`workspace_path`, `mime_type`,
     `size`, `upload_time`.
   - Agent turn injects an explicit **Current-turn attachments** block into the
     user prompt and strips any frontend `[Attachments]` blob so the model does
     not need to scan `uploads/`.
   - Conversation persistence keeps `attachments[]` on user messages.
   - Frontend manifest carries `filename`, `mime_type`, `workspace_path`.

2. **Unified ToolRegistry (ADR §4.6)**
   - Python: `sandbox/services/tool_registry.py` — categories
     Sandbox | Process | Skill | MCP | Artifact | Enterprise HTTP.
   - Node: `agent/tool-registry.js` — same categories; chat-runner builds
     allowlist + custom tools from the registry.
   - `GET /mcp/registry` returns the tree + version.

3. **MCP Manager (ADR §4.6 / §12.5)**
   - `sandbox/services/mcp_manager.py`:
     server register, discovery, schema adapt, allowlist, org/user authz,
     approval policy, B4 ledger integration, timeout/retry, result normalize.
   - Tool names namespaced as `mcp_{server_id}_{tool}`.
   - Built-in sandbox MCP tools seeded as server `sandbox`.
   - HTTP: `POST/GET/DELETE /mcp/servers`, `GET /mcp/discover`,
     `GET /mcp/policy`, `POST /mcp/invoke` (legacy `/mcp/tools` + `/mcp/call`
     unchanged).
   - Agent: `createMcpTools` discovers via sandbox and registers into the
     ToolRegistry; high-risk tools surface approval + ledger via invoke.

### Out of scope (B6/B7)

- Steer / follow-up / budget (B6)
- Model registry (B7)
- Full external MCP stdio transport (HTTP + local only)

### Verification (this run)

```text
uv run pytest tests/ -q --tb=short -k 'attach or mcp or registry'
→ 35+ passed

node --test agent/tests/*.test.js
→ 118 passed

node --check agent/{chat-runner,mcp-tools,tool-registry,attachment-context,message-helpers}.js
→ syntax ok
```
