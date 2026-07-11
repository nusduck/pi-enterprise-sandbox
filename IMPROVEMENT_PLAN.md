# Pi Enterprise Sandbox — Project Review & Improvement Plan

> ⚠️ **SUPERSEDED / HISTORICAL (2026-07-11)** — 本文档不再是现行实现规范。  
> **当前单一事实源：** `README.md`、`docs/architecture.md`、`docs/api.md`、`docs/deployment.md`、`docs/development.md`、`.trellis/spec/`、活跃 Trellis 任务。  
> 最终发行边界：四服务（Frontend→BFF→Agent→Sandbox）、Node 22、零内置 Skill、PostgreSQL 生产、相对 workspace/`workspace_id`、无 Python Agent / 双 Runtime。  
>
> **Generated:** 2026-07-09 · **Revised:** 2026-07-09 (implementation complete for Phase 0 + Phase 1 core)  
> **Partial update 2026-07-11:** 全栈硬化子任务已落地（backend security、request-context/cancel、frontend SSE/security 测试、CI 矩阵与 readiness）。详见 `.trellis/tasks/07-11-*`。  
> **Implementation status:** **Phase 0–1 done**. **Phase 1.5 done:** approval pause in bash tool + SSE/UI, policy high-risk command patterns, GET /approvals/{id}, auth foundation (register/login/JWT, optional SANDBOX_AUTH_ENABLED).  
> **Independent Node Agent (2026-07-11):** `agent/` 独立服务承载 pi-coding-agent；BFF 仅 SSE relay；Python Agent Runtime / `AGENT_RUNTIME` / `POST /agent/chat` 已删除。  
> **Still remaining / out of this hardening wave:** full multi-user ownership, mount-namespace polish, 强制 Ruff/Mypy 门禁等。  
> ⚠️ 文中部分“当前代码问题”描述可能已修复；**以仓库代码与测试为准**，本文件作原则与路线图，不作逐行审计。  
> **Based on:** live v4 review + design principles + manual Docker test feedback  
> **Supersedes:** `PLAN.md` (v2-era paths); corrects stale gaps in `AUDIT.md`  
> **Scope:** architecture, security, reliability, UX, ops, and phased delivery

---

## 0. Core Design Principles (non-negotiable)

These principles **outrank** historical implementation choices and any prior plan text. New work must comply; existing code that violates them is tech debt to retire on the path below.

### P1 — One agent session owns one workspace

| Rule | Detail |
|------|--------|
| Ownership | Exactly **one workspace** is bound to **one agent session**. |
| Lifecycle | Workspace is **created when the session starts** and **torn down (or archived) when the session ends**. |
| No sharing | Workspaces are never shared across concurrent agent sessions. |
| Multi-turn | Multiple user turns in the same agent session reuse the **same** workspace. |

**Implication for current code:** Today each `POST /api/chat` often creates a new sandbox session while conversation workspaces try to outlive sessions. Target model is **session-scoped workspace ownership**, with optional *archive/export* if product needs longer file retention—not a second shared mutable workspace layer.

### P2 — Workspace starts empty

| Rule | Detail |
|------|--------|
| Initial state | New session workspace is an **empty directory**. |
| Forbidden | No pre-created `input/`, `output/`, sample files, or seed trees unless the product explicitly creates them via user/agent action. |
| Skills | Skills live **outside** the workspace (`/home/sandbox/skill`); they are not copied into the workspace at init. |

**Implication:** Remove init-time scaffolding and any “helpful” sample content. Optional subdirs only after user/agent `write` / `mkdir`.

### P3 — Agent-visible paths are stable

| Mount / path | Role | Mutability |
|--------------|------|------------|
| `/home/sandbox/workspace` | **Current session workspace** (always) | Read/write for that session only |
| `/home/sandbox/skill` | **Shared skill directory** (always) | Read-only |

Agents, tools, system prompts, and docs must use **only** these logical paths. Physical storage may live under e.g. `/var/sandbox/workspaces/{session_id}/`, but the process environment seen by bash/python/node/file APIs must present the stable paths above.

**Implication:** Retire agent-facing use of `/sandbox/workspace`, `/sandbox/skills`, and conversation IDs in user-visible paths. Implementation options (per-session bind-mount, user namespace, or chroot/pivot) must preserve the stable path contract **without** a single process-global symlink that races under concurrency.

### P4 — Workspace isolation applies to every tool surface

The same boundary must be enforced for:

- Bash / shell  
- Python runtime  
- Node.js runtime  
- File APIs (read/write/list/preview/download/upload)  
- Artifact APIs (register/submit/list/download)  
- MCP tools  

No alternate path that “escapes” to host layout, sibling sessions, or skill tree writes.

**Implication:** One shared path-resolution + policy module; all routers, MCP adapters, and agent tools call it. Concurrency tests must cover every surface.

### P5 — Agent runtime should be Python-first

