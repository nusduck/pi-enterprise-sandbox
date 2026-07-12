# B7 — Model Registry

## Goal

Model 能力由 Registry 驱动：provider, model_id, api_protocol, modalities, context_window, max_output_tokens, tool_call, developer_role, reasoning, thinking_levels, pricing, enabled。创建 session 时读取真实配置；Run 记录实际模型与 usage。

## Dependencies

B1 session creation path.

## Acceptance Criteria

- [x] Models use real context window / max output from registry
- [x] Registry marks tool calling and reasoning capability
- [x] Run records actual model, tokens, cost
- [x] No hard-coded sole source of model capability constants in hot path

## Infrastructure Note (2026-07-12)

Dedicated PostgreSQL container is available:
`docker compose --profile postgres up -d postgres`
URL: `postgresql://sandbox:sandbox_dev_only@localhost:5432/sandbox`

