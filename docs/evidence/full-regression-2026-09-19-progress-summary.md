# Full regression progress summary (2026-09-19)

## Scope and integrity

- This is an additive summary for the Jev-browser follow-up run; the original 95-case baseline remains unchanged in `full-regression-2026-09-19-jev-browser.md`.
- No production source was changed by this testing pass. Existing dirty-worktree changes were preserved.
- Only synthetic fixtures were uploaded or used. No private data, external credentials, destructive database reset, or shared-resource deletion was used.
- The exact-model constraint was respected for browser runs: `deepseek-flash`.

## New or strengthened results

| Case | Current conclusion from this pass |
|---|---|
| `CHAT-05` | Independent foreground conversations completed while the first remained active; returned to the first conversation without state loss. Positive branch is proven; full R/W artifact matrix is not. |
| `CHAT-06` | Reload during a live `sleep 15` run, reopen the recent conversation, and observe backend/tool completion after reload. Still partial because the refreshed message area did not expose the final assistant text independently. |
| `CHAT-07` | Follow-up queued behind a live foreground run and completed after it, without `session lock busy`. Cancel/restart/waiting-state branches remain untested. |
| `INPUT-01` | Real `WAITING_INPUT` and structured option rendering are proven. In the new dual-question probe, only the audience answer surfaced; the model correctly refused to fabricate the missing year range. Still partial. |
| `TOOL-02` | Synthetic CSV upload plus actual model file read is proven; filename, row count, columns, and measured totals were returned. R/W/X attachment matrix, removal-before-send, same-name isolation, and restart persistence remain open. |
| `RUN-02` | Steer is accepted and follow-up output is produced, but two attempts showed the foreground shell completed naturally; hard interruption is not proven. Still partial. |
| `MCP-02` | Real Streamable HTTP facade client exercised the six-tool file/Python/shell/artifact closure. |
| `MCP-03` | Same-context reuse, cross-context isolation, generated context reuse, and invalid/tampered artifact signatures were exercised. Expired-signature branch remains open. |
| `BIZ-01` | Synthetic S1, X, artifact delivery, oracle reconciliation, and cross-pass preservation were exercised. Full required business package and second-pass matrix remains partial. |
| `BIZ-02` | Synthetic Word/PPT/todo path and second-pass preservation were exercised. Full first-pass ambiguity matrix remains partial. |
| `CRON-01` | Created a synthetic one-time schedule, used Run now, observed History `SUCCEEDED`, and exercised Pause/Resume. Deletion was not performed; overall case remains partial. |

## Remaining hard boundaries

The full matrix still has blockers requiring capabilities not available in the current ordinary-user/shared-Compose context: administrator and second-identity/second-organization setup, real R/W source package and four-format office matrix, external A2A credentials, bound external MCP tools, fault-injection and restart environments (Worker/exec/Redis/DBPM/Proxy), quota/load testing, target K8s/VM/UPDRDB validation, and destructive cleanup confirmation.

Therefore this pass does **not** establish “all test cases passed” and does not close the regression goal. The detailed per-case baseline and additive evidence files are the authoritative record.

## Latest continuation after the initial summary

| Case | Additional observation | Current conclusion |
|---|---|---|
| `USER-01` | Two ordinary users in separate browser identities completed distinct harmless foreground runs with distinct Run/Conversation/Session IDs. The capture observed B running while A had just completed; both returned exact expected markers. | Strengthened, still `PARTIAL`: no real R/W upload-to-office-artifact closure or larger owner count. |
| `LOAD-02` | Two-owner concurrent execution completed without cross-session output mixing. | Strengthened, still `PARTIAL`: no 20-owner load, idempotency-key race, or Last-Event-ID matrix. |
| `SEC-02` | A and B Runs lists excluded the other user’s run; distinct owner records were confirmed in Logs. | Strengthened, still `PARTIAL`: direct cross-owner detail 404 was not claimed because browser API navigation was blocked. |
| `FAIL-02` | A real missing-path read produced `not found (missing path)` and `FAIL02_MISSING_PATH_REJECTED`; a same-conversation follow-up returned `FAIL02_RECOVERY_OK`. | Strengthened, still `PARTIAL`: corrupted upload and non-zero bash branches remain open. |
| `SEC-01` / `NAV-01` | Ordinary-user direct `/settings/agents` and `/settings/a2a` pages rendered `Administrator role is required`; mutation/publish controls were disabled. | UI boundary strengthened; exact API 403 coverage remains open. |
| `AUTH-04` | Live Register accepted a one-character synthetic password despite the checked-in 6–128 character source check. Two additional synthetic users were accidentally created during a form-state/append interaction; both were logged out and not used or deleted. | `PARTIAL/FAILED` validation evidence; duplicate-registration and race branches remain unverified. See the dedicated evidence for the exact operator sequence. |

