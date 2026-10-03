# Artifact module

Artifact is an in-process Sandbox domain module. It is not a separate service
and it does not share Dataset business semantics.

## Layout and dependency boundary

```text
exec/src/artifact/
  service.ts               # 公开入口：ArtifactService（提交 / 列表 / 下载 / 导入）
  control-plane-storage.ts # 控制面快照存储（SANDBOX_ARTIFACTS_ROOT / SANDBOX_CONTROL_ROOT）
```

New callers use `ArtifactService` from `exec/src/artifact/service.ts`:

- `submit(...)` / `submitRevision(...)`
- `list(...)` / `listByWorkspace(...)` / `listByOwner(...)`（产物库另有按 owner 跨会话的列表，见 `api.md` 的 `GET /artifacts`）
- `importToWorkspace(...)` / `importRevisionToWorkspace(...)`
- `getInOrg(...)`（审核面 org 作用域只读）

The former Python `sandbox.artifact.{domain,application,infrastructure,api}` package
paths and `sandbox.artifact.application.facade.ArtifactFacade` no longer exist
(TS 重写 ADR 0008 后已删除）. They must not receive new business logic.

## Frozen delivery contract

The phase-one module migration does not change formal delivery:

```text
workspace file
  → submit_artifact
  → immutable {artifacts_root}/{org_id}/{artifact_id}/blob
  → owner/run metadata
  → artifact.ready / file_ready
  → artifact_id download
```

- `submit_artifact` remains the only formal-delivery operation.
- Workspace paths are never Artifact download fallbacks.
- Existing Artifact bytes are immutable.
- Dataset remains an input/staging concept.
- Existing submit/download event and table shapes are unchanged.

## Artifact visibility（交付物审核，2026-10-01）

`tbl_agsvc_exec_artifacts` 新增三列，把「这件产物能不能交付」变成 exec 自己记录并执行的
事实（设计 [design/agent-output-review.md](design/agent-output-review.md) §3，
决策 [ADR 0016](adr/0016-agent-output-human-review.md) D1）：

| 列 | 取值 | 说明 |
|---|---|---|
| `visibility` | `released`（默认）\| `held` \| `withdrawn` | 存量行与 direct 工作区一律 `released` |
| `revision_of` | 上一版 artifact id \| NULL | 审核员的修订版指向被替换的那一版 |
| `created_by_kind` | `agent` \| `reviewer` | 谁提交的这一版 |

规则（与上面「冻结交付契约」的关系：交付路径不变，只是**多了一道可见性门禁**）：

- review 工作区里提交的产物一律 `held`；direct 工作区不变（`released`）。
  「这个工作区要审核」记在 `tbl_agsvc_exec_workspace_policies`，由 agent 在会话确保时
  经 HMAC 内部面设置，**只能设置、不能撤销**。
- 状态只能 `held → released | withdrawn`，终态不可再变；变更在**单事务**里完成且幂等
  （outbox 是至少一次投递）。
- **owner 公共面只认 `released`**：会话产物列表（E1）、下载（E2）、产物库（E3）、
  跨会话导入（E4）。非 `released` 与「不存在」返回同一个 404——存在性本身不能泄漏。
- review 工作区的**工作区字节读路径**一律 404（E5 文件列表/读取/预览/下载/ls/find/grep、
  E6 进程日志与数据集读取），因为读工作区就能拿到 `submit_artifact` 的源文件、绕过审核。
  上传照常允许（E7）。
- 判据分流是刻意的：E1–E4 由**产物可见性**判（列表照常返回，只是过滤掉），
  E5–E6 由**工作区策略**判（整条路径 404）。
- 查询失败 fail-closed：读操作 503，绝不当作放行。
- 审核面另有一条 org 作用域的只读通道（`ArtifactService.getInOrg`）供审核员读取任一版本；
  它只服务 exec 的 HMAC 内部审核端点，不经过 owner 公共面。

### 状态是谁推进的（agent 侧账本）

exec 只记录并执行可见性，**不放行自己**。推进者是 agent-worker 的审核循环，消费 agent 的
outbox 行（design §5.3）：

| outbox 事件 | 谁排队 | 消费者做什么 |
|---|---|---|
| `review.snapshot` | Run 终态建审核任务时（同一事务） | 对每个材料调 `POST /internal/v1/review/artifacts/snapshot`，把材料行从 `unavailable` 推到 `ready` |
| `review.decided` | 审核员通过/驳回时（同一事务） | 先 `POST …/visibility`（当前版本 → `released`，同一交付物集合里的其它版本 → `withdrawn`），再 `POST …/import` 把修订版导入工作区 `审核版/X` |

两条都**跨服务调用不进事务**（exec 侧单事务 + `WHERE visibility='held'` + 覆盖同名导入，
所以至少一次投递下重复执行安全）。失败分类决定要不要重试：4xx/404 是输入不可满足
（源文件被删、产物不存在），结清并留痕；5xx/网络交给 outbox 退避重试。

材料快照**不存源路径**（账本只记附件身份），投递时按 `attachment_id` 从触发消息里重新解析
源路径——所以「发起人删了工作区文件」表现为快照失败，这是要的状态，而不是猜一个路径。

放行后 `artifact.released` / `review.rejected` 事件落在**原 Run** 上（不是新 Run），刷新页面
靠会话事件重放就能拿到；产物库与下载随可见性变化立即生效，没有第二份缓存。

## Cross-conversation Import MVP

Public BFF operation:

```http
POST /api/conversations/{target_conversation_id}/artifact-imports
Content-Type: application/json

{
  "artifact_id": "01...",
  "target_filename": "report.pdf"
}
```

Sandbox compatibility upstream:

```http
POST /sessions/{target_session_id}/artifacts/imports
```

Successful response:

```json
{
  "import_id": "01...",
  "artifact_id": "01...",
  "target_session_id": "01...",
  "target_conversation_id": "01...",
  "workspace_file": {
    "name": "report.pdf",
    "path": "imports/01.../report.pdf",
    "mime_type": "application/pdf",
    "size": 1234,
    "sha256": "..."
  }
}
```

Import semantics:

1. Agent resolves and authorizes the target session for the caller.
2. Sandbox requires the source Artifact to match the target session's
   `org_id + user_id`.
3. Sandbox reads only the immutable control-plane snapshot.
4. Bytes are atomically published with no-follow directory traversal to
   `imports/{import_id}/{sanitized_filename}` in the target workspace.
5. File-size and workspace quota limits are enforced.
6. The operation writes an owner-scoped audit event. If authoritative audit
   persistence fails, the published file is rolled back.

Import does **not**:

- modify the source Artifact;
- bind its `artifact_id` to the target conversation;
- insert a second Artifact metadata row;
- emit `artifact.ready` or `file_ready`;
- make the imported file a formal deliverable.

The frontend opens the target conversation and puts the imported workspace file
in the composer as an uploaded attachment. If the user later wants it delivered
from the target conversation, the Agent must call `submit_artifact`, which
creates a new immutable Artifact and new `artifact_id`.

## Deferred scope

Phase one does not include a global user Library, shared Artifact links,
cross-user sharing, blob deduplication, retention/deletion policy, or an
independent Artifact microservice.
