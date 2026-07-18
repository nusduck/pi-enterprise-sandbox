# PR-06 MCP adapter deferred notes

## Status

The enterprise Agent path uses a **strict offline seam** for MCP:

1. `agent/src/infrastructure/mcp/mcp-config-loader.js` — parse/validate logical AgentVersion `mcpServers` (serverId, enabledTools, toolPolicy, timeout 1–300s, secretRef only). Recursive plaintext-secret scan; never embeds secret values in errors.
2. `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js` — **does not invent vendor API**.

## Binding contract (project port, not vendor API)

| Step | Behavior |
| ---- | -------- |
| empty `mcpServers` | No module load |
| non-empty, module missing | `PI_MCP_ADAPTER_UNAVAILABLE` |
| non-empty, module present, **no** `adapterBinder` | `PI_MCP_ADAPTER_API_UNVERIFIED` (even if package is installed) |
| non-empty + injected `adapterBinder` | Binder receives `{ module, config, secretResolver }` and returns platform `{ tools, mcpResolver, binding }` |

`adapterBinder` is a **project-owned port**. It is **not** claimed to equal any specific export of `pi-mcp-adapter`. Production code must **not** probe `createPiMcpAdapter` / `createAdapter` / `default` until the locked package `.d.ts` is reviewed and a concrete binder is approved.

## Not installed in this repo lockfile (yet)

`package.json` / lockfiles are **not** modified by PR-06. Do not claim the adapter is installed without updating the lockfile.

## Forbidden

- Fallback to legacy `McpConnectionManager` / self-built JSON-RPC/SSE/tools/list clients
- Embedding plaintext secrets in AgentVersion config (use `secretRef`)
- Guessing multiple package export names
- Using module presence alone as production “MCP ready”

## Tool naming

Registered tools must be:

```text
mcp__{serverId}__{toolName}
```

Registration is owned by the real adapter (via approved binder), not enterprise protocol code.

## Final approval (slice 2+)

1. Install/lock `pi-mcp-adapter` after dependency review.
2. Read the package public `.d.ts` / root exports.
3. Implement a single explicit binder against those verified exports.
4. Wire secret provider → binder → `PiRuntimeFactory` tools/mcpResolver.