The dedicated records are `full-regression-2026-09-19-user-concurrency-followup.md`, `full-regression-2026-09-19-auth04-fail02-followup.md`, and `full-regression-2026-09-19-admin-boundary-followup.md`. No production source was changed in these continuation probes.

## Jev correction and management-page follow-up

- This continuation used the actual Jev bridge inside `cua_repl` (`jev-1.13.0`, `typesafe`) for Schedules, Settings → MCP Servers, Tools, Models, and Extension diagnostics, with fresh AX verification after every Jev handoff. The Jev Runs navigation attempt was rejected by the bridge's 24,000-character snapshot guard because the page contains a large run table; the subsequent Runs route, Logs, Trace, and status-filter checks are explicitly recorded as CUA fallback rather than Jev evidence.
- Fresh capability evidence confirmed Models (`deepseek-flash`, `qwen3.8-27b`, both enabled, context window 262144) and Extension diagnostics (`pi-enterprise-agent @ 4.0.0`, built-in audit, allowed tools 15).
- Fresh Runs evidence opened a read-only Logs detail and Trace detail, and exercised Completed, Failed, Waiting Approval, and Waiting Input filters. Failed, Waiting Approval, and Waiting Input showed empty-state messages. These observations strengthen `CAP-01`, `MGMT-01`, and `TRACE-01`; they do not close the full cases.
- Detailed action/fallback evidence is in `full-regression-2026-09-19-jev-bridge-followup.md` and `full-regression-2026-09-19-mgmt-trace-followup.md`.

## CHAT-07 queue continuation

- A fresh browser probe ran one foreground `sleep 8`, then submitted two separate follow-ups while the base run was active. The base returned `CHAT07_BASE_DONE`; after the queue drained, the same conversation visibly returned `CHAT07_FOLLOWUP_ONE_OK` and `CHAT07_FOLLOWUP_TWO_OK`, with no remaining Running state.
- This confirms the positive two-follow-up queue branch. Cancellation of queued follow-ups, multi-worker behavior, and failure/retry branches remain open, so `CHAT-07` stays partial. See `full-regression-2026-09-19-chat07-two-followups.md`.

## Administrator, Agents, and A2A continuation

- The user supplied the local administrator credentials. An initial login attempt
  returned the visible `Invalid credentials`; after confirming the local
  `SANDBOX_AUTH_ADMIN_USERNAMES=admin` bootstrap rule, the precisely cleared
  `admin` form logged in and visibly rendered `Logged in as admin` / `Admin`.
  One append-style form mistake created `root@admin.comadmin` as a normal User;
  it was logged out and is not used as admin evidence. No password is recorded.
- Jev `jev-1.13.0` completed `Settings → Agents` with two clicks and zero failed
  decisions. The later Agents snapshot exceeded Jev's size guard, so the
  explicitly recorded CUA fallback handled the remaining page navigation.
- Admin Agents evidence now covers two synthetic organization Agents at v1,
  draft-only diagnostics for unknown fields/unavailable model/unsupported
  temperature, a v2 save-without-activate followed by activation and rollback,
  and a real data-analysis Agent selection with successful first Run and
  same-conversation follow-up. See
  `full-regression-2026-09-19-admin-agents-a2a-followup.md`.
- Admin A2A evidence now covers minimum-scope and full-test credentials without
  recording secrets; Agent Card 200/protocol 0.3/streaming true; authenticated
  `message/send`, `message/stream`, `tasks/get`, `tasks/resubscribe`, and
  converged `tasks/cancel`; a minimum-scope 403; and JSON-RPC `-32601` / `-32602`
  negative responses. Rotation is now also evidenced: the old credential was
  rejected after rotation and the new one remained usable. A2A artifact
  download, expiry, revocation, and cross-tenant/client isolation remain open.
  Synthetic admin resources were not deleted in this pass.

