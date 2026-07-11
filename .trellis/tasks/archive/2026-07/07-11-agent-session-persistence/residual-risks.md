# Residual Risks (MVP deferred)

Foundational agent session persistence is implemented. The following are **explicitly deferred** and remain residual risk for production HA:

| Area | Status | Notes |
|------|--------|-------|
| Full SDK JSONL rebuild from PG | Deferred | Dual-write keeps `conversations.messages` as UI projection; `agent_events` is recovery log only. No `SessionManager.open()` from materialized JSONL yet. |
| Redis coordination | Deferred | Lease/cancel use DB optimistic version only; no Redis pub/sub or distributed lease store. |
| Perfect multi-replica production HA | Deferred | Lease claim is best-effort via `version` + `lease_until`; single-process is correct; multi-process races are mitigated but not HA-proven. |
| Legal hold UI | Deferred | `conversations.legal_hold` column + TTL skip exists; no admin UI to set/clear holds. |
| Audit event purge job | Stub only | `cleanup_expired_audit_stub` computes 180d cutoff; does not delete rows. |
| Conversation 90d inactive purge | Partial | Config default present; only draft (empty messages, 24h) cleanup is implemented. |
| Tool ledger wired into every tool path | Partial | API + repository ready; Node tools do not yet call prepare/executing/terminal on every invoke (can be hooked next). |
| Python agent runtime parity | Partial | Node BFF chat path creates runs/events; Python `/agent/chat` path not fully dual-written yet. |

## Acceptance mapping (MVP)

- Schema dual dialect + ALTER-safe migrate: **done**
- Event append monotonic sequence: **done**
- Lease claim conflict: **done** (DB)
- Tool unknown never auto-retry: **done**
- Interrupted dual-write + UI badge: **done**
- TTL defaults + draft cleanup: **done**