| Rule | Detail |
|------|--------|
| Preferred SDK | Use the **`pi-coding-agent` Python SDK** where possible. |
| Avoid | Keeping **core agent orchestration** trapped in TypeScript/Node (`api-server` as the long-term agent host). |
| Acceptable interim | Node BFF may remain as a thin HTTP/SSE edge during migration. |
| End state | Orchestration, tool binding, session restore, approvals, and traces live primarily in the **Python** process space (alongside or inside Sandbox / a Python agent service). |

**Implication:** Improvement plan includes an explicit **Agent Runtime Migration** track (TS → Python), not only sandbox hardening.

### P6 — First-class persisted objects

The following are **first-class domain objects**: stored, restorable, auditable, and observable—not ephemeral dicts or log-only side effects.

| Object | Must support |
|--------|----------------|
| **Session** | Create, bind workspace, TTL/close, restore metadata |
| **Messages** | Append-only history per session (or conversation linked 1:1 to session policy) |
| **Skills** | Registry metadata + mount path; version/visibility as needed |
| **Tools** | Definitions, risk class, allow/deny decisions |
| **MCP** | Connections, auth, call audit |
| **Approvals** | Pending/approved/rejected, timeout, actor |
| **Artifacts** | Path, mime, size, session, provenance — **sole user-delivery channel (see P7)** |
| **Traces** | End-to-end `trace_id` spanning UI → agent → sandbox → tools |

**Implication:** Dual in-memory + DB “maybe” stores must converge on repositories; approvals must leave pure memory; messages must be server-side SoT; traces must start at the agent entrypoint.

### P7 — User-facing files only via Artifact API

Workspace I/O and user delivery are **separate concerns**. Only the Artifact API may expose files to the human user as downloadable deliverables.

| Action | Creates disk file? | Registers artifact? | UI download / `file_ready`? |
|--------|--------------------|---------------------|------------------------------|
| `write` / `edit` | Yes | **No** | **No** |
| `bash` / python / node generating files | Yes | **No** | **No** |
| `submit_artifact` (Artifact API) | File must already exist | **Yes** | **Yes** |

| Rule | Detail |
|------|--------|
| Write ≠ share | `write` / `edit` only mutate the private session workspace. They must **not** auto-trigger user download links. |
| Single delivery channel | All “send file to user” flows go through **Artifact API** (`POST .../artifacts/submit` or equivalent tool / MCP). |
| What to submit | **Final outputs**, **important results**, or **files the user explicitly asked for** — not every intermediate script, draft, or temp file. |
| No auto workspace scan | Do not scan the workspace after a turn to invent downloads. Explicit submit only. |
| SSE contract | `file_ready` (or successor event) is emitted **only** after a successful artifact submit, and should carry `artifact_id` (+ name, path, mime, size, download URL). |
| Download channel | User downloads use **artifact download** (`GET .../artifacts/{artifact_id}/download`), not ad-hoc raw path promotion of every write. |
| Agent guidance | System prompt + tool descriptions must state: intermediate work stays in workspace; call `submit_artifact` only when ready to deliver. |

**Current violation:** `api-server/routes/chat.js` emits `file_ready` on every successful `write` **and** on `submit_artifact`. System prompt claims write files are “automatically available for download.” That dual path confuses agents and floods the UI with intermediate files.

**Target flow:**

```
Workspace (private to session)
  write / edit / bash / python / node
        │
        │  agent decides: final / important / user-requested
        ▼
Artifact API  (submit / register)
        │
        │  SSE: file_ready { artifact_id, path, name, mime, size, ... }
        ▼
User UI download (Artifact API only)
```

**Implication:** Remove auto-`file_ready` on `write`; unify docs, prompts, frontend, and MCP on artifact-only delivery; treat artifacts as the product “Deliverables” list for a session.

---

## 1. Executive Summary

**Pi Enterprise Sandbox** is currently a three-container stack:

| Layer | Stack (today) | Role |
|-------|----------------|------|
| Frontend | Vite SPA + Nginx | Pure UI, SSE consumer |
| API Server | Node.js 20 + `pi-coding-agent` (TS) | Agent orchestration (violates P5 long-term) |
| Sandbox | Python 3.11 + FastAPI | Execution, files, sessions, audit, MCP |

**Foundation quality:** modular services, SQLite/PostgreSQL, path checks, iptables, non-root, RLIMIT, skills, approval backend skeleton, prod Nginx overlay.

**Principle compliance (today):**

| Principle | Status | Gap summary |
|-----------|--------|-------------|
| P1 Session ↔ workspace 1:1 | ✅ | Reuse sandbox session per conversation; empty session WS; cleanup on conv delete |
| P2 Empty workspace | ✅ | Empty init; no seed skills-in-ws |
| P3 Stable paths | ⚠️ | Agent cwd + constants `/home/sandbox/*`; exec uses physical path (mount-ns still ideal) |
| P4 Isolation all surfaces | ✅ | Physical-only exec cwd; isolation + path-escape tests |
| P5 Python-first agent | ❌ removed | Independent Node `agent/` service; Python agent runtime deleted |
| P6 First-class persistence | ⚠️ | Messages/approvals/sessions/artifacts in DB; UI approvals pause not fully wired into bash path |
| P7 Artifact-only user delivery | ✅ | submit_artifact only; allowlist fixed; frontend artifact download |