## Latest browser-interaction boundary

- After the native-confirmation dialog on the original A2A tab, a fresh admin
  tab was created and independently verified. It rendered the Agents table and
  accepted text input, but Jev's safe navigation returned `no_progress`; fresh
  CUA/semantic clicks on visible `Edit`, settings links, and `Send` controls did
  not change the UI. This is recorded as an interaction-layer blocker, not as
  proof of an application authorization failure. The rotated A2A credential
  was still valid, so revoke was not retried without action-time confirmation.

## Second Agent binding continuation

- A fresh admin conversation selected `project-handoff-jev-20260919` in the
  Agent picker before sending. The header retained that Agent and the run
  reached `Succeeded`; the synthetic first response was exactly
  `AGENT_HANDOFF_BIND_OK`.
- A same-conversation follow-up returned exactly
  `AGENT_HANDOFF_FOLLOWUP_OK` with the same Agent header. This strengthens
  `AGENT-03`/`CHAT-03`'s second-assistant positive branch, but does not close
  their full model/version, R/W, or cross-organization assertions.

## Explicit flash version continuation

- `data-analysis-jev-20260919` was given a valid v2 with explicit
  `modelPolicy.modelId=deepseek-flash` and `maxOutputTokens=1024`; the UI
  reported v2 active and the Agent service reported the normalized draft
  valid.
- A new conversation selected that Agent after activation and reached
  `Succeeded` with the exact synthetic response `AGENT_DATA_V2_BIND_OK`.
  This strengthens `AGENT-02`/`AGENT-03`/`CHAT-03`'s new-conversation binding
  branch. It does not prove the full upstream request capture, old-conversation
  version pin inspection, or R/W tool matrix.

## Authentication boundary continuation

- A fresh logout showed the signed-out UI, and direct navigation to
  `/settings/agents` rendered `Authentication required` with no usable Agent
  controls.
- Re-login through the UI with the supplied administrator credentials showed
  `Logged in as admin` and the `Admin` account chip. The password was not
  recorded.
- Refreshing the Agents page after login restored the expected organization
  table: default v1, `data-analysis-jev-20260919` active v2, and
  `project-handoff-jev-20260919` active v1.

## Skills lifecycle continuation

- A synthetic `.zip` Skill uploaded to Capabilities → Skills, moved from Drafts
  to My Skills on Enable, and loaded in a new conversation through the actual
  Skill mechanism; the execution step said it was loaded and returned the exact
  marker `SKILL_JEV_REGRESSION_LOADED_20260919`.
- Disable moved it back to Drafts. A new conversation reported the package was
  unavailable and did not report its marker; the previously loaded conversation
  remained intact. The package was re-enabled.
- Invalid `.txt` and corrupt `.zip` uploads were rejected with visible errors
  and no half-created draft. A separate valid `.skill` package uploaded,
  enabled, loaded through the Skill mechanism with marker
  `SKILL_JEV_ALT_LOADED_20260919`, then was disabled to verify the draft-only
  boundary and re-enabled.
- Jev handled the mechanical registry refresh/navigation and lifecycle clicks;
  CUA handled the file chooser, text entry, and independent verification. The
  full Skill matrix remains open for model-created packages, scripts,
  path-traversal archives, update/publish validation, every system Skill, and
  cross-terminal/Pod persistence.

## Agent policy continuation

- The Agent service rejected a synthetic existing-Agent draft containing an
  invalid output-token type, unknown tool/server references, and an embedded
  placeholder model object with five field-level diagnostics; no invalid
  version was created.
- A valid `toolPolicy.tools.read=deny` draft was saved as inactive v3, activated
  for a real new conversation, then rolled back to active v2. In the v3 run the
  model-visible catalog omitted `read` and the model did not substitute `bash`.
  This is fail-closed policy evidence, but not a full executed ToolExecution
  denial branch.

## Cron browser continuation

