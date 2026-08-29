# exec/ 与 Python 执行面的逐函数对照

**审计于 2026-08-29，基线 `4dda7a9b`（删除前的最后一版 Python）对 `refactor/dsh-rebuild`。**

写这份东西的直接原因：[README.md](README.md) 的进度表把 Wave 3 标成 ✅，
`exec` 的 231 个用例也全绿，但公共面的产物、数据集与搜索三块**是占位实现**。
测试没抓到，是因为它们断言的是**响应形状**，而占位实现形状是对的。

> **怎么读这份文档**：`❌ 缺失` 是漏做，要补；`➖ 刻意不做` 是有 ADR 依据的删减，
> 不要"补回来"；`⚠️ 形状不足` 是接口签名本身就承载不了需求，补实现之前得先改签名。

---

## 结论速览

| 子系统 | Python 行数 | `exec/` 行数 | 状态 |
|---|---|---|---|
| shell / 进程 | ~3,500 | `shell/` 3,662 | ✅ 已移植 |
| 隔离 | — | `isolation/` 993 | ✅ 已移植 |
| 工作区 / 配额 | 972 | `workspace/` 1,545 | ✅ 已移植 |
| 文件读写 | ~2,900 | `fs/` 637 | ⚠️ 基础操作靠继承 `dsh-fs-local`，编辑/读运行时缺 |
| **搜索** | 1,368 | `search/` 约 900 | ✅ 已补（2026-08-29）|
| **数据集** | 1,856 | `dataset/` 128 | ❌ 上传不落盘；签名形状也不支持流式 |
| **产物** | ~2,000 | `artifact/` 约 700 | ✅ 已补（2026-08-29），快照改存控制面 |

`exec/src` 合计 11,717 行，其中 1,323 行是 2026-08-29 新写的 `mcp/`。

---

## 一、搜索（`file_search.py` 975 + `formal_search_runtime.py` 393）

> **✅ 已补，2026-08-29。** `exec/src/search/` 落地 `ls` / `find` / `grep`，
> 内部面与公共面共用同一个服务。验收：`exec/test/search-service.test.ts` 18 条
> + `semantic-gaps.test.ts` 的 3 条搜索用例。下表保留作移植对照。

原状（占位期）：

| 路由 | 现状 |
|---|---|
| `POST /internal/v1/fs/find` (`internal-fs.ts:183`) | 忽略 `pattern`，返回 `fs.listDir(target)` |
| `POST /internal/v1/fs/grep` (`internal-fs.ts:191`) | 校验 `pattern` 是字符串后**丢弃它**，返回 `fs.listDir(target)` |
| `POST /sessions/:id/files/find` (`public/files.ts:306`) | 恒返回 `{files: [], total: 0}` |
| `POST /sessions/:id/files/grep` | 同上 |

**这是最该先补的一块**：agent 的 `grep` / `find` 工具直接绑在这里，模型会拿到
一个"没有报错但结果是错的"回答——比报错更糟。

### `FileSearchService` 逐条

| Python | exec | 说明 |
|---|---|---|
| `ls(root, path, depth, include_hidden, temp_path)` | ⚠️ `fs.listDir` 顶替 | `listDir` 无 depth、无 hidden 过滤、无 skill 根 |
| `find(...)` | ❌ 缺失 | glob 匹配（`_glob_matches` 同时按 name 与 rel 匹配）、排序、截断、`stop_reason` |
| `grep(...)` | ❌ 缺失 | 正则编译（`_compile_grep_query`）、二进制探测跳过、上下文行、匹配计数 |
| `_is_binary_bytes` / `_is_binary_file` | ❌ 缺失 | 不跳过二进制会把乱码灌进模型上下文 |
| `_resolve_skill_search_root` / `SkillSearchRoots` | ❌ 缺失 | 搜索要能覆盖 skill 根，且逐包受启用集约束（ADR 0006 P1(A)） |
| `_to_rel(root, path, public_prefix)` | ❌ 缺失 | 结果里的路径必须是逻辑路径，不能泄漏物理根 |
| `_within_workspace` | ✅ 等价物在 `fs/path-policy.ts` | |
| `_clamp_int` | ❌ 缺失 | 上限钳制，防止 `limit=10^9` |
| `FormalSearchRuntime`（claim / replay / UNKNOWN 对账） | ➖ 刻意不做 | 正式执行记账在 agent 侧，ADR 0007 D5；exec 只做无状态搜索 |

