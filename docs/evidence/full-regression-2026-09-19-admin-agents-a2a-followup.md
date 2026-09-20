# Full regression follow-up — administrator, Agents, and A2A

Date: 2026-09-19

This is additive evidence for the current browser regression. It does not rewrite
the baseline matrix or earlier evidence. Browser interaction used the local IAB
tab at `http://127.0.0.1:3000/`; Jev was used for the safe Settings → Agents
navigation, and CUA handled text entry, credential issuance, configuration
editing, and independent verification. No password or Bearer secret is recorded.

## Authentication boundary

- An initial Login attempt with the user-supplied `admin` account returned the
  visible `Invalid credentials` message; this was not counted as an admin login.
- The local deployment configuration lists `admin` in
  `SANDBOX_AUTH_ADMIN_USERNAMES`. Registering a precisely cleared `admin` form
  then returned `Username already exists`; logging in with the supplied
  credentials subsequently rendered `Logged in as admin` and the account chip
  rendered `Admin`.
- One earlier append-style form interaction created the unintended username
  `root@admin.comadmin`, which rendered `User`. It was logged out and was not
  used as administrator evidence. No password is recorded here.

## Jev and Agents management

- Jev `jev-1.13.0` completed the safe `Settings → Agents` navigation with two
  executed clicks and zero failed decisions. Fresh AX verification showed the
  administrator page, the existing organization `default` agent at v1, the
  version history, validation preview, and the create/save controls.
- The Agents page exceeded Jev's snapshot-size guard on a later navigation
  attempt; that attempt did not click. Subsequent page navigation was explicitly
  performed through CUA fallback.
- Created two uniquely named synthetic organization agents, both with v1:
  `data-analysis-jev-20260919` and `project-handoff-jev-20260919`.
- For `project-handoff-jev-20260919`, a valid v2 was saved without activation;
  the page reported `Created version 2 without activating it` and retained v1
  as Active. v2 was then activated and v1 was activated again, leaving v1
  Active with the version history intact.
- Draft-only validation produced concrete diagnostics without enabling save:
  - unknown top-level field: `CONFIG_UNKNOWN_FIELD` for `unknownField`;
  - unavailable `modelPolicy.modelId`: `Model "not-a-real-model" is not
    available on this platform`;
  - `deepseek-flash` plus `temperature`: `temperature is not supported by the
    current model adapter`.
- After a reload, the new-conversation Agent picker visibly offered `Default`,
  `project-handoff-jev-20260919`, and `data-analysis-jev-20260919`. Selecting
  the data-analysis Agent fixed the chip to that Agent; a real synthetic first
  Run returned `AGENT_DATA_BIND_OK` with `Succeeded`, and a follow-up in the
  same conversation returned `AGENT_DATA_FOLLOWUP_OK` while the same Agent chip
  remained visible.

## A2A administrator and protocol checks

The A2A Access page, while logged in as admin, showed the default Agent Card,
streaming `Enabled`, Bearer API authentication, the agent-specific Card URL and
JSON-RPC endpoint, and no credentials before issuance. The visible default
Agent identifiers were `01M29ZJKT5ZM5SS9AP3D9B58SG` and version
`01M29ZJKT9YFP2GCTT51VVWWET`.

- Issued a synthetic minimum-scope credential for client
  `jev-regression-a2a-20260919` with only `agent.invoke`; the UI showed an Active
  credential and recorded an `A2A.CREDENTIAL_ISSUED` audit event. The one-time
  secret was not copied into this file.
- Issued a separate synthetic full-test credential for client
  `jev-regression-a2a-full-20260919` with `agent.invoke`, `agent.read`,
  `agent.cancel`, and `artifact.read`. Its secret was also not recorded.
- Agent Card request: HTTP 200, protocol version `0.3`, streaming `true`.
- Minimum credential `message/send`: HTTP 200, JSON-RPC 2.0 Task, initial
  state `working` (task `PH022PHYXM8K04APFHZP5Y8XW1`).
