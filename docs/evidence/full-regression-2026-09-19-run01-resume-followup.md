# Full regression browser evidence — RUN-01 cancellation idempotency and recovery (2026-09-19)

## Probe

In the existing ordinary-user browser session, a fresh synthetic conversation asked the agent to run only foreground `sleep 20`. No files, MCP calls, or external side effects were allowed.

## Observed lifecycle

- Conversation: `RUN-01 idempotency probe: execute only sleep 20 ...`; sandbox label `CT69QM`.
- Run displayed `Running · 1 tool`; the visible tool was `bash` with input `$ sleep 20`.
- The first UI Stop action converged the Run to `Cancelled · 1 tool · 4s`, with run/trace prefix `d754124a` visible in the conversation.
- A second Stop attempt found the stop control already gone (the browser surface reported a shadow-root targeting error rather than issuing a second active click). A fresh AX snapshot showed the Run remained `Cancelled`; it did not create a duplicate terminal transition.
- Expanding the execution tree showed the authoritative tool output `Error: This operation was aborted`, source `sandbox`, and an `Execution interrupted` marker.
- Clicking both visible Resume affordances did not transition this already-cancelled Run; it remained cancelled. This is recorded as an observation, not a claim that every interrupted Run cannot resume.
- A new user message was then sent in the same conversation: `取消后同会话恢复探针：只回答 RUN01_FOLLOWUP_OK，不调用工具，不读取或修改文件。` It created a separate Run with prefix `a58d79d8`, displayed `Succeeded · 1s`, and the assistant returned exactly `RUN01_FOLLOWUP_OK`.

## Result impact

This strengthens RUN-01's cancellation convergence, aborted-tool visibility, and same-session recovery subclaims. RUN-01 remains `PARTIAL` because the full case also requires a repeated API cancellation proof and a separately queued-Run cancellation branch.

