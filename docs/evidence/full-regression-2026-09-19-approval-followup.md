# Full regression 2026-09-19 — approval-gated MCP follow-up

Date: 2026-09-19 (Asia/Singapore)

- In the admin Agent editor, selected the connected `exa` server and only its
  `web_search_exa` tool, with the existing `require_approval` policy. The
  Agent service validated the draft, and the UI published it as a temporary
  active v5 (`deepseek-flash`, `maxOutputTokens=1024`).
- A new conversation explicitly selected
  `data-analysis-jev-20260919` and requested one harmless
  `mcp__exa__web_search_exa` call. The Run entered `Waiting approval`; the
  conversation displayed the approval ID and Approve/Reject controls.
- Approval Center → Pending showed the same MCP tool, Run/Conversation
  references, high-risk label, and expanded sanitized arguments containing the
  query `OpenAI official documentation`. No secret or credential was shown.
- The read-only request was approved in Approval Center. Pending became empty,
  the Run resumed and completed with `Succeeded · 2 tools · 1m 00s`, and the
  assistant returned `APPROVAL_MCP_ALLOWED_20260919`.
- Restored `data-analysis-jev-20260919` to active v2 and copied v2 back into
  the editor draft, leaving no unsaved MCP test draft. The temporary v5 remains
  in version history as an auditable test version; no production source was
  changed.

Result: APPROVAL-01's positive approval path and MGMT-02's Pending → Approved
projection are verified for a real bound MCP tool. Reject, competing decisions,
network-failure retry, expiry/cancel, and a waiting-approval Worker restart
remain open.

Negative branch continuation:

- Re-activated the same temporary v5, submitted a second new conversation, and
  rejected its `web_search_exa` approval from the visible conversation control.
  The Run completed with one tool and the exact response
  `APPROVAL_MCP_REJECTED_20260919`; no search result was returned.
- Approval Center → Rejected then showed the same high-risk tool with the
  matching Run/Conversation references and sanitized arguments. Active v2 and
  the v2 editor draft were restored again.

This verifies the positive and negative single-decision branches. It still
does not cover decision races, transport retry, expiry/cancel, or restart while
waiting for approval.
