# pi-enterprise-sandbox Helm chart

Deploys the four services to Kubernetes with multiple replicas each.

## The one thing to understand first

**The Sandbox is sharded, not load balanced.**

A workspace is a directory on one replica's local volume. A managed process
(`process_start`) is a `Popen` handle in one replica's memory. Neither is
reachable from anywhere else — no shared volume fixes this, because the process
table was never on disk.

So the Sandbox runs as a **StatefulSet** with per-pod storage and stable
identity, `sandbox_sessions.node_id` binds each workspace to one replica for
its lifetime, and the Agent routes every workspace-bound call to that replica
through per-pod headless DNS. A request that reaches the wrong replica is
refused with `409 PLACEMENT_MISMATCH` naming the owner, and the Agent retries
there once.

This matters because the failure it prevents is silent: without routing, the
wrong replica would create an empty workspace, report a live process as "no
output", or accept a kill that signals nothing — all with HTTP 200.

Everything else (frontend, BFF, Agent HTTP, Agent worker, MCP facade) is
stateless and scales freely.

## Prerequisites

- Kubernetes 1.30+ (see the cluster requirements below — they are not optional)
- MySQL 8 and two Redis instances, **not** deployed by this chart:
  - one for Agent coordination (queue, leases, cancel, event stream)
  - a **separate** one for the Sandbox HMAC replay store; the Sandbox asserts
    the isolation at startup and refuses to share credentials with the Agent's
- A `ReadWriteMany` storage class, **only** if `agentWorker.userSkills.enabled`
  (see "Remaining RWX dependency")

## Cluster requirements for the Sandbox

Bubblewrap needs kernel features that Kubernetes does not grant by default.
Compose expresses these with `security_opt`; the Kubernetes equivalents are
less direct, and one has no clean equivalent at all.

| Compose | Chart | Notes |
|---|---|---|
| `cap_drop: ALL` + 5 caps | `sandbox.security.capabilities.add` | chown/chmod of mounted storage, privilege drop, signalling bubblewrap orphans |
| `seccomp=sandbox/seccomp-bubblewrap.json` | `seccompProfile: Localhost` | **You must install the profile on every node** under the kubelet seccomp directory (typically `/var/lib/kubelet/seccomp/pi-enterprise/`), usually via a DaemonSet |
| `apparmor=unconfined` | `appArmorProfile: Unconfined` | The default profile denies `mount` even inside a new user namespace |
| `systempaths=unconfined` | `procMount: Unmasked` + `hostUsers: false` | **No clean equivalent.** Requires the `ProcMountType` feature gate |

Nodes may additionally need `kernel.unprivileged_userns_clone=1`.

> **Verify this combination on your cluster before rolling out.** Run
> `tests/container_bwrap_smoke.py` inside a Sandbox pod. If bubblewrap cannot
> start, the isolation backend — not just the chart — needs rethinking. Setting
> `sandbox.security.seccompProfile.type=Unconfined` is the documented fallback
> and is a real reduction in defence depth.

## Install

```bash
helm install pi deploy/helm/pi-enterprise-sandbox \
  --namespace pi --create-namespace \
  --set secrets.mysqlUser=pi \
  --set secrets.mysqlPassword="$MYSQL_PASSWORD" \
  --set secrets.llmApiKey="$LLMIO_API_KEY" \
  --set secrets.llmBaseUrl="$LLMIO_BASE_URL" \
  --set secrets.internalHmacKeyring="$HMAC_KEYRING_JSON" \
  --set secrets.internalHmacActiveKid=k1 \
  --set ingress.enabled=true --set ingress.host=pi.example.com
```

Prefer `secrets.existingSecret` with a secret you manage out of band; the keys
it must contain are listed in `templates/config.yaml`.

Migrations run as a `pre-install,pre-upgrade` hook. Every replica keeps
`AGENT_MIGRATE_ON_START=false` — N replicas racing the same DDL during a
rollout is exactly what the hook avoids.

## Scaling

| Component | How |
|---|---|
| frontend, api-server, agent | `replicaCount`, or enable `autoscaling` |
| agent-worker | `agentWorker.replicaCount`. Recovery/cron/outbox sweeps claim rows with `FOR UPDATE SKIP LOCKED`, so extra replicas duplicate polling, not work |
| **sandbox** | `sandbox.replicaCount` — read below first |

**Scaling the Sandbox up** adds capacity for *new* workspaces. Existing ones
stay on their current shard; they are never rebalanced, because their data
exists nowhere else.

**Scaling the Sandbox down strands the workspaces on removed shards.** Their
PVCs survive (StatefulSet does not delete them), so scaling back up restores
access. Before a permanent scale-down, drain the shard: deliverables live in
artifacts and MySQL, which survive; workspaces are working directories and are
expected to be recreatable.

`sandbox.uvicornWorkers` must stay `1`. The execution admission lock and the
managed-process table live in a single process, so a second worker would serve
the same workspace without seeing either. The container refuses to start
otherwise.

## Probes

Readiness is deliberately **self-scoped** on the BFF (`/health/ready` reports
only whether this replica can serve). A dependency-aware readiness probe would
fail every replica simultaneously on one upstream blip, emptying the Service
endpoints and turning partial degradation into a full outage. Dependency status
lives at `/health/deps` for dashboards.

## Same-origin requirement

The browser's SSE fetch sends no explicit credentials, so serving the SPA and
`/api` from different origins silently drops the session cookie and every
stream 401s. The ingress routes everything to the frontend, whose nginx proxies
`/api` to the BFF. If you put your own proxy in front, it must preserve
`proxy-buffering: off`, `proxy-request-buffering: off`, a read timeout ≥ the
SSE heartbeat, and a 55m body size — otherwise SSE buffers and uploads 413.

## Remaining RWX dependency

`agentWorker.userSkills` is the only volume several pods write to concurrently,
so it needs `ReadWriteMany`. It is also the only reason this deployment needs
an RWX storage class at all. Set `agentWorker.userSkills.enabled=false` if you
do not use user-installed skills.

## Not yet covered

- Execution-owner leases: a SIGKILLed Sandbox pod can leave `tool_executions`
  rows RUNNING with no sweeper to reap them. Columns exist; the logic does not.
- Artifact bytes are stored per shard (`artifacts.storage_node_id`) and routed
  accordingly. Moving them to object storage would decouple downloads from
  Sandbox placement entirely.