- Full credential `message/send`: HTTP 200 Task, followed by `tasks/get` after
  completion returning `completed` and the exact synthetic marker
  `A2A_SEND_FULL_OK` (task `AQP53JCR96XCRTH0YC8ZA8PFRW`).
- Full credential `message/stream`: HTTP 200 `text/event-stream`; frames were
  `task`, `status-update`, `status-update`, `status-update`, `status-update`,
  ending in `completed` with `final=true` (task `S9058FXPAQ9GPK57MQD7YAS6V6`).
- `tasks/resubscribe` for that stream task returned HTTP 200 SSE, included the
  terminal `completed` frame with `final=true`, and did not create a second
  task.
- A long harmless synthetic task (task `J5J60Z2K3XFW31JWBRCJ9JNR8Z`) was
  cancelled through `tasks/cancel`; after waiting, `tasks/get` reported
  `canceled`. A repeated cancel returned the same `canceled` terminal state.
- Scope and protocol negative checks: using the minimum credential for
  `tasks/get` returned HTTP 403 with JSON-RPC code `-32090`; an unknown method
  returned `-32601 Method not found`; missing `tasks/get` parameters returned
  `-32602 Invalid params`. None returned a 500 or exposed a secret.

## Remaining limits

This follow-up does not claim the full matrix passed. A2A artifact creation and
download, expired/rotated/revoked credential branches, cross-tenant/client
task isolation, and the complete Agent real R/W behavior matrix remain open.
The created synthetic Agents and credentials are intentionally not deleted in
this pass; cleanup remains a separately confirmed destructive action.

## Rotation and browser-interaction continuation

- The full-test A2A credential was rotated in the administrator UI. The old
  row became `Rotated`, the new row became `Active`, and the new key ID was
  visible. The old secret then returned HTTP 401 / JSON-RPC `-32090` while the
  rotated credential could still retrieve the completed task with HTTP 200.
- The UI exposed a native confirmation dialog for revocation. The action was
  not confirmed: the old tab became unresponsive to safe dismissal/close
  operations, and a fresh admin tab verified that the rotated credential still
  retrieved its completed task. Therefore revocation is **pending/not
  executed**, not a pass.
- A fresh admin tab (after the dialog-affected tab) still rendered the Agents
  table and accepted text input, but Jev's safe navigation attempt returned
  `no_progress`; CUA/semantic clicks on visible `Edit`, sidebar links, and
  `Send` controls did not produce a UI state change. This is recorded as a
  browser-interaction blocker, not as an application permission result. No
  further publish, revoke, or destructive action was attempted.

## Second Agent binding continuation

- In a fresh admin conversation, the Agent picker was opened and
  `project-handoff-jev-20260919` was selected before the first message. The
  conversation header visibly retained that Agent name and the run reached
  `Succeeded` (Sandbox session suffix `00JE4D`).
- The synthetic first message returned exactly
  `AGENT_HANDOFF_BIND_OK`. A same-conversation follow-up then returned exactly
  `AGENT_HANDOFF_FOLLOWUP_OK`, with the same Agent header still visible. This
  adds the second-assistant positive binding/follow-up branch to AGENT-03 and
  CHAT-03; model/version and full R/W behavior assertions remain open.

## Explicit model version and new-conversation binding

- The administrator edited `data-analysis-jev-20260919` and validated a new
  configuration containing `modelPolicy.modelId=deepseek-flash` and
  `maxOutputTokens=1024`. The Agent service reported the draft valid; the UI
  then reported `Created version 2 and made it active`, with v2 active and the
  normalized JSON retaining the explicit flash model.
- A new conversation selected that Agent after v2 activation. Its header
  showed `data-analysis-jev-20260919`, the run reached `Succeeded`, and the
  synthetic response was exactly `AGENT_DATA_V2_BIND_OK` (Sandbox session
  suffix `V4J5SJ`). This proves the new-conversation binding branch for the
  explicit flash version; an independent upstream request capture and the
  complete tool/R/W matrix remain open.

