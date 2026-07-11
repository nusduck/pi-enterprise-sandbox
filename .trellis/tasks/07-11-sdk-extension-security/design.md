# Design

## Extension Pipeline

`tool_call → normalize logical input → load versioned policy → acquire lease → persist prepared → approval gate → call Sandbox → persist result → tool_result redact/shape → release lease`。

策略结果为 `allow | approval_required | deny`，并携带不可变 policy version/reason。approval 关闭只把 `approval_required` 映射为 allow + bypass audit。硬拒绝不可由开关或 approval credential 覆盖。

## Sandbox Enforcement

Sandbox 校验签名 request context、workspace lease、tool registration、path、limits 与幂等执行凭证。执行台账对 `(tool_call_id,idempotency_key)` 唯一，重复请求返回既有结果或状态。

## Rollback

Extension 上线前保留现有 wrappers 作为对照测试，但切流后只有一个策略入口。回滚 Agent 镜像时 Sandbox 强制策略继续有效。