- Created a future-only synthetic schedule, used Jev for the mechanical
  create/navigation/run flow, and confirmed Run now plus execution history.
- Attempting to save a syntactically valid but nonexistent Agent ID was rejected
  with `Selected agent is not active for this organization`; no invalid schedule
  was persisted. A corrected prompt then ran successfully and the schedule was
  paused (`Resume` visible) at the end.
- The run history remained `SUCCEEDED` rather than a genuine failed execution,
  so this strengthens CRON-01 and a CRON-03 validation branch but does not close
  CRON-03's failure-preservation/repair requirement. Details are in
  `full-regression-2026-09-19-cron03-followup.md`.

## UI-02 browser continuation

- A fresh conversation accepted Chinese multi-line input with `Shift+Enter`,
  sent once with `Enter`, and returned `UI02_CHINESE_OK_20260919`.
- `Meta+L` opened a new conversation. `Meta+U` added a synthetic attachment as
  `Ready`; after the Jev remove handoff, CUA removed it and the draft vanished.
- IME candidate composition, multi-file drag/drop, pasted image, and full
  keyboard-only approval/download remain untested. Details are in
  `full-regression-2026-09-19-ui02-followup.md`.

## SUB-02 browser continuation

- A text-only synthetic Run launched two sibling subagents and one nested child;
  it returned `SUB02_CHILD_A_OK`, `SUB02_CHILD_B_OK`, and
  `SUB02_NESTED_OK`, with no depth-limit diagnostic and no file/network/artifact
  side effects.
- This proves the allowed depth-2/sibling branch only. Root-slot saturation,
  the actual depth ceiling, parent cancellation, Worker restart, and queue
  cleanup remain open. Details are in
  `full-regression-2026-09-19-sub02-followup.md`.

## SEC-03 browser continuation

- A data-analysis Agent made exactly one read attempt against the nonexistent
  absolute path `/root/jev-sec03-outside-20260919.txt`; the execution step and
  response confirmed rejection before filesystem access with marker
  `SEC03_ABS_PATH_REJECTED_20260919`, without fallback tools.
- This strengthens the absolute-outside-root branch only. Full traversal,
  links, upload/import, injection, and dangerous-command coverage remain open.
  Details are in `full-regression-2026-09-19-sec03-followup.md`.

## REC-01 browser continuation

- A synthetic `Waiting input` Run survived an isolated `agent-worker` restart
  and Jev browser reload; both answer options remained visible.
- Selecting one option resumed the Run to `Succeeded` with
  `REC01_RECOVERED_20260919`. Model/tool/approval in-flight and multi-worker
  takeover branches remain open. Details are in
  `full-regression-2026-09-19-rec01-followup.md`.

## REC-02 browser continuation

- A fresh Run started one harmless background `sleep 45` job and returned
  `REC02_JOB_STARTED_20260919`; a read-only check confirmed the isolated
  `bwrap`/Bash/`sleep` process tree before interruption.
- The sandbox container was hard-killed, restored with Compose, and verified
  healthy. A fresh process check found no residual `bwrap`, Bash, or `sleep`
  process, and a new Jev-driven conversation returned
  `REC02_RECOVERED_20260919` successfully.
- This strengthens the hard-kill/recovery/no-residual-process branch only;
  orphan-ledger/lease and concurrent-job accounting variants remain open.
  Details are in `full-regression-2026-09-19-rec02-followup.md`.

## REC-03 browser continuation

- A fresh foreground `sleep 20` Run was visibly active before an isolated
  `api-server` restart. After the service returned healthy, Jev reloaded the
  same conversation; it converged to `Succeeded` with
  `REC03_BFF_RESTART_OK_20260919`, and an independent DOM check found no
  residual Running state.
- This strengthens the BFF restart/catch-up branch only. Redis outage, outbox
  replay, multi-Worker lease behavior, and pending-side-effect handling remain
  open. Details are in
  `full-regression-2026-09-19-rec03-followup.md`.

## RUN-02 hard-Steer continuation

- A `sleep 60` Run accepted a Steer request only after the command had already
  completed naturally. A second `sleep 180` Run remained active for 30 seconds
  after an immediate Steer request; the sandbox process was still live, so the
  request was not counted as a hard interrupt.
