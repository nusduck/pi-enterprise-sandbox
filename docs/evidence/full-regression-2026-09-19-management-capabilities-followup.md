# Full regression 2026-09-19 — management/capabilities browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- As admin, Jev opened Settings → Runs. The page exposed All, Running, Waiting
  Approval, Waiting Input, Failed, and Completed filters. Completed showed
  real succeeded rows with Open/Logs/Trace actions; Waiting Input and Failed
  showed explicit empty-state text when no matching runs existed.
- As admin, Jev opened Settings → Approvals. Pending, Approved, Rejected,
  Expired, and Cancelled filters all switched successfully; the current empty
  states were explicit and no approval decision was made in this read-only
  pass.
- Settings → Capabilities reported one connected `exa` MCP server, 17 tools,
  two enabled models, and an Extension diagnostics record for the configured
  `pi-enterprise-agent` profile. The model inventory showed `deepseek-flash`
  with tool calls enabled and reasoning disabled; no alternate model was used
  for this regression run.

This is read-only evidence for management projection and current capability
inventory. It does not prove dependency-failure/reconnect behavior, MCP
server reauthorization, or the full approval decision matrix.
