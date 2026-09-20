# Full regression browser evidence — USER-01 / SEC-02 concurrent ordinary users

- Date: 2026-09-19 (Asia/Singapore)
- Environment: rebuilt local Compose stack at `http://127.0.0.1:3000/`; browser execution through Jev with CUA verification.
- Scope: additive follow-up only. No production source changes; existing dirty worktree and prior evidence were preserved.
- Data boundary: synthetic prompts and harmless `sleep` commands only. No private upload, external MCP call, file read, file write, artifact submission, or destructive cleanup.

## Users and prompts

| Account | Role observed in UI | Prompt | Resulting sandbox label |
|---|---|---|---|
| `root@admin.comrt-20260919-a` | `User` | `Synthetic USER-A concurrent probe. Run exactly one harmless foreground command \`sleep 8\`; do not read files, call MCP, create files, or modify data. After it completes, answer USER_A_CONCURRENT_OK.` | `KY9W29` in chat; settings session suffix `KJKY9W29` |
| `adminnot-an-email` | `User` | `Synthetic USER-B concurrent probe. Run exactly one harmless foreground command `sleep 5`; do not read files, call MCP, create files, or modify data. After it completes, answer USER_B_CONCURRENT_OK.` | `AXWSJ4` in chat; settings session suffix `7MAXWSJ4` |

The second account was the ordinary user accidentally created earlier in this regression session and was not deleted. No additional account was created for this probe.

## Observed overlap

1. A was started first. While the A chat showed `Running · —`, B was started in a separate Chrome session.
2. The immediate cross-tab capture showed B as `Running · 1 tool · —` while A had already completed its `sleep 8` command. This proves independent scheduling/execution was possible in the two user sessions, but the browser capture did not catch both rows in `Running` at the exact same instant because A completed during the short UI transition used to start B.
3. Both conversations then completed independently with one bash tool and distinct run/session/conversation IDs.

## Durable run records

### A user

Runs page and Logs detail showed:

- `run_id`: `01M2WXVBD8B5DXPWA5EHPDYRAS`
- `conversation_id`: `01M2WXVBD02R4HE2H9RRXPDCBF`
- `session_id`: `01M2WXVBD319SA066NKJKY9W29`
- status: `SUCCEEDED`
- started: `2026-09-19T13:31:48.043Z`
- finished: `2026-09-19T13:31:58.169Z`
- duration shown in table: `00:10`; `last_sequence: 76`; `error: —`
- visible final answer: `USER_A_CONCURRENT_OK`

### B user

Runs page and Logs detail showed:

- `run_id`: `01M2WXYYA8EMJWVDBGPJX3W406`
- `conversation_id`: `01M2WXYY9WA2YKTRRQB8DW8E68`
- `session_id`: `01M2WXYYA2APKJ548Z7MAXWSJ4`
- status: `SUCCEEDED`
- started: `2026-09-19T13:33:45.709Z`
- finished: `2026-09-19T13:33:52.580Z`
- duration shown in table: `00:06`; `last_sequence: 16`; `error: —`
- visible final answer: `USER_B_CONCURRENT_OK`

## Assessment

- `USER-01`: **PARTIAL, strengthened**. Two ordinary users in the same organization completed independent, harmless foreground work and returned distinct expected answers. This does not prove the full matrix requirement for simultaneous real uploads/artifacts, larger owner counts, or all cross-tenant boundaries.
- `LOAD-02`: **PARTIAL, strengthened**. The probe demonstrates two-owner concurrency with separate run records, but not the required 20-owner load, idempotency assertions, or sustained saturation behavior.
- `SEC-02`: **PARTIAL, strengthened**. Per-user Runs lists previously excluded the other ordinary user's run, and this probe confirms distinct user-owned run/session records. A direct browser verification of cross-owner detail returning 404 remains unavailable because navigating the API URL was blocked by the browser client; therefore no direct 404 claim is made here.
