# Artifact 讨论纪要：模块化、跨会话复制与「库」

**日期：** 2026-07-24  
**分支上下文：** `codex/plan-acceptance`  
**状态：** 方案讨论（未实施改造）  
**相关文档：** `plan.md` §2.8 / §8.15、`docs/architecture.md`、`docs/module-layout.md`、`docs/webui.md`

---

## 1. 背景与问题

本轮讨论围绕三个问题：

1. **模块化**：Artifact 相关代码能否形成单独模块、独立管理？有无可参考的外部项目？
2. **跨会话复制**：在**不做改造**的前提下，如何把 Conversation A 的 artifact 弄到 Conversation B？
3. **用户级「库」**：Artifact 是否有单独挂载？能否做成类似 ChatGPT「库」的跨会话文件中心？

---

## 2. 现状摘要

### 2.1 产品语义

唯一正式交付链路（禁止 `write`/`edit` 自动 `file_ready`）：

```text
Workspace file
  → submit_artifact
  → 不可变 control-plane snapshot + MySQL metadata
  → artifact.ready / file_ready
  → 仅凭 artifact_id 下载（禁止 workspace path 作为交付 fallback）
```

Artifact 绑定：

- `org_id` / `user_id`
- `conversation_id` / `agent_session_id` / `run_id`
- 不可变 blob：`{SANDBOX_ARTIFACTS_ROOT}/{org_id}/{artifact_id}/blob`

### 2.2 代码分布（一阶相关约 3k+ 行）

| 层 | 代表位置 | 职责 |
|----|----------|------|
| Sandbox 核心 | `artifact_manager` / `artifact_store` / `formal_artifact_runtime` / `control_plane_storage` / contracts / repos / routers | 提交、快照、幂等、下载、所有权 |
| Agent | `submit_artifact` tool、HMAC client、`artifact.ready` 投影、A2A download、MySQL `ArtifactRepository` | 工具编排、事件权威、A2A 元数据 |
| BFF | `routes/artifacts.js`、files artifact-download proxy | list / 边缘鉴权代理 |
| Frontend | `ArtifactPanel`、`ArtifactCard`、entities store、`runReducer` | 当前 Run 交付列表与下载 URL |

### 2.3 存储与挂载

Compose 中 control-plane **独立挂载**（不进入 Bubblewrap workspace）：

```text
./artifacts  →  /var/sandbox/artifacts   (SANDBOX_ARTIFACTS_ROOT)
./control    →  /var/sandbox/control     (dataset staging 等)
./workspaces →  /var/sandbox/workspaces  (会话工作区)
```

要点：

- 物理上已是独立对象根；按 `org_id/artifact_id` 布局，不是「库/相册」目录树。
- 用户上传附件进 **session workspace**；Dataset staging 在 **control** 卷；二者都不是 Artifact 交付根。

### 2.4 对外 API / UI（无用户级库）

| 能力 | 现状 |
|------|------|
| List | `GET /api/artifacts?session_id=`（必须带 session） |
| Download | `/api/files/artifact-download?session_id=&artifact_id=` |
| UI | Workbench Context Inspector 内 `ArtifactPanel`（按 Run） |
| 全局库 | **无** 侧栏「库」、无 全部/图片/文档、无跨会话入口 |

仓储层存在 `list_for_owner(org, user)`（可不带 `run_id`），仅内部/恢复路径使用，**未**暴露为产品「我的全部文件」API。

---

## 3. 讨论一：能否形成独立模块

### 3.1 结论

| 问题 | 结论 |
|------|------|
| 能否形成单独模块？ | **能**。领域边界已存在，缺的是代码组织上的「模块壳」。 |
| 能否独立管理（版本/owner/测试）？ | **能**。优先 monorepo 内 package / 领域目录 + CODEOWNERS。 |
| 是否应拆成独立微服务？ | **当前不推荐**。强耦合 Run 身份、tool claim、workspace 读源、事件投影与 Dataset 共享 control-plane 原语。 |

### 3.2 强耦合点（限制 L3 拆服务）

1. 身份与 Run 绑定（conversation / agent_session / run）
2. 与 bash/files 同一套 claim / fence / idempotency / supervisor
3. 提交时必须从 workspace 安全打开源文件
4. `control_plane_storage` 与 Dataset 共享
5. Sandbox 写 metadata + Agent A2A 读 metadata
6. Agent 事件投影 `artifact.ready`

