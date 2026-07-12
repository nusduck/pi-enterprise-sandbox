# Design — Agent Runtime Capability Completion (Parent)

## Architecture (ADR §6)

```
Browser → API/BFF → Agent Control Service
  Conversation Manager | Agent Session Manager | Run Manager
  Tool Registry | MCP Manager | Approval Manager | Event Stream
→ PostgreSQL (sessions/entries/runs/events/tool_executions/approvals/process_executions)
→ Fixed Sandbox Runner Pool (files, process, commands, artifacts)
```

## Session Layers

- Conversation 1:1 Sandbox Session
- Conversation 1:1 Workspace
- Conversation 1:1 Logical Pi SDK Agent Session (B1 delivers this)

## Ordered Integration

1. B1 schema + restore path first (unblocks multi-turn fidelity)
2. B2 process control plane (can land tools while B1 matures)
3. B3 streaming on bash + process
4. B4 ledger across all paths
5. B5/B6/B7 on top of stable run/session contracts

## Source of Truth

`docs/adr/0002-backend2712.md` is authoritative for contracts, APIs, acceptance, and test scenarios.