- The second Run was then stopped explicitly and converged to Cancelled; a
  fresh process check found no residual sleep. This strengthens RUN-01 cleanup,
  not RUN-02's Steer assertion. Details are in
  `full-regression-2026-09-19-run02-hard-steer-followup.md`.

## USER-01/USER-02 browser continuation

- Two synthetic ordinary users were registered through the UI after logging
  out the admin session. User A completed `USER01_A_BROWSER_OK_20260919`; its
  Settings navigation exposed no Agents/A2A administration. After switching to
  user B, B's Recent list and Runs page did not contain A's conversation or
  Run; B then completed `USER02_B_BROWSER_OK_20260919` and saw only its own
  conversation.
- This strengthens sequential same-organization owner isolation and ordinary
  role-bound navigation. Concurrent dual-browser execution, second-organization
  isolation, direct resource-ID replay, and full upload/tool/artifact isolation
  remain open. Details are in
  `full-regression-2026-09-19-user01-user02-followup.md`.

## Management/capabilities browser continuation

- As admin, Jev verified Runs status filters and the explicit empty/succeeded
  projections, then verified Approval Center status filters without making a
  decision.
- Capabilities showed one connected `exa` MCP server, 17 tools, two enabled
  models, and a configured extension diagnostic; the flash model declared tool
  calls and no reasoning. Failure/reconnect/reauthorization branches remain
  open. Details are in
  `full-regression-2026-09-19-management-capabilities-followup.md`.

## AGENT-06 browser continuation

- Two in-app administrator tabs prepared different valid drafts from the same
  active Agent v2. Tab A published v4 first; tab B then received the visible
  `Activation conflict: another administrator changed the active version. Your
  draft was preserved.` message, with its distinct draft still present.
- v2 was activated again afterward and the second tab closed. This strengthens
  AGENT-06's stale publish/conflict branch; delayed validation, network retry,
  and expected-active-version compatibility variants remain open. Details are
  in `full-regression-2026-09-19-agent06-followup.md`.

## AGENT-07 browser continuation

- A synthetic `schemaVersion=0` draft with legacy field names was diagnosed with
  five explicit errors (`schemaVersion` plus each unknown field), remained
  unpublishable, and was not silently normalized or persisted as a new version.
- The draft was restored to active flash v2 without saving. A supported old
  schema fixture and migrated historical-session proof remain unavailable.
  Details are in `full-regression-2026-09-19-agent07-followup.md`.

## CRON-03 browser continuation

- Created `cron03-failure-recovery-20260919`, ran it twice against a
  deliberately missing synthetic file, and inspected the second Run from
  Settings → Runs. The tool did return a not-found error, but both History
  rows were finalized as `SUCCEEDED`; the product did not create the required
  `FAILED` row.
- Restarted only `agent-worker`; it became healthy, and a Jev-driven refresh
  showed the same paused schedule and exactly the same two history rows, with
  no duplicate trigger. The schedule was left paused.
- CRON-03 is therefore partial: schedule persistence/restart and error
  observability are evidenced, but post-failure repair and recovery cannot be
  claimed without a real FAILED terminal state. Details are in
  `full-regression-2026-09-19-cron03-failure-recovery-followup.md`.

## APPROVAL-01 / MGMT-02 browser continuation

- A temporary admin Agent version explicitly bound the connected `exa`
  `web_search_exa` tool with `require_approval`. A new conversation entered
  real `Waiting approval`; Approval Center → Pending showed the same Run and
  sanitized query arguments.
- Approving the harmless read-only request cleared Pending and the same Run
  completed with `APPROVAL_MCP_ALLOWED_20260919`. The active Agent was restored
  to flash v2 and the draft was reset to v2 afterward.
- This closes only the positive approval projection/decision branch; reject,
  race, retry, expiry/cancel, and restart variants remain open. A second run
  then exercised visible Reject and Approval Center → Rejected, returning
  `APPROVAL_MCP_REJECTED_20260919` without a search result. Details are in
  `full-regression-2026-09-19-approval-followup.md`.

## CRON-02 browser continuation

- Two paused synthetic schedules expressed the same UTC instant through
  `Asia/Singapore` and `America/New_York`; both projected to the same browser
  next-run time.