## Authentication boundary continuation

- In the fresh browser session, account-menu logout completed and the UI showed
  `Logged out` with sign-in/register actions and no recent conversations.
- Direct navigation to `/settings/agents` while logged out rendered
  `Authentication required`; the organization-agent table was absent and the
  controls were disabled/empty. This is browser evidence for the protected
  route, not only an API status check.
- The supplied administrator credentials were entered through the sign-in form
  without recording the password. The UI then showed `Logged in as admin` and
  the `Admin` account chip.
- After login, refreshing `/settings/agents` restored the organization table:
  the default Agent remained v1, `data-analysis-jev-20260919` showed active v2,
  and `project-handoff-jev-20260919` showed active v1.

## Skills upload and lifecycle continuation

- On Capabilities → Skills, Jev `jev-1.13.0` handled the refresh/navigation and
  Enable/Disable decisions; CUA was used only for the file chooser, text entry,
  and fresh-state verification because uploads are outside Jev's supported
  operations.
- A synthetic ZIP package named `jev-regression-skill-20260919` uploaded into
  `Drafts (1)`. Enabling moved it to `My Skills (1)` with `from draft` visible.
  In a new conversation, an explicit request to load it through the Skill
  mechanism produced an Agent Execution Step `Loaded the skill via the Skill
  mechanism` and the exact synthetic marker
  `SKILL_JEV_REGRESSION_LOADED_20260919`.
- Disabling returned the package to Drafts and `My Skills (0)`. A new
  conversation then reported that the package was not available and did not
  report its marker. The original loaded conversation remained visible with
  its prior response. The package was re-enabled afterward.
- A `.txt` upload was rejected client-side with `Please select a .zip or .skill
  file`; a corrupt `.zip` was rejected with `Skill archive must be a ZIP file`
  and did not create a draft.
- A second synthetic `.skill` archive named
  `jev-regression-skill-alt-20260919` uploaded as `Drafts (1)`, enabled into
  `My Skills (2)`, and loaded successfully through the Skill mechanism with
  marker `SKILL_JEV_ALT_LOADED_20260919`. Disabling it made the exact package
  remain draft-only; a new load request refused to load it and did not report
  its marker. It was re-enabled to leave the test environment in the enabled
  state.

These results strengthen `SKILL-01` and `SKILL-03` but do not close the full
Skill matrix: model-generated write/edit/bash creation, package scripts and
path-traversal archives, update/publish validation, every system Skill, and
cross-terminal/Pod persistence remain open.

## Agent tool-policy continuation

- While editing `data-analysis-jev-20260919`, an invalid draft containing a
  non-integer `modelPolicy.maxOutputTokens`, unknown `toolPolicy.not_a_real_tool`,
  unavailable MCP server/tool references, and an embedded placeholder `model`
  object was rejected by the Agent service with five field diagnostics. The
  published v2 remained unchanged and no version was created from that draft.
- A valid draft using `toolPolicy.tools.read = deny` was accepted by the Agent
  service and saved as v3 without activation. The UI showed v3 as inactive and
  v2 as active; activating v3 then showed the read permission as `Deny` in the
  form and v3 as active.
- A new conversation selected `data-analysis-jev-20260919` while v3 was active.
  The model-visible tool catalog omitted `read` and the run did not substitute
  `bash`; it reported that no read-policy denial ToolExecution occurred because
  the tool was not exposed. This is positive fail-closed evidence for tool
  omission, but not a complete executed-denial assertion.
- v2 was then activated again. v3 remains an inactive synthetic version for
  auditability; the active configuration is restored to the prior flash v2.

This strengthens `AGENT-04` and `AGENT-05`'s validation and fail-closed policy
branches. Exact upstream parameter capture, executed allow/approval branches,
and AGENT-06 concurrent stale-response/publish conflict checks remain open.
