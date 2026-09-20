# Full regression 2026-09-19 — REC-03 browser follow-up

Date: 2026-09-19 (Asia/Singapore)

- A fresh admin conversation started one harmless foreground `sleep 20` tool
  operation and was visibly `Running · 1 tool` before the interruption.
- The `api-server` Compose service was restarted in isolation. Docker reported
  the service running and healthy again after the restart.
- Jev reloaded the same browser conversation after the BFF restart. The fresh
  AX state showed the original Run as `Succeeded · 1 tool · 22s` and contained
  `REC03_BFF_RESTART_OK_20260919`.
- An independent DOM verification confirmed the browser remained on the local
  app origin, the marker was present, `Succeeded` was present, and no `Running`
  state remained.

This is evidence for the BFF restart → browser catch-up → same-Run completion
branch of `REC-03`. Redis outage, outbox replay, multi-Worker lease behavior,
and a run with a pending external side effect remain open.
