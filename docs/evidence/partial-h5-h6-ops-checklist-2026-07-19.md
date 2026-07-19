# H5 / H6 ops residual checklist — production sampling + MCP allowlist

**Date:** 2026-07-19  
**Branch:** `codex/plan-acceptance`  
**STATUS IDs:** H5 (Secrets not in model/logs/events), H6 (Business DB only via controlled MCP)  
**Offline verdict:** **closed** for dual-path redaction + structural MCP-only tool plane (unit suite green).  
**Overall verdict for promotion to `done`:** **still `partial`** — residual is **ops-only** (no production log/event samples and no signed deployment allowlist audit in this evidence pack).

**Do not invent production samples.** Empty checkboxes below mean the work is **not done**. Do not mark H5/H6 `done` until every critical item is filled with dated evidence (log excerpts, SQL redaction proofs, allowlist inventory, gate run IDs).

Related offline evidence (already in repo when parent commits):

- `docs/evidence/h5-h6-secrets-mcp-audit-2026-07-19.md`
- `docs/evidence/p1-h5-h6-offline-closeout-2026-07-19.md`
- Scratch suite log: `partial-h5-h6.log` (same directory as this checklist)

---

## 0. Offline proof baseline (already green — do not re-litigate for residual)

### Suite command

```bash
cd agent && node --test \
  tests/bootstrap/secret-and-mcp-policy.unit.test.js \
  tests/pi/mcp-seam.unit.test.js \
  tests/pi/platform-event-projector.unit.test.js \
  tests/tool-payload-sanitizer.test.js \
  tests/outbox/outbox-repository.unit.test.js \
  tests/skill-paths.test.js \
  tests/redis/connection-error-guard.unit.test.js
```

**Expected:** all pass (69 tests as of 2026-07-19 offline closeout). Capture stdout in release evidence.

### What offline already proves

| Area | Proof |
|------|--------|
| Shared redaction | `SECRET_PATTERNS` / `redactSecretText` cover Bearer, field secrets (`token`/`password`/`access_token`/`refresh_token`/`client_secret`/…), Cookie, `sk-*`, URI userinfo |
| Durable status / outbox | `sanitizeStatusReason` + `sanitizeOutboxError` call `redactSecretText` then collapse DSN schemes |
| Redis logs | `sanitizeRedisLogText` routes through `redactSecretText` first |
| Projector | INLINE patterns + shared base; MCP results/progress redacted before Pi |
| MCP config | Plaintext secrets rejected; `secretRef` / `authTokenRef` / `envRefs` / `headerRefs` only |
| MCP stack | Only `pi-mcp-adapter` modules under `agent/src/infrastructure/mcp/` (closed set: index, loader, factory) |
| Tool plane | `ENTERPRISE_DEFAULT_TOOLS === SANDBOX_TOOL_NAMES` (10 non-SQL tools) + `ask_user`; no extension SQL/DSN clients; platform MySQL is infrastructure-only |

### What offline **cannot** prove (residual)

| Residual | Blocks |
|----------|--------|
| Real container / host log lines under secret-bearing MCP load | H5 → `done` |
| Durable MySQL rows (`run_events`, `tool_executions`, `runs.status_reason`, `domain_outbox.last_error`) under that load | H5 → `done` |
| Deployed `MCP_SERVERS_JSON` inventory + owner + credential-ref policy | H6 → `done` |
| Live capability snapshot: model never sees a non-`mcp__*` business SQL/DSN tool | H6 → `done` |

---

## 1. H5 — production / staging secret sampling

**Goal:** Demonstrate that canaries (Bearer, DSN userinfo, field tokens, provider keys) do **not** appear in operator-visible surfaces after a controlled secret-bearing run.

### 1.1 Preconditions

- [ ] Environment named and dated: `________________` (staging preferred first; production only with change ticket)
- [ ] Build/image SHA or compose image digests recorded: `________________`
- [ ] Operator has read access to agent logs + MySQL app DB (no write beyond fixture run)
- [ ] Canary secrets are **synthetic** (not real customer credentials), unique strings greppable later:
  - Bearer: `Bearer h5canary-bearer-________________`
  - Field: `access_token=h5canary-access-________________`
  - DSN-shaped: `mysql://h5canary:h5canary-pass-________________@db.example/prod`
  - Provider-style: `sk-h5canary________________`
- [ ] Fixture path chosen (one of):
  - [ ] MCP server fixture that echoes canaries in tool **result** and **progress**
  - [ ] Sandbox `bash`/`python` tool that prints canaries (secondary; still exercises projector + sanitizers)
  - [ ] Forced failure path that would land canaries in `status_reason` / outbox `last_error` (e.g. connect error message containing DSN)

### 1.2 Run the fixture

- [ ] Create/run id: `run_id=________________` `org_id=________________` `trace_id=________________`
- [ ] Timestamp window (UTC): `from ________ to ________`
- [ ] Confirm MCP path used if business secrets are the concern: tool names `mcp__…` appear in diagnostics/events

