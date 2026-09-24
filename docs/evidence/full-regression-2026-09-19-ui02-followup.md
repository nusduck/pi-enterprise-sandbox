# Full regression 2026-09-19 — UI-02 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

## Observed

- In a fresh conversation, the message textbox accepted Chinese text and
  `Shift+Enter` preserved a newline: `中文第一行\n第二行`.
- A final `Enter` sent the multi-line Chinese message once. The Run reached
  `Succeeded` and returned the exact synthetic marker
  `UI02_CHINESE_OK_20260919`; the visible message retained the two-line body.
- `Meta+L` opened a fresh `New Conversation` from the existing conversation.
- `Meta+U` opened the attachment chooser. A synthetic text file appeared in
  `attachment-drafts` as `81 B · Ready`; the Jev mechanical remove attempt
  handed back, so CUA performed the supported fallback click. The attachment
  draft then disappeared and was not sent.

This strengthens the keyboard/newline, Chinese input, new-chat shortcut, and
attachment-draft removal branches of `UI-02`. IME candidate composition,
multi-file drag/drop, pasted image, keyboard-only login/approval/download, and
live-region verbosity remain open.
