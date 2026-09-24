# Full regression CHAT-02 follow-up (2026-09-20)

## Scope

This additive record covers the synthetic conversation/follow-up/Regenerate
branch of `CHAT-02`. It uses no files, MCP, network, or artifacts.

## Browser execution

- A fresh administrator conversation returned the exact initial marker
  `CHAT02_INITIAL_OK_20260920` and reached `Succeeded` in about 708 ms.
- The completed message's visible `Regenerate` control was activated. The same
  user prompt remained once, while a second assistant message returned the
  same marker and the conversation's latest Run reached `Succeeded` in about
  802 ms. This proves a new generation without duplicating the user message.
- A same-conversation correction follow-up then requested a five-point
  checklist and marker `CHAT02_CORRECTED_20260920`. The UI rendered five
  numbered points, preserved the initial marker, and included the correction
  marker verbatim; the latest Run reached `Succeeded` in about one second.

## Result impact

The synthetic follow-up and Regenerate behavior is verified, including user
message ordering and separate terminal Runs. `CHAT-02` remains `PARTIAL`: the
required R source-based technical explanation, fact correction, and complete
post-refresh evidence are not covered by this synthetic branch.
