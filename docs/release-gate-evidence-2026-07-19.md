# Release Gate Evidence (2026-07-19)

This record covers the live gate batches completed on the stated date. It does
not close the full P0 release gate in `docs/refactor-follow-up.md`.

## Environment

- Host date/time zone: 2026-07-19, Asia/Shanghai.
- Docker Engine: `29.4.0`.
- Docker Compose: `v5.1.2`.
- MySQL image: `mysql:8.0`, image ID
  `sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b`.
- MySQL server: `8.0.46`, Linux/aarch64.
- Redis image: `redis:7.2`, image ID
  `sha256:f0707c78ea880b293ccdeb410c9c0a8ccae93fe7128799b751333a698b0a39a7`.
- Redis server: `7.2.14`, Linux/aarch64.
- BullMQ package: `5.80.7` (installed runtime version).
- Development Compose services at the beginning and end of the gate:
  Agent, Agent Worker, API Server, Frontend, MySQL, Agent Redis, Sandbox, and
  Sandbox replay Redis were running. Services with health checks were healthy.

Credentials were read from the running development containers into shell
variables and were not written to this file or test output.

## MySQL Gate

The test used the dedicated schema `pi_gate_20260719_release1`. It did not use
the development `sandbox` schema. The application MySQL user was granted access
only to this additional schema for the test.

Command shape (credentials redacted):

```sh
docker exec pi-enterprise-mysql mysql -uroot "-p${ROOT_PASSWORD}" -e \
  "DROP DATABASE IF EXISTS pi_gate_20260719_release1;
   CREATE DATABASE pi_gate_20260719_release1
     CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
   GRANT ALL PRIVILEGES ON pi_gate_20260719_release1.* TO '${MYSQL_USER}'@'%';"

TEST_MYSQL_URL='mysql://<user>:<redacted>@127.0.0.1:3306/pi_gate_20260719_release1' \
  npm run test:mysql:integration
```

Result: **PASS, 6/6 tests, 0 skipped**.

Verified against the real MySQL server:

- empty-schema `migrateLatest` creates every declared core table, InnoDB with
  `utf8mb4`, message append-only triggers, and Sandbox execution-domain tables;
- `migrateRollbackAll` removes the application schema and triggers, followed by
  a successful `migrateLatest` re-apply;
- an orphan membership insert fails with a real foreign-key error;
- direct message `UPDATE` and `DELETE` fail through the real append-only
  triggers;
- 32 concurrent `RunEventRepository.append` calls produce exactly the unique,
  contiguous sequence `1..32` and leave `runs.next_event_sequence = 32`.

The test's final cleanup ran `migrateRollbackAll`. A post-check found only the
two Knex migration metadata tables in the gate schema. The development
`sandbox` schema remained present with 28 base tables; no gate command pointed
rollback or truncate at that schema.

## Redis Coordination Gate

An initial run against the development Redis was deliberately not accepted as
evidence. It produced 3 passes and 1 failure because the online Agent Worker
consumed the fixed `agent-runs` BullMQ test Job, leaving it locked during test
cleanup. This demonstrates that a shared live queue is not an isolated test
environment; it is not a Redis product failure.

The accepted run used a dedicated container and named AOF volume:

```sh
docker volume create pi_release_gate_redis_20260719
docker run -d \
  --name pi-release-gate-redis-20260719 \
  --restart=no \
  -p 127.0.0.1:6389:6379 \
  -v pi_release_gate_redis_20260719:/data \
  -e REDIS_PASSWORD='<redacted>' \
  redis:7.2 redis-server \
  --appendonly yes --appendfsync everysec --requirepass '<redacted>'

TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:6389/0' \
  npm run test:redis:integration
```

Result: **PASS, 6/6 tests, 0 skipped**.

Verified against the real Redis server:

- lease acquire, renew, wrong-owner release rejection, and owner release;
- lease expiry followed by acquisition by a recovery worker;
- Session Lock acquire, renew, and token-safe release;
- Run Stream append/range and Cancel Signal lifecycle;
- BullMQ reference-only Job enqueue and cleanup on an isolated queue server.

## Redis Restart, Outbox Retry, and SSE Fallback Gate

The destructive test has three safety conditions: explicit
`RUN_REDIS_RESTART_GATE=1`, a container matching
`pi-release-gate-redis-*`, and a MySQL database starting with `pi_gate_`.

Command shape (credentials redacted):

```sh
RUN_REDIS_RESTART_GATE=1 \
TEST_REDIS_CONTAINER=pi-release-gate-redis-20260719 \
TEST_MYSQL_URL='mysql://<user>:<redacted>@127.0.0.1:3306/pi_gate_20260719_release1' \
TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:6389/0' \
  node --test tests/redis/redis-restart.release-gate.test.js
```

Result: **PASS, 4/4 tests, 0 skipped**.

