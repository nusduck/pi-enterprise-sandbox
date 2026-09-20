# Full regression browser evidence — navigation and draft interaction follow-up (2026-09-19)

## Scope

This is an additive browser-only follow-up. It uses the existing logged-in browser session `root@admin.comrt-20260919-a`, whose visible role is `User`. No conversation, artifact, schedule, or production source was deleted or modified.

## NAV-01: legacy routes and role boundary

- Navigating to `http://127.0.0.1:3000/runs` landed at `/settings/runs`; the page rendered `Active Runs` and the All/Running/Waiting Approval/Waiting Input/Failed/Completed filters.
- Navigating to `http://127.0.0.1:3000/approvals` landed at `/settings/approvals`; the page rendered `Approval Center` and the pending/approved/rejected/expired/cancelled filters.
- The account control exposed `root@admin.comrt-20260919-a` with visible role `User`; it exposed `Log Out`, not administrator controls.
- These observations strengthen the legacy-route portion of NAV-01. They do not prove the full admin navigation or the complete direct-link authorization matrix.

## UI-02: keyboard, Chinese multiline draft, and draft retention

- `Ctrl+L` from an existing conversation opened `New Conversation`.
- The composer accepted the Chinese multiline draft:

  ```text
  中文输入回归草稿：管理层简报
  第二行：保留草稿，不发送
  ```

- The draft was still present after navigating to `/settings/capabilities` and returning to `/` without sending it. The AX tree exposed the same two lines in the composer value.
- The upload button and `Ctrl/Cmd+U` affordance were visible, but this follow-up did not claim the attachment subcase: the in-app browser did not expose a selectable native file dialog through the available UI surface. Earlier attachment evidence is kept separately.

## Result impact

- NAV-01 remains `PARTIAL`: legacy route redirects and the current ordinary-user boundary are evidenced, but the full admin/old-link matrix is not.
- UI-02 remains `PARTIAL`: keyboard shortcut, Chinese multiline input, and cross-page draft retention are evidenced; attachment/IME candidate/keyboard download and approval branches are not all evidenced.

## CHAT-04: delete-confirmation cancel branch

- Clicking the delete control for the top synthetic INPUT-01 conversation opened the native confirmation text `Delete this conversation? Workspace and linked session may be cleaned up.`
- The confirmation was dismissed with Escape. The same conversation remained in the recent-conversations list, and its delete control was still present.
- No delete confirmation was accepted; the irreversible deletion branch remains intentionally unexecuted pending action-time confirmation.

CHAT-04 therefore has evidence for the cancel branch only and remains `PARTIAL`/not a full pass.