### 1.3 App / container log sampling

Search agent (and api-server if it proxies run errors) logs in the window for every canary substring.

```bash
# Example patterns — adjust log backend (docker logs / Loki / CloudWatch)
rg -n 'h5canary|sk-h5canary|Bearer h5canary' <log-export>
```

| Surface | Command / query used | Canary found? (must be **no**) | Evidence path / ticket |
|---------|----------------------|-------------------------------|-------------------------|
| Agent stdout/stderr | | ☐ no / ☐ **YES — FAIL** | |
| Agent structured logs | | ☐ no / ☐ **YES — FAIL** | |
| Worker process logs | | ☐ no / ☐ **YES — FAIL** | |
| Redis connection error logs (if exercised) | | ☐ no / ☐ **YES — FAIL** | |
| Reverse-proxy / nginx access (should not include bodies; confirm no Authorization echo) | | ☐ no / ☐ **YES — FAIL** | |

**Pass criterion:** zero raw canary matches. Redacted forms (`[REDACTED]`, `token=[REDACTED]`, `mysql://***`) are allowed and should be noted.

### 1.4 Durable MySQL row sampling

Run as a read-only app user. Replace placeholders. Prefer selecting only columns that may hold free text / JSON.

```sql
-- runs.status_reason
SELECT run_id, status, status_reason, updated_at
FROM runs
WHERE run_id = '<run_id>';

-- run_events payload / text (column names follow migrations; adjust if projected JSON)
SELECT event_id, run_id, event_type, created_at
FROM run_events
WHERE run_id = '<run_id>'
ORDER BY event_id
LIMIT 200;
-- Then inspect payload JSON offline; grep for canaries.

-- tool_executions arguments / result summaries
SELECT tool_execution_id, tool_name, status, arguments_json, result_json, error_message, updated_at
FROM tool_executions
WHERE run_id = '<run_id>'
ORDER BY tool_execution_id;

-- domain outbox last_error (if publish failed or was forced)
SELECT id, aggregate_id, event_type, status, last_error, attempts, updated_at
FROM domain_outbox
WHERE aggregate_id = '<run_id>'
   OR payload LIKE '%<run_id>%'
ORDER BY id DESC
LIMIT 50;
```

| Table / column | Canary raw? | Redacted form present? | Evidence (export hash or ticket) |
|----------------|-------------|------------------------|----------------------------------|
| `runs.status_reason` | ☐ no / ☐ FAIL | ☐ | |
| `run_events` payload / text | ☐ no / ☐ FAIL | ☐ | |
| `tool_executions.arguments_json` | ☐ no / ☐ FAIL | ☐ | |
| `tool_executions` result / error fields | ☐ no / ☐ FAIL | ☐ | |
| `domain_outbox.last_error` | ☐ no / ☐ FAIL | ☐ | |
| SSE / A2A audit rows if emitted for the run | ☐ no / ☐ FAIL | ☐ | |

**Pass criterion:** no raw canary in any durable free-text/JSON field; governance may store hashes/summaries only.

### 1.5 Model-visible surface (H5 intersects H6)

- [ ] Capture model-facing tool result text (session transcript / projected events) for the canary MCP call
- [ ] Assert model text contains redaction markers, **not** raw canaries
- [ ] Evidence: `________________`

### 1.6 H5 sign-off

| Role | Name | Date | Result |
|------|------|------|--------|
| Operator | | | ☐ pass / ☐ fail |
| Security / platform review | | | ☐ pass / ☐ fail |

**H5 may move to `done` only when §1.3–1.5 all pass with attached non-invented samples.** Until then STATUS stays **`partial`**.

---

## 2. H6 — deployment MCP allowlist + no business-SQL tool gate

**Goal:** Business databases and customer data planes are reachable **only** through controlled MCP servers listed in deployment config; Agent never exposes a first-class SQL/DSN tool; platform MySQL remains Run-authority infrastructure only.

### 2.1 Inventory deployment MCP registry

Source of truth: `MCP_SERVERS_JSON` (see `docs/deployment.md`, `.env.example`, compose `agent` / `agent-worker` env).

- [ ] Environment: `________________`
- [ ] How config is injected (compose env / secret manager / K8s ConfigMap): `________________`
- [ ] Raw registry redacted dump attached (ids, urls/commands, **refs only** — never resolved secrets): `________________`

| server id | transport (http/stdio/…) | url or command | authTokenRef | envRefs keys | headerRefs keys | owner team | data class (knowledge / business DB / other) | enabled? |
|-----------|--------------------------|----------------|--------------|--------------|-----------------|------------|-----------------------------------------------|----------|
| | | | | | | | | ☐ |

**Rules (fail closed if violated):**