---

## 二、数据集（`dataset_manager.py` 975 + `dataset_store.py` 881）

`exec/src/dataset/service.ts` 128 行，只有 `create(content: Uint8Array)` 与 `read()`。

### ⚠️ 签名形状不足——补实现之前必须先改

Python 是**分块流式**：`begin_upload` → `write_chunk` → `finish_upload`，
配合 `stream_from_iterator`。`STATUS.md` C8 记着一次 **5GiB 实测**。

`DatasetService.create()` 收的是 `content: Uint8Array`，即**整文件进内存**。
5GiB 数据集会直接把进程打死。这不是"少写了几个函数"，是接口签名就不成立。

`public/datasets.ts:62` 的注释写着"真实流由下游 `fetchSandboxBounded` 背压"，
但那条路径上**没有下游**——它自己就是下游，且 `DatasetService` 根本没被调用。

### 逐条

| Python | exec | 说明 |
|---|---|---|
| `begin_upload` / `write_chunk` / `finish_upload` | ❌ 缺失 | 三段式流式上传 |
| `abort_upload` | ❌ 缺失 | 失败时清理暂存与配额预留 |
| `stream_from_iterator` | ❌ 缺失 | |
| `normalize_dataset_idempotency_key` / `dataset_upload_request_hash` / `_finish_idempotent_upload` / `_fail_idempotent_candidate` | ❌ 缺失 | 幂等键。路由**已经在要求** `Idempotency-Key` 头（`datasets.ts:55`）却不用它 |
| `sanitize_dataset_filename` / `extension_of` | ⚠️ 复用 `attachment/sanitize.ts` | 需核对规则是否逐条一致 |
| `logical_dataset_path` / `staging_relative_path` | ⚠️ 部分 | exec 直写终点，无暂存目录，因此没有"写一半失败"的干净回退 |
| `get` / `list_for_session` | ⚠️ 有 `read`，无 `list` | |
| `is_readable_by_agent` | ❌ 缺失 | agent 侧可读性闸门 |
| `_entry_from_formal` / `set_formal_repository` / `FormalDatasetDualWriter` | ➖ 刻意不做 | 双写是 Sandbox SQLite 时代的产物；MySQL 是唯一权威（ADR 0007 D5） |

---

## 三、产物（`artifact_manager.py` 825 + `control_plane_storage.py` 834）

> **✅ 已补，2026-08-29。** 新增 `exec/src/artifact/control-plane-storage.ts`
> （`streamCopyHashToControl` / `iterSnapshotChunks` / `FileIdentity`），
> `ArtifactService` 重写为控制面快照，`exec_artifacts` 扩列
> `sha256`/`mime_type`/`source_path`/`identity`/`session_id`，公共面四条路由与
> 内部面两条全部接上真实服务。验收：`artifact-dataset-attachment.test.ts` 6 条
> + `semantic-gaps.test.ts` 的 4 条产物用例。下文保留作决策记录。

### ⚠️ 存储位置的设计曾经偏了（已修）

Python 的语义是 **快照存控制面，不存工作区**，读时用 `stat` identity 校验：

```python
# public.py:233
"""Stream control-plane snapshot (not workspace). Chunks via thread pool."""
```

`exec/src/artifact/service.ts:113` 把产物写进 `工作区/artifacts/{id}/{name}`。
工作区是模型可写的——模型可以改写甚至删掉自己已提交的产物，而产物的意义
恰恰是"提交那一刻的不可变快照"。**这条要先定，再谈补函数。**

### 公共面四条路由全是假的（`public/artifacts.ts`）

