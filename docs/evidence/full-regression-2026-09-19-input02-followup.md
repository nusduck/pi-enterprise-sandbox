# Full regression browser evidence — INPUT-02 concurrent answers (2026-09-19)

## Probe

Using the Jev-assisted browser workflow with the CUA fallback for cross-tab observation, two authenticated browser tabs for the same ordinary user opened the same synthetic conversation. The conversation asked the agent to call `ask_user_question` with exactly one choice, `Alpha` or `Beta`, and then report the selected label and `INPUT02_OK`. No files, MCP calls, or external side effects were allowed.

## Observed lifecycle

- Both tabs displayed the same `WAITING_INPUT` question, `Choose Label`, with `Alpha` and `Beta` buttons. Both showed sandbox label `3BY36K` and one tool step.
- The first tab clicked `Alpha`. The second tab, still showing the same waiting card, immediately clicked `Beta`.
- The first tab rendered `Agent interaction response failed (409): {"error":"Conflict","code":"CONFLICT"}` while the authoritative Run remained in the waiting state briefly. This is the visible race response, not a second Run.
- After refresh/poll convergence, both tabs showed the same Run as `Succeeded · 1 tool · 1m 46s`; the first tab showed the assistant result `Selected label: Alpha` followed by `INPUT02_OK`.
- No second conversation, Run, tool step, or side effect appeared. The losing answer was not applied over the first accepted answer.
- The browser displayed trace/run prefix `8fd13ab0` and sandbox label `3BY36K` for this probe.

## Result impact

This is evidence for the normal first-answer CAS behavior, duplicate-answer rejection, and cross-tab convergence to one authoritative answer. INPUT-02 remains `PARTIAL`: the separate replay-of-an-already-answered request and the required cancel-then-answer race were not exercised in this probe.

## Cancel-then-answer follow-up

- A second synthetic conversation asked the same one-question flow with `Gamma` or `Delta`. Both tabs initially displayed the waiting card; sandbox label was `9MSCJH` and the visible run prefix was `899cd54b`.
- The first tab clicked Stop. It converged to `Cancelled · 1 tool · 15s`; the question card disappeared and the execution tree showed `Execution interrupted` / `Run was interrupted`.
- The second tab initially held a stale waiting view, but its answer-button target disappeared before the click could be issued. A fresh accessibility snapshot then showed the same Run as `Cancelled`, with only `Resume` affordances and no Gamma/Delta answer card. No answer revived the cancelled Run and no second Run was created.

This strengthens the “cancelled Run cannot be answered through a stale waiting card” observation. It is not a full proof of every API replay path, so INPUT-02 remains `PARTIAL`.