While extending the gate, one earlier 3/4 run failed in test setup because the
test attempted to load `ExternalReferenceRepository` from a barrel that does
not export it. The test was corrected to import the repository's formal module;
that failed attempt did not reach the Redis-stop or SSE assertions.

Verified against real Docker, Redis, and MySQL:

- a Run Stream entry was AOF-fsynced with `WAITAOF 1 0 5000`, the Redis
  container was restarted, the existing client recovered, and the entry was
  still readable;
- the Redis container was fully stopped (`State.Running=false`) before an
  Outbox publish attempt;
- the failed Redis append returned the real MySQL row to `PENDING`, incremented
  `attempts` to 1, and stored a retry time and sanitized error;
- after Redis restarted, the next publish changed the row to `PUBLISHED`,
  incremented attempts to 2, and delivered exactly one matching stream event.
- an SSE subscription used the real owner-resolving `RunEventQueryService`,
  real MySQL `runs`/`run_events`, and the real Redis Stream client; after live
  cutover, Redis was stopped, a terminal event was committed only to MySQL, and
  the same subscription switched to `mysql-poll-fallback`, emitted sequences 1
  and 2 exactly once, and emitted its terminal `end` frame.

The pre-existing live Outbox integration was also run against these isolated
resources:

```sh
TEST_MYSQL_URL='mysql://<user>:<redacted>@127.0.0.1:3306/pi_gate_20260719_release1' \
TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:6389/0' \
  node --test tests/outbox/outbox.integration.test.js
```

Result: **PASS, 3/3 tests, 0 skipped**. This independently verified real MySQL
`FOR UPDATE SKIP LOCKED`, a stable event append to the real Redis Stream, and
claim-token rejection for an incorrect publisher token.

Running the destructive test without its opt-in variables also passed its
safety test and skipped the destructive suite without touching Docker.

## BullMQ Worker Process Restart Gate

This gate used the project's real `createRunQueue`, `enqueueRunJob`, and
`createRunWorker` factories, a dedicated Redis container, and two independent
Node child processes. It did not use a mocked Worker, Redis fake, or in-process
processor replacement.

The test retained BullMQ's installed production defaults:

- `lockDuration = 30000` ms;
- `stalledInterval = 30000` ms;
- `maxStalledCount = 1`.

Command shape (credential redacted):

```sh
RUN_BULLMQ_WORKER_RESTART_GATE=1 \
TEST_REDIS_CONTAINER=pi-release-gate-redis-20260719 \
TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:6389/0' \
  node --test tests/redis/bullmq-worker-restart.release-gate.test.js
```

Result: **PASS, 2/2 tests, 0 skipped**, duration `60.635s`.

Verified against real processes and Redis:

- Worker A acquired the reference-only Job and entered its processor with
  `attemptsStarted = 1`;
- Worker A was terminated with `SIGKILL`, so it could not gracefully close or
  return the Job;
- a separately spawned Worker B reported BullMQ's `stalled` event with the
  previous state `active` and re-entered the same Job processor;
- the recovered Job kept the same deterministic `jobId` and exact
  `{ runId, orgId, traceId }` payload;
- the recovered Job had `attemptsStarted >= 2` and `stalledCounter >= 1`, then
  reached `completed` with Worker B's process ID in its persisted return value.

An earlier run reached stalled recovery and Worker B execution but failed a
test assertion because the parent read the Job immediately before BullMQ's
`completed` event made `returnvalue` observable. The gate was corrected to wait
for that real event before reading the persisted Job; no production code or
BullMQ timing was changed.

This proves BullMQ lock-loss/stalled-Job recovery. It does not by itself prove
the full Agent `ExecuteRunService` plus Pi model/tool execution recovery path.

## Agent Worker Checkpoint-Aware Restart Gate

The Agent restart gate now covers both recovery branches with the real
`createServiceContainer`, MySQL repositories, BullMQ queue, Redis lease, and
two independent Worker child processes. The executor fixture is intentionally
limited to a durable side-effect probe; it is not a real Pi model provider.

Command shape (credentials redacted):

```sh
RUN_AGENT_WORKER_RESTART_GATE=1 \
TEST_REDIS_CONTAINER=pi-release-gate-redis-20260719-worker \
TEST_MYSQL_URL='mysql://<user>:<redacted>@127.0.0.1:33316/pi_gate_20260719_worker' \
TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:36382/0' \
  node --test tests/redis/agent-worker-restart.release-gate.test.js
```

Result: **PASS, 3/3 tests, 0 skipped**, duration `76.2s`.

Verified against isolated Docker Redis `redis:7.2` and a dedicated MySQL
`pi_gate_*` schema:

