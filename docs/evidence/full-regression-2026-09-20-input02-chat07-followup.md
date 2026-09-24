# Full regression INPUT-02 / CHAT-07 follow-up (2026-09-20)

## INPUT-02 same-question cross-tab answer

- A fresh administrator conversation invoked the real `ask_user_question`
  tool once and entered `Waiting input` with `red` and `blue` options.
- A second authenticated in-app browser tab opened the same conversation while
  it was waiting. Both tabs showed the same Run and the same question card.
- The two tabs submitted `red` and `blue` concurrently. The authoritative Run
  accepted only one answer (`blue`) and completed as one `Succeeded` Run; the
  assistant response reported the selected value and that the question tool
  was used once.
- The second tab initially showed a stale waiting card but then refreshed to
  the same completed Run before a second answer could be issued. No second Run,
  tool step, or duplicate assistant result was created. This is convergence
  evidence, but this attempt did not expose a separate HTTP 409 response (the
  stale card disappeared before the second click).

## CHAT-07 queued follow-up observation

- A fresh conversation started one harmless foreground `sleep 12` Run. While
  it was running, two follow-up messages were submitted in order.
- The base Run completed with `CHAT07_BASE_CANCEL_PROBE_DONE_20260920`.
- The first queued follow-up executed and returned
  `CHAT07_CANDIDATE_ONE_20260920`; the second user message remained visible in
  the conversation after a Jev-driven page reload, but no independent Run or
  assistant response for it appeared in the refreshed UI.
- No side-effecting tools were requested by either follow-up. This is useful
  negative evidence for the second queued item, not a pass for the required
  three-submit/cancel/retry matrix.

## Result impact

`INPUT-02` is strengthened with same-question cross-tab single-consumer
convergence, while the separate replay/explicit conflict response and
cancel-then-answer branches remain partial. `CHAT-07` remains `PARTIAL`:
two-follow-up ordering was already proven by the earlier record, but this
probe leaves a second queued message without a visible terminal Run and the
cancel/retry/restart matrix open.
