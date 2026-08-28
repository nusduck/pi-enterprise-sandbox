# 2026-08-26 — Live chain after the review-fix change set

AGENTS.md §4 requires a container rebuild and a real-chain run whenever the
change set touches a run path or deletes production code. This one does both,
so the whole chain below was driven against freshly built images.

Environment: local Compose, `DEPLOYMENT_ENV=development`, `AUTH_ENABLED=true`,
Sandbox isolation `bubblewrap` with `isolation_required=true` and preflight
passed. **Not a production-isolation acceptance** — see `review-deferred-items.md`.

```
docker compose build agent api-server sandbox   # all three rebuilt
docker compose up -d                            # data volumes untouched
```

Two throwaway accounts were registered for the run (`verify0826a`,
`verify0826b`); no credentials appear in this file.

## Readiness

`GET /health/ready` → `status: ok`, Agent `authority: mysql`, Sandbox
`workspace_available: true`, runtimes python/bash/node all true,
`isolation_backend: bubblewrap`, `isolation_preflight_passed: true`.

This is also the first exercise of the two `checkHealth` probes this change set
bounded — both answer inside the new deadline.

## Chain

| Step | Result |
|------|--------|
| Register + `GET /api/auth/me` | 200, session cookie established |
| `POST /api/sessions/ensure` | conversation `01M0Z5JAR7D93VHPF2YASGB9GM`, sandbox session `01M0Z5JARAB8TZPYVSDK4F4M4W` |
| Tool-using Run (`bash` → `echo LIVE_VERIFY_OK`) | `SUCCEEDED`; assistant text is exactly `LIVE_VERIFY_OK` |
| `POST /api/files/upload` | 201, `uploads/att_…/upload.txt`, 30 bytes |
| `GET /api/files/download` | 200, `Content-Disposition: attachment; filename="upload.txt"`, bytes match |
| Managed process: `status` / `read` / `signal` / `cancel` | see below |
| Cross-tenant reads as the second account | 404 on run, conversation, file download, process logs — never 403 |

## R1: the A2A terminal-event root cause, confirmed on a real journal

The successful Run's durable journal (56 events) contains:

```
run.accepted  run.queued  run.started  run.status.changed  run.completed
```

and **zero** `run.succeeded` — the name the A2A projector used to look for.
`plan.md`'s event vocabulary lists the same five names the services actually
emit. Terminal payloads carry the status durably, e.g.

```json
{"type":"run.completed","payload":{"from":"RUNNING","to":"SUCCEEDED","status":"SUCCEEDED"}}
```

Replaying that journal through the fixed projector yields the official
task-lifecycle stream, ending on a terminal frame:

```
seq  1  run.accepted      → status-update submitted  final=false
seq  3  run.started       → status-update working    final=false
seq 54  message.completed → status-update working    final=false  "LIVE_VERIFY_OK"
seq 56  run.completed     → status-update completed  final=true
```

Before the fix the last two lines did not exist: `run.completed` was not in the
projector's vocabulary, and `message.completed` did not project either, because
production writes it as `{ context, data: { role, message, messageId } }` while
the projector only read the flat shape. That second defect was invisible to the
unit suite — its fixtures happened to use the flat shape — and only surfaced
here, against a real journal. Both shapes are now read, and both are pinned in
`agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js`.

**Not covered here:** the A2A HTTP surface itself. Driving `message/stream`
end-to-end needs an admin-minted A2A credential, which this run did not have.
What is proven is the projection — the layer the defect was in — against the
exact envelopes a live Run produces.

## Managed process control (review item R2)

Started a process that was still running when the operator surface was driven
(`for i in $(seq 1 200); do echo TICK-$i; sleep 1; done`):

| Call | Result |
|------|--------|
| `GET /api/processes/{id}` | `running`, pid 123, `exit_code: null` |
| `GET …/read?stream=stdout` | incremental cursor `0-0` → `0-199`, TICK-1…TICK-26, `completed: false` |
| `POST …/signal {"signal":"SIGTERM"}` | `{signaled: true, signal: 15}` — but the process kept running |
| `POST …/kill` | same TERM branch, same outcome |
| `POST …/cancel` | `{cancelled: true}` → converged: `cancelled`, exit 137, `finished_at` set, `read` reports `completed: true`, 182 ticks captured |

So the active-termination branch the 2026-08-26 scenario report could not
exercise **does work** — via `cancel`. `kill` is an alias of `signal` that
defaults to SIGTERM (`api-server/src/routes/processes.js:99`), so a program that
defers TERM survives it; that naming is recorded in `review-deferred-items.md`
rather than changed here, since renaming it is a behaviour change.

The process-logs and process-read calls above are also the live exercise of the
agent-side Sandbox public plane this change set gave a default deadline to.

## Offline suites on the same tree

```
uv run pytest -q                 1137 passed, 6 skipped
npm test --prefix agent          1556 passed
npm test --prefix api-server      143 passed
npm test --prefix frontend         319 passed   + tsc --noEmit clean
```

The agent suite reports 6 failures whenever `~/.pi/agent/mcp.json` exists on the
host — the environment trap AGENTS.md §4 documents. Confirmed by moving that
file aside and re-running: 1556/1556.