- Safe branch: Worker A was killed before any tool ledger row or side effect;
  after the lease expired, Worker B recovered `RUNNING → RETRYING → QUEUED`,
  BullMQ redelivered the deterministic job, and Worker B completed `SUCCEEDED`.
  Exactly one `run.retrying` event/outbox row was written and the side effect
  was invoked once by Worker B.
- Manual branch: Worker A persisted a durable `RUNNING` tool execution, wrote
  one side effect, and was killed. Worker B's recovery scan emitted
  `needsReconciliation` with `manual recovery required`; the Run remained
  `RUNNING`, no retry event was written, and Worker B did not invoke the
  executor. The side-effect count remained one.
- The recovery implementation also refuses re-prompt when the durable session
  checkpoint already references the current Run; this boundary is covered by
  focused unit tests.

This is evidence for Agent Worker lease-loss/recovery classification, not proof
of a real Pi model/provider or live Sandbox process restart. Those still need a
separate release gate.

## Real Pi Model/Tool and Sandbox Restart Gate

The real-Pi restart gate used the production `createServiceContainer`, an
independent Agent Worker process, the guarded OpenAI-compatible test provider,
real MySQL and Redis, and a live Sandbox HTTP process. The provider exercised
the Pi model boundary; it was not a repository or executor mock.

Command shape (credentials and ephemeral ports redacted):

```sh
RUN_AGENT_PI_RESTART_GATE=1 \
TEST_MYSQL_URL='mysql://<user>:<redacted>@127.0.0.1:<port>/pi_gate_*' \
TEST_SANDBOX_MYSQL_URL='mysql+pymysql://<user>:<redacted>@127.0.0.1:<port>/pi_gate_*' \
TEST_REDIS_URL='redis://:<redacted>@127.0.0.1:<port>/0' \
  node --test tests/redis/agent-worker-pi-restart.release-gate.test.js
```

Result: **PASS, 4/4 tests, 0 skipped**.

The gate verified:

- Worker A terminated during a real Pi model turn was recovered by Worker B;
  the model turn completed once, no duplicate tool ledger row was created, and
  the Run reached `SUCCEEDED`;
- a durable tool-dispatch boundary terminated before the outcome was known was
  classified as `needsReconciliation`; no second Sandbox execution or retry
  was issued;
- a Sandbox Docker restart during an in-flight execution produced
  `TOOL_OUTCOME_UNKNOWN` at the Agent boundary, without a second execution or
  automatic retry;
- opt-in and dedicated-resource safety guards passed before the destructive
  cases ran.

This does not prove hard `SIGKILL` orphan recovery inside a production
Bubblewrap Sandbox. That remains an explicit open gate rather than an inferred
result from the graceful Docker restart case.

## Cross-Service Concurrency and SSE Gate

The project smoke harness was run with two dedicated Redis containers (Agent
and Sandbox replay, both using database index `0`) and a dedicated `pi_gate_*`
MySQL schema. It started the real BFF, Agent HTTP process, Agent Worker,
Sandbox process, and deterministic OpenAI-compatible provider.

```sh
SMOKE_CONCURRENT_RUNS=50 \
SMOKE_SSE_CLIENTS=100 \
SMOKE_PROVIDER_DELAY_MS=1500 \
  node scripts/smoke-cross-service.mjs
```

Result: **PASS**. All 50 Runs reached `SUCCEEDED`; 100 real SSE clients each
received sequenced events (1,100 frames in total) with monotonic sequence
ordering, and the services shut down cleanly. An initial attempt used replay
Redis database `1` and was rejected by Sandbox's fail-closed
configuration check; the accepted run used separate Redis instances, so this
isolation evidence does not rely on Redis database indexes.

## Sandbox Isolation and Dataset Gate

The managed Sandbox gate used a fresh non-privileged Docker container with the
Bubblewrap isolation backend, a dedicated MySQL schema, and separate replay
Redis. It exercised two tenants and two sessions, owner-bound process and
Artifact access, 20 concurrent Sandbox executions, and a 5 GiB streamed
Dataset upload.

```sh
SANDBOX_GATE_MYSQL_URL='mysql://<user>:<redacted>@127.0.0.1:<port>/pi_gate_*' \
SANDBOX_GATE_MANAGED_CONTAINER=1 \
SANDBOX_GATE_DOCKER_NETWORK='<isolated-backend-network>' \
SANDBOX_GATE_DOCKER_INGRESS_NETWORK='<isolated-ingress-network>' \
SANDBOX_GATE_DATASET_BYTES=5368709120 \
  node scripts/release-gates/sandbox-live-gate.mjs
```

Result: **PASS**.

- cross-tenant execution, cross-session process reads, and cross-owner
  Artifact downloads were all rejected with HTTP `404`;
- 20 Bash executions overlapped with a measured factor of `16.32x`;
- the 5,368,709,120-byte upload completed with a Sandbox RSS delta of `0 KiB`
  against the `131072 KiB` bound;