**Highest-risk gaps vs principles:**

1. Global workspace presentation (`/sandbox/workspace`) races under concurrency (**P3/P4**)  
2. Session/workspace lifecycle not cleanly 1:1 with agent session (**P1**)  
3. Multi-turn messages not first-class in the agent loop (**P6**)  
4. Agent orchestration in TypeScript (**P5**)  
5. Approvals/traces incomplete as product objects (**P6**)  
6. Host tests/CI broken (hardcoded `/sandbox` paths)  
7. User file delivery mixed: auto-on-write + artifact submit (**P7**)

---

## 2. Current State Assessment

### 2.1 What is already strong

| Area | Evidence | Assessment |
|------|----------|------------|
| Layered deploy | `frontend/` + `api-server/` + `sandbox/` + compose | Good separation of UI vs execution |
| Persistence skeleton | `database.py`, repositories, dual SQLite/PG | Right place to grow P6 objects |
| Security baseline | path validation, safe_env, iptables, non-root | Aligns with P4 if applied uniformly |
| Resource limits | RLIMIT + timeout killpg | Real process controls |
| Observability skeleton | trace middleware, metrics, audit, traces route | Extend for full P6 traces |
| Skills content | `skills/*` + preinstalled scientific stack | Content OK; **path contract** must move to `/home/sandbox/skill` |
| Docs / prod edge | architecture, nginx TLS, backups | Ops starting point |

### 2.2 AUDIT.md / PLAN.md correction

Already implemented (older ❌ marks were wrong):

| Feature | Actual |
|---------|--------|
| SQLite WAL / PG backend | ✅ |
| Trace middleware (sandbox) | ✅ |
| MCP token auth | ✅ |
| Node runtime in sandbox | ✅ |
| Network deny + command heuristics | ✅ |
| RLIMIT via preexec | ✅ |
| Preinstalled deps / skills packs | ✅ |

Still open relative to **principles**:

| Gap | Principles |
|-----|------------|
| Stable `/home/sandbox/{workspace,skill}` contract | P3 |
| Per-session isolation without global symlink race | P1, P3, P4 |
| Empty workspace init | P2 |
| Python agent orchestration | P5 |
| Messages / approvals / tools / MCP as full persisted objects | P6 |
| Artifact-only user delivery (no auto-share on write) | P7 |
| Uniform boundary on every tool surface + tests | P4 |
| Auth / multi-tenancy | product requirement beyond P1–P7 |
| Host pytest + CI | engineering quality |

### 2.3 Capability scorecard (0–5)

| Dimension | Score | Notes |
|-----------|------:|-------|
| Principle alignment (P1–P7) | 1.5 | Partial isolation + partial persistence; delivery dual-path |
| Core agent loop | 3.5 | Demo-quality; wrong host language long-term |
| Isolation under concurrency | 1 | Global presentation path |
| Multi-turn / messages SoT | 2 | UI localStorage; agent last-message only |
| User file delivery (P7) | 2 | Explicit artifact exists, but write auto-shares |
| Auth / multi-tenancy | 0 | Service token only |
| Approval governance | 2 | Backend only, in-memory |
| Testability / CI | 1 | Collection fails outside container |
| Production ops | 3 | Nginx/SSL present; shallow monitoring |

---

## 3. Target Architecture (principle-aligned)

### 3.1 Logical layout (agent view)

```
/home/sandbox/
├── workspace/     ← session-private, empty at start, R/W
└── skill/         ← shared skills, R/O (all sessions)
```

Physical example (not agent-visible):

```
/var/sandbox/workspaces/{session_id}/   → mounted or linked as /home/sandbox/workspace
/var/sandbox/skill/                     → mounted as /home/sandbox/skill (ro)
```

### 3.2 Session / workspace lifecycle (P1 + P2)

```
CREATE agent session
   → allocate session_id
   → mkdir empty physical workspace
   → bind to /home/sandbox/workspace for this session's execution context
   → persist Session row (status=RUNNING, workspace_path=physical, created_at, …)

RUN turns (same session)
   → append Messages
   → tools run with cwd/root = this session workspace only
   → Artifacts / Approvals / Traces attach to session_id

CLOSE / EXPIRE session
   → status=COMPLETED|EXPIRED
   → unbind presentation path
   → delete or archive workspace per retention policy
   → immutable audit trail retained
```

**Conversation product UX** may still offer a “chat thread” UI, but the **system of record for files and tools is the agent session**. If the product needs multi-day file continuity, prefer:

- **resume session** (restore same session_id + workspace archive), or  
- **export artifacts** out of session  

…not a second parallel “conversation workspace” that multiple agent sessions can point at loosely.

### 3.3 Isolation model (P4)

| Surface | Enforcement |
|---------|-------------|
| Exec (bash/python/node) | `cwd` + env rooted at session workspace; path allowlist |
| File API | `resolve + is_relative_to(workspace_root)` |
| Artifacts | files must live under workspace; metadata keyed by session_id |
| MCP | same services as REST; no alternate root |
| Skills | read-only path; writes rejected |