### 3.3 推荐模块化层级

**L1 — 服务内领域模块（推荐先做）**

在 `sandbox/` 内聚合，例如：

```text
sandbox/artifact/   # 或 sandbox/app/artifact/
  domain/           # contracts, records, errors
  application/      # FormalArtifactRuntime
  infrastructure/   # manager, store, repo, blob IO
  api/              # internal + legacy session routers
```

- 对外 facade：`submit` / `resolve_download` / `list`
- 行为零 diff，现有 e2e / live gate 验收

**L2 — 跨服务契约包（可选）**

```text
packages/artifact-contract/   # event shapes / claim schema
packages/artifact-client/     # Agent→Sandbox HMAC clients
```

**L3 — 独立 Artifact Service（暂缓）**

仅当对象存储多 region、跨产品复用、独立 retention/扫描、下载与 Agent 扩缩完全不同时再考虑。

### 3.4 与 Dataset 的关系

- 同属 control-plane，**共享 storage primitives**。
- **不要**合并成一个「blob 模块」：Dataset 是输入/暂存，Artifact 是显式交付。

### 3.5 外部参考（设计对照，非同构可抄）

| 参考 | 可借鉴 | 差异 |
|------|--------|------|
| [MLflow Artifact Store](https://mlflow.org/docs/latest/self-hosting/architecture/artifact-store/) | 元数据与 blob 分离；Run 绑定 | 实验/模型场景，无 enterprise owner + formal claim |
| [W&B Artifacts](https://docs.wandb.ai/models/artifacts) | Run 输入输出版本与血缘 | SaaS 实验跟踪 |
| OpenAI Assistants Files / Code Interpreter | 沙箱生成 → opaque `file_id` 交付 | 闭源托管 |
| Box + LangGraph Deep Agents | 中间产物 vs 交付物出界 | 隔离与权限模型不同 |
| `pi-web-ui` artifacts | MIME 展示层 | 本前端已自研；非企业交付控制面 |

最接近类比：**MLflow（backend metadata + artifact store）+ OpenAI 式 opaque id 交付 + 本仓库 formal tool runtime**。

### 3.6 建议落地节奏（未实施）

1. **Phase A**：契约冻结（submit / download / event / 表）
2. **Phase B**：L1 物理聚合（move + facade，零行为 diff）
3. **Phase C**：L2 schema 共享（可选）
4. **Phase D**：独立服务（仅业务驱动）

**明确不做（现阶段）：** 为模块感单独起 `artifact-service`；Dataset+Artifact 糊成一服务；BFF/前端 path 交付；在 Agent 再写 snapshot 逻辑。

---

## 4. 讨论二：零改造下 A → B 复制 Artifact

### 4.1 结论

**没有一等「复制 / 链接 / rebind」能力。**  
A 的 `artifact_id` **不会**变成 B 的 artifact。  
零改造只能：**字节搬运 + 在 B 重新 `submit_artifact`** → 新 id、新元数据（内容可相同）。

### 4.2 推荐路径（产品能力内）

```text
Conversation A                         Conversation B
──────────────                         ──────────────
下载：
  GET /api/files/artifact-download
    ?session_id=<A_session>
    &artifact_id=<A_artifact>
        │
        ▼  本地文件
        │
  上传：
  POST /api/files/upload?session_id=<B_session>
        │  → B workspace（附件）
        ▼
  B 上 Run：agent 对上传文件 submit_artifact
        │
        ▼
  B 新 artifact_id + 新 snapshot + 新 MySQL 行
```

**UI 步骤：**

1. 打开 A → Artifact 面板下载  
2. 打开 B → 上传该文件  
3. 在 B 提示 agent 对上传物执行 `submit_artifact`  
4. 等待 B 侧 `file_ready` / 面板新条目  

### 4.3 约束与误区

| 误区 | 事实 |
|------|------|
| B 直接挂 A 的 `artifact_id` | 不行（会话/对话绑定） |
| B agent 读取 A workspace / snapshot | 不行（隔离 + owner/session） |
| 上传即交付 | 否；上传只进 workspace，须再 submit |
| 改 MySQL conversation_id 搬家 | 不支持且危险 |

运维级「拷 blob + 插行」可技术上做到，**非产品支持路径**，破坏 claim/审计/一致性。

### 4.4 场景对照

| 场景 | 做法 |
|------|------|
| 偶发几个文件 | UI：下载 → 上传 → submit |
| 批量 | 同上 API 外挂脚本 |
| 只要内容进 B 继续聊，不在乎交付列表 | B 上传当附件即可，不必 submit |
| 产品级「引用 A 交付物」 | 需新能力（link / import / copy API） |

---

## 5. 讨论三：单独挂载 vs ChatGPT「库」

### 5.1 对照

| 维度 | 本项目 | ChatGPT「库」 |
|------|--------|----------------|
| 磁盘/挂载 | 有独立 `artifacts` 卷 | 统一对象存储心智 |
| 数据模型 | 表含 org/user/conversation/run | 用户级聚合展示 |
| API | 按 session list/download | 跨会话「我的文件」 |
| UI | 会话/Run 交付面板 | 侧栏库 + 全部/图片/文档 |
| 复用 | 不能把 A id 挂到 B | 可从库拖进对话 |

**一句话：**  
有 **control-plane 独立挂载**；没有 **用户级跨会话文件库**。  
当前心智是 **「这次任务的交付列表」**，不是 **「我的文件中心」**。

### 5.2 若要做「库」（方向，未设计定稿）

底层条件已具备一半（表字段 + 独立卷）：

1. API：`GET /api/library/artifacts?type=image|doc&cursor=`（owner-scope）  
2. 下载鉴权改为 user/org 为主，弱绑定「当前聊天 session」  
3. UI：侧栏库 + mime 筛选  
4. 进对话：import 或仍走 upload；除非再做 `import_artifact → B`  
5. 范围选择：  
   - **仅 Artifact 交付物**（与现语义一致）  
   - **上传 + 交付物**（更接近 ChatGPT；需索引 attachments）

存储不必换挂载；缺的是 **跨会话索引 + 库 UI + 鉴权模型**。

---

## 6. 综合结论

1. **模块化：** 适合 monorepo 内 L1（Sandbox 聚合）→ 可选 L2 契约；暂不 L3 拆服务。  
2. **跨会话：** 零改造 = 下载 A → 上传 B → 再 submit；无共享 id。  
3. **挂载 vs 库：** `SANDBOX_ARTIFACTS_ROOT` 已独立；产品无 ChatGPT 式库。  
4. **差异化优势应保留：** Artifact-only delivery、opaque `artifact_id`、owner-scoped formal runtime。

---

## 7. 后续可选工作项

| ID | 项 | 类型 |
|----|----|------|
| A1 | L1 目标目录 + 文件搬家清单 | 重构方案 |
| A2 | `docs/artifact-module.md` 契约（submit/download/event/表） | 文档 |
| B1 | 运维/批量 A→B 复制脚本（现有 API） | 运维工具 |
| C1 | 用户级 Library 需求边界（仅 artifact vs 含上传） | 产品/设计 |
| C2 | Library list API + 下载鉴权草案 | 设计 |

---

## 8. 关键代码入口（速查）

| 用途 | 路径 |
|------|------|
| 提交编排 | `sandbox/services/formal_artifact_runtime.py` |
| Snapshot / 下载 | `sandbox/services/artifact_manager.py` |
| 控制面 IO | `sandbox/services/control_plane_storage.py` |
| Internal 契约 | `sandbox/app/domain/internal_artifact_contract.py` |
| Internal 路由 | `sandbox/routers/internal_artifacts.py` |
| Session 兼容路由 | `sandbox/routers/artifacts.py` |
| Agent tool | `agent/src/extensions/sandbox-bridge/tools/index.js`（`submit_artifact`） |
| 事件投影 | `agent/src/application/fenced-tool-governance-recorder.js` |
| A2A 下载 | `agent/src/application/a2a/artifact-download.js` |
| BFF list | `api-server/src/routes/artifacts.js` |
| BFF download proxy | `api-server/src/routes/files.js`（`handleArtifactDownload`） |
| UI 面板 | `frontend/src/widgets/artifact-panel/ArtifactPanel.tsx` |
| 表定义 | `plan.md` §8.15 / Agent schema migrations |

---

*本文档为讨论纪要，不构成已批准 ADR；实施前请再对应当前代码与 `plan.md` 校验。*
