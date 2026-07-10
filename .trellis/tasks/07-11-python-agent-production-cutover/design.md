# Design: Python agent production cutover

## Target topology

```
Browser → Node BFF (auth, CORS, SSE proxy) → Python Agent orchestration
                                              ↘ Sandbox tools / execution / artifacts
```

Compatibility mode may keep Node `handleChat` as fallback behind config.

## Route selection

- Env example: `AGENT_RUNTIME=python|node` (exact name follows existing config style).
- Default remains current behavior until parity evidence is complete; then switch default carefully.
- Health/readiness should report which runtime is active without leaking secrets.

## Parity surfaces

| Surface | Python must provide | Verification |
|---------|---------------------|--------------|
| SSE events | Same event types/order invariants | Shared fixtures |
| History | Multi-turn restore | Integration tests |
| Tools | Sandbox tool binding | Tool call tests |
| Approval | Pause/resume/deny | Approval tests |
| Artifacts | Explicit submit + list/download | Isolation tests |
| Abort | Cancel in-flight work | Cancel tests |

## Rollback

1. Set runtime config to Node compatibility.
2. Restart API edge if required.
3. Confirm SSE smoke; no frontend redeploy if BFF path is stable.