**Concurrency:** isolation is **per session context**, not a single global “active workspace” on the host process. Multi-session = multiple concurrent roots.

### 3.3.1 Session-scoped workspace principle (strengthened)

Each agent session owns **exactly one** isolated workspace.

| View | Path |
|------|------|
| **Agent-visible (always)** | `/home/sandbox/workspace` — empty at session start |
| **Physical storage** | e.g. `/var/sandbox/workspaces/session_{id}/` or `conv_{id}/` |
| **Skills (all sessions, R/O)** | `/home/sandbox/skill` |

- No pre-created `input/`, `output/`, `tmp/`, or sample files unless the user/agent creates them.  
- Agent must **not** list, access, or infer other sessions’ workspaces via bash, Python, Node, file APIs, artifacts, or MCP.  
- Mapping is session-scoped and concurrency-safe — **not** a single process-global mutable symlink.

### 3.3.2 Recommended workspace mapping implementation

**Avoid** as multi-session source of truth:

```text
/sandbox/workspace   # global mutable symlink — race under concurrency
```

**Preferred long-term (pick one):**

1. **Per-session mount namespace** — bind physical workspace → `/home/sandbox/workspace`; bind skills → `/home/sandbox/skill` (ro); hide parent workspace root.  
2. **Per-session sandbox worker** — dedicated process/runtime per agent session with its own `/home/sandbox/workspace`.  

**Short-term fallback (current interim):**

- I/O uses physical path for correctness.  
- Best-effort re-point presentation link before each execution so single-session `pwd` can show `/home/sandbox/workspace`.  
- **Not** sufficient for concurrent sessions; mount-ns or per-session worker remains the target.

### 3.3.3 Workspace isolation acceptance tests (must pass)

1. Create two agent sessions concurrently.  
2. Each starts with empty `/home/sandbox/workspace`.  
3. Session A writes `a.txt`; Session B writes `b.txt`.  
4. A cannot see `b.txt`; B cannot see `a.txt`.  
5. Neither can list/access the physical workspace root of the other.  
6. Both can read `/home/sandbox/skill`; neither can write skills.  
7. Bash, Python, Node, file APIs, artifact APIs, and MCP all respect the same boundary.

### 3.4 Agent runtime (P5) — Python-first module

The agent must **not** remain a thin wrapper around a single `session.prompt(text)` call.

**Target layout:**

```
sandbox/agent/   (or services/agent/)
  agent_runtime.py          # pi-coding-agent Python SDK adapter
  session_manager.py        # create, restore, close, persist agent sessions
  message_manager.py        # persist, load, replay, summarize messages
  conversation_service.py   # bind conversation_id ↔ agent_session_id ↔ workspace
  skill_manager.py          # list, manifest, README, validate, to_prompt
  tool_registry.py          # sandbox + MCP tools in one registry
  mcp_manager.py            # config, auth, list, invoke, audit, trace
  artifact_manager.py       # register/expose deliverables (P7)
  approval_bridge.py        # pause/resume high-risk tools
  trace_context.py          # trace_id across agent → tools → sandbox
```

**Target flow:**

```
Browser ──► Edge (Nginx; optional thin BFF)
              │
              ▼
        Python Agent Module  (pi-coding-agent Python SDK)
              │  session · messages · skills · tools · MCP · approvals · artifacts · traces
              ▼
        Sandbox Runtime APIs  (may colocate)
              │
              ▼
        /home/sandbox/workspace (session) + /home/sandbox/skill (shared ro)
```

**Migration stance:**

| Stage | Agent host | Notes |
|-------|------------|-------|
| Now | Node `api-server` | Interim only; tool allowlist must include all custom tools |
| Phase A | Python agent module behind same HTTP/SSE API | Feature parity |
| Phase B | Delete TS orchestration | P5 complete |

### 3.4.1 Persistent agent session + messages

Each conversation binds to a **persistent agent session**. Persist at least:

`conversation_id`, `agent_session_id`, workspace id/path, user/assistant messages, tool calls/results, approvals, artifacts, `trace_id`, session status, timestamps.

| Turn | Behavior |
|------|----------|
| Turn 1 | create conversation + agent session + empty workspace; persist messages |
| Turn 2+ | restore same conversation/session/workspace; load prior messages; continue |

### 3.4.2 Skill discovery + `to_prompt`

Skills live at `/home/sandbox/skill`. `SkillManager` must: list, read manifest/README, validate structure, convert selected skills into compact prompt blocks (`to_prompt`), expose skill files R/O.

### 3.4.3 MCP is first-class (not a side feature)

`MCPManager` must: load config, auth, list tools, register into unified tool registry, invoke, apply approval policy, audit, propagate `trace_id`.

### 3.5 Persistence model (P6)

Minimum relational (logical) entities:

