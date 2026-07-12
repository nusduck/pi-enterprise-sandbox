# F2 — Entity and Event Architecture

## Goal

建立 Conversation/Session/Run/Tool/Process/Approval/Artifact 实体；Run Event Reducer；按 run 管理的 SSE Manager（Last-Event-ID、重连、去重）；移除直接改 currentMsg.content 的方式。

## Dependencies

F1 foundation.

## Acceptance Criteria

- [x] UI distinguishes Conversation, Session, Run
- [x] Refresh recovers in-progress run state
- [x] Switching conversation does not auto-cancel background runs
- [x] Multi-run status updates independently
- [x] SSE reconnect without duplicate events; sequence resume
