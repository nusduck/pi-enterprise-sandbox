# Code Review Triage — 2026-07-29 (decisions applied)

**Source review:** [`2026-07-29-code-review.md`](./2026-07-29-code-review.md)  
**Re-verified:** `codex/plan-acceptance`  
**Owner context:** Sandbox-side HITL `approval_manager` / bash `pending_approval` is **legacy — do not restore**. Agent durable approval remains the product gate for external side effects.

## Legend

| Verdict | Meaning |
|---------|---------|
| **NO_FIX** | Wrong, obsolete, or intentional vs current product model |
| **REAL** | Confirmed; should fix |
| **CLEANUP** | True; hygiene / dead code / maintainability only |
| **LATENT** | True but not reachable on current production call paths |

---

# Product decisions (owner, 2026-07-29)

| # | Topic | Decision |
|---|--------|----------|
| D1 | Process log retention after eviction/restart | **Live-only is enough for chat UX.** See note below: ordinary tool UI does **not** depend on rehydrating Sandbox process logs. Fix dead `repository` paths / docs; **do not** build durable process log store unless later required for process panel history. |
| D2 | Workspace / session disk GC | **Delete when conversation is deleted** (Agent conversation archive/delete → Sandbox workspace cleanup). No separate legal-hold requirement stated. |
| D3 | Auth-off mode | **Not required.** Formal public routes may keep requiring owner auth. **Current local/deploy config already has auth on:** `SANDBOX_AUTH_ENABLED=true`, `AUTH_ENABLED=true` (local `.env`). Document auth-off as unsupported for formal public session routes (optional: fail-fast if someone turns it off). |
| D4 | Internal `trace_id` binding | **Keep loose** — if request context has no trace, do not fail closed; only enforce mismatch when both sides present. |
| D5 | AgentVersion MCP allowlist | **Must take effect now** — intersect with deployment registry; AgentVersion must not inherit full registry tool surface when it declares a narrower allowlist. |

### D1 detail — does terminal log eviction affect frontend tool display?

**Mostly no for normal chat tools.**

| Path | What frontend shows | Depends on post-eviction Sandbox log store? |
|------|---------------------|-----------------------------------------------|
| **`bash` / `python` / `write` / …** (one-shot tools) | Tool result already streamed into **Run events / messages** (`tool.execution.completed`, journal). Timeline unwraps stdout from that payload. | **No.** Result was captured at tool completion time. |
| **`process_start` + live `process_read` / status** while process is running | May call Sandbox process APIs for live streams. | **Yes while live** (in-memory). |
| **After process terminal + memory eviction / Sandbox restart** | Re-open process panel / `process_read` may get empty/truncated logs; status may still load from formal MySQL. | **Historical full stdout not available** by design today. |

**Conclusion for triage:** D1 does **not** block shipping chat tool UI. Still fix **#2** as code correctness (dead `self.repository`, misleading docs). Defer durable log archival unless product later needs “reopen finished process and see full history.”

---

# Part A — Sandbox (§1–10 + additional)

### #1 Sandbox HITL approval gate “silently dropped”

| | |
|--|--|
| **Re-verify** | Formal path only `is_blocked_command`. Sandbox approval manager gone. Agent durable approval remains for external tools. |
| **Verdict** | **NO_FIX (product)** |
| **Optional CLEANUP** | **Done (2026-07-29):** Sandbox `check()` maps former `approval_required` → `hard_deny`; `approval_timeout` documented unused; enum/status leftovers marked legacy. Agent durable approval unchanged. |
| **Priority** | Cleanup only |

### #2 Dead `self.repository` + terminal eviction

| | |
|--|--|
| **Re-verify** | Repository never wired; Agent uses `get_owned` / formal path; log bodies not in formal schema after eviction |
| **Verdict** | **REAL** (landmine + docs); **not** a chat tool-display blocker (D1) |
| **Should fix** | Remove or wire dead fallback; fix rehydration docs; keep live-only log semantics |
| **Priority** | **P2** |

### #3 TTL / workspace GC / legal hold removed

| | |
|--|--|
| **Re-verify** | TTL config unread; `remove_workspace` unused; disk unbounded without GC |
| **Verdict** | **REAL** |
| **Should fix** | On **conversation delete/archive**, delete associated Sandbox workspace(s) / session binding cleanup (D2). No legal-hold for now. |
| **Priority** | **P1** |

### #4 Reaper crashes on `_persist` before done-event

| | |
|--|--|
| **Verdict** | **REAL** |
| **Should fix** | Fail-soft persist; always signal completion |
| **Priority** | **P0/P1** |

### #5 `require_owned_session` 503 when auth disabled