```
sessions(session_id, user_id?, status, workspace_path, agent_runtime_meta, ttl, …)
messages(id, session_id, role, content_json, created_at, trace_id?)
skills(id, name, path, version, enabled, …)          -- registry; files on disk
tools(id, name, risk_level, config_json, …)          -- catalog / policy
tool_invocations(id, session_id, tool_name, args, result, status, trace_id, …)
mcp_endpoints / mcp_calls(…)
approvals(approval_id, session_id, tool_name, status, payload, expires_at, decided_at, …)
artifacts(artifact_id, session_id, path, mime, size, source_execution_id, …)
  -- P7: only rows here are user-visible deliverables
traces(trace_id, session_id, root_span, started_at, …)  -- or derive from audit_logs
audit_logs(…)  -- already present; keep as append-only event stream
```

All write paths that matter for restore/compliance go through repositories—not only stdout logs.

### 3.6 User file delivery (P7)

| Layer | Responsibility |
|-------|----------------|
| Workspace file APIs / write tool | Private session storage only |
| Artifact submit API + `submit_artifact` tool | Promote selected files to user deliverables |
| Agent system prompt | Teach “write for work, submit for share” |
| SSE / frontend | Show download chips **only** for artifacts |
| Session “Deliverables” UI (optional) | `GET /sessions/{id}/artifacts` as source of truth |

**Agent decision guide (product copy):**

- Intermediate code, drafts, temp data → **write only**  
- Final report, chart, export, or “please give me a file” → **`submit_artifact`**  
- Same path may be rewritten many times; **submit when ready** (re-submit if versioning is needed later)

---

## 4. Critical Findings (mapped to principles)

### P0-1. Process-global workspace presentation (P1, P3, P4)

**Where:** `workspace_manager.WORKSPACE_LINK`, executions hardcoding `/sandbox/workspace`.

**Why it fails principles:** Not session-owned; not stable under concurrency; breaks isolation on exec surface.

**Fix:**
1. Eliminate shared mutable global symlink as the multi-session root.  
2. Bind **session → workspace** 1:1 in DB and runtime.  
3. Present **`/home/sandbox/workspace`** only within that session’s execution context.  
4. Concurrency tests: two sessions, all surfaces, zero cross-read/write.

### P0-2. Path contract mismatch (P3)

**Today:** `/sandbox/workspace`, `/sandbox/skills` (and variants).  
**Target:** `/home/sandbox/workspace`, `/home/sandbox/skill`.

**Fix:** Config + Dockerfile + entrypoint + prompts + skills mount + docs + tests updated together. Single constants module; no scattered string literals.

### P0-3. Workspace not guaranteed empty (P2)

**Today:** may add skills symlink into workspace, conversation reuse, leftover trees.

**Fix:** Init = `mkdir` empty dir only. Skills **only** via `/home/sandbox/skill`. No auto `output/` tree until policy decides (prefer agent-created).

### P0-4. Messages not first-class in agent loop (P6, multi-turn)

**Where:** `api-server/routes/chat.js` prompts only last user message; history in `localStorage`.

**Fix:** Persist messages on session; restore into Python (or interim Node) agent each turn; UI reads history from API.

### P0-5. Agent orchestration in TypeScript (P5)

**Where:** `api-server` + `@earendil-works/pi-coding-agent` JS.

**Fix:** Stand up Python agent path with SDK; parity checklist (SSE events, tools, skills, artifacts); cut over; delete TS core.

### P0-6. Incomplete first-class objects (P6)

| Object | Gap |
|--------|-----|
| Approvals | In-memory only; no UI; not restored |
| Traces | Not generated at API/agent entry |
| Tools | Risk map in code; not persisted catalog |
| MCP | Works; calls not fully first-class rows |
| Skills | Files on disk; weak registry metadata |
| Messages | Client-side / partial conversation table |
| Artifacts | Exist, but user delivery also bypasses them via write→`file_ready` (P7) |

### P0-7. Dual user-delivery path: write auto-share vs Artifact API (P7)

**Where:**
- `api-server/routes/chat.js` — on `tool_execution_end`, if `toolName === 'write'` → SSE `file_ready`
- Same file also emits `file_ready` for `submit_artifact`
- Injected system prompt: write files are “automatically made available for download”
- Frontend: `file_ready` → download link (often via **file** path proxy, not artifact id)
- Docs (`docs/api.md`, architecture): document write as auto-download trigger

**Why it fails P7:** Every intermediate `write` becomes a user-facing download. Workspace I/O and user delivery are conflated. Artifact metadata is optional rather than mandatory for sharing.

**Fix:**
1. Remove auto-`file_ready` on `write` / `edit`.  
2. Emit user-delivery events **only** after successful Artifact API submit.  
3. Prefer SSE payload: `{ type: "file_ready", artifact_id, path, name, mime_type, size }`.  
4. Frontend downloads via artifact download URL.  
5. Rewrite system prompt + `submit_artifact` tool description; update skills that mention sharing.  
6. Update `docs/api.md`, `docs/architecture.md`, `docs/webui.md` to drop write-auto-download.  
7. Tests: write alone → no `file_ready` / no artifact row; submit → both.

### P0-8. Tests / CI host-broken

Hardcoded `/sandbox` paths; empty conftest; no Actions. Blocks safe refactors required by P1–P4.

---

## 5. High Priority (P1 product/ops)