- The default `Skip while previous run is active` branch rejected the second
  immediate Run now with `Cron job already has an active execution` and left
  one successful history row. The `Allow parallel runs` branch produced two
  distinct running rows and two successful history rows.
- CRON-02 is partial: the timezone and concurrency branches are verified, but
  missed-time `skip`/`fire_once` behavior remains open. Details are in
  `full-regression-2026-09-19-cron02-followup.md`.

## CRON-02 missed-trigger continuation

- The first missed-trigger `skip` attempt was discarded because the worker had
  already claimed the due occurrence before it was stopped.
- A controlled second attempt stopped the worker before the `00:05:00`
  Asia/Singapore occurrence and restarted it at `00:10:09`, with the schedule
  Edit view confirming `Skip missed run`. Jev Refresh then showed a
  `00:05:00 · SUCCEEDED` history row with a Run ID, so the skip branch is
  negative evidence rather than a pass.
- A parallel controlled `Run once after recovery` attempt missed `00:09:00`;
  after recovery, Jev History showed exactly one `00:09:00 · SUCCEEDED` row,
  verifying the positive fire-once branch. Both schedules were paused and the
  worker was healthy afterward.
- CRON-02 remains partial because the skip policy did not produce a skipped
  outcome, and the native one-time creation path remains blocked by the
  earlier in-app browser crash. See
  `full-regression-2026-09-19-cron02-followup.md`.

## CHAT-05 parallel-switch continuation

- Jev started a 25-second harmless foreground Run in conversation A, opened a
  new conversation B while A was `Running`, and the sidebar showed `2 active`.
- B completed with `CHAT05_B_DONE_20260920`; returning to A showed its own
  `CHAT05_A_DONE_20260920` and an independent successful Run. No conversation
  text was mixed and A was not cancelled by the switch.
- The positive parallel-switch branch is strengthened; the full R/W upload,
  artifact, and independent-result matrix remains partial. Details are in
  `full-regression-2026-09-19-chat-parallel-followup.md`.

## PROC-01 / JOB-01 Process Console continuation

- A harmless background loop returned `PROC01_STARTED_20260920` and exposed a
  real job ID. The execution tree opened the matching Process Console, whose
  `Load history` view showed `PROC01_BATCH_1` through `_20`, with stdout/stderr
  filters, search, auto-scroll, history, and download controls.
- The console's stdin control was explicitly disabled for this background
  process; EOF and signal/cancel controls were visible. SIGTERM was submitted
  and acknowledged, but the visible card stayed `running` during the capture;
  a later Runs view was `Succeeded` and a read-only container check found no
  residual matching loop. This is not counted as conclusive UI signal
  convergence, and the later Cancel click timed out at the browser-control
  layer.
- `PROC-01` and `JOB-01` are strengthened but remain `PARTIAL`: stdin/EOF,
  live signal/cancel convergence, and one-job cross-checking of every job
  ledger operation are not closed. Details are in
  `full-regression-2026-09-20-proc-job-followup.md`.

## NAV-01 legacy-route continuation (2026-09-20)

- Directly opening legacy `/runs` redirected to `/settings/runs` and rendered
  the `Active Runs` page with the `Run ID` table.
- Directly opening legacy `/approvals` redirected to `/settings/approvals` and
  rendered the `Approval Center` page.
- This was a read-only CUA fallback after Jev's guarded handback on the large
  IAB page; Jev remained in use for the surrounding browser actions. The
  current IAB send-control no-op was not counted as a product result.
- `NAV-01` remains `PARTIAL`. See
  `full-regression-2026-09-20-nav-routing-followup.md`.

## TODO-01 continuation (2026-09-20)

- A fresh administrator conversation used the real todo tool to create exactly
  five synthetic W-briefing items. The rendered table showed one `completed`
  item and four `pending` items, and the Run ended `Succeeded` with one tool.
- Jev then reloaded the conversation. The fresh AX state rendered the same
  five-row table after reload; Jev's stale-state/step-limit handback was not
  treated as a pass by itself.
- `TODO-01` is strengthened but remains `PARTIAL` because the full W-data
  progress and event-persistence matrix is not closed. See
  `full-regression-2026-09-20-todo01-followup.md`.

