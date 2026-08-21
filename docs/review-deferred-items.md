# Review deferred items

Non-severe / non-blocking items only. **Do not** park unresolved severe
vulnerabilities or unfinished PR-07 security work here.

**Acceptance blockers** belong only in [`STATUS.md`](./STATUS.md) (mapped to
[`plan.md`](./plan.md) §32). This file must not be used as a substitute progress board.

## Deferred

Non-blocking follow-ups. Each row states what exists today, what the residual
risk is, and what decision would close it — so a reader can act without
re-deriving the context.

**Last audited:** `bd66cd6f` (2026-08-21) — every row below was re-checked
against the tree. Rows whose only remaining proof needs a live deployment are
marked **(live gate)**; they cannot be closed from code and were left as-is.

Closure evidence from the 2026-07-31 refactor moved to
[`archive/reviews/2026-07-31-refactor-closures.md`](./archive/reviews/2026-07-31-refactor-closures.md).

| Item | Evidence | Risk | Benefit | Decision needed |
| --- | --- | --- | --- | --- |
| Child quota residual inter-sample race **(live gate)** | Bounded monitor only; hard isolation is operator-asserted volume/project quota (`HARD_BACKEND_ASSERTED`) | Residual until live gate sets hard backend | True hard multi-tenant disk | Provision XFS/project/volume quota then set HARD_BACKEND_ASSERTED |
| Bubblewrap `--unshare-cgroup` | plan §16.4 lists it; current prepare/preflight omit it | Low until cgroup escape is shown in this container profile; unverified flag can break launch | Stronger cgroup isolation when runtime guarantees support | Confirm host/container `bwrap` + cgroup ns policy, then enable with preflight |
| Historical naming (`workspace_path` DB column) | Dual field after lease/symlink removal | None for security | Cleaner schema naming | Hygiene PR only |
| Dev `auth_enabled=false` offline create | Local suites create sessions without HMAC proof | None if production always has auth on | Hermetic tests without Agent provisioner | Never ship compose/prod with auth off |
| Claim capability probe scope | Probe checks PR-07B claim columns + two uniques only (not every Agent table) | Low if migrations applied in order | Faster startup | Expand probe if claim path gains more required indexes |
| Redis ACL for replay keyspace only | Compose uses shared password; docs recommend minimal authority | Low until multi-tenant Redis sharing | Least privilege | Ops ACL: `sandbox:internal:replay:v1:*` only |
| Live Redis/MySQL readiness soak **(live gate)** | Offline suite injects fakes; no live ping gate in CI here | None for offline | Production confidence | Staging connectivity checklist before cutover |
| Redis ACL on shared process | Compose uses **dedicated** sandbox-replay-redis; ACL user on shared Redis not wired | Low with dedicated service | Multi-tenant hardening | Optional ACL file if consolidating instances |
| Live ACL command denial **(live gate)** | Offline asserts policy document only | None offline | Confirm SET-only user rejects GET/SELECT | Final gate on real Redis |
| Per-child controlled egress proxy | Production rejects `allowlist`; no netns+proxy path yet | None while production is `disabled` only | Safe package installs / selective egress without container-wide firewall | Design + implement proxy; then re-enable production allowlist |
| Dev allowlist/unrestricted peer reachability | Dev modes share container net on `backend_internal`; children can reach peer service IPs | Dev-only | Convenience for local tooling | Keep prod disabled; optional stricter dev unshare |
| Remove legacy iptables env from local `.env` | Operators may still have `SANDBOX_IPTABLES_*` / `SANDBOX_ALLOWED_CIDRS` in private `.env` (ignored) | None | Cleaner operator env | Manual cleanup; not committed |
| README/deployment long-form network runbook | Core tables updated; deeper diagrams may lag | Low | Operator education | Follow-up docs PR |
| Live MySQL dual-write for process_executions **(live gate)** | ProcessManager dual-writes via injected formal port; offline uses FakeFormalProcessRepository | Medium until staging MySQL plane proves create/update under owner scope | Full multi-tenant process ledger in shared MySQL | Staging gate with real MySQL + sandbox plane enabled |
| Process stream logs on durable disk (not only memory + snapshot columns) | Cursor reads use StreamLogBuffer + DB snapshot/chunk fallback; no separate rotating files yet | Low while log caps are enforced | Cheaper huge-output retention | Optional stdout_path/stderr_path file sinks under session temp |
| Cross-container process reclaim | Restart recovery marks LOST and identity-kills only when pid+start_identity still match on **this** host | None if Sandbox is single-instance; multi-host needs no reclaim of foreign PIDs | Honest LOST without false control | Keep fail-closed; do not invent attach across hosts |
| macOS start_identity strength | Uses `ps -o lstart` when `/proc` absent; weaker than Linux starttime jiffies | Dev-only PID reuse race | Stronger identity on Linux prod | Acceptable; prod Linux uses `/proc` |
| process_start HTTP still shell-wrapped | Managed process argv is `bash -c command` under isolation (same as bash tool) | Medium for untrusted command strings | Eventual argv-array process_start | Policy already hard-denies; optional later argv mode |
| Dataset multipart chunked/resume API | plan §17.1 optional multi-part (`dataset-uploads` + parts); PR-09 ships single-stream only | Low for phase-1 | Resumable multi-GB uploads | Product decision; stream path already no full-buffer |
| Optional virus scan on Dataset ready | plan §17.4 optional | Low until scanner available | Malware gate before agent read | Ops integration |
| BFF conversation ownership gate before dataset proxy | Proxy requires session_id + conversation_id; full conversation owner ACL is PR-10 | Low while sandbox session ownership holds | End-to-end conversation ACL | PR-10 only |
| Content-Disposition non-ASCII filename* clients | Server emits RFC 5987 `filename*` + CRLF strip | Low | Better CJK download names | Browser matrix only |
| Multi-host quota without shared control volume | Control-plane `control_root/quota` + fcntl covers multi-worker same host | Low while single-instance/shared control volume | Cross-host quota | Topology decision |
| Live MySQL + control volume mount gate **(live gate)** | Offline: FakeFormal + immutable artifacts_root snapshots + restart recovery; compose mounts `SANDBOX_ARTIFACTS_ROOT` / `SANDBOX_CONTROL_ROOT` (never bwrap-bound) | None for offline suite | Connectivity + mounts present | Staging: MySQL ping + verify artifacts/control volumes exist and are not workspace binds |
| cgroup memory/cpu (vs RLIMIT_AS/CPU only) | PR-07 hard limits use setrlimit in child preexec; no memory.high / cpu.max cgroup v2 | Medium for hostile multi-tenant share of host | Stronger isolation under nested abuse | Optional cgroup path after bubblewrap `--unshare-cgroup` decision |
| RLIMIT_NPROC accounting under shared container UID | NPROC counts all processes for the sandbox UID (not per-session); tighten-only apply avoids host-test fork death | Low with per-session managed caps | True per-session PID budget | User-ns + separate UID map or cgroup pids controller |
| Live Linux container gate for FSIZE/NOFILE SIGXFSZ **(live gate)** | Offline suite asserts inheritance + best-effort over-limit; macOS may differ on signal delivery | None offline | Confirm SIGXFSZ/EFBIG under prod image | Staging smoke: write > max_file_size_mb and open > max_open_files |
| Cancel full idempotency_records response replay | Create path stores full response; cancel is first-writer durable intent + key required, not full stored response replay | Low (intent is durable) | Perfect cancel key replay across BFF retries | Optional: store cancel response JSON under operation `cancel_run` |
| BFF direct Redis stream (no Agent hop) | PR-10 keeps Agent as SSE authority; BFF byte-proxies | Low latency extra hop | One fewer hop for live tail | Topology decision; would require BFF Redis + owner ACL parity |
| SSE `event:` named types vs legacy nested `data.event.type` | PR-11 normalizes platform envelopes + BFF relay; dual-path still supports Agent legacy types | Low | Drop legacy Agent adapter once Agent only emits platform envelopes | Follow-up when Agent wire is platform-only |
| Live Redis XREAD BLOCK | Offline uses non-blocking `readAfter` + poll; no dedicated blocking connection | Low (pollMs ~400) | Lower live latency under sparse events | Optional: duplex Redis client + abort on disconnect |
| Agent HTTP factory injects eventSseService in all unit fakes | Factory falls back to MySQL poll path when SSE service omitted | None offline | Uniform production path in all harnesses | Test hygiene only |
| Virtualized timeline for 10k+ tool cards | Activity drawer maps full run tool/process lists; process logs capped at 256KiB/stream | Low for typical runs | Avoid DOM growth on extreme runs | Optional windowing if field shows large timelines |
| Trace panel span tree completeness | Spans projected from tool/model/artifact events only; no OpenTelemetry backend yet | Low | Full distributed trace UI | Wire when observability exports span trees |
| Dataset delete/replace controls | Panel is read-only status + path; upload still via composer/attachments | Low | Full §19.7 ops | Product UX when DELETE dataset API is productized |
| Approval decision reason input field | Approve/Reject buttons only; no free-text reason box in card | Low | Auditability of deny reasons | Optional form control |
| A2A blocking SendMessage (return_immediately=false) | Always non-blocking create + optional stream | Low | Spec default blocking mode | Optional wait-for-terminal path |
| Live Redis XREAD BLOCK on A2A stream | Same as BFF SSE: poll + readAfter | Low | Lower latency | Share duplex Redis client work |
| GetTask artifact scan safety ceiling | Hard fail over 10k events / 500 artifacts (no silent truncate) | Low for typical runs | Streaming artifact index | Raise limits or dedicated index table |
| HTTP `POST .../artifacts/register` alias | Already calls `submit`; name is legacy | None | Single URL | Optional alias drop after clients all use `/submit` |
| Offline concurrent CreateRun without real InnoDB locks **(live gate)** | Fake knex serializes txn in PR-14 load tests; true multi-writer CAS races need live MySQL | None offline | Prove idempotency under real row locks | Live gate: concurrent CreateRun same key on MySQL |
| ru_maxrss constant-memory proof for multi-MiB stream **(live gate)** | Platform units differ (Linux KB vs macOS bytes); peak RSS noisy under GC | None (chunk-size instrumentation is authoritative offline) | OS-level RSS soak | Live gate optional; offline uses max `os.read`/`os.write` ≤ chunk |
| 50 concurrent real Sandbox executions / 20 concurrent process starts **(live gate)** | The plan's required 20-execution gate passed live; this stricter 50-Sandbox capacity target remains unverified | Medium for higher load | Capacity plan validation | Staging load with 50 real Sandbox executions |
| Live Redis failure while SSE connected (kill redis mid-stream) **(live gate)** | Offline injects `readAfter` throw → MySQL poll fallback | Low offline | Ops confidence | Staging: stop Redis, assert SSE continues from MySQL |
| Live MySQL failure fail-closed on CreateRun (connection refused) **(live gate)** | Offline fake txn fail + queue fail | Low offline | Production error codes | Staging kill MySQL mid-create; assert no partial commits |
| Agent HTTP listen smoke under sandbox EPERM **(live gate)** | `listen-smoke` may EPERM in restricted environments | None for logic | Local bind proof | Final approval: run listen/smoke outside sandbox |
| Migration 00006 (+ other ALTER-only ups) lack this-run partial DDL tracker | Core/00003/00009 use `withPartialDdlCleanup`; 00006 does `alterTable` then raw `CREATE TRIGGER` without tracker | Low after binlog preflight; mid-up failure can leave additive column without migration row | Symmetric cleanup for ALTER + trigger ups | Optional tracker for non-createTable DDL + orphan sentinels |
| migrateLatest preflight runs before knex migration lock | Orphan + trigger gates then `migrate.latest` (lock inside knex) | Low (lock serializes DDL; rare concurrent dual migrator) | Single locked preflight+DDL critical section | Only if multi-owner migrate races appear in ops |
| LeaseBusy/NeedsReconciliation `delayMs` unused by BullMQ worker | Errors thrown; `createRunWorker` relies on recovery re-enqueue + jobId=runId removeCompleted/Failed | None (job not completed; recovery path works) | Explicit delayed retry without recovery lag | Optional map `delayMs` to BullMQ `Worker` delayed failure |
| Shared MySQL coincidental core table names trip orphan gate | Gate assumes dedicated agent schema | Low if shared multi-app DB | Namespaced tables or schema | Ops: dedicated database per service |
| A2A push notification configs | Agent Card advertises `pushNotifications: false`; `task-request.js` rejects a supplied `pushNotificationConfig` | Low | Webhook delivery without a held stream | Product decision; `ListTasks` shipped 2026-08-04 (`192a2520`) |
| Background processes not reaped on Run/session end | Sandbox `ProcessManager.cancel_for_session()` exists (process_manager.py:1781) but has **zero callers** — no router, session-close path, or Agent run-end hook invokes it; workspace removal (`remove_workspace`) deletes files only. A background process from `process_start` outlives its Run until sandbox restart recovery marks it LOST/orphaned | Medium for long-lived sandboxes (resource leak + quota pressure) | Deterministic per-Run/process cleanup contract | Wire `cancel_for_session` into session close/remove_owned, or add an explicit run-end reap call from the Agent sandbox transport; document the chosen owner |
