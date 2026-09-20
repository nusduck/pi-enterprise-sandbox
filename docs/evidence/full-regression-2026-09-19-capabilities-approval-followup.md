# Full regression browser evidence — capability projection vs model tool binding (2026-09-19)

## Capability page observation

Authenticated ordinary-user navigation to `/settings/capabilities` showed:

- `Skills 13`: 13 system Skills, all displayed `Enabled: Yes`; `Drafts (0)` and `My Skills (0)` were empty.
- `MCP Servers 1`: server `exa`, status `Connected`, two tools, authorization `host-injected`.
- `Tools 17`: the two `mcp__exa__*` entries were displayed as `Connected`, `RISK: HIGH`, source `mcp`, approval `require_approval`, and risk source `class:external_high`.
- The built-in `ask_user_question` entry was displayed as enabled and `allow`.

## Approval probe

A fresh synthetic conversation asked the model to call `mcp__exa__web_search_exa` exactly once with the harmless query `OpenAI official documentation`, waiting for approval before the call. No files or artifacts were involved.

The resulting Run (`K0KSTN`, trace prefix `3de66c9f`) succeeded in 2s without an approval card or MCP ToolExecution. The model's visible thought stated that `mcp__exa__web_search_exa` was not bound in its runtime tool list, and the visible response was:

> Status: rejected — the MCP tool `mcp__exa__web_search_exa` is not bound in this runtime, so the search could not be executed (fails closed); no other tools were used.
>
> APPROVAL01_REJECT_OK

## Result impact

This is evidence that the capability-page projection and the model-side tool binding are inconsistent in this browser run. It is a fail-closed unavailability result, not evidence that the approval ledger's Approve/Reject buttons work. CAP-01 is therefore `PARTIAL`; APPROVAL-01 remains `BLOCKED` for this environment until a real bound approval-gated tool is available. No external search was executed.

The same page's `Models 2` tab showed `deepseek-flash` and `qwen3.8-27b` both enabled, provider `llmio`, protocol `openai-completions`, context window `262144`, max output `65536`, and tool calls `Yes`. `Extension diagnostics` then reported profile `coding-agent @ 4.0.0`, audit `built-in`, and `Allowed Tools 15`, which explains the model-visible omission of the two MCP entries despite the capability tool tab displaying 17 entries.

The browser's `/settings/approvals` page independently showed `No approvals found` in the Pending view. This is consistent with the probe creating no approval ledger entry, but does not validate the approval decision controls themselves.