| ID | Item | Principles / notes |
|----|------|--------------------|
| H1 | Session reuse across multi-turn until close/TTL | P1 (stop new session every HTTP chat) |
| H2 | Explicit session close + workspace dispose/archive | P1 |
| H3 | Uniform path helper on file/artifact/MCP/exec | P4 |
| H4 | Workspace quota + CPU RLIMIT fully wired | Abuse resistance |
| H5 | SSE `approval_required` + UI decide | P6 approvals |
| H6 | Full `trace_id` browser → agent → sandbox | P6 traces |
| H7 | Conversation UI = view over sessions/messages | Product; still session-centric data model |
| H8 | CORS / rate limit / port exposure hardening | Security |
| H9 | Version & doc alignment (pyproject 0.1.0 vs 4.0.0) | Hygiene |
| H10 | AuthN/AuthZ + ownership (user_id on session) | Multi-user (after P1–P4 solid) |
| H11 | Optional “Deliverables” panel from artifact list API | P7 product UX |
| H12 | Soft agent reminder if model claims a file is ready without submit | P7 quality (optional) |

---

## 6. Medium / later (P2)

- Structured logs + OpenTelemetry  
- TypeScript frontend only (UI), not agent core  
- Rich StepCards / markdown / artifact preview  
- Skill registry versioning  
- Per-user budgets  
- PostgreSQL default in prod  
- Stronger isolation (gVisor / per-session container)  
- Playwright e2e  
- SBOM / image scan  

---

## 7. Phased Delivery Plan

Phases are ordered so **principles land before multi-user scale**.

### Phase 0 — Stabilize agent session, workspace, and runtime correctness

**Goal:** trustworthy single-tenant **multi-session** agent runtime: isolated empty workspaces, stable agent-visible paths, P7 delivery, persistent messages, skill access, MCP path, tests/CI.  
Python agent module **starts** in Phase 0; full cutover may finish in Phase 2.

| # | Work item | Exit criteria | Status |
|---|-----------|---------------|--------|
| 0.1 | Remove global workspace as sole exec cwd | No correctness depends on global mutable symlink alone | ✅ physical-only exec cwd |
| 0.2 | One agent session → one empty workspace | New sessions empty; no seed dirs | ✅ |
| 0.3 | Agent cwd stable `/home/sandbox/workspace` | Agent + bash see fixed path mapped to session WS | ⚠️ agent cwd fixed; exec physical (safe); mount-ns optional |
| 0.4 | Mount skills `/home/sandbox/skill` R/O | All sessions read; none write | ✅ |
| 0.5 | Workspace concurrency isolation tests | §3.3.3 tests pass | ✅ |
| 0.6 | Skill visibility + read-only tests | Skills readable, not writable | ✅ |
| 0.7 | Multi-turn message persistence + replay | Agent uses prior turns | ✅ |
| 0.8 | Start Python agent module migration | Scaffold `sandbox/agent/` | ✅ |
| 0.9 | `pi-coding-agent` Python SDK adapter | Create/continue sessions in Python | ⚠️ scaffold only |
| 0.10 | MCP manager in Python agent module | Discover + call via unified registry | ⚠️ façade; REST MCP works |
| 0.11 | Host pytest + CI | Green on laptop + GitHub Actions | ✅ |
| 0.12 | **P7 artifact-only delivery** | write ≠ download; submit = download | ✅ |
| 0.13 | Tool allowlist includes all custom tools | Model sees `submit_artifact` | ✅ |
| 0.14 | Reuse sandbox session per conversation | Same session across turns when RUNNING | ✅ |
| 0.15 | Workspace quota enforcement | Over-quota writes fail | ✅ |
| 0.16 | Approvals DB persistence | Survive restart | ✅ |
| 0.17 | Trace ID API → sandbox | X-Trace-Id per chat | ✅ |
| 0.18 | Conversation sidebar + server history | UI load/switch/delete | ✅ |
| 0.19 | Deliverables panel | Artifact chips | ✅ |

#### Phase 0.12 checklist — Artifact-only delivery (P7)

| Step | Change | Status |
|------|--------|--------|
| A | Stop auto-`file_ready` on `write` / `edit` | ✅ |
| B | `file_ready` only after `submit_artifact` + `artifact_id` | ✅ |
| C | System prompt: write private; submit to share | ✅ |
| D | `submit_artifact` tool description | ✅ |
| E | Frontend artifact download URL | ✅ |
| F | Docs + skills | ✅ |
| G | **Register tool in createAgentSession allowlist** | ✅ fixed after manual test |
| H | Tests: write-only no download; submit downloads | TBD |

### Phase 1 — First-class session loop (2–3 weeks)

**Goal:** P6 for session/messages/approvals/artifacts/traces on interim agent host; deepen P7 product UX.