| 路由 | 现状 |
|---|---|
| `GET .../artifacts` | 恒 `{artifacts: [], total: 0}` |
| `POST .../artifacts/register\|submit` | 编造记录：`art_${Date.now()}`、`sha256: '0'.repeat(64)`、`size: 0`，回 **201** |
| `POST .../artifacts/imports` | 只回显入参，不导入 |
| `GET .../artifacts/:id/download` | 恒 404 |

`ArtifactService` 存在但**没有被注入** `PublicArtifactDeps`。

### 内部面同样是假的（`internal-artifact.ts`）

`submit` 回 `art-xxxxxxxx-stub`；`download` 回 `bytes: ''`。

### 逐条

| Python | exec | 说明 |
|---|---|---|
| `submit(...)` 含 `expected_sha256` 校验 | ⚠️ 有 `submit`，**不算 sha256** | `exec_artifacts` 表没有 `sha256` 列 |
| `iter_snapshot_chunks(path, expected)` | ❌ 缺失 | 流式读 + identity 校验；exec 是 `readFile` 整读进内存 |
| `resolve_download` | ❌ 缺失 | |
| `import_to_workspace` | ❌ 缺失 | 跨工作区导入 |
| `get_for_owner` / `get_for_owner_scope` / `get_for_session` | ⚠️ 只有 `getById` + workspaceId 相等 | 缺 org/user/conversation/agent_session 维度 |
| `_same_session_live_cache` / `_cache_entry_matches_formal` / `_restore_from_formal` | ➖ 刻意不做 | 同上，双写时代产物 |
| `source_provenance` | ❌ 缺失 | `source_execution_id` 溯源 |
| `delete_by_session` | ❌ 缺失 | |
| `_snapshot_path(org_id, artifact_id)` | ❌ 缺失 | 控制面按 org 分片 |
| mime 兜底：`text/html` / `image/svg+xml` → `octet-stream` | ❌ 缺失 | 防止浏览器把用户产物当页面执行（存储型 XSS） |
| `X-Content-Type-Options: nosniff` / `X-Artifact-Sha256` / `Content-Length` | ❌ 缺失 | 下载响应头 |
| `expected_sha256` 不匹配即拒 | ❌ 缺失 | |

`control_plane_storage.py` 的 `stream_copy_hash_to_control`（边拷边算 sha256、
带 `max_bytes` 上限、返回 identity）是产物与 MCP 提交共用的底座，**也没有对应物**。

---

## 四、这份清单对验收标准的影响

[dsh-rebuild.md §9](../dsh-rebuild.md) 的 14 条里，下面几条现在**不成立**：

- **第 2 条**（SSE 契约逐字节不变）—— SSE 本身没问题，但同批声称的"公共面契约
  不变"只在形状层面成立，语义层面不成立
- **第 9 条**（本机文件系统不可达）—— 未受影响，仍成立
- **第 14 条**（真实链路）—— 从未跑过；按本清单，跑也跑不通

[ADR 0008 §验收要求](../../adr/0008-sandbox-isolation-and-fs-seam-redesign.md) 第 9 条
"公共面契约不变：BFF 侧用例零改动通过"**需要重新表述**：BFF 用例通过，是因为
它们断言 JSON 形状；产物与数据集的语义没有被任何用例覆盖。

---

## 五、补实现的建议顺序

1. **搜索** —— agent 工具直接依赖，且没有存储设计问题，是三块里最独立的
2. **产物** —— 先定"快照存哪里"（建议随 Python 走控制面目录），再补
   `stream_copy_hash_to_control` 底座，产物与 MCP 提交共用
3. **数据集** —— 先改签名为三段式流式，再补幂等键

每一块的验收必须是**断言语义的用例**，不能再是形状用例：

- grep 断言"匹配到的行号与内容"，不是"返回了一个数组"
- artifact 断言"下载回来的字节 sha256 等于提交时的字节"，不是"返回了 sha256 字段"
- dataset 断言"写进去的字节能原样读回来"，不是"返回了 201"