## SUB-01 continuation (2026-09-20)

- A fresh parent Run dispatched exactly two real read-only child tasks for API
  and frontend inspection. The parent produced a structured execution tree and
  a terminal summary after ten tool steps.
- Both children accurately returned explicit `NOT_FOUND` markers because the
  Agent's permitted sandbox workspace was empty; the parent refused to emit the
  requested success markers. This is useful negative/no-fabrication evidence,
  not a positive content result.
- `SUB-01` remains `PARTIAL`/blocked for the actual R-release paths; parent
  cancellation and positive path conclusions remain open. See
  `full-regression-2026-09-20-sub01-followup.md`.

## RUN-01 cancellation continuation (2026-09-20)

- A fresh foreground `sleep 30` Run was visibly active, then its Stop control
  was activated from the current AX state. The Run converged to
  `Cancelled · 1 tool · 10s` with an `Execution interrupted` card and Resume
  affordance; the reserved natural-completion marker was absent.
- The post-cancel UI removed the Stop control, so repeated-cancel idempotency
  was not claimed. `RUN-01` remains `PARTIAL`. See
  `full-regression-2026-09-20-run01-idempotent-followup.md`.

## CHAT-02 Regenerate continuation (2026-09-20)

- A fresh synthetic conversation returned `CHAT02_INITIAL_OK_20260920`, then
  Regenerate created a second assistant response with the same marker without
  duplicating the user message; both terminal Runs were successful.
- A same-conversation correction follow-up rendered a five-point checklist and
  preserved `CHAT02_CORRECTED_20260920` in the response.
- `CHAT-02` remains `PARTIAL` because the required R-based technical/factual
  correction matrix is not replaced by synthetic marker evidence. See
  `full-regression-2026-09-20-chat02-regenerate-followup.md`.

## TOOL-02 / BIZ-01 S/X attachment continuation (2026-09-20)

- A fresh administrator conversation uploaded `orders.csv` and `refunds.csv`
  through the real file chooser; both were `Ready`, remained attached to the
  sent message, and were read by the Agent. The UI showed 8/3 data rows and
  correct columns, with independent totals `540 SGD`, `75 SGD`, and `465 SGD`.
- The same conversation then uploaded `orders-x.csv` and `refunds-x.csv` and
  preserved the approved S result while identifying duplicate `O002`, blank
  amount `O009`, and orphan refund `R004 → O999`.
- `TOOL-02` and `BIZ-01` are strengthened but remain `PARTIAL` for restart,
  same-name isolation, cross-session import, and the full artifact matrix. The
  separate remove-before-send branch is now verified. See
  `full-regression-2026-09-20-attachment-s-x-followup.md`.

## DATA-02 / ART-03 post-sandbox-restart continuation (2026-09-20)

- Restarted the `sandbox` service and confirmed it returned healthy before
  reopening the BIZ-01 conversation.
- A new post-restart Run re-read the persisted attachment bytes from disk,
  independently of the prior transcript, and reported `orders.csv` with 8
  rows and its original five columns plus `refunds.csv` with 3 rows and its
  original five columns. The reported MD5 fingerprints matched the original
  S-branch bytes, and the Run returned
  `DATA02_RESTART_DATASET_READ_OK_20260920`.
- DATA-02 and ART-03 are strengthened but remain `PARTIAL` for cross-owner
  isolation, cross-session import, download/reopen behavior, and the complete
  office-artifact matrix. See
  `full-regression-2026-09-20-restart-dataset-followup.md`.

## INPUT-02 / CHAT-07 continuation (2026-09-20)

- A fresh `Waiting input` Run was opened in two authenticated browser tabs and
  both tabs submitted different options concurrently. Only one answer was
  applied; both tabs converged to one `Succeeded` Run with no duplicate Run or
  tool step. This attempt did not expose a separate 409 because the losing
  stale card refreshed away before a second click.
- A fresh CHAT-07 probe submitted two follow-ups while a foreground `sleep 12`
  Run was active. The base and first queued follow-up completed in order, but
  after a Jev-driven reload the second user message remained without an
  independent visible Run or assistant response. The cancellation/retry and
  restart matrix remains open.