- the Dataset was read by Python, a long process updated the result, and the
  explicit Artifact download SHA-256 matched the persisted metadata.

The reusable gate implementation is
`scripts/release-gates/sandbox-live-gate.mjs`; it requires a dedicated
`pi_gate_*`/`sandbox_gate_*` schema and rolls that schema back in `finally`.

## BFF Dataset/Artifact End-to-End Gate

The cross-service smoke harness was also run with `SMOKE_ARTIFACT_GATE=1`.
Through the public BFF routes it uploaded a Dataset, executed the Run through
Pi Python and `submit_artifact`, refreshed Dataset/Artifact state, and fetched
the resulting bytes. The downloaded report contained the Dataset-derived
row count and source filename, and the Run completed successfully.

Result: **PASS** on dedicated MySQL and separate Agent/Replay Redis instances.

## A2A Invoke, Streaming, Reconnect, Cancel, Audit, and Artifact Gate

The live A2A gate used the real Agent HTTP process, an independent Agent Worker,
the Pi runtime with the guarded scripted OpenAI-compatible test provider, real
MySQL and Redis, and the current Sandbox image. The test provider did not write
the Artifact or mutate the tool ledger: it proposed `write`, then
`submit_artifact`, and Pi dispatched both through the production tool and
Sandbox transports.

Credentials were issued through the admin HTTP surface. Each credential
created a distinct service user and active organization membership; only the
credential hash was persisted. Bearer values and short-lived download tokens
are intentionally omitted from this record.

Protocol results:

- the credential-routed Agent Card and Agent-specific endpoint were callable;
- `SendMessage` created a durable A2A Task mapped to an internal Run;
- `SendStreamingMessage` returned HTTP 200 with
  `text/event-stream; charset=utf-8` and JSON-RPC response frames;
- `SubscribeToTask` replayed the terminal Run after disconnect. A reconnect
  from sequence 2 emitted the persisted Run sequences `3`, `4`, and `11` in
  order, without canceling or duplicating the Run;
- `CancelTask` produced a durable `CANCELLED` Run and a matching A2A canceled
  projection;
- MySQL retained correlated `a2a.send_message`, `a2a.subscribe_task`,
  `a2a.stream_end`, `a2a.cancel_task`, `a2a.get_task`, and
  `a2a.artifact_download` audit rows with client, Task, Run, Artifact, and
  trace identifiers.

The public Artifact delivery used a fresh, legitimate Run rather than a
manually inserted terminal-Run tool row:

```text
A2A Task:  PEZDW6SPPK0P5NSYCK0BXHVDD5
Run:       01KXVK4PVQXG1HF1XZ190B7MV7 (SUCCEEDED)
Artifact:  01KXVK4Q6P5HZBD46Q2TXQFEQH
Client:    live-artifact-retry-20260719
Trace:     1234567890abcdef1234567890abcdef
```

The durable tool ledger contained exactly the successful `write` and
`submit_artifact` calls used by this Run. `GetTask` returned one File Part with
a short-lived URI bound to the caller organization, client, Task, and Artifact.
Downloading that URI with the issuing credential returned:

```text
HTTP status:       200
Content-Length:    21
X-Artifact-Id:     01KXVK4Q6P5HZBD46Q2TXQFEQH
X-Artifact-Sha256: 1c98126fa58fbc9b91d3fa075dbb573dc148f151c15d08cfd611d79018717371
Actual SHA-256:    1c98126fa58fbc9b91d3fa075dbb573dc148f151c15d08cfd611d79018717371
Body:              A2A_ARTIFACT_BYTES_OK
```

The same URI with another active `artifact.read` credential in the same
organization but a different `client_id` returned HTTP 403
`Download token ownership mismatch`. The URI without a credential returned
HTTP 401. The successful request persisted `a2a.artifact_download` with trace
`fedcba9876543210fedcba9876543210`; the rejected cross-client request did not
produce a false successful-download audit. This verifies the public
caller-bound A2A delivery path in addition to the separately verified
Agent-to-Sandbox internal byte transport; an internal Sandbox 200 alone was
not accepted as this gate.

## Remaining Scope

This batch does not verify:

- hard `SIGKILL` orphan recovery inside the production Bubblewrap Sandbox;
- 50 concurrent real Sandbox executions (the plan's 20-execution gate is
  covered above);
- a full distributed OpenTelemetry trace backend and its production export
  path; the frontend currently renders the durable span projection;
- live ACL denial, MySQL failure injection, and other deferred operational
  hardening items listed in `docs/review-deferred-items.md`.

After evidence capture, the dedicated Redis container and named volume were
deleted. The gate schema was dropped and its schema-scoped grant was revoked.
A post-check showed that the application MySQL user retained only its original
`sandbox.*` privileges.