| # | Work | Exit criteria |
|---|------|---------------|
| 1.1 | Messages persisted + restored each turn | Multi-turn golden test |
| 1.2 | One agent session per chat thread until close | No workspace thrash per message |
| 1.3 | Approvals DB + SSE + UI | Human gate works e2e |
| 1.4 | Artifacts always under session workspace; **only** user download channel | Download only own session artifacts |
| 1.5 | Trace id from agent entry through audit | `GET /traces/{id}` complete |
| 1.6 | Tool invocation records | Queryable tool history per session |
| 1.7 | Quota + CPU limits enforced | Config bites under test |
| 1.8 | Optional Deliverables panel (`GET .../artifacts`) | User can re-download without re-chat |

### Phase 2 — Python-first agent runtime (2–4 weeks)  **P5**

| # | Work | Exit criteria |
|---|------|---------------|
| 2.1 | Spike: `pi-coding-agent` Python SDK session + tools | Spike doc + demo |
| 2.2 | Python Agent Service: SSE parity with current events | Frontend works unchanged |
| 2.3 | Tools call sandbox with session-scoped roots | P4 preserved |
| 2.4 | Skills load from `/home/sandbox/skill` | Agent discovers skills |
| 2.5 | Cut traffic to Python agent; deprecate TS orchestration | Feature flag → default |
| 2.6 | Remove core agent code from `api-server` | Repo layout matches P5 |

### Phase 3 — Multi-user & production (3–4 weeks)

| # | Work | Exit criteria |
|---|------|---------------|
| 3.1 | Auth (JWT/OIDC) + `user_id` on sessions | Unauthenticated denied |
| 3.2 | AuthZ: session ownership on every surface | IDOR tests fail closed |
| 3.3 | Optional: `users/{id}/sessions/{id}` physical layout | Still agent-visible stable paths |
| 3.4 | PG prod default, backup drills, rate limits | Runbook complete |
| 3.5 | Load test multi-session isolation | Published capacity |

### Phase 4 — Hardening & differentiation (ongoing)

Stronger sandbox runtimes, skill marketplace, admin console, cost controls, etc.

---

## 8. Suggested PR sequence (near-term)

```text
PR-01  test harness: conftest overrides + CI
PR-02  path constants → /home/sandbox/workspace + /home/sandbox/skill
PR-03  empty workspace init (P2); remove seed trees / skills-in-workspace
PR-04  session-owned workspace; kill global symlink race (P1/P3/P4)
PR-05  unify path enforcement on exec/file/artifact/MCP
PR-06  concurrency isolation test matrix (all surfaces)
PR-07  artifact-only user delivery (P7): no file_ready on write; prompt + docs
PR-08  file_ready payload uses artifact_id; frontend artifact download only
PR-09  messages first-class + multi-turn restore (P6)
PR-10  session reuse across turns; explicit close (P1)
PR-11  approvals persist + SSE + UI (P6)
PR-12  trace_id from agent entry (P6)
PR-13  Python agent service spike + SSE parity (P5) — keep P7 in parity matrix
PR-14  cutover + delete TS agent core (P5)
PR-15  authN/Z + ownership
PR-16  prod PG + hardening
```

---

## 9. Testing Strategy (principle-driven)

| Suite | Must prove |
|-------|------------|
| Unit | Path allow/deny; empty init; session lifecycle |
| Isolation matrix | 2+ sessions × {bash, python, node, file, artifact, MCP} |
| **Delivery (P7)** | `write` → file on disk, **zero** artifacts, **zero** `file_ready`; `submit_artifact` → artifact row + `file_ready` with `artifact_id` |
| **Delivery negative** | bash-created file without submit → not downloadable in UI |
| Message restore | Turn N references turn N−1 facts |
| Approval e2e | High-risk blocks until approve |
| Trace e2e | Single id across agent + sandbox audit |
| Migration | Python agent SSE parity vs frozen fixture (including P7 events only) |
| Host CI | No dependency on real `/sandbox` unless docker job |

---

## 10. Security backlog (ordered)

1. Session-scoped isolation (P1/P4)  
2. Stable path + no sibling traversal (P3/P4)  
3. AuthN/AuthZ  
4. Approvals as real control plane  
5. Quota / RLIMIT  
6. Egress (iptables) + runtime network policy  
7. Log redaction  
8. Supply chain / stronger runtimes  

---

## 11. Success criteria

### Principle acceptance tests

| Principle | Pass condition |
|-----------|----------------|
| P1 | Create two sessions → separate empty workspaces; close session A → A’s workspace gone/archived; B intact |
| P2 | Fresh session `list_files` → empty |
| P3 | Agent `pwd` / skill reads resolve under `/home/sandbox/workspace` and `/home/sandbox/skill` only |
| P4 | Every tool surface rejects `../` and foreign session paths |
| P5 | Production path runs agent loop in Python SDK; TS not required for chat |
| P6 | Restart process → session, messages, artifacts, approvals, traces still queryable |
| P7 | Agent writes 3 intermediate files + submits 1 final → UI shows **exactly one** download; artifact list length 1; write paths alone never appear as deliverables |

### Engineering KPIs

| Metric | Target after Phase 0/1 |
|--------|------------------------|
| Host pytest | Green on main |
| Concurrent isolation suite | 100% pass |
| Multi-turn golden | Pass |
| P7 delivery suite | 100% pass (no write auto-share regressions) |
| Unauthenticated chat (Phase 3) | Denied |