| | |
|--|--|
| **Verdict** | **NO_FIX / document** (D3): auth-off not a supported formal public mode |
| **Should fix** | Docs + optional startup warning if `auth_enabled=false` |
| **Priority** | **P3** docs |
| **Current env** | Auth **enabled** (`true` / `true`) |

### #6 Service token non-constant-time `==`

| | |
|--|--|
| **Verdict** | **REAL** |
| **Priority** | **P2** |

### #7 `request_hash` never verified

| | |
|--|--|
| **Verdict** | **REAL** |
| **Priority** | **P2** — verify or drop claim + fix docs |

### #8 `cancel()` returns True for any terminal process

| | |
|--|--|
| **Verdict** | **NO_FIX** (intentional idempotent cancel) |

### #9 Trace binding skipped when request `trace_id` unset

| | |
|--|--|
| **Verdict** | **NO_FIX** (D4 keep loose) |
| **Note** | Mismatch when both sides present must still deny |

### #10 MCP internal body reader weaker than shared helper

| | |
|--|--|
| **Verdict** | **REAL** |
| **Priority** | **P2** |

### Sandbox additional

| Item | Verdict | Priority |
|------|---------|----------|
| Redis isolation password `==` | **CLEANUP** | P3 |
| `_persist` before formal wired | **REAL** (with #4) | P1 |
| MCP Bearer parse duplicated | **CLEANUP** | P3 |
| Artifact sha256 helpers dual | **CLEANUP** | P3 |
| Config validators / giant model_validator | **CLEANUP** | P3 |
| workspace_quota_ledger triplicate | **CLEANUP** | P3 |
| `on_exceed` dead | **CLEANUP** | P3 |
| Cron phantom `CRASHED` | **CLEANUP** | P3 |

---

# Part B — Agent (A1–A5 + latent)

### A1 Extension load-failure gate skipped on rebind / skill reload

| | |
|--|--|
| **Verdict** | **REAL** |
| **Should fix** | `assertExtensionsLoadedClean` after every bind/rebind; skill reload fail-closed if policy extension errors |
| **Priority** | **P0/P1** |

### A2 Per-AgentVersion MCP allowlist discarded when registry non-empty

| | |
|--|--|
| **Verdict** | **REAL** — **must fix now** (D5) |
| **Should fix** | Deployment registry = connectivity catalog; **intersect** with AgentVersion `mcpServers` / `enabledTools` / toolPolicy so a version cannot see undeclared tools |
| **Priority** | **P1** |

### A3 Concurrent default agent creation race

| | |
|--|--|
| **Verdict** | **LATENT / harden** |
| **Should fix** | `UNIQUE(org_id, name)` + require txn lock |
| **Priority** | **P2** |

### A4 No JSON-schema arg validation; full buffer then redact

| | |
|--|--|
| **Verdict** | **REAL** |
| **Priority** | **P2** |

### A5 Sequential unbounded MCP discovery blocks readiness

| | |
|--|--|
| **Verdict** | **REAL** |
| **Priority** | **P2** |

### Agent latent

| Item | Verdict |
|------|---------|
| Optional `agentVersionId` in recovery | **LATENT** |
| Idempotent CreateRun after archive | **REAL mild** |
| Executor ignores AgentVersion `status` | **LATENT** |
| Governance audit assumes policyEngine | **LATENT** |
| MCP cleanup only temp dir | **REAL mild** |

---

# Summary board (post-decision)

| Priority | IDs | Action |
|----------|-----|--------|
| **P0/P1** | **A1**, **#4** | Extension rebind fail-closed; reaper persist resilience |
| **P1** | **A2**, **#3** | MCP allowlist intersection; conversation-delete → workspace delete |
| **P2** | **#2, #6, #7, #10, A3, A4, A5** | Process repo cleanup; security hygiene; MCP hardening |
| **P3** | **#5 docs**, extras | Auth-off unsupported docs; cleanup backlog |
| **NO_FIX** | **#1, #8, #9** | Legacy Sandbox approval; cancel idempotency; loose trace |

## Suggested implementation order

1. **A1** — rebind/reload extension fail-closed  
2. **#4** — reaper persist fail-soft  
3. **A2** — AgentVersion ∩ registry MCP tools  
4. **#3** — conversation delete → Sandbox workspace cleanup  
5. **#2 #6 #7 #10 A3 A4 A5** batch  
6. CLEANUP + #5 docs  

---

## Decision log

| When | Who | Notes |
|------|-----|--------|
| 2026-07-29 | Owner | D1 live-only logs (chat UI independent); D2 delete on conversation delete; D3 no auth-off, auth already on; D4 loose trace; D5 MCP allowlist now |