- [ ] No plaintext `token` / `password` / `apiKey` / header values in registry JSON
- [ ] Every credential uses `authTokenRef` / `envRefs` / `headerRefs` pointing at env var **names** only
- [ ] Referenced env vars exist in the runtime secret store and are not logged at process start
- [ ] Business DB MCP servers (if any) are explicitly labeled and owned; default empty `MCP_SERVERS_JSON=[]` is acceptable and means **no** external MCP
- [ ] Sandbox is **not** configured as an MCP client path for business DB (architecture: Agent `pi-mcp-adapter` only)

### 2.2 Credential hygiene

- [ ] Resolved secrets never appear in `AGENT_MCP_RUNTIME_ROOT` leftovers after run dispose (spot-check empty/absent run dirs)
- [ ] Materialized adapter config mode is `0600` while live (unit-covered offline; ops confirms host/volume not world-readable)
- [ ] DB MCP gateway (if used) enforces tenant/data-domain server-side (plan § tenant injection) — record control owner: `________________`

### 2.3 Live “no business SQL tool” gate

Offline structural tests assert sandbox-bridge tool names and ban extension SQL clients. Live gate confirms the **running** session.

- [ ] On a production-like agent, after session start with the env’s MCP registry, export active tools / diagnostics snapshot:
  - source: extension diagnostics / capability list API / session tool list — note which: `________________`
- [ ] Assert every non-`mcp__*` tool is subset of:

  `read`, `write`, `edit`, `bash`, `python`, `process_start`, `process_status`, `process_read`, `process_kill`, `submit_artifact`, `ask_user`

- [ ] Assert **no** tool named like `sql`, `execute_sql`, `mysql_query`, `run_query`, `db_query`, `postgres`, `psql`, or any DSN-shaped built-in
- [ ] Assert any database capability appears **only** as `mcp__<server>__<tool>` for an allowlisted server id from §2.1
- [ ] Optional adversarial: prompt model to “open mysql with DATABASE_URL” — expect policy denial / no tool; record transcript id: `________________`

| Check | Result | Evidence |
|-------|--------|----------|
| Active tools ⊆ sandbox + ask_user + mcp__* | ☐ pass / ☐ fail | |
| No non-MCP SQL/DSN tool | ☐ pass / ☐ fail | |
| Business DB only via allowlisted mcp__* | ☐ pass / ☐ fail / ☐ N/A (no DB MCP) | |

### 2.4 Platform MySQL vs business DB (clarity for auditors)

| Plane | Path | Secret surface | Allowed as model tool? |
|-------|------|----------------|------------------------|
| Platform Run authority | `agent/src/infrastructure/mysql` + `AGENT_DATABASE_URL` | Ops DSN; never model tool | **No** |
| Business / customer DB | External MCP only (`MCP_SERVERS_JSON`) | MCP `*Ref` env secrets | **Only** as `mcp__…` tools |

- [ ] Confirm production agent process env does **not** place business DB DSNs into sandbox tool env (sandbox `SENSITIVE_ENV_KEY` + disabled net in prod)

### 2.5 H6 sign-off

| Role | Name | Date | Result |
|------|------|------|--------|
| Operator / deployer | | | ☐ pass / ☐ fail |
| Security / data-plane owner | | | ☐ pass / ☐ fail |

**H6 may move to `done` only when §2.1–2.3 pass with attached inventory + live tool snapshot.** Until then STATUS stays **`partial`**.

---

## 3. Explicit residual wording (for STATUS notes)

Use language that does **not** over-claim:

> Offline dual-path redaction and MCP structural guards are green (secret-and-mcp-policy + mcp-seam + projector + redis guard + sanitizer + outbox). **Residual (blocks done):** (1) production/staging log + durable-row sampling under secret-bearing MCP load per ops checklist; (2) deployment `MCP_SERVERS_JSON` allowlist audit + live no-business-SQL-tool snapshot. No production samples in-repo yet.

**Do not** use `waived` for H5/H6 residual: production sampling and allowlist audit are **in-scope** acceptance for plan § secrets / business-DB-via-MCP, not out-of-scope debt. Prefer **`partial`** until evidence exists.

---

## 4. Promotion gate summary

| ID | Offline | Ops residual | Promote to `done` when |
|----|---------|--------------|------------------------|
| **H5** | ✅ dual-path redaction + unit suite | Log + MySQL row sampling (§1) | §1.6 dual sign-off with real samples |
| **H6** | ✅ MCP-only structural + tool-plane test | Allowlist inventory + live tool gate (§2) | §2.5 dual sign-off with inventory + snapshot |

**Recommended STATUS (2026-07-19):** keep **H5 = `partial`**, **H6 = `partial`**.

---

## 5. Scratch artifacts (this closeout)

| Artifact | Path |
|----------|------|
| Suite log | `{SCRATCH}/partial-h5-h6.log` |
| This checklist | `{SCRATCH}/partial-h5-h6-checklist.md` |

Parent should copy this checklist into `docs/evidence/` when committing offline closeout; fill §1–§2 only after real ops work.