---

## 12. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Implementing “stable path” via one global symlink again | Ban in review checklist; concurrency CI gate |
| Conversation UX fighting session lifecycle | UI threads map 1:1 to sessions; archives for history |
| Python SDK maturity / API gaps | Spike early (Phase 2.1); keep thin BFF only if needed |
| Migration dual-running Node+Python | Feature flag; parity tests; short dual-run window |
| Empty workspace surprises users who liked seeds | Docs + optional “starter skill” instead of seed files |
| Scope creep to multi-tenant before P1–P4 | Phase gate: no auth work until isolation suite green |
| Agent forgets to `submit_artifact` after P7 | Strong prompt + tool description; optional soft reminder; skill docs |
| Users expect every written file to download | Product copy: “Deliverables” vs workspace; optional list UI |

---

## 13. Manual test findings (2026-07-09) → actions

| Finding | Root cause | Action |
|---------|------------|--------|
| Agent said `submit_artifact` not in toolset | `createAgentSession({ tools: [...] })` is an **allowlist**; only `read/bash/edit/write` listed | Add `submit_artifact` to allowlist |
| Agent saw `/var/sandbox/workspaces/conv_*` | Exec cwd was physical path; conversation WS path leaked into agent context | Force agent `cwd` to `/home/sandbox/workspace`; re-activate presentation link per exec (interim); mount-ns remains target |
| Prompt claimed write auto-share (old) | Fixed earlier (P7) | Keep prompt + allowlist in sync |

## 14. This week (recommended)

1. Redeploy with tool allowlist + stable cwd fixes; re-test `submit_artifact` manually.  
2. Complete §3.3.3 isolation + skill R/O tests.  
3. Multi-turn message persistence + session reuse (0.7).  
4. Scaffold `sandbox/agent/` + Python SDK spike (0.8–0.10).  
5. Mount-namespace or per-session worker design spike for true concurrent stable paths.

---

## 15. Explicit non-goals (near term)

- Custom agent framework replacing `pi-coding-agent`  
- Pre-populated demo files in every workspace  
- Agent-visible paths that include session IDs  
- Keeping TypeScript as the long-term orchestration home  
- Multi-region active-active before isolation + Python cutover  
- **Auto-sharing every `write` as a user download** (explicitly rejected by P7)  
- **Post-turn full-workspace scans** to invent deliverables (explicitly rejected by P7)  

---

## 16. Appendix — Principle → current code map

| Principle | Primary files to change |
|-----------|-------------------------|
| P1 | `session_manager.py`, `workspace_manager.py`, `routers/sessions.py`, chat/agent entry |
| P2 | `workspace_manager.init_*`, Dockerfile/entrypoint seeds |
| P3 | `config.py`, entrypoint mounts, prompts, frontend docs, all hardcoded `/sandbox/...` |
| P4 | `execution_manager.py`, `file_manager.py`, `artifact_manager.py`, MCP adapters, `path_validation.py` |
| P5 | New Python agent service; deprecate `api-server` agent loop / `sandbox-tools.js` orchestration |
| P6 | `database.py` schema, repositories, approvals, messages, traces, tool invocation logging |
| P7 | `api-server/routes/chat.js` (stop write→`file_ready`), `sandbox-tools.js` (`submit_artifact`), `frontend/src/*` downloads, `sandbox/routers/artifacts.py`, `docs/api.md` / `architecture.md` / `webui.md`, skills that mention file sharing |

---

## 17. Appendix — Current vs target file delivery (P7 detail)

### Today (incorrect dual path)

```
write success  ──► SSE file_ready(path) ──► UI download (file proxy)     ❌ auto-share
submit_artifact ──► Artifact API + SSE file_ready(path) ──► UI download   ✅ but not exclusive
bash creates file ──► (nothing) ──► agent must submit_artifact            ✅ requires explicit
```

### Target (artifact-only)

```
write / edit / bash / python / node  ──► workspace disk only (private)
submit_artifact / POST .../artifacts/submit  ──► artifact row + SSE file_ready(artifact_id, ...)
UI / user  ──► GET .../artifacts/{artifact_id}/download only
```

| Role | Tool / API | User sees download? |
|------|------------|---------------------|
| Create/edit intermediate files | `write`, `edit`, shell, runtimes | No |
| Deliver final / important / requested file | `submit_artifact` → Artifact API | Yes |

---

## 18. Document control

| Field | Value |
|-------|-------|
| Status | Active roadmap (principles-aligned) |
| Principles version | 2026-07-09 + manual-test feedback + expanded Phase 0 |
| Review cadence | Every phase exit; any PR that touches workspace, agent host, tools allowlist, or file delivery |
| Related | `README.md`, `docs/architecture.md`, `docs/api.md`, `AUDIT.md`, `.hermes/plans/*` |

**Rule of thumb for reviewers:** if a change makes workspaces shared, non-empty at birth, path-unstable, isolation-incomplete, TypeScript-centric for orchestration, objects log-only, omits custom tools from the agent allowlist, or **auto-shares workspace writes without Artifact API**—**reject** until it matches §0.
