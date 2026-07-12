# B5 — Attachment Context and MCP / Tool Registry

## Goal

消息显式携带 attachments 元数据；统一 ToolRegistry（Sandbox/Process/Skill/MCP/Artifact/Enterprise HTTP）；MCP 注册、discovery、schema、allowlist、权限、approval、ledger、timeout/retry、result normalize。

## Dependencies

B1 (session/message path), B4 (ledger for MCP tools).

## Acceptance Criteria

- [x] Multi-file upload: agent sees exact current-turn attachments without scanning uploads/
- [x] Attachment path/name/mime auditable
- [x] Discover registered MCP tools
- [x] Unauthorized users cannot call restricted MCP tools
- [x] High-risk MCP tools require approval
- [x] MCP calls enter tool ledger

## Infrastructure Note (2026-07-12)

Dedicated PostgreSQL container is available:
`docker compose --profile postgres up -d postgres`
URL: `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`