- Both cases remain `PARTIAL`. See
  `full-regression-2026-09-20-input02-chat07-followup.md`.

## CHAT-06 reload continuation (2026-09-20)

- A fresh `sleep 15` Run was reloaded through Jev while active. Fresh AX state
  later showed `Succeeded · 1 tool · 16s`, and the expanded execution tree
  independently showed the completed `bash sleep 15` step and sandbox source.
- The reserved final assistant marker was still absent from the post-reload
  message projection, so this strengthens backend/tool catch-up but does not
  close CHAT-06. See
  `full-regression-2026-09-19-chat-reload-followup.md`.

## ART-01 download/immutability continuation (2026-09-20)

- A fresh admin conversation created a 31 B synthetic Markdown Artifact through
  real `write` → `read` → `submit_artifact` calls and returned
  `ART01_DOWNLOAD_SUBMITTED_20260920`.
- The browser deliverable link was downloaded and independently checked at
  31 B with SHA-256
  `777857aa2b73b37a67e13e294651fca147ded19a5a87b413e903cee8b1a3140b`.
- The source file was then mutated without resubmission; downloading the old
  link again yielded the same bytes and hash. ART-01 is strengthened but
  remains `PARTIAL` for the broader failure and office-format matrix.
- After `docker compose restart sandbox` returned healthy, Jev reloaded the
  conversation and the same artifact link downloaded a third 31 B file with
  the same SHA-256 and original bytes. This adds a real ART-03
  restart/retrieval branch; cross-session import and the complete office-format
  snapshot matrix remain open. See
  `full-regression-2026-09-20-art01-download-followup.md`.

## SKILL-02 model-created draft continuation (2026-09-20)

- A fresh administrator conversation used the real model `write` and `bash`
  tools to create exactly one synthetic draft named
  `jev-model-draft-20260920` under the permitted skill-draft area. It contained
  a minimal `SKILL.md` and executable `scripts/echo.sh`.
- The script self-test exited `0` and returned
  `SKILL02_ECHO_OK_20260920`. Two real `skill`-mechanism load attempts returned
  `unknown or no longer available` while the draft was unenabled. The model
  returned `SKILL02_DRAFT_SELFTEST_OK_20260920` only after both conditions were
  observed.
- No enable/publish/install, artifact submission, MCP, network, or system Skill
  root mutation occurred. `SKILL-02` is strengthened but remains `PARTIAL` for
  packaging/hash, archive-safety, system Skill, and persistence/isolation
  branches. See
  `full-regression-2026-09-20-skill02-model-draft-followup.md`.

## MGMT-01 Runs-page cancel continuation (2026-09-20)

- A real foreground `sleep 30` Run appeared in the Runs table with `Cancel`,
  but the click opened a native confirmation dialog that was not accepted by
  the automation handoff; the Run therefore completed naturally and explicitly
  reported no cancellation.
- A second independent `sleep 30` Run again appeared as `Running` with
  `Cancel`. The native confirmation dialog could not be completed by the
  in-app browser handoff; a separate fresh Runs tab later showed that same row
  as `Succeeded` after about 32 seconds. A prior draft-only attempt also
  created no Run. These attempts are negative evidence, not a pass;
MGMT-01 remains `PARTIAL` until the native confirmation is accepted and the
table shows that same Run as `Cancelled`.
  See `full-regression-2026-09-19-mgmt-trace-followup.md`.

## SEC-03 relative-traversal continuation (2026-09-20)

- The authenticated admin composer visibly held exactly one harmless
  `read` request for the nonexistent relative path
  `../../tmp/jev-sec03-traversal-missing-20260920.txt`, but Send, Enter, and a
  coordinate click produced no user message or Run. The browser runtime
  reported the host Mac was locked, so this is an interaction blocker rather
  than a traversal result.
- Jev was independently called on the small Schedules page using
  `jev-1.13.0`; it chose `Click Chat` at `0.99` confidence and reported the
  action as executed with `noEffect: true`. The page remained on `/schedules`.
- SEC-03 remains `PARTIAL`; this probe did not establish either acceptance or
  rejection of relative traversal. See
  `full-regression-2026-09-19-sec03-followup.md`.
